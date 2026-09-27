import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { config } from "../config.js";
import {
  MAX_TOOL_ITERATIONS,
  ProviderConfigError,
  type ChatProvider,
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from "./types.js";

/**
 * The reference implementation. Claude is the only provider here with
 * mid-conversation system messages, adaptive thinking, explicit prompt-cache
 * control, and a refusal fallback -- the other adapters are deliberately
 * plainer, and the README lists what each one gives up.
 */
export class ClaudeProvider implements ChatProvider {
  readonly id = "claude" as const;
  readonly label = "Claude (Anthropic)";
  readonly supportsMidConversationSystem = true;
  readonly streams = true;

  private readonly client: Anthropic;

  constructor(readonly model: string = config.model) {
    this.client = new Anthropic(
      config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {},
    );
  }

  async runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
    const messages: Anthropic.Beta.BetaMessageParam[] = request.history.map(
      (turn) => ({ role: turn.role, content: turn.content }),
    );

    if (messages.length === 0) {
      messages.push({ role: "user", content: request.userMessage });
    }

    if (request.injectedContext) {
      // Carries operator authority and leaves the cached system prefix intact.
      // Must follow a user turn and be the last entry -- both hold here.
      messages.push({ role: "system", content: request.injectedContext });
    }

    const tools = request.tools.map((def) =>
      betaZodTool({
        name: def.name,
        description: def.description,
        inputSchema: def.schema,
        run: def.run,
      }),
    );

    const runner = this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 8192,
      max_iterations: MAX_TOOL_ITERATIONS,
      system: [
        {
          type: "text",
          text: request.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort: config.effort },
      betas: ["server-side-fallback-2026-06-01"],
      fallbacks: [{ model: "claude-opus-4-8" }],
      tools,
      messages,
      stream: true,
    });

    let finalMessage: Anthropic.Beta.BetaMessage | null = null;
    let toolCalls = 0;

    for await (const stream of runner) {
      if (request.onText) stream.on("text", request.onText);
      const message = await stream.finalMessage();
      finalMessage = message;

      toolCalls += message.content.filter(
        (block) => block.type === "tool_use",
      ).length;

      // The runner only continues after a client tool returns a result, so a
      // paused turn would otherwise end the loop with a truncated answer.
      if (message.stop_reason === "pause_turn") {
        runner.pushMessages({ role: "assistant", content: message.content });
      }
    }

    if (!finalMessage) {
      throw new Error("The Claude tool runner produced no message.");
    }

    return {
      text: extractText(finalMessage),
      stopReason: finalMessage.stop_reason ?? "unknown",
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
        cachedInputTokens: finalMessage.usage.cache_read_input_tokens ?? null,
      },
      toolCalls,
      raw: finalMessage.content,
    };
  }
}

function extractText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter(
      (block): block is Anthropic.Beta.BetaTextBlock => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function createClaudeProvider(): ChatProvider {
  // No credential check here, unlike the other providers: the SDK also resolves
  // an `ant auth login` profile, so an unset ANTHROPIC_API_KEY is not
  // necessarily an error. A genuine failure surfaces as a 401 on first call.
  if (!config.model) {
    throw new ProviderConfigError("claude", "AGENT_MODEL is empty.");
  }
  return new ClaudeProvider();
}
