import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { pool, toVectorLiteral, withTransaction } from "../db.js";
import { embedOne } from "../embeddings.js";
import type {
  Client,
  Conversation,
  MemoryKind,
  PendingConfirmation,
  RecalledMemory,
} from "../types.js";

/**
 * Every function here takes a clientId and filters on it in SQL. That is the
 * only place the privacy boundary is enforced -- the model is never handed a
 * query it could widen to another client's rows.
 */

// ------------------------------------------------------------------ clients --

export async function findOrCreateClient(
  externalId: string,
  displayName?: string,
): Promise<Client> {
  const { rows } = await pool.query<{
    id: string;
    external_id: string;
    display_name: string | null;
    locale: string;
    created_at: Date;
  }>(
    `INSERT INTO clients (external_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (external_id) DO UPDATE
       SET display_name = COALESCE(clients.display_name, EXCLUDED.display_name),
           updated_at   = now()
     RETURNING id, external_id, display_name, locale, created_at`,
    [externalId, displayName ?? null],
  );

  const row = rows[0];
  if (!row) throw new Error(`Failed to resolve client "${externalId}".`);
  return {
    id: row.id,
    externalId: row.external_id,
    displayName: row.display_name,
    locale: row.locale,
    createdAt: row.created_at,
  };
}

// ------------------------------------------------------------ conversations --

/**
 * Resumes the client's most recent open conversation, or starts one. Resuming
 * is what makes the agent feel continuous across sessions; `maxIdleHours`
 * decides when a gap is long enough to count as a fresh conversation.
 */
export async function openConversation(
  clientId: string,
  maxIdleHours = 72,
): Promise<{ conversation: Conversation; resumed: boolean }> {
  const existing = await pool.query<ConversationRow>(
    `SELECT id, client_id, topic, stage, status, last_active_at
       FROM conversations
      WHERE client_id = $1
        AND status = 'open'
        AND last_active_at > now() - make_interval(hours => $2::int)
      ORDER BY last_active_at DESC
      LIMIT 1`,
    [clientId, maxIdleHours],
  );

  const found = existing.rows[0];
  if (found) return { conversation: mapConversation(found), resumed: true };

  const created = await pool.query<ConversationRow>(
    `INSERT INTO conversations (client_id)
     VALUES ($1)
     RETURNING id, client_id, topic, stage, status, last_active_at`,
    [clientId],
  );
  const row = created.rows[0];
  if (!row) throw new Error("Failed to create conversation.");
  return { conversation: mapConversation(row), resumed: false };
}

interface ConversationRow {
  id: string;
  client_id: string;
  topic: string | null;
  stage: string;
  status: string;
  last_active_at: Date;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    clientId: row.client_id,
    topic: row.topic,
    stage: row.stage,
    status: row.status as Conversation["status"],
    lastActiveAt: row.last_active_at,
  };
}

export async function updateConversationState(
  conversationId: string,
  patch: { topic?: string; stage?: string; status?: Conversation["status"] },
): Promise<void> {
  await pool.query(
    `UPDATE conversations
        SET topic          = COALESCE($2, topic),
            stage          = COALESCE($3, stage),
            status         = COALESCE($4, status),
            last_active_at = now()
      WHERE id = $1`,
    [conversationId, patch.topic ?? null, patch.stage ?? null, patch.status ?? null],
  );
}

// ---------------------------------------------------------------- messages --

/**
 * Stores a turn. `content` keeps the raw Claude content blocks so the
 * conversation can be replayed to the API unchanged -- including thinking and
 * tool blocks, which must go back exactly as they came out.
 */
