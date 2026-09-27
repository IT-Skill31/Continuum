import { Mistral } from "@mistralai/mistralai";
import {
  executeTool,
  findTool,
  toJsonSchema,
  unknownToolMessage,
} from "./toolBridge.js";
import {
  MAX_TOOL_ITERATIONS,
  ProviderConfigError,
  type ChatProvider,
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from "./types.js";

type MistralMessages = Parameters<
  Mistral["chat"]["complete"]
>[0]["messages"];

/**
 * Mistral via the official SDK. Accepts a system message inside the
 * conversation, so the retrieved record stays on the system channel.
 *
 * Relevant if your clients are in the EU and you want inference hosted there.
 */
export class MistralProvider implements ChatProvider {
  readonly id = "mistral" as const;
  readonly label = "Mistral";
  readonly supportsMidConversationSystem = true;
  readonly streams = false;

  private readonly client: Mistral;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.client = new Mistral({ apiKey });
  }

  async runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
    const messages: MistralMessages = [
      { role: "system", content: request.systemPrompt },
      ...request.history.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
    ];

    if (request.history.length === 0) {
      messages.push({ role: "user", content: request.userMessage });
    }

    if (request.injectedContext) {
      messages.push({ role: "system", content: request.injectedContext });
    }

    const tools = request.tools.map((def) => ({
      type: "function" as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: toJsonSchema(def, "json-schema"),
      },
    }));

    let toolCalls = 0;
    let usage: ProviderTurnResult["usage"] = null;
    let raw: unknown = null;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const response = await this.client.chat.complete({
        model: this.model,
        messages,
        tools,
        toolChoice: "auto",
        maxTokens: 8192,
      });

      raw = response;

      if (response.usage) {
        usage = {
          inputTokens: response.usage.promptTokens ?? null,
          outputTokens: response.usage.completionTokens ?? null,
          cachedInputTokens: null, // not reported by the API
        };
      }

      const choice = response.choices?.[0];
      if (!choice) throw new Error("Mistral returned no choices.");

      const message = choice.message;
      if (!message) throw new Error("Mistral returned a choice with no message.");
      const pendingCalls = message.toolCalls ?? [];

      if (pendingCalls.length === 0) {
        const text = flattenContent(message.content).trim();
        if (text && request.onText) request.onText(text);
        return {
          text,
          stopReason: normaliseFinishReason(choice.finishReason),
          usage,
          toolCalls,
          raw,
        };
      }

      messages.push({
        role: "assistant",
        content: flattenContent(message.content),
        toolCalls: pendingCalls,
      });

      for (const call of pendingCalls) {
        toolCalls += 1;
        const name = call.function.name;
        const def = findTool(request.tools, name);
        // The SDK types `arguments` as string | object depending on the model.
        const outcome = def
          ? await executeTool(def, call.function.arguments)
          : { content: unknownToolMessage(name, request.tools) };

        messages.push({
          role: "tool",
          name,
          ...(call.id ? { toolCallId: call.id } : {}),
          content: outcome.content,
        });
      }
    }

    return { text: "", stopReason: "tool_limit", usage, toolCalls, raw };
  }
}

/** Mistral content may be a plain string or an array of typed chunks. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "text" in chunk) {
        const text = (chunk as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

function normaliseFinishReason(reason: string | undefined | null): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
    case "model_length":
      return "max_tokens";
    default:
      return reason ?? "unknown";
  }
}

export function createMistralProvider(model: string, apiKey: string): ChatProvider {
  if (!apiKey) {
    throw new ProviderConfigError(
      "mistral",
      "MISTRAL_API_KEY is not set. Add it to .env, or pick another provider.",
    );
  }
  return new MistralProvider(model, apiKey);
}
