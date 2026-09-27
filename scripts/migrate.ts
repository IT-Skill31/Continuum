/**
 * Applies every .sql file in db/migrations in filename order, recording each in
 * a schema_migrations table so re-running is safe.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, describeDbError, pool } from "../src/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "db", "migrations");

async function main(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  const applied = new Set(rows.map((row) => row.filename));

  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const filename of files) {
    if (applied.has(filename)) {
      console.log(`  skip  ${filename} (already applied)`);
      continue;
    }

    const sql = await readFile(join(migrationsDir, filename), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [filename],
      );
      await client.query("COMMIT");
      console.log(`  ok    ${filename}`);
      count += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`  FAIL  ${filename}`);
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(
    count === 0 ? "Schema already up to date." : `Applied ${count} migration(s).`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      describeDbError(error) ?? (error instanceof Error ? error.message : error),
    );
    process.exitCode = 1;
  })
  .finally(closePool);
