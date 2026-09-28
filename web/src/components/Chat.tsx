import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import { ApiError, type OpenedSession, type TurnOutcome } from "../api";
import { errorMessage, useI18n } from "../i18n";

const MAX_CHARS = 4000;

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "done" | "streaming" | "error";
  /** For a failed user message: the error code, and the text to resend. */
  error?: string;
}

interface ChatProps {
  session: OpenedSession;
  send: (text: string, onDelta: (delta: string) => void) => Promise<TurnOutcome>;
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

let nextId = 0;
const newId = () => `m${++nextId}`;

export function Chat({ session, send }: ChatProps) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [escalated, setEscalated] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);

  const history = session.history;
  const name = session.client.displayName;
  const greeting = t(session.resumed ? "chat.greetingBack" : "chat.greetingNew", {
    name: name ? ` ${name}` : "",
  });

  // Follow the conversation as it streams, unless the client scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending, history]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Grow the textarea with its content, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const submit = async (raw: string, retryOf?: string) => {
    const text = raw.trim();
    if (!text || pending || text.length > MAX_CHARS) return;

    const userId = retryOf ?? newId();
    const replyId = newId();
    stickToBottom.current = true;
    setPending(true);
    if (!retryOf) setDraft("");

    setMessages((current) => [
      ...(retryOf
        ? current.map((m) =>
            m.id === retryOf ? { ...m, status: "done" as const, error: undefined } : m,
          )
        : [...current, { id: userId, role: "user" as const, text, status: "done" as const }]),
    ]);

    let started = false;
    try {
      const outcome = await send(text, (delta) => {
        setMessages((current) => {
          if (!started) {
            started = true;
            return [...current, { id: replyId, role: "assistant", text: delta, status: "streaming" }];
          }
          return current.map((m) => (m.id === replyId ? { ...m, text: m.text + delta } : m));
        });
      });

      // The final text is authoritative: the server may have replaced a
      // truncated or refused reply with an explanation.
      setMessages((current) => {
        const exists = current.some((m) => m.id === replyId);
        const reply: ChatMessage = { id: replyId, role: "assistant", text: outcome.text, status: "done" };
        return exists ? current.map((m) => (m.id === replyId ? reply : m)) : [...current, reply];
      });
      if (outcome.escalated) setEscalated(true);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "generic";
      setMessages((current) =>
        current
          .filter((m) => m.id !== replyId)
          .map((m) => (m.id === userId ? { ...m, status: "error" as const, error: code } : m)),
      );
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit(draft);
    }
  };

  const waitingForFirstToken =
    pending && messages[messages.length - 1]?.role !== "assistant";
  const showSuggestions = history.length === 0 && messages.length === 0;
  const overLimit = draft.length > MAX_CHARS;
  const nearLimit = draft.length > MAX_CHARS * 0.9;

  return (
    <main className="chat">
      <div className="chat__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat__log" role="log" aria-live="polite" aria-relevant="additions">
          {history.length > 0 && (
            <>
              {history.map((turn, index) => (
                <Bubble key={`h${index}`} role={turn.role} text={turn.text} muted />
              ))}
              <div className="divider" role="separator">
                <span>{t("chat.resumed")}</span>
              </div>
            </>
          )}

          <Bubble role="assistant" text={greeting} />

          {showSuggestions && (
            <div className="suggestions">
              <p className="suggestions__title">{t("chat.suggestionsTitle")}</p>
              <div className="suggestions__list">
                {(["chat.suggestion1", "chat.suggestion2", "chat.suggestion3"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="chip"
                    disabled={pending}
                    onClick={() => void submit(t(key))}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <div key={message.id}>
              <Bubble
                role={message.role}
                text={message.text}
                streaming={message.status === "streaming"}
                failed={message.status === "error"}
              />
              {message.status === "error" && (
                <div className="bubble-error" role="alert">
                  <span>{errorMessage(t, message.error ?? "generic")}</span>
                  <button
                    type="button"
                    className="button button--link"
                    disabled={pending}
                    onClick={() => void submit(message.text, message.id)}
                  >
                    {t("chat.retry")}
                  </button>
                </div>
              )}
            </div>
          ))}

          {waitingForFirstToken && (
            <div className="row row--assistant">
              <div className="bubble bubble--assistant typing" aria-label={t("chat.thinking")}>
                <span />
                <span />
                <span />
              </div>
            </div>
          )}

          {escalated && (
            <p className="alert alert--info" role="status">
              {t("chat.escalated")}
            </p>
          )}
        </div>
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(draft);
        }}
      >
        <div className="composer__box">
          <textarea
            ref={inputRef}
            className="composer__input"
            rows={1}
            dir="auto"
            value={draft}
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="submit"
            className="composer__send"
            disabled={pending || !draft.trim() || overLimit}
            aria-label={t("chat.send")}
            title={t("chat.send")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 12l16-8-6 16-2.5-6.5L4 12z" fill="currentColor" />
            </svg>
          </button>
        </div>
        <div className="composer__meta">
          <span>{t("chat.hint")}</span>
          {nearLimit && (
            <span className={overLimit ? "composer__count composer__count--over" : "composer__count"}>
              {t("chat.tooLong", { count: draft.length, max: MAX_CHARS })}
            </span>
          )}
        </div>
      </form>
    </main>
  );
}

interface BubbleProps {
  role: "user" | "assistant";
  text: string;
  muted?: boolean;
  streaming?: boolean;
  failed?: boolean;
}

function Bubble({ role, text, muted, streaming, failed }: BubbleProps) {
  const { t } = useI18n();
  const classes = [
    "bubble",
    `bubble--${role}`,
    muted && "bubble--muted",
    streaming && "bubble--streaming",
    failed && "bubble--failed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`row row--${role}`}>
      <div className={classes}>
        <span className="sr-only">{role === "user" ? t("chat.you") : t("chat.assistant")}: </span>
        {role === "assistant" ? (
          // react-markdown renders no raw HTML, so model output cannot inject markup.
          <div className="markdown" dir="auto">
            <Markdown components={MARKDOWN_COMPONENTS}>{text}</Markdown>
          </div>
        ) : (
          <p className="plain" dir="auto">{text}</p>
        )}
      </div>
    </div>
  );
}
