/**
 * Mints a signed client token for the web client, for testing token mode.
 *
 *   npm run token -- <client-identifier> [--name="Jane Doe"] [--ttl=3600]
 *
 * In production your own site does this for a logged-in client (same format,
 * see src/webAuth.ts) and links them to  <chat-url>/?token=<token>.
 */
import "dotenv/config";
import { mintClientToken } from "../src/webAuth.js";

const secret = process.env.WEB_AUTH_SECRET ?? "";
if (!secret) {
  console.error("WEB_AUTH_SECRET is not set in .env.");
  process.exit(1);
}

let sub: string | undefined;
let name: string | undefined;
let ttl = 3600;

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--name=")) name = arg.slice("--name=".length);
  else if (arg.startsWith("--ttl=")) ttl = Number.parseInt(arg.slice("--ttl=".length), 10);
  else if (!arg.startsWith("--")) sub ??= arg;
}

if (!sub || !Number.isFinite(ttl) || ttl <= 0) {
  console.error('Usage: npm run token -- <client-identifier> [--name="Jane Doe"] [--ttl=3600]');
  process.exit(1);
}

const token = mintClientToken(
  { sub, ...(name ? { name } : {}), exp: Math.floor(Date.now() / 1000) + ttl },
  secret,
);

const port = process.env.WEB_PORT ?? "8787";
console.log(token);
console.log(`\ndev:  http://localhost:5173/?token=${token}`);
console.log(`prod: http://localhost:${port}/?token=${token}`);
