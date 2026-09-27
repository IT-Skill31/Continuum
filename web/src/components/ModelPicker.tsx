import type { ProviderOption } from "../api";
import { useI18n } from "../i18n";

interface ModelPickerProps {
  providers: ProviderOption[];
  value: string | null;
  disabled?: boolean;
  onChange: (provider: string) => void;
}

/**
 * Chooses the LLM backend. Switching keeps the conversation and the client's
 * memories -- those live in Postgres, shared by every backend.
 */
export function ModelPicker({ providers, value, disabled, onChange }: ModelPickerProps) {
  const { t } = useI18n();

  return (
    <label className="model">
      <span className="sr-only">{t("model.label")}</span>
      <svg className="model__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"
          fill="currentColor"
        />
      </svg>
      <select
        className="model__select"
        value={value ?? ""}
        disabled={disabled}
        title={t("model.label")}
        onChange={(event) => onChange(event.target.value)}
      >
        {value === null && <option value="">{t("model.none")}</option>}
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id} disabled={!provider.available}>
            {provider.label} · {provider.model}
            {provider.available ? "" : ` (${t("model.unavailable")})`}
          </option>
        ))}
      </select>
    </label>
  );
}
