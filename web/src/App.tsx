import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  closeSession,
  getConfig,
  openSession,
  sendMessage,
  type Credentials,
  type OpenedSession,
  type ServerConfig,
} from "./api";
import { Chat } from "./components/Chat";
import { Header } from "./components/Header";
import { Login } from "./components/Login";
import { ModelPicker } from "./components/ModelPicker";
import { errorMessage, useI18n } from "./i18n";

/**
 * Credentials live in sessionStorage (this tab only), not the server session
 * id: server sessions are in memory and vanish on restart or idle timeout, and
 * re-opening with the same credentials resumes the same conversation anyway.
 */
const CREDENTIALS_KEY = "continuum.credentials";

function loadCredentials(): Credentials | null {
  try {
    const raw = sessionStorage.getItem(CREDENTIALS_KEY);
    return raw ? (JSON.parse(raw) as Credentials) : null;
  } catch {
    return null;
  }
}

function saveCredentials(credentials: Credentials | null): void {
  try {
    if (credentials) sessionStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
    else sessionStorage.removeItem(CREDENTIALS_KEY);
  } catch {
    // storage blocked: a refresh will simply ask again
  }
}

/** Takes ?token= from the URL and removes it, so it doesn't linger in history. */
function takeTokenFromUrl(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return null;
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  return token;
}

type State =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "login"; busy: boolean; error: string | null }
  | { kind: "chat"; session: OpenedSession };

const PROVIDER_KEY = "continuum.provider";

function loadProvider(): string | null {
  try {
    return localStorage.getItem(PROVIDER_KEY);
  } catch {
    return null;
  }
}

function saveProvider(provider: string): void {
  try {
    localStorage.setItem(PROVIDER_KEY, provider);
  } catch {
    // not remembered; the choice still applies to this visit
  }
}

/** The remembered choice if the server can still serve it, else the server's default. */
function pickProvider(serverConfig: ServerConfig): string | null {
  const remembered = loadProvider();
  const usable = serverConfig.providers.some((p) => p.id === remembered && p.available);
  return usable ? remembered : serverConfig.defaultProvider;
}

export function App() {
  const { t } = useI18n();
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [provider, setProvider] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const credentialsRef = useRef<Credentials | null>(null);
  const sessionRef = useRef<OpenedSession | null>(null);
  const providerRef = useRef<string | null>(null);

  const connect = useCallback(async (credentials: Credentials) => {
    setState({ kind: "login", busy: true, error: null });
    try {
      const session = await openSession(credentials, providerRef.current);
      credentialsRef.current = credentials;
      sessionRef.current = session;
      saveCredentials(credentials);
      setState({ kind: "chat", session });
    } catch (error) {
      saveCredentials(null);
      const code = error instanceof ApiError ? error.code : "generic";
      setState({ kind: "login", busy: false, error: code });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((serverConfig) => {
        if (cancelled) return;
        setConfig(serverConfig);
        const initial = pickProvider(serverConfig);
        providerRef.current = initial;
        setProvider(initial);
        const token = takeTokenFromUrl();
        const credentials = token ? { token } : loadCredentials();
        if (credentials) void connect(credentials);
        else setState({ kind: "login", busy: false, error: null });
      })
      .catch(() => !cancelled && setState({ kind: "unavailable" }));
    return () => {
      cancelled = true;
    };
  }, [connect]);

  /**
   * Changes backend. Mid-chat this opens a new session on the same client: the
   * conversation resumes with its history and memories, now answered by the
   * chosen model.
   */
  const changeProvider = useCallback(async (next: string) => {
    const previous = providerRef.current;
    providerRef.current = next;
    setProvider(next);
    setNotice(null);

    const credentials = credentialsRef.current;
    const current = sessionRef.current;
    if (!credentials || !current) {
      saveProvider(next);
      return;
    }

    setSwitching(true);
    try {
      const session = await openSession(credentials, next);
      void closeSession(current.sessionId);
      sessionRef.current = session;
      saveProvider(next);
      setState({ kind: "chat", session });
    } catch (error) {
      providerRef.current = previous;
      setProvider(previous);
      setNotice(errorMessage(t, error instanceof ApiError ? error.code : "generic"));
    } finally {
      setSwitching(false);
    }
  }, [t]);

  /** Sends a turn; if the server forgot the session, reopens it once and resends. */
  const send = useCallback(async (text: string, onDelta: (delta: string) => void) => {
    const session = sessionRef.current;
    if (!session) throw new ApiError("session_expired");
    try {
      return await sendMessage(session.sessionId, text, onDelta);
    } catch (error) {
      const credentials = credentialsRef.current;
      if (!(error instanceof ApiError) || error.code !== "session_expired" || !credentials) {
        throw error;
      }
      const reopened = await openSession(credentials, providerRef.current);
      sessionRef.current = reopened;
      return sendMessage(reopened.sessionId, text, onDelta);
    }
  }, []);

  const signOut = useCallback(() => {
    if (sessionRef.current) void closeSession(sessionRef.current.sessionId);
    sessionRef.current = null;
    credentialsRef.current = null;
    saveCredentials(null);
    setNotice(null);
    setState({ kind: "login", busy: false, error: null });
  }, []);

  const picker = config && (
    <ModelPicker
      providers={config.providers}
      value={provider}
      disabled={switching || (state.kind === "login" && state.busy)}
      onChange={(next) => void changeProvider(next)}
    />
  );

  const noticeBar = notice && (
    <p className="alert alert--error notice" role="alert">{notice}</p>
  );

  if (state.kind === "chat") {
    const client = state.session.client;
    return (
      <div className="app">
        <Header
          clientLabel={client.displayName ?? client.externalId}
          onSignOut={signOut}
          picker={picker}
        />
        {noticeBar}
        {/* Keyed by session so a model switch reloads the transcript cleanly. */}
        <Chat key={state.session.sessionId} session={state.session} send={send} />
      </div>
    );
  }

  return (
    <div className="app">
      <Header picker={picker} />
      {noticeBar}
      {state.kind === "loading" && <div className="center" aria-busy="true"><span className="spinner" /></div>}
      {state.kind === "unavailable" && (
        <div className="center">
          <p className="alert alert--error" role="alert">{t("error.service_unavailable")}</p>
        </div>
      )}
      {state.kind === "login" && config && (
        <Login
          authMode={config.authMode}
          busy={state.busy}
          error={state.error ? errorMessage(t, state.error) : null}
          onSubmit={(credentials) => void connect(credentials)}
        />
      )}
    </div>
  );
}
