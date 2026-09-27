import { z } from "zod";
import { defineTool, type AgentToolDef } from "../providers/types.js";
import { MEMORY_KINDS } from "../types.js";
import {
  listPendingConfirmations,
  recallMemories,
  recordEscalation,
  recordPendingConfirmation,
  resolvePendingConfirmation,
  saveMemory,
} from "../memory/store.js";

export interface SessionScope {
  clientId: string;
  conversationId: string;
  /** Called when the model escalates, so the caller can route the handoff. */
  onEscalate?: (escalation: {
    id: string;
    category: string;
    reason: string;
    summary: string;
  }) => void;
}

const KIND_ENUM = z.enum(MEMORY_KINDS);

/**
 * Tools are built per session and close over the client id. The model never
 * supplies a client identifier, so it has no way to express a query that
 * reaches another client's data -- the boundary is structural, not instructed.
 */
export function buildTools(scope: SessionScope): AgentToolDef[] {
  const recall = defineTool({
    name: "recall_client_memory",
    description:
      "Search this client's stored history for anything relevant to a topic: past requests, stated preferences, decisions, and details they shared. Use it whenever the client's message touches something they may have told you before. Returns an empty list when nothing is stored, which means you do not know -- say so rather than guessing.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "What you are looking for, phrased as the client would have said it (e.g. 'delivery address', 'preferred contact time', 'the pricing decision from last month').",
        ),
      kinds: z
        .array(KIND_ENUM)
        .optional()
        .describe("Restrict to these memory kinds. Omit to search all."),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    run: async (input) => {
      const memories = await recallMemories({
        clientId: scope.clientId,
        query: input.query,
        ...(input.kinds ? { kinds: input.kinds } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });

      if (memories.length === 0) {
        return "No stored memory matches that. You do not have this information — ask the client for it.";
      }

      return memories
        .map(
          (memory) =>
            `[${memory.id}] (${memory.kind}, importance ${memory.importance}, ` +
            `recorded ${memory.createdAt.toISOString().slice(0, 10)}) ${memory.content}`,
        )
        .join("\n");
    },
  });

  const remember = defineTool({
    name: "remember_client_fact",
    description:
      "Store something durable the client just told you, so it is available in future conversations. Call this as soon as the information arrives, not at the end of the conversation. Do not store small talk, or anything you inferred rather than were told.",
    schema: z.object({
      kind: KIND_ENUM.describe(
        "preference: how they want things done. request: something they asked for. decision: a choice they made. fact: a durable detail about them or their situation. contact: how to reach them.",
      ),
      content: z
        .string()
        .min(3)
        .describe(
          "One self-contained sentence, written so it still makes sense read cold in six months. Include the specifics, not a pointer to this conversation.",
        ),
      importance: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("1 incidental, 3 normal, 5 shapes every future interaction."),
      supersedes_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "The id of the memory this replaces, taken from a recall_client_memory result. Use it whenever the client changes something they told you before.",
        ),
    }),
    run: async (input) => {
      const { id, embedded } = await saveMemory({
        clientId: scope.clientId,
        kind: input.kind,
        content: input.content,
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
        ...(input.supersedes_id ? { supersedesId: input.supersedes_id } : {}),
      });
      return embedded
        ? `Stored as ${id}.`
        : `Stored as ${id} (text-search only: no embedding provider configured).`;
    },
  });

  const listPending = defineTool({
    name: "list_pending_confirmations",
    description:
      "List everything this client still owes you an answer on, or that you promised to come back to. Check this when resuming a conversation.",
    schema: z.object({}),
    run: async () => {
      const pending = await listPendingConfirmations(scope.clientId);
      if (pending.length === 0) return "Nothing pending for this client.";
      return pending
        .map(
          (item) =>
            `[${item.id}] opened ${item.createdAt.toISOString().slice(0, 10)}: ${item.description}`,
        )
        .join("\n");
    },
  });

  const recordPending = defineTool({
    name: "record_pending_confirmation",
    description:
      "Record an open loop: something awaiting the client's decision, or a follow-up you committed to. Use it so the item survives to the next conversation.",
    schema: z.object({
      description: z
        .string()
        .min(3)
        .describe("What is outstanding, and who owes the next move."),
    }),
    run: async (input) => {
      const id = await recordPendingConfirmation({
        clientId: scope.clientId,
        conversationId: scope.conversationId,
        description: input.description,
      });
      return `Recorded as ${id}.`;
    },
  });

  const resolvePending = defineTool({
    name: "resolve_pending_confirmation",
    description:
      "Close an open loop once the client has answered, or once it no longer applies.",
    schema: z.object({
      id: z.string().uuid().describe("From list_pending_confirmations."),
      status: z.enum(["confirmed", "declined", "cancelled"]),
      outcome: z.string().optional().describe("What was decided, in one line."),
    }),
    run: async (input) => {
      const updated = await resolvePendingConfirmation({
        clientId: scope.clientId,
        id: input.id,
        status: input.status,
        ...(input.outcome ? { outcome: input.outcome } : {}),
      });
      return updated
        ? `Marked ${input.id} as ${input.status}.`
        : `No pending item ${input.id} for this client — it may already be resolved.`;
    },
  });

  const escalate = defineTool({
    name: "escalate_to_human",
    description:
      "Hand the conversation to a qualified person. Use it when the request needs human judgment (technical work beyond your reach, legal questions, sensitive financial matters) or when the client asks for a person. After calling this, tell the client plainly that you are handing off and what happens next.",
    schema: z.object({
      category: z.enum([
        "technical",
        "legal",
        "financial",
        "client_request",
        "other",
      ]),
      reason: z.string().describe("Why this needs a human, in one line."),
      summary: z
        .string()
        .describe(
          "Context the colleague needs to pick this up cold: what the client wants, what has already been established, and what is blocked.",
        ),
    }),
    run: async (input) => {
      const id = await recordEscalation({
        clientId: scope.clientId,
        conversationId: scope.conversationId,
        category: input.category,
        reason: input.reason,
        summary: input.summary,
      });
      scope.onEscalate?.({
        id,
        category: input.category,
        reason: input.reason,
        summary: input.summary,
      });
      return `Escalation ${id} filed and the conversation is flagged for handoff. Tell the client you are passing this to a colleague.`;
    },
  });

  // Order is stable across requests so the tool block stays cacheable.
  return [
    recall,
    remember,
    listPending,
    recordPending,
    resolvePending,
    escalate,
  ];
}
