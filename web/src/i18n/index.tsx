import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ar } from "./ar";
import { en, type MessageKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";

/**
 * Interface strings only. The assistant's replies are not translated here: the
 * system prompt tells the model to answer in whatever language the client
 * writes in, whichever UI language is selected.
 */
export const LOCALES = [
  { code: "en", label: "English", dir: "ltr" },
  { code: "fr", label: "Français", dir: "ltr" },
  { code: "es", label: "Español", dir: "ltr" },
  { code: "ar", label: "العربية", dir: "rtl" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en, fr, es, ar };
const STORAGE_KEY = "continuum.locale";

function isLocale(value: string | null | undefined): value is Locale {
  return LOCALES.some((locale) => locale.code === value);
}

const DEFAULT_LOCALE: Locale = "en";

/** English unless this device has already picked another language. */
function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // storage blocked: use the default
  }
  return DEFAULT_LOCALE;
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir =
      LOCALES.find((option) => option.code === locale)?.dir ?? "ltr";
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // not persisted; the choice still applies for this visit
    }
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => {
      const template = DICTIONARIES[locale][key] ?? en[key];
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in vars ? String(vars[name]) : match,
      );
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>.");
  return value;
}

/** Maps an API error code to a translated sentence. */
export function errorMessage(t: Translate, code: string): string {
  const key = `error.${code}` as MessageKey;
  return key in en ? t(key) : t("error.generic");
}
