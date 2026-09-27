import OpenAI from "openai";
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

/**
 * OpenAI Chat Completions with function calling, driven by a manual loop.
 *
 * Not streamed: accumulating tool-call argument deltas by index is the fiddly
 * part of OpenAI streaming, and none of it could be exercised here. The whole
 * reply arrives at once through `onText`. See README -> "Ce que chaque
 * fournisseur abandonne".
 */
export class OpenAIProvider implements ChatProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI (GPT)";
  readonly supportsMidConversationSystem = true;
  readonly streams = false;

  private readonly client: OpenAI;

  constructor(
    readonly model: string,
    apiKey: string,
    baseURL?: string,
  ) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: request.systemPrompt },
      ...request.history.map((turn) =>
        turn.role === "user"
          ? ({ role: "user", content: turn.content } as const)
          : ({ role: "assistant", content: turn.content } as const),
      ),
    ];

    if (request.history.length === 0) {
      messages.push({ role: "user", content: request.userMessage });
    }

    if (request.injectedContext) {
      // OpenAI accepts a system message anywhere in the array, so the retrieved
      // record stays on the system channel rather than inside the client's turn.
      messages.push({ role: "system", content: request.injectedContext });
    }

    const tools: OpenAI.Chat.ChatCompletionTool[] = request.tools.map((def) => ({
      type: "function",
      function: {
        name: def.name,
        description: def.description,
        parameters: toJsonSchema(def, "json-schema"),
      },
    }));

    let toolCalls = 0;
    let usage: ProviderTurnResult["usage"] = null;
    let stopReason = "unknown";
    let text = "";
    let raw: unknown = null;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools,
        max_completion_tokens: 8192,
      });

      raw = response;
      const choice = response.choices[0];
      if (!choice) throw new Error("OpenAI returned no choices.");

      if (response.usage) {
        usage = {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          cachedInputTokens:
            response.usage.prompt_tokens_details?.cached_tokens ?? null,
        };
      }

      const message = choice.message;
      const pendingCalls = message.tool_calls ?? [];

      if (pendingCalls.length === 0) {
        text = (message.content ?? "").trim();
        stopReason = normaliseFinishReason(choice.finish_reason);
        if (text && request.onText) request.onText(text);
        return { text, stopReason, usage, toolCalls, raw };
      }

      messages.push(message);

      for (const call of pendingCalls) {
        // Only function calls carry a name/arguments pair; anything else (a
        // built-in tool type) is not ours to execute.
        if (call.type !== "function") {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Error: unsupported tool call type "${call.type}".`,
          });
          continue;
        }

        toolCalls += 1;
        const def = findTool(request.tools, call.function.name);
        const outcome = def
          ? await executeTool(def, call.function.arguments)
          : { content: unknownToolMessage(call.function.name, request.tools) };

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: outcome.content,
        });
      }
    }

    return { text, stopReason: "tool_limit", usage, toolCalls, raw };
  }
}

function normaliseFinishReason(reason: string | null): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return reason ?? "unknown";
  }
}

export function createOpenAIProvider(model: string, apiKey: string, baseURL?: string): ChatProvider {
  if (!apiKey) {
    throw new ProviderConfigError(
      "openai",
      "OPENAI_API_KEY is not set. Add it to .env, or pick another provider.",
    );
  }
  return new OpenAIProvider(model, apiKey, baseURL);
}
