import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /(?:^|;)\s*text\/html\b/i.test(contentType);
}

export function decompressBody(body: Buffer, contentEncoding: string | undefined): Buffer {
  if (!contentEncoding) return body;
  const enc = contentEncoding.toLowerCase().trim();
  if (!enc || enc === "identity") return body;
  if (enc === "gzip" || enc === "x-gzip") return gunzipSync(body);
  if (enc === "br") return brotliDecompressSync(body);
  if (enc === "deflate") return inflateSync(body);
  return body;
}

export function rewriteCspHeader(csp: string, nonce: string): string {
  const directives = csp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);

  let hasScriptSrc = false;
  let hasConnectSrc = false;

  const updated = directives.map((directive) => {
    const parts = directive.split(/\s+/);
    const name = parts[0].toLowerCase();
    if (name === "script-src") {
      hasScriptSrc = true;
      const out = [...parts];
      if (!out.includes("'self'")) out.push("'self'");
      out.push(`'nonce-${nonce}'`);
      return out.join(" ");
    }
    if (name === "connect-src") {
      hasConnectSrc = true;
      const out = [...parts];
      if (!out.includes("'self'")) out.push("'self'");
      return out.join(" ");
    }
    return directive;
  });

  if (!hasScriptSrc) {
    // Only add script-src if default-src would otherwise block inline/self script
    const defaultDir = directives.find((d) => d.toLowerCase().startsWith("default-src"));
    if (defaultDir) {
      const baseTokens = defaultDir.split(/\s+/).slice(1);
      if (!baseTokens.includes("'self'")) baseTokens.push("'self'");
      baseTokens.push(`'nonce-${nonce}'`);
      updated.push(`script-src ${baseTokens.join(" ")}`);
    }
  }

  if (!hasConnectSrc) {
    const defaultDir = directives.find((d) => d.toLowerCase().startsWith("default-src"));
    if (defaultDir && !defaultDir.includes("'self'")) {
      const baseTokens = defaultDir.split(/\s+/).slice(1);
      baseTokens.push("'self'");
      updated.push(`connect-src ${baseTokens.join(" ")}`);
    }
  }

  return updated.join("; ");
}

export function injectOverlayIntoHtml(html: string, nonce: string, scriptSrc = "/__stagepin/overlay.js"): string {
  const tag = `<script defer nonce="${nonce}" src="${scriptSrc}" data-stagepin="1"></script>`;
  const closeBodyIdx = html.search(/<\/body>/i);
  if (closeBodyIdx !== -1) {
    return `${html.slice(0, closeBodyIdx)}${tag}${html.slice(closeBodyIdx)}`;
  }
  const closeHtmlIdx = html.search(/<\/html>/i);
  if (closeHtmlIdx !== -1) {
    return `${html.slice(0, closeHtmlIdx)}${tag}${html.slice(closeHtmlIdx)}`;
  }
  return `${html}\n${tag}`;
}
