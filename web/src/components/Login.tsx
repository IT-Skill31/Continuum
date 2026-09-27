import { useState, type FormEvent } from "react";
import type { Credentials } from "../api";
import { useI18n } from "../i18n";
import { Logo } from "./Header";

interface LoginProps {
  authMode: "token" | "open";
  busy: boolean;
  error: string | null;
  onSubmit: (credentials: Credentials) => void;
}

export function Login({ authMode, busy, error, onSubmit }: LoginProps) {
  const { t } = useI18n();
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = externalId.trim();
    if (!id || busy) return;
    const name = displayName.trim();
    onSubmit(name ? { externalId: id, displayName: name } : { externalId: id });
  };

  return (
    <main className="login">
      <section className="card login__card" aria-labelledby="login-title">
        <div className="login__logo">
          <Logo />
        </div>

        {authMode === "token" ? (
          <>
            <h1 id="login-title" className="login__title">
              {t("login.tokenTitle")}
            </h1>
            <p className="login__subtitle">{t("login.tokenBody")}</p>
            {error && (
              <p className="alert alert--error" role="alert">
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <h1 id="login-title" className="login__title">
              {t("login.title")}
            </h1>
            <p className="login__subtitle">{t("login.subtitle")}</p>

            <form className="form" onSubmit={submit} noValidate>
              <label className="field">
                <span className="field__label">{t("login.identifier")}</span>
                <input
                  className="field__input"
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  autoFocus
                  required
                  maxLength={200}
                  placeholder={t("login.identifierPlaceholder")}
                  value={externalId}
                  onChange={(event) => setExternalId(event.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">{t("login.name")}</span>
                <input
                  className="field__input"
                  type="text"
                  autoComplete="name"
                  maxLength={100}
                  placeholder={t("login.namePlaceholder")}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>

              {error && (
                <p className="alert alert--error" role="alert">
                  {error}
                </p>
              )}

              <button
                type="submit"
                className="button button--primary button--block"
                disabled={busy || !externalId.trim()}
              >
                {busy ? t("login.connecting") : t("login.submit")}
              </button>
            </form>

            <p className="login__notice">{t("login.devNotice")}</p>
          </>
        )}
      </section>
      <p className="login__tagline">{t("app.tagline")}</p>
    </main>
  );
}
