import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CreatePinInput, Pin, PinDiagnostics, PinReply, PinStatus } from "../types.js";

interface PinRow {
  id: number;
  page_path: string;
  selector: string;
  anchor_text: string;
  x_percent: number;
  y_percent: number;
  author: string;
  body: string;
  status: string;
  diagnostics_json: string;
  github_url: string | null;
  created_at: string;
}

interface ReplyRow {
  id: number;
  pin_id: number;
  author: string;
  body: string;
  created_at: string;
}

function normalizeDiagnostics(input?: Partial<PinDiagnostics>): PinDiagnostics {
  return {
    viewportWidth: typeof input?.viewportWidth === "number" && Number.isFinite(input.viewportWidth) ? Math.max(0, Math.round(input.viewportWidth)) : 0,
    viewportHeight: typeof input?.viewportHeight === "number" && Number.isFinite(input.viewportHeight) ? Math.max(0, Math.round(input.viewportHeight)) : 0,
    userAgent: typeof input?.userAgent === "string" ? input.userAgent.slice(0, 400) : "",
    events: Array.isArray(input?.events)
      ? input.events.slice(-20).map((e) => ({
          kind: e.kind === "network.error" || e.kind === "window.error" ? e.kind : "console.error",
          timestamp: typeof e.timestamp === "string" ? e.timestamp.slice(0, 40) : new Date().toISOString(),
          message: typeof e.message === "string" ? e.message.slice(0, 600) : "",
          status: typeof e.status === "number" && Number.isFinite(e.status) ? e.status : undefined,
          url: typeof e.url === "string" ? e.url.slice(0, 500) : undefined,
        }))
      : [],
  };
}

export class PinStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS pins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_path TEXT NOT NULL,
        selector TEXT NOT NULL,
        anchor_text TEXT NOT NULL DEFAULT '',
        x_percent REAL NOT NULL,
        y_percent REAL NOT NULL,
        author TEXT NOT NULL DEFAULT 'Guest',
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        diagnostics_json TEXT NOT NULL DEFAULT '{}',
        github_url TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pin_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin_id INTEGER NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
        author TEXT NOT NULL DEFAULT 'Guest',
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pins_page_path ON pins(page_path);
      CREATE INDEX IF NOT EXISTS idx_replies_pin_id ON pin_replies(pin_id);
    `);
  }

  private hydratePin(row: PinRow): Pin {
    const replies = this.db
      .prepare("SELECT id, pin_id, author, body, created_at FROM pin_replies WHERE pin_id = ? ORDER BY id ASC")
      .all(row.id) as unknown as ReplyRow[];

    let parsedDiag: Partial<PinDiagnostics> = {};
    try {
      parsedDiag = JSON.parse(row.diagnostics_json) as Partial<PinDiagnostics>;
    } catch {
      parsedDiag = {};
    }

    return {
      id: row.id,
      pagePath: row.page_path,
      selector: row.selector,
      anchorText: row.anchor_text,
      xPercent: row.x_percent,
      yPercent: row.y_percent,
      author: row.author,
      body: row.body,
      status: row.status === "resolved" ? "resolved" : "open",
      diagnostics: normalizeDiagnostics(parsedDiag),
      githubUrl: row.github_url,
      createdAt: row.created_at,
      replies: replies.map((r) => ({
        id: r.id,
        pinId: r.pin_id,
        author: r.author,
        body: r.body,
        createdAt: r.created_at,
      })),
    };
  }

  createPin(input: CreatePinInput): Pin {
    const body = input.body.trim();
    if (!body) throw new Error("Pin comment body is required");
    const pagePath = (input.pagePath || "/").slice(0, 500);
    const selector = (input.selector || "body").slice(0, 500);
    const anchorText = (input.anchorText ?? "").trim().slice(0, 200);
    const author = (input.author ?? "Guest").trim().slice(0, 80) || "Guest";
    const xPercent = Math.max(0, Math.min(100, Number.isFinite(input.xPercent) ? input.xPercent : 50));
    const yPercent = Math.max(0, Math.min(100, Number.isFinite(input.yPercent) ? input.yPercent : 50));
    const diagnostics = normalizeDiagnostics(input.diagnostics);
    const now = new Date().toISOString();

    const res = this.db
      .prepare(
        `INSERT INTO pins (page_path, selector, anchor_text, x_percent, y_percent, author, body, status, diagnostics_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(pagePath, selector, anchorText, xPercent, yPercent, author, body.slice(0, 4000), JSON.stringify(diagnostics), now);

    const id = Number(res.lastInsertRowid);
    const created = this.getPin(id);
    if (!created) throw new Error("Failed to reload inserted pin");
    return created;
  }

  getPin(id: number): Pin | null {
    const row = this.db.prepare("SELECT * FROM pins WHERE id = ?").get(id) as unknown as PinRow | undefined;
    return row ? this.hydratePin(row) : null;
  }

  listPins(pagePath?: string): Pin[] {
    const rows = pagePath
      ? (this.db.prepare("SELECT * FROM pins WHERE page_path = ? ORDER BY id ASC").all(pagePath) as unknown as PinRow[])
      : (this.db.prepare("SELECT * FROM pins ORDER BY id ASC").all() as unknown as PinRow[]);
    return rows.map((r) => this.hydratePin(r));
  }

  addReply(pinId: number, author: string, body: string): PinReply {
    const cleanBody = body.trim();
    if (!cleanBody) throw new Error("Reply body is required");
    if (!this.getPin(pinId)) throw new Error(`Pin #${pinId} not found`);
    const cleanAuthor = author.trim().slice(0, 80) || "Guest";
    const now = new Date().toISOString();

    const res = this.db
      .prepare("INSERT INTO pin_replies (pin_id, author, body, created_at) VALUES (?, ?, ?, ?)")
      .run(pinId, cleanAuthor, cleanBody.slice(0, 4000), now);

    return {
      id: Number(res.lastInsertRowid),
      pinId,
      author: cleanAuthor,
      body: cleanBody.slice(0, 4000),
      createdAt: now,
    };
  }

  setPinStatus(pinId: number, status: PinStatus): Pin | null {
    const res = this.db.prepare("UPDATE pins SET status = ? WHERE id = ?").run(status, pinId);
    if (res.changes === 0) return null;
    return this.getPin(pinId);
  }

  setPinGithubUrl(pinId: number, url: string): Pin | null {
    const res = this.db.prepare("UPDATE pins SET github_url = ? WHERE id = ?").run(url, pinId);
    if (res.changes === 0) return null;
    return this.getPin(pinId);
  }

  deletePin(pinId: number): boolean {
    const res = this.db.prepare("DELETE FROM pins WHERE id = ?").run(pinId);
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
