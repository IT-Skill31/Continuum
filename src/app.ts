/**
 * Application identity, in one place.
 *
 * Kept out of a package.json read on purpose: importing JSON at runtime would
 * tie these strings to the build layout, and they are shown to operators in the
 * CLI banner.
 */
export const APP = {
  name: "Continuum",
  /** Lowercase form for package names, database names and CLI usage lines. */
  slug: "continuum",
  version: "0.1.0",
  tagline: "Unbroken client context, session after session",
  description:
    "A client-facing conversational agent that remembers the people it talks to. " +
    "Conversation state and long-term client memory live in PostgreSQL; relevant " +
    "memories are retrieved per turn and injected into the request, so a client " +
    "never has to repeat something they already said.",
} as const;

/** One-line banner for the CLI and any operator-facing surface. */
export function banner(): string {
  return `${APP.name} v${APP.version} — ${APP.tagline}`;
}
