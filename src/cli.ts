/**
 * Continuum — interactive client conversation.
 *
 *   npm run chat -- <client-identifier> [--provider=claude|openai|gemini|mistral|ollama]
 *   npm run chat -- --list-providers
 *   npm run chat -- --about
 *
 * The identifier is whatever you key clients by — email, CRM id, session
 * number. Run it twice with the same identifier to see memory carry over; run
 * it twice with different --provider values to compare backends against the
 * same stored memory.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import { AgentSession } from "./agent/agent.js";
import { APP, banner } from "./app.js";
import { config } from "./config.js";
import { closePool, describeDbError } from "./db.js";
import { embedder } from "./embeddings.js";
import {
  describeAuthError,
  describeProviders,
  parseProviderArgument,
  ProviderConfigError,
  type ProviderId,
} from "./providers/index.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

interface Args {
  externalId?: string;
  provider?: ProviderId;
  listProviders: boolean;
  about: boolean;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { listProviders: false, about: false };

  for (const arg of argv) {
    if (arg === "--list-providers") {
      result.listProviders = true;
    } else if (arg === "--about" || arg === "--version") {
      result.about = true;
    } else if (arg.startsWith("--provider=")) {
      result.provider = parseProviderArgument(arg.slice("--provider=".length));
    } else if (!arg.startsWith("--") && !result.externalId) {
      result.externalId = arg;
    }
  }

  return result;
}

function printAbout(): void {
  console.log(`${BOLD}${APP.name}${RESET} v${APP.version}`);
  console.log(`${APP.tagline}.\n`);
  console.log(wrap(APP.description, 78));
  console.log(
    `\n${DIM}backend: ${config.provider} · retrieval: ${
      embedder.enabled ? "hybrid (vector + full-text)" : "full-text only"
    }${RESET}`,
  );
}

/** Wraps on word boundaries so the description stays readable in a terminal. */
function wrap(text: string, width: number): string {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

function printProviders(): void {
  console.log("Available LLM backends (default from AGENT_PROVIDER):\n");
  for (const provider of describeProviders()) {
    const mark = provider.configured ? "✓" : "·";
    const current = provider.id === config.provider ? " (default)" : "";
    console.log(
      `${mark} ${BOLD}${provider.id}${RESET}${current} — ${provider.label}`,
    );
    console.log(`    model: ${provider.model}`);
    console.log(
      `    system channel for retrieved memories: ${
        provider.systemChannel ? "yes" : "no — folded into the client turn"
      }`,
    );
    console.log(`    ${DIM}${provider.notes}${RESET}`);
    if (!provider.configured) {
      console.log(`    ${DIM}credentials not configured${RESET}`);
    }
    console.log();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.about) {
    printAbout();
    return;
  }

  if (args.listProviders) {
    printProviders();
    return;
  }

  if (!args.externalId) {
    console.error(
      `${APP.name} — ${APP.tagline}\n\n` +
        "Usage: npm run chat -- <client-identifier> [--provider=claude|openai|gemini|mistral|ollama]\n" +
        "       npm run chat -- --list-providers\n" +
        "       npm run chat -- --about",
    );
    process.exitCode = 1;
    return;
  }

  const session = await AgentSession.open(args.externalId, {
    onText: (delta) => stdout.write(delta),
    ...(args.provider ? { provider: args.provider } : {}),
  });

  const { profile, pending } = await session.openingContext();

  console.log(`${BOLD}${banner()}${RESET}`);
  console.log(
    `${DIM}client ${session.client.externalId} · conversation ${session.conversation.id.slice(0, 8)} ` +
      `· ${session.resumed ? "resumed" : "new"} · ${session.provider.id}/${session.provider.model} ` +
      `· retrieval ${embedder.enabled ? "hybrid" : "text-only"}${RESET}`,
  );
  if (!session.provider.supportsMidConversationSystem) {
    console.log(
      `${DIM}note: ${session.provider.label} has no system channel inside the conversation — ` +
        `retrieved memories travel in the client turn, fenced by delimiters.${RESET}`,
    );
  }
  if (!session.provider.streams) {
    console.log(
      `${DIM}note: ${session.provider.label} is not streamed here — replies arrive all at once.${RESET}`,
    );
  }
  console.log(
    `${DIM}${profile.length} memory item(s) and ${pending.length} open loop(s) on file. Ctrl+C to quit.${RESET}\n`,
  );

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      const userMessage = (await rl.question(`${BOLD}you ›${RESET} `)).trim();
      if (!userMessage) continue;
      if (["/quit", "/exit"].includes(userMessage)) break;

      stdout.write(`${BOLD}agent ›${RESET} `);
      try {
        const result = await session.send(userMessage);

        // onText already emitted the reply. Only print again when the stop
        // reason meant that text was not the whole story.
        if (result.stopReason !== "end_turn" && result.stopReason !== "tool_use") {
          stdout.write(`\n${result.text}`);
        }
        stdout.write("\n");

        const usage = result.usage;
        console.log(
          `${DIM}  ${result.injected.length} memory item(s) injected` +
            ` · ${result.toolCalls} tool call(s)` +
            (usage
              ? ` · in ${usage.inputTokens ?? "?"}` +
                (usage.cachedInputTokens !== null
                  ? ` (cached ${usage.cachedInputTokens})`
                  : "") +
                ` · out ${usage.outputTokens ?? "?"}`
              : "") +
            (result.escalated ? " · ESCALATED to a human" : "") +
            `${RESET}\n`,
        );
      } catch (error) {
        stdout.write("\n");
        console.error(`  ${describeError(error)}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

function describeError(error: unknown): string {
  if (error instanceof ProviderConfigError) return error.message;

  const dbProblem = describeDbError(error);
  if (dbProblem) return dbProblem;

  const authProblem = describeAuthError(error);
  if (authProblem) return authProblem;

  // Anthropic's typed errors only apply to the Claude path; other providers
  // surface their own classes, which fall through to the generic branches.
  if (error instanceof Anthropic.AuthenticationError) {
    return "Claude API rejected the credentials. Set ANTHROPIC_API_KEY, or run `ant auth login`.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited by the Claude API — wait a moment and try again.";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Claude API rejected the request: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Claude API — check the network.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Claude API error ${error.status}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

main()
  .catch((error: unknown) => {
    console.error(describeError(error));
    process.exitCode = 1;
  })
  .finally(closePool);
