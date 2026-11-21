import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { PinStore } from "../db/store.js";
import { parseGitHubTarget, pushPinToGitHub } from "../github/push.js";
import { buildOverlayScript } from "../overlay/script.js";
import type { CreatePinInput, PinStatus, StagepinServerOptions } from "../types.js";
import { decompressBody, injectOverlayIntoHtml, isHtmlContentType, rewriteCspHeader } from "./html.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const MAX_JSON_BODY = 256 * 1024;
const MAX_HTML_BUFFER = 8 * 1024 * 1024;

export interface RunningStagepinServer {
  server: Server;
  url: string;
  port: number;
  store: PinStore;
  close: () => Promise<void>;
}

export function validateUpstreamUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid --upstream URL: "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported --upstream protocol "${parsed.protocol}". Only http: and https: are allowed.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Refusing --upstream URL with embedded credentials.");
  }
  return parsed;
}

function timingSafeEqualsStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

async function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function renderPasswordGateHtml(errorMsg?: string): string {
  const errHtml = errorMsg
    ? `<p style="color:#f85149;font-size:13px;margin:0 0 12px 0;">${errorMsg}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Stagepin Guest Review Access</title>
</head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;font-family:ui-sans-serif,system-ui,sans-serif;">
  <form method="POST" action="/__stagepin/auth" style="width:320px;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;">
    <h1 style="margin:0 0 8px 0;font-size:18px;color:#58a6ff;">stagepin</h1>
    <p style="margin:0 0 16px 0;font-size:13px;color:#8b949e;">Enter the guest review password to inspect and leave visual pins.</p>
    ${errHtml}
    <input type="password" name="password" placeholder="Review password" autofocus required style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;margin-bottom:12px;" />
    <button type="submit" style="width:100%;padding:10px;border-radius:8px;border:0;background:#1f6feb;color:#fff;font-weight:600;cursor:pointer;">Unlock Staging Preview</button>
  </form>
</body>
</html>`;
}

