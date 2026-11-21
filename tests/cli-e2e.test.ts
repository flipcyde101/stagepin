import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseCliArgs } from "../src/cli.js";

describe("stagepin CLI & built dist/cli.js", () => {
  it("parses flags and Docker environment variables cleanly", () => {
    const fromEnv = parseCliArgs([], {
      STAGEPIN_UPSTREAM: "http://host.docker.internal:3000",
      STAGEPIN_HOST: "0.0.0.0",
      STAGEPIN_PORT: "9090",
    });
    expect(fromEnv.upstream).toBe("http://host.docker.internal:3000");
    expect(fromEnv.host).toBe("0.0.0.0");
    expect(fromEnv.port).toBe(9090);

    expect(() => parseCliArgs([], {})).toThrow(/--upstream/);
    expect(parseCliArgs(["--demo"]).mode).toBe("demo");
  });

  it("runs built dist/cli.js --help cleanly with node:sqlite preserved", () => {
    const cliPath = resolve(process.cwd(), "dist", "cli.js");
    const out = execFileSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
    expect(out).toContain("stagepin v0.1.0");
    expect(out).toContain("--upstream");
    expect(out).toContain("--demo");
  });
});
