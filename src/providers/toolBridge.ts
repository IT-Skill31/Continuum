import { z } from "zod";
import type { AgentToolDef } from "./types.js";

/**
 * Translates the shared tool definitions into each provider's dialect, and
 * gives every provider the same safe execution path: parse the model's
 * arguments against the Zod schema first, and hand a validation failure back
 * to the model as a tool result instead of throwing.
 *
 * Only Claude guarantees schema-valid tool arguments, so this validation is
 * what keeps the other providers from reaching `run` with the wrong shape.
 */

export type JsonSchemaObject = Record<string, unknown>;

/** Keys Gemini's Schema type rejects outright. */
const GEMINI_ALLOWED_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
]);

export function toJsonSchema(
  def: AgentToolDef,
  dialect: "openapi-subset" | "json-schema",
): JsonSchemaObject {
  const schema = z.toJSONSchema(def.schema, { io: "input" }) as JsonSchemaObject;
  delete schema["$schema"];

  if (dialect === "openapi-subset") {
    return pruneToGeminiSubset(schema);
  }

  // Providers that accept plain JSON Schema still need a `properties` object
  // even for a no-argument tool, or the call is rejected as malformed.
  if (schema["type"] === "object" && schema["properties"] === undefined) {
    schema["properties"] = {};
  }
  return schema;
}

function pruneToGeminiSubset(node: unknown): JsonSchemaObject {
  if (Array.isArray(node) || node === null || typeof node !== "object") {
    return node as JsonSchemaObject;
  }

  const source = node as JsonSchemaObject;
  const output: JsonSchemaObject = {};

  for (const [key, value] of Object.entries(source)) {
    if (!GEMINI_ALLOWED_KEYS.has(key)) continue;

    if (key === "properties" && value && typeof value === "object") {
      const properties: JsonSchemaObject = {};
      for (const [name, sub] of Object.entries(value as JsonSchemaObject)) {
        properties[name] = pruneToGeminiSubset(sub);
      }
      output[key] = properties;
      continue;
    }

    if (key === "items") {
      output[key] = pruneToGeminiSubset(value);
      continue;
    }

    // Gemini has no integer JSON Schema type on this field; it takes a format.
    if (key === "type" && value === "integer") {
      output["type"] = "number";
      continue;
    }

    output[key] = value;
  }

  return output;
}

export interface ExecutionOutcome {
  /** Text handed back to the model as the tool result. */
  content: string;
  /** False when the arguments failed validation or `run` threw. */
  ok: boolean;
}

/**
 * Validates then runs a tool. Never throws: a provider loop that crashed on a
 * bad tool call would lose the whole turn, whereas an error returned as a tool
 * result lets the model correct itself.
 */
export async function executeTool(
  def: AgentToolDef,
  rawArguments: unknown,
): Promise<ExecutionOutcome> {
  let parsedArguments: unknown = rawArguments;

  if (typeof rawArguments === "string") {
    if (rawArguments.trim() === "") {
      parsedArguments = {};
    } else {
      try {
        parsedArguments = JSON.parse(rawArguments);
      } catch {
        return {
          ok: false,
          content: `Error: arguments for ${def.name} were not valid JSON. Call the tool again with a well-formed JSON object.`,
        };
      }
    }
  }

  const validated = def.schema.safeParse(parsedArguments ?? {});
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      content: `Error: arguments for ${def.name} did not match the schema (${issues}). Correct them and call the tool again.`,
    };
  }

  try {
    return { ok: true, content: await def.run(validated.data) };
  } catch (error) {
    // A failed tool must still produce a result, or the conversation stalls.
    return {
      ok: false,
      content: `Error: ${def.name} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function findTool(
  tools: AgentToolDef[],
  name: string,
): AgentToolDef | undefined {
  return tools.find((tool) => tool.name === name);
}

export function unknownToolMessage(name: string, tools: AgentToolDef[]): string {
  return `Error: no tool named "${name}". Available tools: ${tools
    .map((tool) => tool.name)
    .join(", ")}.`;
}

/**
 * Used by providers that cannot carry a system message inside the conversation
 * (Gemini). The delimiters matter: without them, injected memories and client
 * text are indistinguishable in the same turn.
 */
export function foldContextIntoUserTurn(
  userMessage: string,
  injectedContext: string,
): string {
  return [
    "<<<RETRIEVED_CLIENT_RECORD — system-supplied, not written by the client>>>",
    injectedContext,
    "<<<END_RETRIEVED_CLIENT_RECORD>>>",
    "",
    "Message from the client:",
    userMessage,
  ].join("\n");
}
