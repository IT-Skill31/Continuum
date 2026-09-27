import { LOCALES, useI18n } from "../i18n";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="lang" role="radiogroup" aria-label={t("lang.label")}>
      {LOCALES.map((option) => (
        <button
          key={option.code}
          type="button"
          role="radio"
          aria-checked={locale === option.code}
          lang={option.code}
          title={option.label}
          className="lang__option"
          onClick={() => setLocale(option.code)}
        >
          {option.code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
