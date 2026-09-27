# Continuum

**Unbroken client context, session after session.**

[![Node](https://img.shields.io/badge/node-%E2%89%A520-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-skilldev31-FFDD00?style=flat-square&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/skilldev31)

A client-facing conversational agent that remembers the people it talks to. Conversation state and long-term client memory live in PostgreSQL; relevant memories are retrieved per turn (hybrid vector + full-text) and injected into the request, so a client never has to repeat something they already told the agent.

The name is the point: the client relationship is continuous even though the conversations are not.

Runs on five interchangeable LLM backends — Claude (reference), OpenAI, Gemini, Mistral, and local models via Ollama. The memory layer is identical on all of them; only the transport differs. See [Backends](#backends).

## How it works

```
client message
    │
    ├─ persisted to messages
    │
    ├─ retrieval ────────────────────────────────────┐
    │    hybrid recall over this client's memories    │  pgvector (cosine)
    │    + standing profile and open loops (turn 1)   │  + tsvector FTS
    │    fused with Reciprocal Rank Fusion            │
    │                                                 ▼
    └─ request to Claude
         system      = frozen instructions  ← prompt-cached across every turn
         messages[]  = recent turns
                     + this turn's client message
                     + role:"system" block carrying the retrieved memories
         tools       = recall / remember / confirmations / escalate
                                │
                                ▼
                     tool runner loops until done
                                │
    ┌───────────────────────────┘
    ▼
assistant reply persisted, memories written as the client shares them
```

Three decisions are worth knowing about before you change anything:

**Retrieved memories go in a mid-conversation `system` message, not in the user turn or the top-level system prompt.** The top-level system prompt is byte-identical on every request, which is what makes it cacheable — injecting per-turn memories there would invalidate the cache each turn. Putting them in a `role: "system"` entry inside `messages[]` keeps the cached prefix intact *and* keeps them on the operator channel: text smuggled into a user turn can be forged by anything that writes to user input, a `system` message cannot. This requires a model that supports mid-conversation system messages (Opus 5 does; Sonnet 5 does not).

**The privacy boundary is in SQL, not in the prompt.** Tools are constructed per session and close over the client's id ([src/agent/tools.ts](src/agent/tools.ts)). The model has no parameter through which it could name a client, so there is no phrasing that reaches another client's rows. The instruction in the system prompt is a description of that behaviour, not the mechanism enforcing it.

**Changed facts supersede rather than overwrite.** When a client revises something, the new memory row points at the old one via `superseded_by`. Retrieval ignores superseded rows, so the agent acts on the current truth, while the history of the change survives for audit.

## Setup

Requires Node ≥ 20 and PostgreSQL ≥ 14 with the [`pgvector`](https://github.com/pgvector/pgvector) extension available.

```bash
npm install
cp .env.example .env     # then fill in DATABASE_URL and credentials
npm run migrate
npm run seed             # optional: a demo client with a history to talk to
npm run chat -- demo.client@example.com
```

Run `npm run chat` twice with the same identifier to see memory carry across sessions.

### Credentials

`ANTHROPIC_API_KEY` is optional: the SDK also picks up a profile stored by `ant auth login`, so a bare client works with no env var set. Set the key explicitly only if you need a specific one.

### Embeddings

**Anthropic does not serve an embeddings endpoint**, so vectors come from a separate provider. [src/embeddings.ts](src/embeddings.ts) implements a small `Embedder` interface against [Voyage AI](https://docs.voyageai.com/) — swap that class to change providers; nothing downstream depends on it.

Leaving `VOYAGE_API_KEY` empty is a supported mode: memories are stored without vectors and retrieval falls back to Postgres full-text search. That matches on wording rather than meaning, so a memory phrased differently from the question can be missed. The injected context block tells the model when it is running in that mode, so it hedges and re-queries instead of concluding it has nothing.

If you change embedding model, update **both** `EMBEDDING_DIM` and the `vector(N)` column width in [db/migrations/001_init.sql](db/migrations/001_init.sql). The embedder raises on a width mismatch rather than letting Postgres reject every insert.

## Backends

```bash
npm run chat -- --list-providers                              # what's available and configured
npm run chat -- client@x.com                                  # AGENT_PROVIDER default
npm run chat -- client@x.com --provider=openai                # override per session
```

`AGENT_PROVIDER` sets the default; `--provider=` overrides it for one session. Point two sessions at the same client with different backends to compare them against identical stored memory.

**Everything that matters is shared.** Retrieval, storage, the per-client boundary, and the six tools are defined once ([src/agent/tools.ts](src/agent/tools.ts)) and translated per provider ([src/providers/toolBridge.ts](src/providers/toolBridge.ts)). Each backend implements one method, `runTurn`, and owns its own tool loop.

| Backend | Streams | System channel for memories | Gives up |
|---|---|---|---|
| `claude` | yes | yes | — (reference: adaptive thinking + `effort`, explicit prompt cache, refusal fallback) |
| `openai` | no | yes | effort control; caching is automatic and unreported per-request |
| `gemini` | no | **no** | the system channel — see below |
| `mistral` | no | yes | cache reporting |
| `ollama` | no | yes | nothing to a server: runs locally, free. Tool-calling quality varies by model |

Two consequences worth understanding before you pick one:

**Gemini has no system role inside a conversation** — `systemInstruction` exists only at the top level. Retrieved memories therefore travel inside the client's own turn, fenced by explicit delimiters ([`foldContextIntoUserTurn`](src/providers/toolBridge.ts)). That is genuinely weaker than a system message: a client who types something resembling those delimiters is writing into the same channel the record arrives on. Prefer Claude or OpenAI where that matters.

**Only Claude guarantees schema-valid tool arguments.** Every other backend's arguments are parsed and validated against the Zod schema before `run` is reached, and a validation failure goes back to the model as a correctable tool result rather than throwing ([`executeTool`](src/providers/toolBridge.ts)). Without that, a malformed call would take down the turn.

**The non-Claude adapters are not streamed.** The whole reply arrives through `onText` at once. Accumulating tool-call argument deltas is the fiddly part of streaming and none of it could be exercised here; the interface already supports it, so adding it is a local change inside one adapter.

## Layout

| Path | What it is |
|---|---|
| [db/migrations/001_init.sql](db/migrations/001_init.sql) | Schema: clients, conversations, messages, memories, pending confirmations, escalations |
| [src/providers/types.ts](src/providers/types.ts) | The `ChatProvider` contract and the neutral tool/message types |
| [src/providers/toolBridge.ts](src/providers/toolBridge.ts) | Zod → per-dialect JSON Schema, validated tool execution, context folding |
| [src/providers/*.ts](src/providers/) | One adapter per backend; each owns its tool loop |
| [src/config.ts](src/config.ts) | Environment parsing, validated at import |
| [src/db.ts](src/db.ts) | Connection pool, transaction helper, pgvector literal encoding |
| [src/embeddings.ts](src/embeddings.ts) | `Embedder` interface + Voyage implementation + disabled fallback |
| [src/memory/store.ts](src/memory/store.ts) | All persistence and retrieval. Every function is client-scoped |
| [src/agent/systemPrompt.ts](src/agent/systemPrompt.ts) | The frozen, cacheable instruction block |
| [src/agent/tools.ts](src/agent/tools.ts) | The six tools, built per session |
| [src/agent/agent.ts](src/agent/agent.ts) | `AgentSession`: one turn = persist, retrieve, inject, run, persist |
| [src/cli.ts](src/cli.ts) | Interactive REPL for talking to a client's session |

## Tools available to the model

| Tool | Purpose |
|---|---|
| `recall_client_memory` | Hybrid search over this client's history. Returns an explicit "you do not know this" on no match |
| `remember_client_fact` | Write a durable fact, optionally superseding an earlier one |
| `list_pending_confirmations` | Open loops carried over from earlier sessions |
| `record_pending_confirmation` | Register a new open loop |
| `resolve_pending_confirmation` | Close one, with the outcome |
| `escalate_to_human` | File a handoff with a summary a colleague can pick up cold, and flag the conversation |

## Model configuration

These apply to the `claude` backend. The others take a model id and nothing else — see `.env.example`.

- **Model:** `claude-opus-5`, with adaptive thinking (`thinking: { type: "adaptive" }`).
- **Effort:** `AGENT_EFFORT`, default `high` (the API default). Effort is the cost lever for conversational traffic — `medium` and `low` are often indistinguishable on routine chat turns and cost meaningfully less. Measure on real transcripts before lowering it.
- **Refusal fallbacks are enabled.** A policy decline would otherwise just stop the turn; instead the same request is re-run on `claude-opus-4-8` inside the same call. A decline before any output isn't billed. Remove the `betas` / `fallbacks` pair in [src/agent/agent.ts](src/agent/agent.ts) to opt out.
- **Streaming** is on, so the CLI shows the reply as it is generated.
- `usage.cache_read_input_tokens` is printed after every turn. If it stays at zero across turns, something volatile has crept into the system prefix or the tool list.

## Things to know before extending it

- **History is replayed as text.** [`loadRecentTurns`](src/memory/store.ts) flattens stored turns to text and drops tool, thinking, and injected-context blocks. Those blocks only need to round-trip *within* the turn that produced them, which the tool runner handles in memory; replaying a `tool_use` whose result fell outside the history window would be rejected by the API. The full blocks are kept in `messages.content` for audit.
- **History is a fixed window** (`HISTORY_TURNS`), not compaction. Long-lived context is meant to live in `memories`, not in an ever-growing transcript. If you do want server-side compaction, it is a beta on the same endpoint and would need to coexist with the tool-runner beta.
- **`FTS_CONFIG` must match the migration.** The `content_tsv` generated column hardcodes its dictionary, because a generated column cannot read a runtime setting. Changing one without the other silently stops queries matching the index.
- **The HNSW index is deliberate.** `ivfflat` needs rows present at `CREATE INDEX` time, which a fresh migration does not have.

## Support

If this saved you some time, you can [buy me a coffee](https://buymeacoffee.com/skilldev31). Entirely optional — issues and pull requests are just as welcome.
