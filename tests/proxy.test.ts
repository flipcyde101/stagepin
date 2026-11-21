import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { startStagepinServer, validateUpstreamUrl, type RunningStagepinServer } from "../src/proxy/server.js";

describe("stagepin reverse proxy, auth gate, overlay injection, and pin API", () => {
  const serversToClose: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (serversToClose.length > 0) {
      await serversToClose.pop()!();
    }
  });

  it("rejects non-HTTP(S) and credentialed upstream URLs", () => {
    expect(() => validateUpstreamUrl("file:///etc/passwd")).toThrow();
    expect(() => validateUpstreamUrl("http://user:pass@localhost:3000")).toThrow();
    expect(validateUpstreamUrl("http://127.0.0.1:3000").origin).toBe("http://127.0.0.1:3000");
  });

  it("proxies gzip HTML with Shadow DOM overlay injection, passes JSON untouched, enforces guest password, and strips internal cookie upstream", async () => {
    let seenUpstreamCookie = "";
    const upstream: Server = createServer((req, res) => {
      seenUpstreamCookie = req.headers.cookie ?? "";
      if (req.url === "/api/data") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const html = gzipSync(Buffer.from("<!doctype html><html><body><h1>Staging App</h1></body></html>", "utf8"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Encoding": "gzip",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      });
      res.end(html);
    });

    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    serversToClose.push(() => new Promise<void>((r) => upstream.close(() => r())));
    const upPort = (upstream.address() as { port: number }).port;

    const sp: RunningStagepinServer = await startStagepinServer({
      upstreamUrl: `http://127.0.0.1:${upPort}`,
      port: 0,
      dbPath: ":memory:",
      password: "secret-review-key",
    });
    serversToClose.push(() => sp.close());

    // 1. Unauthenticated request receives 401 password gate
    const unauth = await fetch(`${sp.url}/`);
    expect(unauth.status).toBe(401);
    expect(await unauth.text()).toContain("Unlock Staging Preview");

    // 2. Magic-link sets HttpOnly cookie and redirects cleanly
    const magic = await fetch(`${sp.url}/?stagepin_key=secret-review-key`, { redirect: "manual" });
    expect(magic.status).toBe(302);
    const setCookie = magic.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("stagepin_auth=");
    expect(setCookie).toContain("HttpOnly");
    const authCookie = setCookie.split(";")[0];

    // 3. Authenticated HTML request decompresses gzip, injects overlay script + CSP nonce, and strips stagepin_auth from upstream Cookie
    const htmlRes = await fetch(`${sp.url}/`, { headers: { Cookie: `${authCookie}; app_session=xyz` } });
    expect(htmlRes.status).toBe(200);
    const htmlBody = await htmlRes.text();
    expect(htmlBody).toContain("<h1>Staging App</h1>");
    expect(htmlBody).toContain('src="/__stagepin/overlay.js"');
    expect(htmlRes.headers.get("content-security-policy")).toMatch(/'nonce-[A-Za-z0-9_-]+'/);
    expect(seenUpstreamCookie).toBe("app_session=xyz");

    // 4. Non-HTML API request passes through untouched
    const jsonRes = await fetch(`${sp.url}/api/data`, { headers: { Cookie: authCookie } });
    expect(await jsonRes.json()).toEqual({ ok: true });

    // 5. Overlay script is served cleanly
    const jsRes = await fetch(`${sp.url}/__stagepin/overlay.js`, { headers: { Cookie: authCookie } });
    expect(jsRes.status).toBe(200);
    expect(await jsRes.text()).toContain("attachShadow");

    // 6. Pin CRUD + replies + status toggle work through internal API
    const createdRes = await fetch(`${sp.url}/__stagepin/api/pins`, {
      method: "POST",
      headers: { Cookie: authCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ pagePath: "/", selector: "h1", xPercent: 50, yPercent: 20, body: "Bump heading size" }),
    });
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as { id: number };

    const listRes = await fetch(`${sp.url}/__stagepin/api/pins`, { headers: { Cookie: authCookie } });
    const list = (await listRes.json()) as Array<{ id: number; body: string }>;
    expect(list).toHaveLength(1);
    expect(list[0].body).toBe("Bump heading size");

    const patchRes = await fetch(`${sp.url}/__stagepin/api/pins/${created.id}/status`, {
      method: "PATCH",
      headers: { Cookie: authCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { status: string }).status).toBe("resolved");
  });
});
