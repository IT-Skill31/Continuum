import { embedder } from "../embeddings.js";
import {
  appendMessage,
  findOrCreateClient,
  listPendingConfirmations,
  loadClientProfile,
  loadRecentTurns,
  openConversation,
  recallMemories,
} from "../memory/store.js";
import { createProvider } from "../providers/index.js";
import type {
  ChatProvider,
  NeutralMessage,
  ProviderId,
  ProviderUsage,
} from "../providers/types.js";
import type { Client, Conversation, RecalledMemory } from "../types.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { buildTools, type SessionScope } from "./tools.js";

export interface TurnResult {
  text: string;
  escalated: boolean;
  /** Memories injected before the model ran, for logging and debugging. */
  injected: RecalledMemory[];
  usage: ProviderUsage | null;
  stopReason: string;
  toolCalls: number;
}

export interface SessionOptions {
  /** Streams assistant text where the provider supports it. */
  onText?: (delta: string) => void;
  /** Overrides AGENT_PROVIDER for this session. */
  provider?: ProviderId;
  displayName?: string;
}

/**
 * One client, one conversation, one LLM backend. Construct with
 * `AgentSession.open(externalId)`.
 *
 * The memory layer is provider-agnostic: retrieval, storage and the client
 * boundary work identically whichever backend is selected. Only the transport
 * and the channel used to carry retrieved memories differ -- see src/providers.
 */
export class AgentSession {
  private constructor(
    readonly provider: ChatProvider,
    readonly client: Client,
    readonly conversation: Conversation,
    readonly resumed: boolean,
    private readonly options: SessionOptions,
  ) {}

  static async open(
    externalId: string,
    options: SessionOptions = {},
  ): Promise<AgentSession> {
    const client = await findOrCreateClient(externalId, options.displayName);
    const { conversation, resumed } = await openConversation(client.id);
    const provider = createProvider(options.provider);

    return new AgentSession(provider, client, conversation, resumed, options);
  }

  /** What the agent already knows before the client says anything this session. */
  async openingContext(): Promise<{
    profile: RecalledMemory[];
    pending: Awaited<ReturnType<typeof listPendingConfirmations>>;
  }> {
    const [profile, pending] = await Promise.all([
      loadClientProfile(this.client.id),
      listPendingConfirmations(this.client.id),
    ]);
    return { profile, pending };
  }

  async send(userMessage: string): Promise<TurnResult> {
    await appendMessage({
      conversationId: this.conversation.id,
      role: "user",
      content: [{ type: "text", text: userMessage }],
      text: userMessage,
    });

    // Includes the turn just stored, so it is not appended again below.
    const history = (await loadRecentTurns(
      this.conversation.id,
    )) as NeutralMessage[];

    const contextBlock = await this.buildContextBlock(userMessage);
    const injected = contextBlock?.memories ?? [];

    if (contextBlock) {
      await appendMessage({
        conversationId: this.conversation.id,
        role: "system",
        content: [{ type: "text", text: contextBlock.text }],
        text: null, // excluded from replay; kept for audit only
      });
    }

    let escalated = false;
    const scope: SessionScope = {
      clientId: this.client.id,
      conversationId: this.conversation.id,
      onEscalate: () => {
        escalated = true;
      },
    };

    const result = await this.provider.runTurn({
      systemPrompt: SYSTEM_PROMPT,
      history,
      userMessage,
      injectedContext: contextBlock?.text ?? null,
      tools: buildTools(scope),
      ...(this.options.onText ? { onText: this.options.onText } : {}),
    });

    await appendMessage({
      conversationId: this.conversation.id,
      role: "assistant",
      content: result.raw,
      text: result.text,
      usage: {
        provider: this.provider.id,
        model: this.provider.model,
        ...result.usage,
      },
    });

    return {
      text: this.describeStop(result.stopReason, result.text),
      escalated,
      injected,
      usage: result.usage,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
    };
  }

  /**
   * Assembles the retrieval payload for one turn: the client's standing profile
   * and open loops, plus memories relevant to what they just said. Returns null
   * when there is genuinely nothing stored, so an empty store never injects a
   * block implying otherwise.
   *
   * The profile and the open loops are re-sent on *every* turn, not just the
   * first. They have to be: loadRecentTurns deliberately drops injected context
   * from the replayed history, so anything sent once is gone by the next turn --
   * which made the agent state it did not know something it had been told one
   * turn earlier. The block sits after the cached prefix, so re-sending it
   * costs a few tokens and does not disturb the prompt cache.
   */
  private async buildContextBlock(
    userMessage: string,
  ): Promise<{ text: string; memories: RecalledMemory[] } | null> {
    const [relevant, profile, pending] = await Promise.all([
      recallMemories({ clientId: this.client.id, query: userMessage }),
      loadClientProfile(this.client.id),
      listPendingConfirmations(this.client.id),
    ]);

    const seen = new Set<string>();
    const memories: RecalledMemory[] = [];
    for (const memory of [...profile, ...relevant]) {
      if (seen.has(memory.id)) continue;
      seen.add(memory.id);
      memories.push(memory);
    }

    if (memories.length === 0 && pending.length === 0) return null;

    const sections: string[] = [
      "Retrieved from this client's record. Treat it as established fact; anything not here, you do not know.",
    ];

    if (memories.length > 0) {
      sections.push(
        "Known about this client:\n" +
          memories
            .map(
              (memory) =>
                `- [${memory.id}] (${memory.kind}) ${memory.content}` +
                ` — recorded ${memory.createdAt.toISOString().slice(0, 10)}`,
            )
            .join("\n"),
      );
    }

    if (pending.length > 0) {
      sections.push(
        "Still open from earlier:\n" +
          pending.map((item) => `- [${item.id}] ${item.description}`).join("\n"),
      );
    }

    if (!embedder.enabled) {
      sections.push(
        "(Retrieval ran on keyword search only — a relevant memory worded differently may have been missed. Use recall_client_memory with alternative phrasings before concluding you have nothing.)",
      );
    }

    return { text: sections.join("\n\n"), memories };
  }

  /** Turns a non-normal stop reason into something the client can be told. */
  private describeStop(stopReason: string, text: string): string {
    switch (stopReason) {
      case "refusal":
        return (
          text ||
          "I'm not able to help with that one, and I'd rather hand it to a colleague than guess. Would you like me to pass it on?"
        );
      case "max_tokens":
        return `${text}\n\n[Reply was cut off at the length limit.]`;
      case "tool_limit":
        return (
          text ||
          "I got stuck working through that — let me hand it to a colleague rather than keep you waiting."
        );
      default:
        return (
          text ||
          "Something went wrong on my side before I could answer — could you send that again?"
        );
    }
  }
}
