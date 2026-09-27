-- Persistent client memory for the conversational agent.
--
-- Design notes:
--  * Every memory row is owned by exactly one client. Retrieval is always
--    filtered by client_id in SQL, never by asking the model to behave.
--  * Memories are never mutated in place when a client changes their mind:
--    the old row gets superseded_by set, so the history of a decision survives.
--  * messages.content holds the raw Claude content blocks as JSONB so a
--    conversation can be replayed to the API byte-for-byte, including
--    tool_use / tool_result / thinking blocks.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- clients ---
CREATE TABLE IF NOT EXISTS clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text UNIQUE NOT NULL,   -- email, CRM id, session number...
  display_name  text,
  locale        text NOT NULL DEFAULT 'en',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------- conversations ---
CREATE TABLE IF NOT EXISTS conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  topic          text,                      -- current subject, model-maintained
  stage          text NOT NULL DEFAULT 'new',
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'closed', 'escalated')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_client_active_idx
  ON conversations (client_id, last_active_at DESC);

-- --------------------------------------------------------------- messages ---
CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         jsonb NOT NULL,   -- Claude content blocks, verbatim
  text            text,            -- flattened text, for search and display
  usage           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON messages (conversation_id, created_at);

-- --------------------------------------------------------------- memories ---
CREATE TABLE IF NOT EXISTS memories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN
                      ('preference', 'request', 'decision', 'fact', 'contact')),
  content           text NOT NULL,
  importance        smallint NOT NULL DEFAULT 3
                      CHECK (importance BETWEEN 1 AND 5),
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  superseded_by     uuid REFERENCES memories(id) ON DELETE SET NULL,

  -- Width must match EMBEDDING_DIM in .env (voyage-3.5 -> 1024).
  -- NULL when no embedding provider is configured; retrieval then relies on
  -- the full-text index below.
  embedding         vector(1024),

  content_tsv       tsvector GENERATED ALWAYS AS
                      (to_tsvector('simple', content)) STORED,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memories_client_idx
  ON memories (client_id) WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS memories_tsv_idx
  ON memories USING gin (content_tsv);

-- HNSW gives good recall without a training step, so it works on an empty
-- table -- unlike ivfflat, which needs rows present before CREATE INDEX.
CREATE INDEX IF NOT EXISTS memories_embedding_idx
  ON memories USING hnsw (embedding vector_cosine_ops);

-- -------------------------------------------------- pending_confirmations ---
-- Open loops the agent must not lose track of between sessions.
CREATE TABLE IF NOT EXISTS pending_confirmations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  description     text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled')),
  outcome         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS pending_confirmations_open_idx
  ON pending_confirmations (client_id) WHERE status = 'pending';

-- ------------------------------------------------------------ escalations ---
CREATE TABLE IF NOT EXISTS escalations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  category        text NOT NULL CHECK (category IN
                    ('technical', 'legal', 'financial', 'client_request', 'other')),
  reason          text NOT NULL,
  summary         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS escalations_client_idx
  ON escalations (client_id, created_at DESC);
