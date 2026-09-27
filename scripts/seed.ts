/**
 * Seeds one demo client with a plausible history, so continuity is observable
 * on the very first `npm run chat` instead of after a long warm-up.
 *
 * Idempotent: re-running reuses the client and skips memories already stored
 * verbatim.
 */
import { closePool, describeDbError, pool } from "../src/db.js";
import { embedder } from "../src/embeddings.js";
import {
  findOrCreateClient,
  recordPendingConfirmation,
  openConversation,
  saveMemory,
} from "../src/memory/store.js";
import type { MemoryKind } from "../src/types.js";

const DEMO_EXTERNAL_ID = "demo.client@example.com";

const MEMORIES: Array<{
  kind: MemoryKind;
  content: string;
  importance: number;
}> = [
  {
    kind: "contact",
    content:
      "Prefers to be contacted by email at demo.client@example.com; asked not to be phoned during working hours.",
    importance: 5,
  },
  {
    kind: "preference",
    content:
      "Wants written summaries kept short — bullet points over prose, and no attachments unless asked.",
    importance: 4,
  },
  {
    kind: "request",
    content:
      "Asked for a quote to migrate their internal reporting dashboard off a legacy Excel process, sometime in Q1.",
    importance: 4,
  },
  {
    kind: "decision",
    content:
      "Chose the monthly billing plan over annual in order to keep the first-year commitment low.",
    importance: 3,
  },
  {
    kind: "fact",
    content:
      "Team of six; the client is the only person on it with database access, which is why rollouts have to be scheduled around their availability.",
    importance: 4,
  },
];

async function main(): Promise<void> {
  const client = await findOrCreateClient(DEMO_EXTERNAL_ID, "Demo Client");
  console.log(`Client ${client.externalId} -> ${client.id}`);

  const { rows } = await pool.query<{ content: string }>(
    "SELECT content FROM memories WHERE client_id = $1",
    [client.id],
  );
  const existing = new Set(rows.map((row) => row.content));

  let added = 0;
  for (const memory of MEMORIES) {
    if (existing.has(memory.content)) continue;
    await saveMemory({ clientId: client.id, ...memory });
    added += 1;
  }

  const pending = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pending_confirmations WHERE client_id = $1",
    [client.id],
  );
  if (pending.rows[0]?.count === "0") {
    const { conversation } = await openConversation(client.id);
    await recordPendingConfirmation({
      clientId: client.id,
      conversationId: conversation.id,
      description:
        "Client still has to confirm which two weeks in March work for the dashboard migration window.",
    });
    console.log("Recorded 1 pending confirmation.");
  }

  console.log(
    `Stored ${added} new memory row(s)` +
      (embedder.enabled
        ? " with embeddings."
        : " without embeddings (no VOYAGE_API_KEY — recall will use full-text search)."),
  );
  console.log(`\nTry it:  npm run chat -- ${DEMO_EXTERNAL_ID}`);
}

main()
  .catch((error: unknown) => {
    console.error(
      describeDbError(error) ?? (error instanceof Error ? error.message : error),
    );
    process.exitCode = 1;
  })
  .finally(closePool);