export async function appendMessage(params: {
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: unknown;
  text: string | null;
  usage?: unknown;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, content, text, usage)
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb)
     RETURNING id`,
    [
      params.conversationId,
      params.role,
      JSON.stringify(params.content),
      params.text,
      params.usage === undefined ? null : JSON.stringify(params.usage),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to persist message.");

  await pool.query(
    `UPDATE conversations SET last_active_at = now() WHERE id = $1`,
    [params.conversationId],
  );
  return row.id;
}

/**
 * Loads the tail of a conversation for replay, as plain text turns.
 *
 * Two things are deliberately dropped. Stored `system` turns were retrieval
 * context injected for one specific turn, and stale context misleads the model
 * later. Tool and thinking blocks are only required to round-trip *within* the
 * turn that produced them -- the tool runner keeps those in memory -- and
 * replaying a tool_use whose result lived in a trimmed-away message would be
 * rejected by the API. The full blocks stay in `messages.content` for audit.
 */
export async function loadRecentTurns(
  conversationId: string,
  turnLimit = config.historyTurns,
): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const { rows } = await pool.query<{ role: string; text: string }>(
    `SELECT role, text FROM (
       SELECT role, text, created_at
         FROM messages
        WHERE conversation_id = $1
          AND role IN ('user', 'assistant')
          AND text IS NOT NULL
          AND btrim(text) <> ''
        ORDER BY created_at DESC
        LIMIT $2
     ) recent
     ORDER BY created_at ASC`,
    [conversationId, turnLimit],
  );

  const messages: Anthropic.Beta.BetaMessageParam[] = rows.map((row) => ({
    role: row.role as "user" | "assistant",
    content: row.text,
  }));

  // The API requires the first message to be a `user` turn. A window that
  // happens to start on an assistant reply would be rejected, so trim it.
  while (messages.length > 0 && messages[0]?.role !== "user") {
    messages.shift();
  }

  return messages;
}

// ---------------------------------------------------------------- memories --

export async function saveMemory(params: {
  clientId: string;
  kind: MemoryKind;
  content: string;
  importance?: number;
  sourceMessageId?: string;
  supersedesId?: string;
}): Promise<{ id: string; embedded: boolean }> {
  const vector = await embedOne(params.content, "document");

  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO memories
         (client_id, kind, content, importance, source_message_id, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)
       RETURNING id`,
      [
        params.clientId,
        params.kind,
        params.content,
        params.importance ?? 3,
        params.sourceMessageId ?? null,
        vector ? toVectorLiteral(vector) : null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to save memory.");

    if (params.supersedesId) {
      // Scoped by client_id so a supplied id can never touch another client's row.
      await tx.query(
        `UPDATE memories
            SET superseded_by = $1, updated_at = now()
          WHERE id = $2 AND client_id = $3`,
        [row.id, params.supersedesId, params.clientId],
      );
    }

    return { id: row.id, embedded: vector !== null };
  });
}

interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  importance: number;
  created_at: Date;
  score: string | number;
}

/**
 * Hybrid retrieval: vector similarity plus full-text search, fused with
 * Reciprocal Rank Fusion. RRF needs no score calibration between the two
 * retrievers, which matters because cosine similarity and ts_rank are not on
 * comparable scales. Falls back to text-only when embeddings are disabled.
 */
export async function recallMemories(params: {
  clientId: string;
  query: string;
  kinds?: MemoryKind[];
  limit?: number;
}): Promise<RecalledMemory[]> {
  const limit = params.limit ?? config.recallLimit;
  const perRetriever = Math.max(limit * 2, 10);
  const kindFilter = params.kinds?.length ? params.kinds : null;

  const vector = await embedOne(params.query, "query");

  const [semantic, textual] = await Promise.all([
    vector
      ? pool.query<MemoryRow>(
          `SELECT id, kind, content, importance, created_at,
                  1 - (embedding <=> $2::vector) AS score
             FROM memories
            WHERE client_id = $1
              AND superseded_by IS NULL
              AND embedding IS NOT NULL
              AND ($3::text[] IS NULL OR kind = ANY($3))
            ORDER BY embedding <=> $2::vector
            LIMIT $4`,
          [params.clientId, toVectorLiteral(vector), kindFilter, perRetriever],
        )
      : Promise.resolve({ rows: [] as MemoryRow[] }),

    // OR of the query's lexemes, not websearch_to_tsquery.
    //
    // websearch_to_tsquery ANDs every term, so with a stopword-free dictionary
    // like 'simple' it builds 'how' & 'do' & 'you' & 'prefer' & 'to' &
    // 'contacted' -- every one of those words must appear in the memory, which
    // a natural question never satisfies. Measured on real rows: natural
    // questions returned nothing in any language; only bare keywords matched.
    //
    // ORing trades precision for recall, which is the right way round here:
    // ts_rank orders the matches, LIMIT truncates the tail, and RRF fusion then
    // weighs them against the vector hits. quote_literal keeps a lexeme
    // containing a hyphen or an apostrophe from breaking tsquery parsing.
    pool.query<MemoryRow>(
      `WITH q AS (
         SELECT to_tsquery(
                  $5::regconfig,
                  string_agg(quote_literal(lexeme), ' | ')
                ) AS tsq
           FROM unnest(to_tsvector($5::regconfig, $2))
       )
       SELECT m.id, m.kind, m.content, m.importance, m.created_at,
              ts_rank(m.content_tsv, q.tsq) AS score
         FROM memories m, q
        WHERE m.client_id = $1
          AND m.superseded_by IS NULL
          AND ($3::text[] IS NULL OR m.kind = ANY($3))
          AND q.tsq IS NOT NULL
          AND m.content_tsv @@ q.tsq
        ORDER BY score DESC
        LIMIT $4`,
      [params.clientId, params.query, kindFilter, perRetriever, config.ftsConfig],
    ),
  ]);

  return fuse(semantic.rows, textual.rows, limit);
}

