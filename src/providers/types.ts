import type { z } from "zod";

export const PROVIDER_IDS = [
  "claude",
  "openai",
  "gemini",
  "mistral",
  "ollama",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * A tool, defined once and translated per provider. The Zod schema is the
 * single source of truth: Claude gets it through the SDK's Zod helper, the
 * others get a JSON Schema derived from it, and every provider validates
 * arguments against it before `run` is called.
 */
export interface AgentToolDef<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: Schema;
  /**
   * Declared with method syntax deliberately: that makes the parameter
   * bivariant, so a tool with a concrete schema is assignable to
   * `AgentToolDef[]`. Property syntax would be rejected under
   * strictFunctionTypes.
   */
  run(input: z.output<Schema>): Promise<string>;
}

/** Preserves schema inference inside `run` while still producing an `AgentToolDef`. */
export function defineTool<Schema extends z.ZodType>(
  def: AgentToolDef<Schema>,
): AgentToolDef<Schema> {
  return def;
}

/** Provider-neutral conversation turn. Text only -- see loadRecentTurns. */
export interface NeutralMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProviderTurnRequest {
  /** Frozen instructions. Identical on every request, so it can be cached. */
  systemPrompt: string;
  /** Replayed history, oldest first, already trimmed to start on a user turn. */
  history: NeutralMessage[];
  /** What the client just said. Already included as the last item of `history`. */
  userMessage: string;
  /** Retrieved memories for this turn, or null when there is nothing stored. */
  injectedContext: string | null;
  tools: AgentToolDef[];
  /** Called with text fragments by providers that stream. */
  onText?: (delta: string) => void;
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Tokens served from the provider's prompt cache, where it reports them. */
  cachedInputTokens: number | null;
}

export interface ProviderTurnResult {
  text: string;
  /** Normalised: "end_turn" | "max_tokens" | "refusal" | "tool_limit" | "unknown". */
  stopReason: string;
  usage: ProviderUsage | null;
  /** Number of tool executions during the turn, for logging. */
  toolCalls: number;
  /** The provider's final response object, persisted for audit. */
  raw: unknown;
}

export interface ChatProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;

  /**
   * Whether the provider accepts a system/developer message *inside* the
   * conversation. When false, retrieved memories have to be folded into the
   * user turn instead, which is weaker -- see the note in README.
   */
  readonly supportsMidConversationSystem: boolean;

  /** Whether `onText` will be called incrementally. */
  readonly streams: boolean;

  runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult>;
}

/** Raised when a provider is selected but its credentials are missing. */
export class ProviderConfigError extends Error {
  constructor(
    readonly providerId: ProviderId,
    message: string,
  ) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export const MAX_TOOL_ITERATIONS = 8;
