/**
 * Continuum — HTTP API for the web client.
 *
 *   npm run serve
 *
 * Endpoints:
 *   GET  /api/config                      auth mode, for the login screen
 *   POST /api/sessions                    open (or resume) a client session
 *   POST /api/sessions/:id/messages       send a message; replies as an SSE stream
 *   DELETE /api/sessions/:id              forget the session server-side
 *
 * Anything else is served from web/dist when it has been built, so production
 * is one process on one origin and needs no CORS.
 *
 * Sessions are held in memory: one AgentSession per browser tab, dropped after
 * WEB_SESSION_IDLE_MINUTES. Losing them on restart costs nothing -- the
 * conversation and the client's memories live in Postgres, and the web client
 * simply opens a new session, which resumes the same conversation.
 */
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "./agent/agent.js";
import { banner } from "./app.js";
import { config } from "./config.js";
import { closePool, describeDbError } from "./db.js";
import { embedder } from "./embeddings.js";
import { loadRecentTurns } from "./memory/store.js";
import {
  describeAuthError,
  describeProviders,
  isProviderId,
  ProviderConfigError,
  type ProviderId,
} from "./providers/index.js";
import { verifyClientToken } from "./webAuth.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_IDENTIFIER_CHARS = 200;
const TRANSCRIPT_TURNS = 50;

const authMode = config.webAuthSecret ? "token" : "open";

interface WebSession {
  agent: AgentSession;
  /** Where the current turn's streamed text goes; swapped per request. */
  sink: ((delta: string) => void) | null;
  busy: boolean;
  lastUsed: number;
}

const sessions = new Map<string, WebSession>();

// -------------------------------------------------------------- utilities --

class HttpError extends Error {
  constructor(
    readonly status: number,
    /** Stable code the web client translates; never an internal message. */
    readonly code: string,
  ) {
    super(code);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_json");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Logs the real cause server-side; the browser only ever gets a code. */
function classifyError(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  if (error instanceof ProviderConfigError) {
    console.error(error.message);
    return "provider_unavailable";
  }
  const db = describeDbError(error);
  if (db) {
    console.error(db);
    return "service_unavailable";
  }
  const auth = describeAuthError(error);
  if (auth) {
    console.error(auth);
    return "provider_unavailable";
  }
  console.error(error);
  return "internal_error";
}

// -------------------------------------------------------------- providers --

interface ProviderOption {
  id: ProviderId;
  label: string;
  model: string;
  available: boolean;
}

let ollamaProbe: { at: number; up: boolean } | null = null;

/**
 * "Configured" means credentials are present, which Ollama never needs -- so
 * for it, ask the local server whether it is actually running. Cached so the
 * config endpoint stays fast.
 */
async function ollamaIsUp(): Promise<boolean> {
  if (ollamaProbe && Date.now() - ollamaProbe.at < 30_000) return ollamaProbe.up;
  let up = false;
  try {
    const res = await fetch(new URL("/api/tags", config.ollamaHost), {
      signal: AbortSignal.timeout(1500),
    });
    up = res.ok;
  } catch {
    up = false;
  }
  ollamaProbe = { at: Date.now(), up };
  return up;
}

async function providerOptions(): Promise<ProviderOption[]> {
  const ollamaUp = await ollamaIsUp();
  return describeProviders().map((provider) => ({
    id: provider.id,
    label: provider.label,
    model: provider.model,
    available: provider.id === "ollama" ? ollamaUp : provider.configured,
  }));
}

/** AGENT_PROVIDER when it can actually answer, otherwise the first that can. */
function defaultProvider(options: ProviderOption[]): ProviderId | null {
  const preferred = options.find((o) => o.id === config.provider && o.available);
  return (preferred ?? options.find((o) => o.available))?.id ?? null;
}

// --------------------------------------------------------------- sessions --

function getSession(id: string | undefined): WebSession {
  const session = id ? sessions.get(id) : undefined;
  if (!session) throw new HttpError(404, "session_expired");
  session.lastUsed = Date.now();
  return session;
}

setInterval(() => {
  const cutoff = Date.now() - config.webSessionIdleMinutes * 60_000;
  for (const [id, session] of sessions) {
    if (!session.busy && session.lastUsed < cutoff) sessions.delete(id);
  }
}, 60_000).unref();

async function openSession(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson(req);

  let externalId: string | undefined;
  let displayName: string | undefined;

  if (authMode === "token") {
    const token = optionalString(body.token);
    const payload = token ? verifyClientToken(token, config.webAuthSecret) : null;
    if (!payload) throw new HttpError(401, "invalid_token");
    externalId = payload.sub.trim();
    displayName = payload.name?.trim() || undefined;
  } else {
    externalId = optionalString(body.externalId);
    displayName = optionalString(body.displayName);
    if (!externalId || externalId.length > MAX_IDENTIFIER_CHARS) {
      throw new HttpError(400, "invalid_identifier");
    }
  }

  // The browser may pick the backend, but only among those that can answer.
  const options = await providerOptions();
  const requested = optionalString(body.provider);
  let provider: ProviderId | null;
  if (requested) {
    if (!isProviderId(requested)) throw new HttpError(400, "invalid_provider");
    provider = options.find((o) => o.id === requested)?.available ? requested : null;
  } else {
    provider = defaultProvider(options);
  }
  if (!provider) throw new HttpError(503, "provider_unavailable");

  const holder: { session?: WebSession } = {};
  const agent = await AgentSession.open(externalId, {
    provider,
    onText: (delta) => holder.session?.sink?.(delta),
    ...(displayName ? { displayName: displayName.slice(0, 100) } : {}),
  });

  const session: WebSession = {
    agent,
    sink: null,
    busy: false,
    lastUsed: Date.now(),
  };
  holder.session = session;

  const id = randomBytes(24).toString("base64url");
  sessions.set(id, session);

  const transcript = agent.resumed
    ? await loadRecentTurns(agent.conversation.id, TRANSCRIPT_TURNS)
    : [];

  sendJson(res, 201, {
    sessionId: id,
    client: {
      externalId: agent.client.externalId,
      displayName: agent.client.displayName,
    },
    resumed: agent.resumed,
    provider: agent.provider.id,
    streams: agent.provider.streams,
    history: transcript.map((turn) => ({
      role: turn.role,
      text: typeof turn.content === "string" ? turn.content : "",
    })),
  });
}

async function postMessage(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string | undefined,
): Promise<void> {
  const session = getSession(sessionId);
  const body = await readJson(req);
  const text = optionalString(body.text);

  if (!text) throw new HttpError(400, "empty_message");
  if (text.length > MAX_MESSAGE_CHARS) throw new HttpError(413, "message_too_long");
  if (session.busy) throw new HttpError(409, "turn_in_progress");

  session.busy = true;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // keep reverse proxies from buffering the stream
  });

