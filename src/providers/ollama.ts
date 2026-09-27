import {
  executeTool,
  findTool,
  toJsonSchema,
  unknownToolMessage,
} from "./toolBridge.js";
import {
  MAX_TOOL_ITERATIONS,
  type ChatProvider,
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from "./types.js";

/**
 * Local models through Ollama's HTTP API.
 *
 * Two reasons this one is worth having: no key and no cost for testing, and no
 * client data leaves the machine -- which can be the deciding factor when the
 * memory store holds personal details.
 *
 * Caveat: tool calling quality varies sharply by model. A model without solid
 * tool support will answer from the injected context but never call
 * `remember_client_fact`, so nothing new gets stored. Verify against your
 * chosen model before trusting it with real conversations.
 *
 * Spoken to over raw HTTP on purpose: this is Ollama's documented contract, and
 * it avoids a dependency for four fields.
 */

interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaProvider implements ChatProvider {
  readonly id = "ollama" as const;
  readonly label = "Ollama (local)";
  readonly supportsMidConversationSystem = true;
  readonly streams = false;

  constructor(
    readonly model: string,
    private readonly host: string,
  ) {}

  async runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
    const messages: OllamaMessage[] = [
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
      // Ollama passes a mid-conversation system message through, though whether
      // the model honours it depends on that model's chat template.
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
      const response = await this.post({ messages, tools });
      raw = response;

      if (response.error) {
        throw new Error(`Ollama error: ${response.error}`);
      }

      usage = {
        inputTokens: response.prompt_eval_count ?? null,
        outputTokens: response.eval_count ?? null,
        cachedInputTokens: null, // no prompt cache to report
      };

      const message = response.message;
      if (!message) throw new Error("Ollama returned no message.");

      const pendingCalls = message.tool_calls ?? [];

      if (pendingCalls.length === 0) {
        const text = (message.content ?? "").trim();
        if (text && request.onText) request.onText(text);
        return {
          text,
          stopReason: normaliseDoneReason(response.done_reason),
          usage,
          toolCalls,
          raw,
        };
      }

      messages.push({
        role: "assistant",
        content: message.content ?? "",
        tool_calls: pendingCalls,
      });

      for (const call of pendingCalls) {
        const name = call.function?.name ?? "";
        toolCalls += 1;
        const def = findTool(request.tools, name);
        const outcome = def
          ? await executeTool(def, call.function?.arguments ?? {})
          : { content: unknownToolMessage(name, request.tools) };

        // Ollama has no tool_call_id; it matches results by order and name.
        messages.push({ role: "tool", tool_name: name, content: outcome.content });
      }
    }

    return { text: "", stopReason: "tool_limit", usage, toolCalls, raw };
  }

  private async post(body: {
    messages: OllamaMessage[];
    tools: unknown[];
  }): Promise<OllamaChatResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, stream: false, ...body }),
      });
    } catch (error) {
      throw new Error(
        `Could not reach Ollama at ${this.host}. Is it running? ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 404) {
        throw new Error(
          `Ollama has no model "${this.model}". Pull it first: ollama pull ${this.model}`,
        );
      }
      throw new Error(
        `Ollama responded ${response.status}: ${text.slice(0, 300)}`,
      );
    }

    return (await response.json()) as OllamaChatResponse;
  }
}

function normaliseDoneReason(reason: string | undefined): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return reason ?? "unknown";
  }
}

export function createOllamaProvider(model: string, host: string): ChatProvider {
  // No key to check -- a wrong host surfaces as a connection error on first use.
  return new OllamaProvider(model, host.replace(/\/+$/, ""));
}
