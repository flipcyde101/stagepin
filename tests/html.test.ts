import { describe, it, expect } from "vitest";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { decompressBody, injectOverlayIntoHtml, isHtmlContentType, rewriteCspHeader } from "../src/proxy/html.js";

describe("HTML decompression, injection, and CSP nonce rewriting", () => {
  it("decompresses gzip and brotli payloads cleanly", () => {
    const raw = Buffer.from("<html><body><h1>Hello</h1></body></html>", "utf8");
    expect(decompressBody(gzipSync(raw), "gzip").toString("utf8")).toBe(raw.toString("utf8"));
    expect(decompressBody(brotliCompressSync(raw), "br").toString("utf8")).toBe(raw.toString("utf8"));
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("application/json")).toBe(false);
  });

  it("injects deferred nonce script immediately before </body> or fallback", () => {
    const injected = injectOverlayIntoHtml("<html><body><main>App</main></body></html>", "abc123");
    expect(injected).toContain('<script defer nonce="abc123" src="/__stagepin/overlay.js" data-stagepin="1"></script></body>');

    const fragment = injectOverlayIntoHtml("<div>No body tag</div>", "xyz789");
    expect(fragment).toContain('nonce="xyz789"');
  });

  it("rewrites CSP script-src with nonce without stripping existing directives", () => {
    const csp = "default-src 'none'; script-src https://cdn.example.com; img-src https: data:";
    const rewritten = rewriteCspHeader(csp, "nonce42");
    expect(rewritten).toContain("default-src 'none'");
    expect(rewritten).toContain("img-src https: data:");
    expect(rewritten).toContain("script-src https://cdn.example.com 'self' 'nonce-nonce42'");
    expect(rewritten).toContain("connect-src 'none' 'self'");
  });
});
