import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import {
  executeTool,
  findTool,
  foldContextIntoUserTurn,
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
 * Google Gemini via `@google/genai`.
 *
 * The important difference from every other provider here: `systemInstruction`
 * exists only at the top level, so there is no system channel *inside* the
 * conversation. Retrieved memories therefore ride in the client's own turn,
 * fenced by explicit delimiters. That is genuinely weaker -- a client who types
 * something resembling those delimiters is writing into the same channel the
 * record arrives on. Prefer Claude or OpenAI when that matters.
 */
export class GeminiProvider implements ChatProvider {
  readonly id = "gemini" as const;
  readonly label = "Google Gemini";
  readonly supportsMidConversationSystem = false;
  readonly streams = false;

  private readonly client: GoogleGenAI;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
    const contents: Content[] = request.history.map((turn) => ({
      role: turn.role === "user" ? "user" : "model",
      parts: [{ text: turn.content }],
    }));

    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: request.userMessage }] });
    }

    // No mid-conversation system role: rewrite the final user turn to carry the
    // retrieved record alongside the client's words.
    if (request.injectedContext) {
      const last = contents.at(-1);
      if (last?.role === "user") {
        last.parts = [
          {
            text: foldContextIntoUserTurn(
              request.userMessage,
              request.injectedContext,
            ),
          },
        ];
      }
    }

    const functionDeclarations: FunctionDeclaration[] = request.tools.map(
      (def) => ({
        name: def.name,
        description: def.description,
        // Gemini takes an OpenAPI subset, not full JSON Schema.
        parametersJsonSchema: toJsonSchema(def, "openapi-subset"),
      }),
    );

    let toolCalls = 0;
    let usage: ProviderTurnResult["usage"] = null;
    let raw: unknown = null;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: request.systemPrompt,
          tools: [{ functionDeclarations }],
          maxOutputTokens: 8192,
        },
      });

      raw = response;

      if (response.usageMetadata) {
        usage = {
          inputTokens: response.usageMetadata.promptTokenCount ?? null,
          outputTokens: response.usageMetadata.candidatesTokenCount ?? null,
          cachedInputTokens:
            response.usageMetadata.cachedContentTokenCount ?? null,
        };
      }

      const calls = response.functionCalls ?? [];

      if (calls.length === 0) {
        const text = (response.text ?? "").trim();
        if (text && request.onText) request.onText(text);
        return {
          text,
          stopReason: normaliseFinishReason(
            response.candidates?.[0]?.finishReason,
          ),
          usage,
          toolCalls,
          raw,
        };
      }

      // Echo the model's own call parts back before answering them.
      contents.push({
        role: "model",
        parts: calls.map((call) => ({ functionCall: call })),
      });

      const responseParts: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        toolCalls += 1;
        const def = findTool(request.tools, name);
        const outcome = def
          ? await executeTool(def, call.args ?? {})
          : { content: unknownToolMessage(name, request.tools) };

        responseParts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name,
            response: { output: outcome.content },
          },
        });
      }

      contents.push({ role: "user", parts: responseParts });
    }

    return { text: "", stopReason: "tool_limit", usage, toolCalls, raw };
  }
}

function normaliseFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return "refusal";
    default:
      return reason ?? "unknown";
  }
}

export function createGeminiProvider(model: string, apiKey: string): ChatProvider {
  if (!apiKey) {
    throw new ProviderConfigError(
      "gemini",
      "GEMINI_API_KEY is not set. Add it to .env, or pick another provider.",
    );
  }
  return new GeminiProvider(model, apiKey);
}