  const emit = (event: string, data: unknown): void => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  session.sink = (delta) => emit("delta", { text: delta });

  try {
    const result = await session.agent.send(text);
    emit("done", { text: result.text, escalated: result.escalated });
  } catch (error) {
    emit("error", { code: classifyError(error) });
  } finally {
    session.sink = null;
    session.busy = false;
    session.lastUsed = Date.now();
    res.end();
  }
}

// ------------------------------------------------------------ static files --

const webRoot = resolve(fileURLToPath(new URL("../web/dist", import.meta.url)));
const hasWebBuild = existsSync(join(webRoot, "index.html"));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function serveStatic(pathname: string, res: ServerResponse): void {
  if (!hasWebBuild) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  let target = resolve(webRoot, "." + normalize(decodeURIComponent(pathname)));
  if (target !== webRoot && !target.startsWith(webRoot + sep)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  // Single-page app: unknown paths get index.html.
  if (!existsSync(target) || statSync(target).isDirectory()) {
    target = join(webRoot, "index.html");
  }

  const immutable = target.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  createReadStream(target).pipe(res);
}

// ------------------------------------------------------------------ router --

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  const handle = async (): Promise<void> => {
    if (path === "/api/config" && method === "GET") {
      const providers = await providerOptions();
      sendJson(res, 200, {
        authMode,
        retrieval: embedder.enabled ? "hybrid" : "text",
        providers,
        defaultProvider: defaultProvider(providers),
      });
      return;
    }

    if (path === "/api/sessions" && method === "POST") {
      await openSession(req, res);
      return;
    }

    const match = /^\/api\/sessions\/([\w-]+)(\/messages)?$/.exec(path);
    if (match) {
      const [, id, messages] = match;
      if (messages && method === "POST") {
        await postMessage(req, res, id);
        return;
      }
      if (!messages && method === "DELETE") {
        if (id) sessions.delete(id);
        res.writeHead(204).end();
        return;
      }
    }

    if (path.startsWith("/api/")) throw new HttpError(404, "not_found");

    if (method === "GET" || method === "HEAD") {
      serveStatic(path, res);
      return;
    }
    throw new HttpError(405, "method_not_allowed");
  };

  handle().catch((error: unknown) => {
    const code = classifyError(error);
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(res, status, { error: code });
  });
});

if (authMode === "open" && !isLoopback(config.webHost)) {
  console.error(
    `Refusing to listen on ${config.webHost} without WEB_AUTH_SECRET.\n` +
      "In open mode anyone who can reach the server can open a session as any " +
      "client and read their memories. Set WEB_AUTH_SECRET (see README → Web " +
      "client), or bind to 127.0.0.1 for local testing.",
  );
  process.exit(1);
}

server.listen(config.webPort, config.webHost, () => {
  console.log(banner());
  console.log(
    `web API on http://${config.webHost}:${config.webPort} · auth ${authMode} · ` +
      `backend ${config.provider} · retrieval ${embedder.enabled ? "hybrid" : "text-only"}` +
      (hasWebBuild ? " · serving web/dist" : " · web/dist not built (use `npm run web:dev`)"),
  );
  if (authMode === "open") {
    console.log(
      "warning: open mode — the browser chooses which client it is. Local testing only.",
    );
  }
});

async function shutdown(): Promise<void> {
  server.close();
  await closePool();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
