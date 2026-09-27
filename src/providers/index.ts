import { config } from "../config.js";
import { createClaudeProvider } from "./claude.js";
import { createGeminiProvider } from "./gemini.js";
import { createMistralProvider } from "./mistral.js";
import { createOllamaProvider } from "./ollama.js";
import { createOpenAIProvider } from "./openai.js";
import {
  PROVIDER_IDS,
  isProviderId,
  type ChatProvider,
  type ProviderId,
} from "./types.js";

export {
  PROVIDER_IDS,
  isProviderId,
  ProviderConfigError,
  type ChatProvider,
  type ProviderId,
} from "./types.js";

export function createProvider(id: ProviderId = config.provider): ChatProvider {
  switch (id) {
    case "claude":
      return createClaudeProvider();
    case "openai":
      return createOpenAIProvider(
        config.openaiModel,
        config.openaiApiKey,
        config.openaiBaseUrl || undefined,
      );
    case "gemini":
      return createGeminiProvider(config.geminiModel, config.geminiApiKey);
    case "mistral":
      return createMistralProvider(config.mistralModel, config.mistralApiKey);
    case "ollama":
      return createOllamaProvider(config.ollamaModel, config.ollamaHost);
  }
}

export interface ProviderSummary {
  id: ProviderId;
  label: string;
  model: string;
  /** Whether credentials are present. Ollama needs none, so it is always true. */
  configured: boolean;
  /** Whether retrieved memories can stay on the system channel. */
  systemChannel: boolean;
  notes: string;
}

/**
 * Describes every backend without constructing a client, so `--list-providers`
 * works with no keys set.
 */
export function describeProviders(): ProviderSummary[] {
  return [
    {
      id: "claude",
      label: "Claude (Anthropic)",
      model: config.model,
      configured: Boolean(config.anthropicApiKey) || hasAntProfileHint(),
      systemChannel: true,
      notes:
        "Reference path: streaming, adaptive thinking + effort, explicit prompt cache, refusal fallback.",
    },
    {
      id: "openai",
      label: "OpenAI (GPT)",
      model: config.openaiModel,
      configured: Boolean(config.openaiApiKey),
      systemChannel: true,
      notes: "No streaming, no effort control, automatic prompt caching only.",
    },
    {
      id: "gemini",
      label: "Google Gemini",
      model: config.geminiModel,
      configured: Boolean(config.geminiApiKey),
      systemChannel: false,
      notes:
        "No system channel inside the conversation: retrieved memories ride in the client's turn, fenced by delimiters.",
    },
    {
      id: "mistral",
      label: "Mistral",
      model: config.mistralModel,
      configured: Boolean(config.mistralApiKey),
      systemChannel: true,
      notes: "No streaming, no cache reporting. EU hosting.",
    },
    {
      id: "ollama",
      label: "Ollama (local)",
      model: config.ollamaModel,
      configured: true,
      systemChannel: true,
      notes:
        "Free and offline; no client data leaves the machine. Tool-calling quality varies sharply by model.",
    },
  ];
}

/** The Anthropic SDK can also authenticate from a stored `ant auth login` profile. */
function hasAntProfileHint(): boolean {
  return Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

/**
 * Translates a provider SDK's authentication failure into a next step.
 *
 * Deliberately reactive rather than a pre-flight check: the Anthropic SDK also
 * authenticates from an `ant auth login` profile on disk, which no environment
 * variable reveals. Refusing to start on an empty ANTHROPIC_API_KEY would break
 * that setup, so we only intervene once the SDK itself has given up.
 */
export function describeAuthError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;

  const claudeMissingCredentials =
    /Could not resolve authentication method/i.test(error.message);
  const rejected =
    /invalid x-api-key|incorrect api key|api key not valid|401|unauthor/i.test(
      error.message,
    );

  if (!claudeMissingCredentials && !rejected) return null;

  const lines: string[] = [];

  if (claudeMissingCredentials) {
    lines.push(
      "No Claude credentials found. Either set ANTHROPIC_API_KEY in .env, or run `ant auth login`.",
    );
  } else {
    lines.push(`The provider rejected the credentials: ${error.message}`);
  }

  const alternatives = describeProviders().filter(
    (candidate) => candidate.configured && candidate.id !== config.provider,
  );

  if (alternatives.length > 0) {
    lines.push(
      "  Other backends with credentials present:",
      ...alternatives.map((candidate) => {
        // `configured` means "no missing credentials", which for Ollama is
        // trivially true -- it says nothing about a server being up.
        const caveat =
          candidate.id === "ollama" ? "  ← needs a local Ollama server" : "";
        return `    npm run chat -- <client> --provider=${candidate.id}   (${candidate.model})${caveat}`;
      }),
      "  Or set AGENT_PROVIDER in .env to make one of those the default.",
    );
  } else {
    lines.push("  `npm run chat -- --list-providers` shows every backend.");
  }

  return lines.join("\n");
}

export function parseProviderArgument(value: string): ProviderId {
  if (!isProviderId(value)) {
    throw new Error(
      `Unknown provider "${value}". Available: ${PROVIDER_IDS.join(", ")}.`,
    );
  }
  return value;
}
