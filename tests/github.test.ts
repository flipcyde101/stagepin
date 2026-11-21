import { describe, it, expect } from "vitest";
import { formatPinMarkdown, parseGitHubTarget, pushPinToGitHub } from "../src/github/push.js";
import type { Pin } from "../src/types.js";

const samplePin: Pin = {
  id: 3,
  pagePath: "/pricing",
  selector: "#pro-card > button",
  anchorText: "Upgrade Now",
  xPercent: 72.4,
  yPercent: 55.1,
  author: "Design QA",
  body: "Button triggers HTTP 500 on staging",
  status: "open",
  diagnostics: {
    viewportWidth: 1440,
    viewportHeight: 900,
    userAgent: "Chrome",
    events: [{ kind: "network.error", status: 500, url: "/api/checkout", message: "Internal Server Error", timestamp: "2026-11-21T00:00:00Z" }],
  },
  githubUrl: null,
  createdAt: "2026-11-21T00:00:00Z",
  replies: [],
};

describe("GitHub Issue/PR push", () => {
  it("parses owner/repo and owner/repo#pr cleanly", () => {
    expect(parseGitHubTarget("flipcyde101/stagepin#42")).toEqual({ owner: "flipcyde101", repo: "stagepin", issueNumber: 42 });
    expect(parseGitHubTarget("flipcyde101/stagepin")).toEqual({ owner: "flipcyde101", repo: "stagepin", issueNumber: undefined });
    expect(() => parseGitHubTarget("invalid target")).toThrow();
  });

  it("formats Markdown with selector, diagnostics, and Stagepin footer, and posts to PR comments API", async () => {
    const md = formatPinMarkdown(samplePin);
    expect(md).toContain("Visual Pin #3");
    expect(md).toContain("`#pro-card > button`");
    expect(md).toContain("HTTP 500 /api/checkout");
    expect(md).toContain("Pinned with [stagepin]");

    let capturedUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ html_url: "https://github.com/flipcyde101/stagepin/pull/42#issuecomment-9" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const pushed = await pushPinToGitHub(samplePin, "flipcyde101/stagepin#42", "ghp_test", fakeFetch);
    expect(capturedUrl).toBe("https://api.github.com/repos/flipcyde101/stagepin/issues/42/comments");
    expect(pushed.htmlUrl).toContain("#issuecomment-9");
  });
});
