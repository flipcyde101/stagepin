import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startDemoUpstreamSite } from "./demo/site.js";
import { startStagepinServer } from "./proxy/server.js";

export interface ParsedCliArgs {
  mode: "help" | "proxy" | "demo";
  upstream?: string;
  host: string;
  port: number;
  dbPath?: string;
  password?: string;
  githubTarget?: string;
}

function printHelp(): void {
  console.log(`stagepin v0.1.0 - Self-hosted Vercel Preview Comments for any site (zero-code reverse proxy)

Usage:
  stagepin --upstream <url> [options]   Proxy any local/staging site with Shadow DOM review pins
  stagepin --demo [options]             Launch built-in SaaS staging preview with seeded pins

Options:
  --upstream <url>                      Upstream HTTP/HTTPS URL (or env STAGEPIN_UPSTREAM)
  --host <addr>                         Bind host (default: 127.0.0.1; use 0.0.0.0 in Docker)
  --port <n>                            Listen port (default: 8080)
  --db <path>                           SQLite file path (default: ~/.stagepin/stagepin.db)
  --password <secret>                   Optional guest review password (or env STAGEPIN_PASSWORD)
  --github <owner/repo#pr>              Enable 1-click GitHub Issue/PR push (uses GITHUB_TOKEN)
  -h, --help                            Show this help`);
}

function requireVal(argv: string[], i: number, flag: string, allowLeadingDash = false): string {
  const v = argv[i + 1];
  if (v === undefined || (!allowLeadingDash && v.trim().startsWith("-"))) {
    throw new Error(`Missing value for ${flag}`);
  }
  return v;
}

function parsePort(raw: string, label: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${label} must be an integer 0..65535`);
  }
  const p = Number(raw.trim());
  if (!Number.isInteger(p) || p < 0 || p > 65535) {
    throw new Error(`${label} must be an integer 0..65535`);
  }
  return p;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCliArgs {
  const envPort = env.STAGEPIN_PORT?.trim();
  const parsed: ParsedCliArgs = {
    mode: "proxy",
    upstream: env.STAGEPIN_UPSTREAM?.trim() || undefined,
    host: env.STAGEPIN_HOST?.trim() || "127.0.0.1",
    port: envPort ? parsePort(envPort, "STAGEPIN_PORT") : 8080,
    dbPath: env.STAGEPIN_DB?.trim() || undefined,
    password: env.STAGEPIN_PASSWORD && env.STAGEPIN_PASSWORD.trim().length > 0 ? env.STAGEPIN_PASSWORD : undefined,
    githubTarget: env.STAGEPIN_GITHUB?.trim() || undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.mode = "help";
      return parsed;
    } else if (arg === "--demo") {
      parsed.mode = "demo";
    } else if (arg === "--upstream") {
      const val = requireVal(argv, i, "--upstream").trim();
      if (!val) throw new Error("--upstream cannot be empty");
      parsed.upstream = val;
      i++;
    } else if (arg === "--host") {
      const val = requireVal(argv, i, "--host").trim();
      if (!val) throw new Error("--host cannot be empty");
      parsed.host = val;
      i++;
    } else if (arg === "--port") {
      parsed.port = parsePort(requireVal(argv, i, "--port"), "--port");
      i++;
    } else if (arg === "--db") {
      const val = requireVal(argv, i, "--db").trim();
      if (!val) throw new Error("--db cannot be empty");
      parsed.dbPath = val;
      i++;
    } else if (arg === "--password") {
      const rawPw = requireVal(argv, i, "--password", true);
      if (rawPw.trim().length === 0) {
        throw new Error("--password cannot be empty or whitespace-only");
      }
      parsed.password = rawPw;
      i++;
    } else if (arg === "--github") {
      const val = requireVal(argv, i, "--github").trim();
      if (!val) throw new Error("--github cannot be empty");
      parsed.githubTarget = val;
      i++;
    } else {
      throw new Error(`Unknown argument "${arg}". Run \`stagepin --help\`.`);
    }
  }

  if (parsed.mode === "proxy" && !parsed.upstream) {
    throw new Error("Missing --upstream <url> (or run `stagepin --demo`).");
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.mode === "help") {
    printHelp();
    return;
  }

  let demoSite: Awaited<ReturnType<typeof startDemoUpstreamSite>> | null = null;
  let upstreamUrl = args.upstream ?? "";
  let dbPath = args.dbPath ?? join(homedir(), ".stagepin", "stagepin.db");

  if (args.mode === "demo") {
    demoSite = await startDemoUpstreamSite();
    upstreamUrl = demoSite.url;
    dbPath = args.dbPath ?? ":memory:";
  }

  const running = await startStagepinServer({
    upstreamUrl,
    host: args.host,
    port: args.port,
    dbPath,
    password: args.password,
    githubTarget: args.githubTarget,
    githubToken: process.env.GITHUB_TOKEN,
  });

  if (args.mode === "demo") {
    running.store.createPin({
      pagePath: "/",
      selector: "#pro-card",
      anchorText: "Pro Plan (Misaligned Card)",
      xPercent: 68,
      yPercent: 42,
      author: "Design QA",
      body: "Pro pricing card sits 18px lower than Starter card due to translateY(18px).",
      diagnostics: {
        viewportWidth: 1440,
        viewportHeight: 900,
        userAgent: "stagepin-demo",
        events: [
          {
            kind: "network.error",
            status: 500,
            url: "/api/checkout",
            message: "Internal Server Error",
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });
  }

  console.log(`stagepin v0.1.0 listening on ${running.url}`);
  console.log(`  upstream: ${upstreamUrl}`);
  if (args.password) {
    console.log(`  guest auth: enabled (magic link format: ${running.url}/?stagepin_key=<your-password>)`);
  }
  if (args.githubTarget) {
    console.log(`  github push: ${args.githubTarget}`);
  }
  console.log("  Alt+Click any element in the browser to leave a visual pin. Press Ctrl+C to stop.");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await running.close();
    if (demoSite) await demoSite.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)).toLowerCase() ===
      realpathSync(resolve(process.argv[1])).toLowerCase()
    );
  } catch {
    return resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();
  }
}

if (isDirectEntry()) {
  main().catch((err) => {
    console.error(`[stagepin] Error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
