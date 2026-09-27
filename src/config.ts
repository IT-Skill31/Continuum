import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}".`);
  }
  return parsed;
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

function effort(): Effort {
  const raw = process.env.AGENT_EFFORT ?? "high";
  if (!(EFFORT_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(
      `AGENT_EFFORT must be one of ${EFFORT_LEVELS.join(" | ")}, got "${raw}".`,
    );
  }
  return raw as Effort;
}

const PROVIDER_IDS = ["claude", "openai", "gemini", "mistral", "ollama"] as const;
export type ConfiguredProviderId = (typeof PROVIDER_IDS)[number];

function defaultProvider(): ConfiguredProviderId {
  const raw = process.env.AGENT_PROVIDER ?? "claude";
  if (!(PROVIDER_IDS as readonly string[]).includes(raw)) {
    throw new Error(
      `AGENT_PROVIDER must be one of ${PROVIDER_IDS.join(" | ")}, got "${raw}".`,
    );
  }
  return raw as ConfiguredProviderId;
}

export const config = {
  /** Claude API key is optional here: the SDK also resolves an `ant auth login` profile. */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? undefined,
  model: process.env.AGENT_MODEL ?? "claude-opus-5",
  effort: effort(),

  /** Default LLM backend; overridable per session with --provider=. */
  provider: defaultProvider(),

  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  /** Set to point the OpenAI client at a compatible gateway (Azure, proxy). */
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "",

  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-pro",

  mistralApiKey: process.env.MISTRAL_API_KEY ?? "",
  mistralModel: process.env.MISTRAL_MODEL ?? "mistral-large-latest",

  ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1",

  databaseUrl: required("DATABASE_URL"),
  pgSslMode: process.env.PGSSLMODE ?? "",

  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "voyage-3.5",
  embeddingDim: int("EMBEDDING_DIM", 1024),

  ftsConfig: process.env.FTS_CONFIG ?? "simple",
  recallLimit: int("RECALL_LIMIT", 8),
  historyTurns: int("HISTORY_TURNS", 12),
} as const;

export const embeddingsEnabled = config.voyageApiKey.length > 0;
