import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
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
const MAX_SSE_CLIENTS = 200;
const UPSTREAM_TIMEOUT_MS = 30_000;

class PayloadTooLargeError extends Error {
  constructor(message = "Request body too large") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

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

const HMAC_COMPARE_KEY = randomBytes(32);

function timingSafeEqualsStr(a: string, b: string): boolean {
  const digestA = createHmac("sha256", HMAC_COMPARE_KEY).update(a, "utf8").digest();
  const digestB = createHmac("sha256", HMAC_COMPARE_KEY).update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
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

function stripStagepinCookie(cookieValue: string): string {
  return cookieValue
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith("stagepin_auth="))
    .join("; ");
}

function isRequestHttps(req: IncomingMessage): boolean {
  if ((req.socket as TLSSocket).encrypted) return true;
  const xfp = req.headers["x-forwarded-proto"];
  const first = (Array.isArray(xfp) ? xfp[0] : xfp ?? "").split(",")[0].trim().toLowerCase();
  return first === "https";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function parseSafeRequestTarget(rawUrl: string | undefined): URL | null {
  const target = rawUrl ?? "/";
  // Reject protocol-relative or backslash-prefixed request targets (`//evil.com`, `/\evil.com`)
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) {
    return null;
  }
  try {
    return new URL(target, "http://stagepin.local");
  } catch {
    return null;
  }
}

function isSafeRedirectPath(dest: string): boolean {
  return /^\/(?!\/|\\)/.test(dest);
}

async function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function renderPasswordGateHtml(errorMsg?: string): string {
  const errHtml = errorMsg
    ? `<p style="color:#f85149;font-size:13px;margin:0 0 12px 0;">${escapeHtml(errorMsg)}</p>`
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

function isSameOriginMutation(req: IncomingMessage): boolean {
  const sfs = typeof req.headers["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"].toLowerCase() : "";
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return false;
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      const reqHost = (req.headers.host ?? "").toLowerCase();
      if (!reqHost || originHost !== reqHost) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function rewriteUpstreamLocation(loc: string, upstream: URL, basePath: string): string {
  try {
    const target = new URL(loc, upstream.origin);
    if (target.origin !== upstream.origin) return loc;
    let pathname = target.pathname;
    if (basePath && pathname.startsWith(basePath)) {
      pathname = pathname.slice(basePath.length) || "/";
    }
    return `${pathname}${target.search}${target.hash}`;
  } catch {
    return loc;
  }
}

export async function startStagepinServer(opts: StagepinServerOptions): Promise<RunningStagepinServer> {
  const upstream = validateUpstreamUrl(opts.upstreamUrl);
  const basePath = upstream.pathname.endsWith("/") ? upstream.pathname.slice(0, -1) : upstream.pathname;
  if (opts.githubTarget) {
    parseGitHubTarget(opts.githubTarget);
  }

  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 8080;
  const store = new PinStore(opts.dbPath ?? ":memory:");
  const password = opts.password ?? "";
  const cookieSecret = randomBytes(32);
  const expectedCookieToken = password
    ? createHmac("sha256", cookieSecret).update(password).digest("hex")
    : "";

  const overlayJs = buildOverlayScript({
    apiBase: "/__stagepin",
    githubEnabled: Boolean(opts.githubTarget && opts.githubToken),
  });

  const sseClients = new Set<ServerResponse>();
  const wsSockets = new Set<Socket>();

  const sseHeartbeat = setInterval(() => {
    for (const client of sseClients) {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        continue;
      }
      try {
        client.write(": keepalive\n\n");
      } catch {
        sseClients.delete(client);
      }
    }
  }, 25_000);
  sseHeartbeat.unref();

  const broadcastPinsChanged = (): void => {
    const msg = `event: pins\ndata: ${JSON.stringify({ updatedAt: Date.now() })}\n\n`;
    for (const client of sseClients) {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        continue;
      }
      try {
        client.write(msg);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const buildAuthCookieHeader = (req: IncomingMessage): string => {
    const secure = isRequestHttps(req) ? "; Secure" : "";
    return `stagepin_auth=${expectedCookieToken}; Path=/; HttpOnly; SameSite=Lax${secure}`;
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
      if (!isSameOriginMutation(req)) {
        sendJson(res, 403, { error: "Cross-origin auth request rejected" });
        return;
      }
      let raw: string;
      try {
        raw = (await readBodyBuffer(req, 16 * 1024)).toString("utf8");
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: err.message });
          return;
        }
        return;
      }
      const form = new URLSearchParams(raw);
      const supplied = form.get("password") ?? "";
      if (password && timingSafeEqualsStr(supplied, password)) {
        res.writeHead(302, {
          "Set-Cookie": buildAuthCookieHeader(req),
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          Location: "/",
        });
        res.end();
        return;
      }
      const html = renderPasswordGateHtml("Invalid password. Please try again.");
      res.writeHead(401, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
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
        "X-Content-Type-Options": "nosniff",
        "Content-Length": Buffer.byteLength(overlayJs),
      });
      res.end(overlayJs);
      return;
    }

