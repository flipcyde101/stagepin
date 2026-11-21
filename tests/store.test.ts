import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinStore } from "../src/db/store.js";

describe("PinStore (node:sqlite WAL persistence)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("persists pins, replies, status toggles, and GitHub URLs across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "sp-db-"));
    dirs.push(dir);
    const dbPath = join(dir, "stagepin.db");

    const store = new PinStore(dbPath);
    const pin = store.createPin({
      pagePath: "/pricing",
      selector: "#pro-card",
      anchorText: "Pro Plan",
      xPercent: 62.5,
      yPercent: 40.2,
      author: "Dillon",
      body: "Card misaligned on Safari",
      diagnostics: {
        viewportWidth: 390,
        viewportHeight: 844,
        userAgent: "TestAgent",
        events: [{ kind: "network.error", status: 500, url: "/api/checkout", message: "HTTP 500", timestamp: "2026-11-21T00:00:00Z" }],
      },
    });
    expect(pin.id).toBe(1);
    expect(pin.status).toBe("open");

    const reply = store.addReply(pin.id, "Frontend Dev", "Fixing translateY now");
    expect(reply.pinId).toBe(pin.id);

    const resolved = store.setPinStatus(pin.id, "resolved");
    expect(resolved?.status).toBe("resolved");
    store.setPinGithubUrl(pin.id, "https://github.com/flipcyde101/stagepin/issues/1#issuecomment-1");
    store.close();

    // Reopen from disk and confirm durability
    const reopened = new PinStore(dbPath);
    const loaded = reopened.listPins("/pricing");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].replies).toHaveLength(1);
    expect(loaded[0].status).toBe("resolved");
    expect(loaded[0].githubUrl).toContain("issuecomment-1");
    expect(loaded[0].diagnostics.events[0].status).toBe(500);
    expect(reopened.deletePin(pin.id)).toBe(true);
    expect(reopened.listPins()).toHaveLength(0);
    reopened.close();
  });
});
