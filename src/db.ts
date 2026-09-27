import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ...(config.pgSslMode === "require"
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
});

export type Queryable = Pick<pg.PoolClient, "query">;

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export async function withTransaction<T>(
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

/**
 * pgvector accepts vectors as a bracketed literal, which we cast in SQL with
 * `$n::vector`. Sending a JS array directly would be serialised as a Postgres
 * array and rejected.
 */
export function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Turns the driver's terse connection errors into something actionable.
 * `ENOTFOUND` in particular says nothing about the usual cause -- a managed
 * Postgres whose direct endpoint resolves to IPv6 only.
 */
export function describeDbError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;

  const code = (error as NodeJS.ErrnoException).code;
  const host = extractHost(error.message);

  if (code === "ENOTFOUND" || error.message.includes("ENOTFOUND")) {
    const lines = [`Database host could not be resolved${host ? `: ${host}` : "."}`];
    if (host?.startsWith("db.") && host.endsWith(".supabase.co")) {
      lines.push(
        "  Supabase direct endpoints are IPv6-only. On an IPv4 network this always fails.",
        "  Use the Session pooler instead — dashboard → Connect → Session pooler:",
        "    postgres://postgres.<ref>:PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres",
        "  Note the user becomes postgres.<ref>, not postgres.",
      );
    } else {
      lines.push(
        "  Check DATABASE_URL for a typo, and whether the instance is paused or still provisioning.",
        `  Verify with: Resolve-DnsName ${host ?? "<host>"} -Type A`,
      );
    }
    return lines.join("\n");
  }

  if (code === "ECONNREFUSED" || error.message.includes("ECONNREFUSED")) {
    return (
      `Nothing is accepting connections${host ? ` at ${host}` : ""}.\n` +
      "  Is PostgreSQL running, and is the port right?"
    );
  }

  if (code === "ETIMEDOUT" || error.message.includes("ETIMEDOUT")) {
    return (
      "Timed out reaching the database.\n" +
      "  Usually a firewall, or a managed instance that restricts inbound addresses."
    );
  }

  if (/self.signed certificate|SSL|certificate/i.test(error.message)) {
    return (
      "TLS handshake with the database failed.\n" +
      "  Managed Postgres requires TLS: set PGSSLMODE=require in .env."
    );
  }

  if (/password authentication failed/i.test(error.message)) {
    return (
      "The database rejected the credentials.\n" +
      "  On a Supabase pooler the user is postgres.<project-ref>, not postgres."
    );
  }

  if (/extension "vector" is not available|type "vector" does not exist/i.test(error.message)) {
    return (
      "pgvector is not available on this server.\n" +
      "  Enable it (Supabase: Database → Extensions → vector), or use a Postgres image that ships it."
    );
  }

  return null;
}

function extractHost(message: string): string | undefined {
  // node's getaddrinfo errors end with the hostname: "getaddrinfo ENOTFOUND db.x.co"
  const match = message.match(/(?:ENOTFOUND|ECONNREFUSED)\s+([^\s:]+)/);
  return match?.[1];
}