    if (path === "/__stagepin/events" && method === "GET") {
      if (sseClients.size >= MAX_SSE_CLIENTS) {
        sendJson(res, 503, { error: "Too many live SSE connections" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      const drop = () => sseClients.delete(res);
      req.on("close", drop);
      res.on("close", drop);
      res.on("error", drop);
      return;
    }

    if (path === "/__stagepin/api/pins" && method === "GET") {
      const pagePath = parsedUrl.searchParams.get("pagePath") ?? undefined;
      sendJson(res, 200, store.listPins(pagePath));
      return;
    }

    // All API mutations require same-origin + X-Stagepin-Request header (CSRF defense)
    if (path.startsWith("/__stagepin/api/") && method !== "GET" && method !== "HEAD") {
      if (!isSameOriginMutation(req) || req.headers["x-stagepin-request"] !== "1") {
        sendJson(res, 403, { error: "CSRF check failed: require same-origin with X-Stagepin-Request: 1" });
        return;
      }
    }

    if (path === "/__stagepin/api/pins" && method === "POST") {
      try {
        const ct = (req.headers["content-type"] ?? "").toLowerCase();
        if (!ct.startsWith("application/json")) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        const raw = (await readBodyBuffer(req, MAX_JSON_BODY)).toString("utf8");
        const data = JSON.parse(raw) as CreatePinInput;
        const created = store.createPin(data);
        broadcastPinsChanged();
        sendJson(res, 201, created);
      } catch (err) {
        const status = err instanceof PayloadTooLargeError ? 413 : 400;
        sendJson(res, status, { error: (err as Error).message });
      }
      return;
    }

    const replyMatch = /^\/__stagepin\/api\/pins\/(\d+)\/replies$/.exec(path);
    if (replyMatch && method === "POST") {
      try {
        const ct = (req.headers["content-type"] ?? "").toLowerCase();
        if (!ct.startsWith("application/json")) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        const pinId = Number(replyMatch[1]);
        const raw = (await readBodyBuffer(req, MAX_JSON_BODY)).toString("utf8");
        const data = JSON.parse(raw) as { author?: string; body?: string } | null;
        if (!data || typeof data !== "object") {
          sendJson(res, 400, { error: "Invalid JSON object" });
          return;
        }
        const reply = store.addReply(pinId, data.author ?? "Guest", data.body ?? "");
        broadcastPinsChanged();
        sendJson(res, 201, reply);
      } catch (err) {
        const status =
          err instanceof PayloadTooLargeError ? 413 : (err as Error).message.includes("not found") ? 404 : 400;
        sendJson(res, status, { error: (err as Error).message });
      }
      return;
    }

    const statusMatch = /^\/__stagepin\/api\/pins\/(\d+)\/status$/.exec(path);
    if (statusMatch && method === "PATCH") {
      try {
        const ct = (req.headers["content-type"] ?? "").toLowerCase();
        if (!ct.startsWith("application/json")) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        const pinId = Number(statusMatch[1]);
        const raw = (await readBodyBuffer(req, MAX_JSON_BODY)).toString("utf8");
        const data = JSON.parse(raw) as { status?: string } | null;
        if (!data || typeof data !== "object" || (data.status !== "open" && data.status !== "resolved")) {
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
        const status = err instanceof PayloadTooLargeError ? 413 : 400;
        sendJson(res, status, { error: (err as Error).message });
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
    const forwardPath = `${basePath}${parsedUrl.pathname}${parsedUrl.search}`;

    const forwardHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lower = k.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower) || lower === "host" || lower === "x-stagepin-password" || lower === "accept-encoding") {
        continue;
      }
      if (lower === "cookie" && typeof v === "string") {
        const filtered = stripStagepinCookie(v);
        if (filtered) forwardHeaders[k] = filtered;
        continue;
      }
      forwardHeaders[k] = v;
    }
    forwardHeaders["host"] = upstream.host;
    // Advertise only encodings we cleanly decompress (prevents upstream zstd corruption)
    forwardHeaders["accept-encoding"] = "gzip, deflate, br";

    const reqFn = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const upReq = reqFn(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: forwardPath,
        headers: forwardHeaders,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (upRes) => {
        upRes.on("error", () => {
          if (!res.headersSent) {
            sendJson(res, 502, { error: "Upstream response stream error" });
          } else if (!res.destroyed) {
            res.destroy();
          }
        });

        const statusCode = upRes.statusCode ?? 200;
        const contentType = Array.isArray(upRes.headers["content-type"])
          ? upRes.headers["content-type"][0]
          : upRes.headers["content-type"];
        const method = (req.method ?? "GET").toUpperCase();
        const isBodylessOrRedirect =
          method === "HEAD" ||
          statusCode < 200 ||
          statusCode === 204 ||
          statusCode === 304 ||
          (statusCode >= 300 && statusCode < 400);
        const shouldInjectHtml = !isBodylessOrRedirect && isHtmlContentType(contentType);

        const buildCleanHeaders = (stripEncodingAndLen: boolean, nonce?: string): Record<string, string | string[]> => {
          const outHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v === undefined) continue;
            const lower = k.toLowerCase();
            if (HOP_BY_HOP_HEADERS.has(lower)) continue;
            if (stripEncodingAndLen && (lower === "content-length" || lower === "content-encoding" || lower === "etag")) {
              continue;
            }
            if (lower === "location") {
              const rawLoc = Array.isArray(v) ? v[0] : v;
              outHeaders[k] = rewriteUpstreamLocation(rawLoc, upstream, basePath);
              continue;
            }
            if (nonce && lower === "content-security-policy") {
              outHeaders[k] = Array.isArray(v)
                ? v.map((p) => rewriteCspHeader(p, nonce))
                : rewriteCspHeader(v, nonce);
              continue;
            }
            outHeaders[k] = v;
          }
          return outHeaders;
        };

        if (!shouldInjectHtml) {
          res.writeHead(statusCode, buildCleanHeaders(false));
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
            upReq.destroy();
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "text/plain" });
              res.end("Upstream HTML response exceeded Stagepin buffer limit");
            }
            return;
          }
          chunks.push(chunk);
        });
        upRes.on("end", () => {
          if (overflowed || res.writableEnded || res.destroyed) return;
          const rawBuf = Buffer.concat(chunks);
          const contentEncoding = Array.isArray(upRes.headers["content-encoding"])
            ? upRes.headers["content-encoding"][0]
            : upRes.headers["content-encoding"];
          let decoded: Buffer;
          try {
            decoded = decompressBody(rawBuf, contentEncoding, MAX_HTML_BUFFER);
          } catch {
            // Safely pass through unmodified bytes with hop-by-hop headers stripped
            const fallbackHeaders = buildCleanHeaders(false);
            fallbackHeaders["content-length"] = String(rawBuf.length);
            res.writeHead(statusCode, fallbackHeaders);
            res.end(rawBuf);
            return;
          }

          const nonce = randomBytes(12).toString("base64url");
          const injected = injectOverlayIntoHtml(decoded.toString("utf8"), nonce);
          const outBuf = Buffer.from(injected, "utf8");
          const outHeaders = buildCleanHeaders(true, nonce);
          outHeaders["content-length"] = String(outBuf.length);
          res.writeHead(statusCode, outHeaders);
          res.end(outBuf);
        });
      }
    );

    upReq.on("timeout", () => {
      upReq.destroy(new Error("Upstream request timed out"));
    });

    upReq.on("error", (err) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: `Upstream unreachable (${upstream.origin}): ${err.message}` });
      }
    });

    req.on("error", () => upReq.destroy());
    res.on("error", () => upReq.destroy());
    res.on("close", () => {
      if (!res.writableEnded) upReq.destroy();
    });

    req.pipe(upReq);
  };

  const server = createHttpServer((req, res) => {
    const parsedUrl = parseSafeRequestTarget(req.url);
    if (!parsedUrl) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    // Support magic-link review parameter `?stagepin_key=...` with strict same-origin redirect validation
    if (password && parsedUrl.searchParams.has("stagepin_key")) {
      const key = parsedUrl.searchParams.get("stagepin_key") ?? "";
      if (timingSafeEqualsStr(key, password)) {
        parsedUrl.searchParams.delete("stagepin_key");
        const candidate = `${parsedUrl.pathname}${parsedUrl.search}`;
        const cleanDest = isSafeRedirectPath(candidate) ? candidate : "/";
        res.writeHead(302, {
          "Set-Cookie": buildAuthCookieHeader(req),
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          Location: cleanDest,
        });
        res.end();
        return;
      }
    }

    if (parsedUrl.pathname.startsWith("/__stagepin/")) {
      handleStagepinInternal(req, res, parsedUrl).catch(() => {
        sendJson(res, 500, { error: "Internal stagepin error" });
      });
      return;
    }

    if (!isAuthorized(req)) {
      const html = renderPasswordGateHtml();
      res.writeHead(401, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    proxyHttpRequest(req, res, parsedUrl);
  });

  // Transparent WebSocket / HMR upgrade passthrough (strips internal auth cookie & preserves upstream basePath)
  server.on("upgrade", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    if (!isAuthorized(req)) {
      clientSocket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const parsed = parseSafeRequestTarget(req.url);
    if (!parsed) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    wsSockets.add(clientSocket);
    const targetPort = Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 80);
    const isTls = upstream.protocol === "https:";
    const upSocket: Socket = isTls
      ? tlsConnect({ host: upstream.hostname, port: targetPort, servername: upstream.hostname })
      : netConnect({ host: upstream.hostname, port: targetPort });
    wsSockets.add(upSocket);

    const cleanup = () => {
      wsSockets.delete(clientSocket);
      wsSockets.delete(upSocket);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upSocket.destroyed) upSocket.destroy();
    };

    const connectEvent = isTls ? "secureConnect" : "connect";
    upSocket.once(connectEvent, () => {
      if (clientSocket.destroyed) {
        cleanup();
        return;
      }
      const wsPath = `${basePath}${parsed.pathname}${parsed.search}`;
      const headerLines = [`${req.method ?? "GET"} ${wsPath} HTTP/1.1`, `Host: ${upstream.host}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = req.rawHeaders[i + 1];
        const lower = k.toLowerCase();
        if (lower === "host" || lower === "x-stagepin-password") continue;
        if (lower === "cookie") {
          const filtered = stripStagepinCookie(v);
          if (filtered) headerLines.push(`${k}: ${filtered}`);
          continue;
        }
        headerLines.push(`${k}: ${v}`);
      }
      upSocket.write(`${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upSocket.write(head);
      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);
    });

    upSocket.on("error", cleanup);
    upSocket.on("close", cleanup);
    clientSocket.on("error", cleanup);
    clientSocket.on("close", cleanup);
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
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;

  return {
    server,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}`,
    store,
    close: async () => {
      clearInterval(sseHeartbeat);
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      sseClients.clear();
      for (const sock of wsSockets) {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
      }
      wsSockets.clear();
      server.closeIdleConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      store.close();
    },
  };
}
