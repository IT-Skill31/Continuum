import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <path
        d="M9 16a7 7 0 0 1 12-4.9M23 16a7 7 0 0 1-12 4.9"
        fill="none"
        stroke="var(--on-accent)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface HeaderProps {
  clientLabel?: string | undefined;
  onSignOut?: (() => void) | undefined;
  picker?: ReactNode;
}

export function Header({ clientLabel, onSignOut, picker }: HeaderProps) {
  const { t } = useI18n();

  return (
    <header className="header">
      <div className="header__brand">
        <Logo />
        <span className="header__name">Continuum</span>
      </div>
      <div className="header__actions">
        {clientLabel && (
          <span className="header__client" title={clientLabel}>
            {clientLabel}
          </span>
        )}
        {picker}
        <LanguageSwitcher />
        {onSignOut && (
          <button type="button" className="button button--ghost" onClick={onSignOut}>
            {t("chat.signOut")}
          </button>
        )}
      </div>
    </header>
  );
}
