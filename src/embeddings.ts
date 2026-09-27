import { config, embeddingsEnabled } from "./config.js";

/**
 * Anthropic does not serve an embeddings endpoint, so vectors come from a
 * separate provider. Everything downstream depends only on this interface --
 * swap the implementation to change providers.
 */
export interface Embedder {
  readonly enabled: boolean;
  readonly dimensions: number;
  /** `input_type` lets asymmetric models embed a question differently from a stored fact. */
  embed(texts: string[], inputType: "document" | "query"): Promise<number[][]>;
}

/** Used when no embedding key is configured; retrieval falls back to full-text search. */
class DisabledEmbedder implements Embedder {
  readonly enabled = false;
  readonly dimensions = config.embeddingDim;

  async embed(): Promise<number[][]> {
    return [];
  }
}

interface VoyageResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  detail?: string;
}

class VoyageEmbedder implements Embedder {
  readonly enabled = true;
  readonly dimensions = config.embeddingDim;

  async embed(
    texts: string[],
    inputType: "document" | "query",
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.voyageApiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: config.embeddingModel,
        input_type: inputType,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Embedding request failed (${response.status}): ${body.slice(0, 400)}`,
      );
    }

    const payload = (await response.json()) as VoyageResponse;
    const rows = payload.data;
    if (!rows || rows.length !== texts.length) {
      throw new Error(
        `Embedding provider returned ${rows?.length ?? 0} vectors for ${texts.length} inputs.`,
      );
    }

    // The API is documented to echo `index`; sort defensively so a reordered
    // response can never silently attach the wrong vector to the wrong text.
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    return ordered.map((row, i) => {
      const vector = row.embedding;
      if (!vector) {
        throw new Error(`Embedding provider returned no vector at index ${i}.`);
      }
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Embedding width mismatch: model "${config.embeddingModel}" returned ` +
            `${vector.length} dimensions but EMBEDDING_DIM is ${this.dimensions}. ` +
            `Update EMBEDDING_DIM and the vector(N) column in db/migrations/001_init.sql.`,
        );
      }
      return vector;
    });
  }
}

export const embedder: Embedder = embeddingsEnabled
  ? new VoyageEmbedder()
  : new DisabledEmbedder();

/** Convenience wrapper for the single-text case. Returns null when embeddings are off. */
export async function embedOne(
  text: string,
  inputType: "document" | "query",
): Promise<number[] | null> {
  if (!embedder.enabled) return null;
  const [vector] = await embedder.embed([text], inputType);
  return vector ?? null;
}
