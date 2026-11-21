import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";

export function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /(?:^|;)\s*text\/html\b/i.test(contentType);
}

export function decompressBody(
  body: Buffer,
  contentEncoding: string | undefined,
  maxOutputLength = 8 * 1024 * 1024
): Buffer {
  if (!contentEncoding) return body;
  const encodings = contentEncoding
    .split(",")
    .map((e) => e.toLowerCase().trim())
    .filter((e) => e && e !== "identity");
  if (encodings.length === 0) return body;

  let current = body;
  // Apply encodings in reverse order per RFC 9110
  for (let i = encodings.length - 1; i >= 0; i--) {
    const enc = encodings[i];
    if (enc === "gzip" || enc === "x-gzip") {
      current = gunzipSync(current, { maxOutputLength });
    } else if (enc === "br") {
      current = brotliDecompressSync(current, { maxOutputLength });
    } else if (enc === "deflate") {
      try {
        current = inflateSync(current, { maxOutputLength });
      } catch {
        current = inflateRawSync(current, { maxOutputLength });
      }
    } else {
      throw new Error(`Unsupported Content-Encoding: ${enc}`);
    }
  }
  return current;
}

function shouldAddNonce(tokens: string[]): boolean {
  const hasUnsafeInline = tokens.some((t) => t.toLowerCase() === "'unsafe-inline'");
  const hasStrictOrCrypto = tokens.some((t) => {
    const lower = t.toLowerCase();
    return (
      lower === "'strict-dynamic'" ||
      lower.startsWith("'nonce-") ||
      lower.startsWith("'sha256-") ||
      lower.startsWith("'sha384-") ||
      lower.startsWith("'sha512-")
    );
  });
  // Never add a nonce alongside 'unsafe-inline' unless strict-dynamic/nonces/hashes are already active,
  // because CSP2/3 ignores 'unsafe-inline' as soon as any nonce is present.
  return !hasUnsafeInline || hasStrictOrCrypto;
}

function rewriteSingleCspPolicy(policy: string, nonce: string): string {
  const rawDirectives = policy
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);

  const parsed = rawDirectives.map((d) => {
    const parts = d.split(/\s+/);
    return { name: parts[0], lower: parts[0].toLowerCase(), tokens: parts.slice(1) };
  });

  const defaultDir = parsed.find((d) => d.lower === "default-src");
  const hasScriptSrc = parsed.some((d) => d.lower === "script-src");
  const hasScriptSrcElem = parsed.some((d) => d.lower === "script-src-elem");
  const hasConnectSrc = parsed.some((d) => d.lower === "connect-src");
  const hasStyleSrc = parsed.some((d) => d.lower === "style-src");

  const ensureSelfAndOptionalNonce = (tokens: string[], allowNonce: boolean): string[] => {
    const cleaned = tokens.filter((t) => t.toLowerCase() !== "'none'");
    if (!cleaned.some((t) => t.toLowerCase() === "'self'")) {
      cleaned.push("'self'");
    }
    if (allowNonce && shouldAddNonce(cleaned)) {
      cleaned.push(`'nonce-${nonce}'`);
    }
    return cleaned;
  };

  const out = parsed.map((d) => {
    if (d.lower === "script-src" || d.lower === "script-src-elem") {
      return `${d.name} ${ensureSelfAndOptionalNonce(d.tokens, true).join(" ")}`;
    }
    if (d.lower === "style-src" || d.lower === "style-src-elem") {
      return `${d.name} ${ensureSelfAndOptionalNonce(d.tokens, true).join(" ")}`;
    }
    if (d.lower === "connect-src") {
      return `${d.name} ${ensureSelfAndOptionalNonce(d.tokens, false).join(" ")}`;
    }
    return `${d.name}${d.tokens.length ? " " + d.tokens.join(" ") : ""}`;
  });

  if (defaultDir) {
    if (!hasScriptSrc && !hasScriptSrcElem) {
      out.push(`script-src ${ensureSelfAndOptionalNonce(defaultDir.tokens, true).join(" ")}`);
    }
    if (!hasStyleSrc) {
      out.push(`style-src ${ensureSelfAndOptionalNonce(defaultDir.tokens, true).join(" ")}`);
    }
    if (!hasConnectSrc && !defaultDir.tokens.some((t) => t.toLowerCase() === "'self'")) {
      out.push(`connect-src ${ensureSelfAndOptionalNonce(defaultDir.tokens, false).join(" ")}`);
    }
  }

  return out.join("; ");
}

export function rewriteCspHeader(csp: string, nonce: string): string {
  // Handle comma-separated multi-policy CSP headers independently
  return csp
    .split(",")
    .map((policy) => rewriteSingleCspPolicy(policy, nonce))
    .join(", ");
}

function findLastTagIndex(html: string, re: RegExp): number {
  re.lastIndex = 0;
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    lastIdx = m.index;
  }
  return lastIdx;
}

export function injectOverlayIntoHtml(html: string, nonce: string, scriptSrc = "/__stagepin/overlay.js"): string {
  const tag = `<script defer nonce="${nonce}" src="${scriptSrc}" data-stagepin="1"></script>`;
  const closeBodyIdx = findLastTagIndex(html, /<\/body>/gi);
  if (closeBodyIdx !== -1) {
    return `${html.slice(0, closeBodyIdx)}${tag}${html.slice(closeBodyIdx)}`;
  }
  const closeHtmlIdx = findLastTagIndex(html, /<\/html>/gi);
  if (closeHtmlIdx !== -1) {
    return `${html.slice(0, closeHtmlIdx)}${tag}${html.slice(closeHtmlIdx)}`;
  }
  return `${html}\n${tag}`;
}
