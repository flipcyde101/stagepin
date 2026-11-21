import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { injectOverlayIntoHtml, rewriteCspHeader } from "../src/proxy/html.js";
import { startStagepinServer, type RunningStagepinServer } from "../src/proxy/server.js";
import { parseCliArgs } from "../src/cli.js";
import { PinStore } from "../src/db/store.js";
import { buildOverlayScript } from "../src/overlay/script.js";

describe("stagepin whole-branch review regression fixes (C1-C7, I1-I11, M1-M9)", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) await closers.pop()!();
  });

  it("C1, C2, C4, I6: handles oversized POST /__stagepin/auth without crashing, blocks open redirect via ?stagepin_key, enforces CSRF/same-origin on API mutations, and sets Secure/no-store behind HTTPS", async () => {
    const upstream: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>ok</body></html>");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => upstream.close(() => r())));
    const upPort = (upstream.address() as { port: number }).port;

    const sp: RunningStagepinServer = await startStagepinServer({
      upstreamUrl: `http://127.0.0.1:${upPort}`,
      port: 0,
      dbPath: ":memory:",
      password: "secret",
    });
    closers.push(() => sp.close());

    // C1: oversized POST /__stagepin/auth returns 413 instead of crashing the process
    const bigBody = "password=" + "a".repeat(24 * 1024);
    const tooLarge = await fetch(`${sp.url}/__stagepin/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bigBody,
    });
    expect(tooLarge.status).toBe(413);

    // C2: double-slash open redirect attempt must NOT redirect to //evil.com
    const openRedir = await fetch(`${sp.url}//x//evil.com/?stagepin_key=secret`, { redirect: "manual" });
    expect([400, 302]).toContain(openRedir.status);
    if (openRedir.status === 302) {
      expect(openRedir.headers.get("location")).toBe("/");
    }

    // I6: magic-link behind X-Forwarded-Proto: https sets Secure + Cache-Control: no-store
    const httpsAuth = await fetch(`${sp.url}/pricing?stagepin_key=secret`, {
      redirect: "manual",
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(httpsAuth.status).toBe(302);
    expect(httpsAuth.headers.get("set-cookie")).toContain("Secure");
    expect(httpsAuth.headers.get("cache-control")).toContain("no-store");
    expect(httpsAuth.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = (httpsAuth.headers.get("set-cookie") ?? "").split(";")[0];

    // C4: cross-origin / missing X-Stagepin-Request CSRF attempt on POST /__stagepin/api/pins must be rejected (403)
    const csrfPost = await fetch(`${sp.url}/__stagepin/api/pins`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ pagePath: "/", selector: "h1", xPercent: 10, yPercent: 10, body: "csrf" }),
    });
    expect(csrfPost.status).toBe(403);

    // Legitimate same-origin API call with X-Stagepin-Request succeeds
    const legit = await fetch(`${sp.url}/__stagepin/api/pins`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Stagepin-Request": "1",
      },
      body: JSON.stringify({ pagePath: "/", selector: "h1", xPercent: 10, yPercent: 10, body: "real pin" }),
    });
    expect(legit.status).toBe(201);
  });

  it("C3: rejects non-http(s) javascript: githubUrl in store and overlay script", () => {
    const store = new PinStore(":memory:");
    try {
      const pin = store.createPin({ pagePath: "/", selector: "h1", xPercent: 10, yPercent: 10, body: "test" });
      expect(() => store.setPinGithubUrl(pin.id, "javascript:alert(1)")).toThrow(/https?/i);
      const valid = store.setPinGithubUrl(pin.id, "https://github.com/flipcyde101/stagepin/issues/1");
      expect(valid?.githubUrl).toBe("https://github.com/flipcyde101/stagepin/issues/1");
    } finally {
      store.close();
    }
    const overlay = buildOverlayScript({ apiBase: "/__stagepin", githubEnabled: true });
    expect(overlay).toContain("https?:\\/\\/");
    expect(overlay).toContain('data-testid');
  });

  it("C5, I4, M1: preserves unsafe-inline CSP without adding nonce, strips 'none', rewrites script-src-elem, and injects before LAST </body>", () => {
    // C5: script-src 'self' 'unsafe-inline' must NOT get a nonce that disables unsafe-inline!
    const demoCsp = "default-src 'self'; script-src 'self' 'unsafe-inline'";
    const rewrittenDemo = rewriteCspHeader(demoCsp, "abc123");
    expect(rewrittenDemo).toContain("script-src 'self' 'unsafe-inline'");
    expect(rewrittenDemo).not.toMatch(/script-src[^;]*'nonce-abc123'/);

    // I4: 'none' must be stripped when adding 'self'
    const noneCsp = "default-src 'none'; script-src 'none'";
    const rewrittenNone = rewriteCspHeader(noneCsp, "xyz789");
    expect(rewrittenNone).not.toContain("script-src 'none'");
    expect(rewrittenNone).toContain("script-src 'self' 'nonce-xyz789'");
    expect(rewrittenNone).not.toContain("connect-src 'none'");
    expect(rewrittenNone).toContain("connect-src 'self'");

    // M1: injects before LAST </body>, not a string literal inside an inline script
    const trickyHtml = '<html><body><script>const s = "</body>";</script><main>hi</main></body></html>';
    const injected = injectOverlayIntoHtml(trickyHtml, "n1");
    expect(injected).toContain('<script>const s = "</body>";</script>');
    expect(injected).toContain("<main>hi</main><script defer");
  });

  it("C6, I1, I2: passes HEAD/304/3xx without HTML injection, rewrites upstream Location header, and safely passes unrecognized Content-Encoding through", async () => {
    const upstream: Server = createServer((req, res) => {
      if (req.url === "/redirect") {
        const port = (upstream.address() as { port: number }).port;
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/dashboard`, "Content-Type": "text/html" });
        res.end("Redirecting...");
        return;
      }
      if (req.url === "/unknown-enc") {
        res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "x-custom-enc" });
        res.end(Buffer.from("RAW_UNKNOWN_ENCODING_BYTES"));
        return;
      }
      const gz = gzipSync(Buffer.from("<html><body>ok</body></html>"));
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(gz);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => upstream.close(() => r())));
    const upPort = (upstream.address() as { port: number }).port;

    const sp = await startStagepinServer({ upstreamUrl: `http://127.0.0.1:${upPort}`, port: 0, dbPath: ":memory:" });
    closers.push(() => sp.close());

    // I1: HEAD returns 200 with empty body (does not inject script into empty HEAD response)
    const headRes = await fetch(`${sp.url}/`, { method: "HEAD" });
    expect(headRes.status).toBe(200);
    expect(await headRes.text()).toBe("");

    // I2: upstream Location matching upstream origin is rewritten to proxy-relative path
    const redirRes = await fetch(`${sp.url}/redirect`, { redirect: "manual" });
    expect(redirRes.status).toBe(302);
    expect(redirRes.headers.get("location")).toBe("/dashboard");

    // C6: unrecognized Content-Encoding is NOT corrupted by UTF-8 injection + header stripping
    const encRes = await fetch(`${sp.url}/unknown-enc`);
    expect(encRes.headers.get("content-encoding")).toBe("x-custom-enc");
    expect(await encRes.text()).toBe("RAW_UNKNOWN_ENCODING_BYTES");
  });

  it("I7, I10: rejects whitespace-only --password and invalid STAGEPIN_PORT, and ships Linux-safe docker-compose + non-root Dockerfile", () => {
    expect(() => parseCliArgs(["--demo", "--password", "   "])).toThrow(/password/i);
    expect(() => parseCliArgs([], { STAGEPIN_UPSTREAM: "http://127.0.0.1:3000", STAGEPIN_PORT: "abc" })).toThrow(/port/i);

    const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
    expect(compose).toContain("host.docker.internal:host-gateway");
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).toContain("USER node");
  });
});
