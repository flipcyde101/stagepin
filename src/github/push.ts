import { validateHttpUrl } from "../db/store.js";
import type { GitHubTarget, Pin } from "../types.js";

export function parseGitHubTarget(raw: string): GitHubTarget {
  const trimmed = raw.trim();
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid --github target "${raw}". Expected "owner/repo" or "owner/repo#42".`);
  }
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: match[3] ? Number(match[3]) : undefined,
  };
}

function mdCode(text: string): string {
  const safe = text.replace(/\r?\n/g, " ");
  const runs = safe.match(/`+/g);
  const maxRun = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const fence = "`".repeat(maxRun + 1);
  return safe.startsWith("`") || safe.endsWith("`") ? `${fence} ${safe} ${fence}` : `${fence}${safe}${fence}`;
}

export function formatPinMarkdown(pin: Pin): string {
  const safeAuthor = pin.author.replace(/\r?\n/g, " ");
  const lines: string[] = [
    `### Visual Pin #${pin.id} (${pin.status.toUpperCase()})`,
    "",
    `> ${pin.body.replace(/\r?\n/g, "\n> ")}`,
    "",
    `- **Author:** ${safeAuthor}`,
    `- **Page:** ${mdCode(pin.pagePath)}`,
    `- **Element Selector:** ${mdCode(pin.selector)}`,
  ];

  if (pin.anchorText) {
    lines.push(`- **Anchor Text:** ${mdCode(pin.anchorText)}`);
  }
  lines.push(
    `- **Position:** (${pin.xPercent.toFixed(1)}%, ${pin.yPercent.toFixed(1)}%) | **Viewport:** ${pin.diagnostics.viewportWidth}x${pin.diagnostics.viewportHeight}`
  );

  if (pin.diagnostics.events.length > 0) {
    lines.push("", "**Captured Diagnostics (last events before pin):**", "");
    for (const ev of pin.diagnostics.events.slice(-10)) {
      const urlPart = ev.url ? ` ${mdCode(ev.url)}` : "";
      const detail = ev.status ? ` (HTTP ${ev.status}${urlPart})` : urlPart ? ` (${urlPart.trim()})` : "";
      lines.push(`- ${mdCode(ev.kind)}${detail}: ${mdCode(ev.message)}`);
    }
  }

  lines.push("", "_Pinned with [stagepin](https://github.com/flipcyde101/stagepin)_");
  return lines.join("\n");
}

export async function pushPinToGitHub(
  pin: Pin,
  targetRaw: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ htmlUrl: string }> {
  const target = parseGitHubTarget(targetRaw);
  const cleanToken = token.trim();
  if (!cleanToken) {
    throw new Error("GITHUB_TOKEN is required to push pins to GitHub Issues/PRs.");
  }

  const body = formatPinMarkdown(pin);
  const apiUrl = target.issueNumber
    ? `https://api.github.com/repos/${target.owner}/${target.repo}/issues/${target.issueNumber}/comments`
    : `https://api.github.com/repos/${target.owner}/${target.repo}/issues`;

  const cleanTitle = pin.body.replace(/\r?\n/g, " ").trim().slice(0, 72);
  const payload = target.issueNumber
    ? { body }
    : {
        title: `[Stagepin #${pin.id}] ${cleanTitle}`,
        body,
      };

  const res = await fetchImpl(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cleanToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "stagepin/0.1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`GitHub API failed (${res.status}): ${errText.slice(0, 240)}`);
  }

  const data = (await res.json()) as { html_url?: string };
  if (!data.html_url) {
    throw new Error("GitHub API response did not include html_url");
  }
  const safeUrl = validateHttpUrl(data.html_url);
  if (!safeUrl.startsWith("https://")) {
    throw new Error("GitHub API returned non-HTTPS html_url");
  }
  return { htmlUrl: safeUrl };
}