export async function startStagepinServer(opts: StagepinServerOptions): Promise<RunningStagepinServer> {
  const upstream = validateUpstreamUrl(opts.upstreamUrl);
  if (opts.githubTarget) {
    parseGitHubTarget(opts.githubTarget);
  }

  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 8080;
  const store = new PinStore(opts.dbPath ?? ":memory:");
  const password = opts.password?.trim() || "";
  const cookieSecret = randomBytes(32);
  const expectedCookieToken = password
    ? createHmac("sha256", cookieSecret).update(password).digest("hex")
    : "";

  const overlayJs = buildOverlayScript({
    apiBase: "/__stagepin",
    githubEnabled: Boolean(opts.githubTarget && opts.githubToken),
  });

  const sseClients = new Set<ServerResponse>();
  const broadcastPinsChanged = (): void => {
    const msg = `event: pins\ndata: ${JSON.stringify({ updatedAt: Date.now() })}\n\n`;
    for (const client of sseClients) {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        continue;
      }
      client.write(msg);
    }
  };

  const isAuthorized = (req: IncomingMessage): boolean => {
    if (!password) return true;
    const cookies = parseCookies(req.headers.cookie);
    const cookieVal = cookies["stagepin_auth"] ?? "";
    if (cookieVal && timingSafeEqualsStr(cookieVal, expectedCookieToken)) return true;
    const headerKey = typeof req.headers["x-stagepin-password"] === "string" ? req.headers["x-stagepin-password"] : "";
    if (headerKey && timingSafeEqualsStr(headerKey, password)) return true;
    return false;
  };

  const handleStagepinInternal = async (req: IncomingMessage, res: ServerResponse, parsedUrl: URL): Promise<void> => {
    const path = parsedUrl.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    if (path === "/__stagepin/auth" && method === "POST") {
      const raw = (await readBodyBuffer(req, 16 * 1024)).toString("utf8");
      const form = new URLSearchParams(raw);
      const supplied = form.get("password") ?? "";
      if (password && timingSafeEqualsStr(supplied, password)) {
        res.writeHead(302, {
          "Set-Cookie": `stagepin_auth=${expectedCookieToken}; Path=/; HttpOnly; SameSite=Lax`,
          Location: "/",
        });
        res.end();
        return;
      }
      const html = renderPasswordGateHtml("Invalid password. Please try again.");
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (path === "/__stagepin/overlay.js" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Length": Buffer.byteLength(overlayJs),
      });
      res.end(overlayJs);
      return;
    }

    if (path === "/__stagepin/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (path === "/__stagepin/api/pins" && method === "GET") {
      const pagePath = parsedUrl.searchParams.get("pagePath") ?? undefined;
      sendJson(res, 200, store.listPins(pagePath));
      return;
    }

    if (path === "/__stagepin/api/pins" && method === "POST") {
      try {
        const raw = (await readBodyBuffer(req, MAX_JSON_BODY)).toString("utf8");
        const data = JSON.parse(raw) as CreatePinInput;
        const created = store.createPin(data);
        broadcastPinsChanged();
        sendJson(res, 201, created);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return;
    }

    const replyMatch = /^\/__stagepin\/api\/pins\/(\d+)\/replies$/.exec(path);
    if (replyMatch && method === "POST") {
      try {
        const pinId = Number(replyMatch[1]);
        const raw = (await readBodyBuffer(req, MAX_JSON_BODY)).toString("utf8");
        const data = JSON.parse(raw) as { author?: string; body?: string };
        const reply = store.addReply(pinId, data.author ?? "Guest", data.body ?? "");
        broadcastPinsChanged();
        sendJson(res, 201, reply);
      } catch (err) {
        const msg = (err as Error).message;
        sendJson(res, msg.includes("not found") ? 404 : 400, { error: msg });
      }
      return;
    }

    const statusMatch = /^\/__stagepin\/api\/pins\/(\d+)\/status$/.exec(path);
    if (statusMatch && method === "PATCH") {
      try {
        const pinId = Number(statusMatch[1]);
        const raw = (await readBodyBuffer(req, MAX_JSON_BODY)).toString("utf8");
        const data = JSON.parse(raw) as { status?: string };
        if (data.status !== "open" && data.status !== "resolved") {
          sendJson(res, 400, { error: 'status must be "open" or "resolved"' });
          return;
        }
        const updated = store.setPinStatus(pinId, data.status as PinStatus);
        if (!updated) {
          sendJson(res, 404, { error: `Pin #${pinId} not found` });
          return;
        }
        broadcastPinsChanged();
        sendJson(res, 200, updated);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return;
    }

    const ghMatch = /^\/__stagepin\/api\/pins\/(\d+)\/github$/.exec(path);
    if (ghMatch && method === "POST") {
      const pinId = Number(ghMatch[1]);
      const pin = store.getPin(pinId);
      if (!pin) {
        sendJson(res, 404, { error: `Pin #${pinId} not found` });
        return;
      }
      if (!opts.githubTarget || !opts.githubToken) {
        sendJson(res, 400, { error: "GitHub push is not configured. Pass --github owner/repo#pr and GITHUB_TOKEN." });
        return;
      }
      try {
        const pushed = await pushPinToGitHub(pin, opts.githubTarget, opts.githubToken);
        const updated = store.setPinGithubUrl(pinId, pushed.htmlUrl);
        broadcastPinsChanged();
        sendJson(res, 200, updated);
      } catch (err) {
        sendJson(res, 502, { error: (err as Error).message });
      }
      return;
    }

    const deleteMatch = /^\/__stagepin\/api\/pins\/(\d+)$/.exec(path);
    if (deleteMatch && method === "DELETE") {
      const pinId = Number(deleteMatch[1]);
      const deleted = store.deletePin(pinId);
      if (!deleted) {
        sendJson(res, 404, { error: `Pin #${pinId} not found` });
        return;
      }
      broadcastPinsChanged();
      sendJson(res, 200, { deleted: true, id: pinId });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  };

  const proxyHttpRequest = (req: IncomingMessage, res: ServerResponse, parsedUrl: URL): void => {
    const basePath = upstream.pathname.endsWith("/") ? upstream.pathname.slice(0, -1) : upstream.pathname;
    const forwardPath = `${basePath}${parsedUrl.pathname}${parsedUrl.search}`;

    const forwardHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lower = k.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower) || lower === "host" || lower === "x-stagepin-password") continue;
      if (lower === "cookie" && typeof v === "string") {
        // Strip internal stagepin_auth cookie before forwarding upstream
        const filtered = v
          .split(";")
          .map((c) => c.trim())
          .filter((c) => c && !c.startsWith("stagepin_auth="))
          .join("; ");
        if (filtered) forwardHeaders[k] = filtered;
        continue;
      }
      forwardHeaders[k] = v;
    }
    forwardHeaders["host"] = upstream.host;

    const reqFn = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const upReq = reqFn(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: forwardPath,
        headers: forwardHeaders,
      },
      (upRes) => {
        const contentType = Array.isArray(upRes.headers["content-type"])
          ? upRes.headers["content-type"][0]
          : upRes.headers["content-type"];
        const isHtml = isHtmlContentType(contentType);

        if (!isHtml) {
          const outHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v === undefined) continue;
            if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
            outHeaders[k] = v;
          }
          res.writeHead(upRes.statusCode ?? 200, outHeaders);
          upRes.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let overflowed = false;
        upRes.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_HTML_BUFFER) {
            overflowed = true;
            upRes.destroy();
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "text/plain" });
              res.end("Upstream HTML response exceeded Stagepin buffer limit");
            }
            return;
          }
          chunks.push(chunk);
        });
        upRes.on("end", () => {
          if (overflowed || res.writableEnded) return;
          const rawBuf = Buffer.concat(chunks);
          const contentEncoding = Array.isArray(upRes.headers["content-encoding"])
            ? upRes.headers["content-encoding"][0]
            : upRes.headers["content-encoding"];
          let decoded: Buffer;
          try {
            decoded = decompressBody(rawBuf, contentEncoding);
          } catch {
            // Fall back to unmodified passthrough if upstream encoding is malformed
            res.writeHead(upRes.statusCode ?? 200, upRes.headers);
            res.end(rawBuf);
            return;
          }

          const nonce = randomBytes(12).toString("base64url");
          const injected = injectOverlayIntoHtml(decoded.toString("utf8"), nonce);
          const outBuf = Buffer.from(injected, "utf8");

          const outHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v === undefined) continue;
            const lower = k.toLowerCase();
            if (HOP_BY_HOP_HEADERS.has(lower) || lower === "content-length" || lower === "content-encoding") {
              continue;
            }
            if (lower === "content-security-policy") {
              const cspStr = Array.isArray(v) ? v.join("; ") : v;
              outHeaders[k] = rewriteCspHeader(cspStr, nonce);
              continue;
            }
            outHeaders[k] = v;
          }
          outHeaders["content-length"] = String(outBuf.length);
          res.writeHead(upRes.statusCode ?? 200, outHeaders);
          res.end(outBuf);
        });
      }
    );

    upReq.on("error", (err) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: `Upstream unreachable (${upstream.origin}): ${err.message}` });
      }
    });

    req.pipe(upReq);
  };

  const server = createHttpServer((req, res) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    // Support magic-link review parameter `?stagepin_key=...`
    if (password && parsedUrl.searchParams.has("stagepin_key")) {
      const key = parsedUrl.searchParams.get("stagepin_key") ?? "";
      if (timingSafeEqualsStr(key, password)) {
        parsedUrl.searchParams.delete("stagepin_key");
        const cleanDest = `${parsedUrl.pathname}${parsedUrl.search}`;
        res.writeHead(302, {
          "Set-Cookie": `stagepin_auth=${expectedCookieToken}; Path=/; HttpOnly; SameSite=Lax`,
          Location: cleanDest || "/",
        });
        res.end();
        return;
      }
    }

    if (parsedUrl.pathname.startsWith("/__stagepin/")) {
      void handleStagepinInternal(req, res, parsedUrl);
      return;
    }

    if (!isAuthorized(req)) {
      const html = renderPasswordGateHtml();
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    proxyHttpRequest(req, res, parsedUrl);
  });

  // Transparent WebSocket / HMR upgrade passthrough
  server.on("upgrade", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    if (!isAuthorized(req)) {
      clientSocket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const targetPort = Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 80);
    const upSocket: Socket =
      upstream.protocol === "https:"
        ? tlsConnect({ host: upstream.hostname, port: targetPort, servername: upstream.hostname })
        : netConnect({ host: upstream.hostname, port: targetPort });

    upSocket.on("connect", () => {
      const headerLines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`, `Host: ${upstream.host}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = req.rawHeaders[i + 1];
        if (k.toLowerCase() === "host" || k.toLowerCase() === "x-stagepin-password") continue;
        headerLines.push(`${k}: ${v}`);
      }
      upSocket.write(`${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upSocket.write(head);
      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);
    });

    const cleanup = () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upSocket.destroyed) upSocket.destroy();
    };
    upSocket.on("error", cleanup);
    clientSocket.on("error", cleanup);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;

  return {
    server,
    port: actualPort,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actualPort}`,
    store,
    close: async () => {
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      store.close();
    },
  };
}
