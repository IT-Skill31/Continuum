/** Thin client for src/server.ts. Errors carry the server's stable code. */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(code);
  }
}

export interface ProviderOption {
  id: string;
  label: string;
  model: string;
  /** False when credentials are missing, or for Ollama, when it isn't running. */
  available: boolean;
}

export interface ServerConfig {
  authMode: "token" | "open";
  retrieval: "hybrid" | "text";
  providers: ProviderOption[];
  defaultProvider: string | null;
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

export interface OpenedSession {
  sessionId: string;
  client: { externalId: string; displayName: string | null };
  resumed: boolean;
  provider: string;
  streams: boolean;
  history: TranscriptTurn[];
}

export type Credentials =
  | { token: string }
  | { externalId: string; displayName?: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  } catch {
    throw new ApiError("network");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? "generic", res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const getConfig = () => request<ServerConfig>("/api/config");

export const openSession = (credentials: Credentials, provider?: string | null) =>
  request<OpenedSession>("/api/sessions", {
    method: "POST",
    body: JSON.stringify(provider ? { ...credentials, provider } : credentials),
  });

export const closeSession = (sessionId: string) =>
  request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  }).catch(() => undefined);

export interface TurnOutcome {
  text: string;
  escalated: boolean;
}

/**
 * Sends one message and reads the server-sent-event stream back. EventSource
 * can't POST, so the stream is parsed by hand: events are separated by a blank
 * line, each with one `event:` and one `data:` line.
 */
export async function sendMessage(
  sessionId: string,
  text: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<TurnOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new ApiError("network");
  }

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? "generic", res.status);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let outcome: TurnOutcome | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let event = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;

        if (event === "delta") onDelta(String(payload.text ?? ""));
        else if (event === "done") {
          outcome = {
            text: String(payload.text ?? ""),
            escalated: Boolean(payload.escalated),
          };
        } else if (event === "error") {
          throw new ApiError(String(payload.code ?? "generic"));
        }
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("network");
  }

  if (!outcome) throw new ApiError("network");
  return outcome;
}