const RRF_K = 60; // standard damping constant; higher flattens rank influence

function fuse(
  semantic: MemoryRow[],
  textual: MemoryRow[],
  limit: number,
): RecalledMemory[] {
  const merged = new Map<string, RecalledMemory>();

  const absorb = (rows: MemoryRow[], label: "semantic" | "text") => {
    rows.forEach((row, rank) => {
      const existing = merged.get(row.id);
      const contribution = 1 / (RRF_K + rank + 1);
      if (existing) {
        existing.score += contribution;
        existing.matchedBy.push(label);
        return;
      }
      merged.set(row.id, {
        id: row.id,
        kind: row.kind as MemoryKind,
        content: row.content,
        importance: row.importance,
        createdAt: row.created_at,
        score: contribution,
        matchedBy: [label],
      });
    });
  };

  absorb(semantic, "semantic");
  absorb(textual, "text");

  return [...merged.values()]
    .sort((a, b) => b.score - a.score || b.importance - a.importance)
    .slice(0, limit);
}

/**
 * The highest-signal memories regardless of the current question: what the
 * agent should know about this client at all times, injected on every turn.
 *
 * No kind filter. An earlier version restricted this to preference/contact/
 * decision, which silently hid every stored `request` -- and "where is my
 * quote?" is the single most common thing a client asks. Importance plus
 * recency is a better selector than kind.
 */
export async function loadClientProfile(
  clientId: string,
  limit = 8,
): Promise<RecalledMemory[]> {
  const { rows } = await pool.query<MemoryRow>(
    `SELECT id, kind, content, importance, created_at, importance AS score
       FROM memories
      WHERE client_id = $1
        AND superseded_by IS NULL
      ORDER BY importance DESC, created_at DESC
      LIMIT $2`,
    [clientId, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as MemoryKind,
    content: row.content,
    importance: row.importance,
    createdAt: row.created_at,
    score: Number(row.score),
    matchedBy: ["text"],
  }));
}

// ---------------------------------------------------- pending confirmations --

export async function listPendingConfirmations(
  clientId: string,
): Promise<PendingConfirmation[]> {
  const { rows } = await pool.query<{
    id: string;
    description: string;
    created_at: Date;
  }>(
    `SELECT id, description, created_at
       FROM pending_confirmations
      WHERE client_id = $1 AND status = 'pending'
      ORDER BY created_at ASC`,
    [clientId],
  );
  return rows.map((row) => ({
    id: row.id,
    description: row.description,
    createdAt: row.created_at,
  }));
}

export async function recordPendingConfirmation(params: {
  clientId: string;
  conversationId: string;
  description: string;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO pending_confirmations (client_id, conversation_id, description)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [params.clientId, params.conversationId, params.description],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to record pending confirmation.");
  return row.id;
}

export async function resolvePendingConfirmation(params: {
  clientId: string;
  id: string;
  status: "confirmed" | "declined" | "cancelled";
  outcome?: string;
}): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE pending_confirmations
        SET status = $3, outcome = $4, resolved_at = now()
      WHERE id = $2 AND client_id = $1 AND status = 'pending'`,
    [params.clientId, params.id, params.status, params.outcome ?? null],
  );
  return (rowCount ?? 0) > 0;
}

// -------------------------------------------------------------- escalations --

export async function recordEscalation(params: {
  clientId: string;
  conversationId: string;
  category: "technical" | "legal" | "financial" | "client_request" | "other";
  reason: string;
  summary: string;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO escalations (client_id, conversation_id, category, reason, summary)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      params.clientId,
      params.conversationId,
      params.category,
      params.reason,
      params.summary,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to record escalation.");

  await updateConversationState(params.conversationId, { status: "escalated" });
  return row.id;
}
