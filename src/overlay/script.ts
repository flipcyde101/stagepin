export interface OverlayConfig {
  apiBase: string;
  githubEnabled: boolean;
}

/**
 * Generates the self-contained zero-dependency Shadow DOM overlay JS bundle
 * served at `/__stagepin/overlay.js` (or embeddable via 1-line <script> tag).
 * All user-authored text is rendered via textContent (never innerHTML) to prevent XSS.
 */
export function buildOverlayScript(config: OverlayConfig): string {
  const apiBaseJson = JSON.stringify(config.apiBase);
  const githubEnabledJson = JSON.stringify(config.githubEnabled);

  return `(() => {
  if (window.__STAGEPIN_MOUNTED__) return;
  window.__STAGEPIN_MOUNTED__ = true;

  const API_BASE = ${apiBaseJson};
  const GITHUB_ENABLED = ${githubEnabledJson};
  const MAX_DIAG = 20;
  const diagRing = [];

  function pushDiag(ev) {
    diagRing.push({ ...ev, timestamp: new Date().toISOString() });
    if (diagRing.length > MAX_DIAG) diagRing.shift();
  }

  // Capture console.error & failed fetch events into a bounded ring buffer
  const origConsoleError = console.error.bind(console);
  console.error = (...args) => {
    try {
      pushDiag({
        kind: "console.error",
        message: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 500),
      });
    } catch {}
    return origConsoleError(...args);
  };

  window.addEventListener("error", (ev) => {
    pushDiag({ kind: "window.error", message: String(ev.message || "Unhandled window error").slice(0, 500) });
  });

  if (typeof window.fetch === "function") {
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      try {
        const res = await origFetch(...args);
        if (!res.ok && !url.includes("/__stagepin/")) {
          pushDiag({ kind: "network.error", status: res.status, url: url.slice(0, 300), message: res.statusText || "HTTP " + res.status });
        }
        return res;
      } catch (err) {
        if (!url.includes("/__stagepin/")) {
          pushDiag({ kind: "network.error", url: url.slice(0, 300), message: String(err && err.message || err).slice(0, 300) });
        }
        throw err;
      }
    };
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return "body";
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && depth < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift("#" + CSS.escape(cur.id));
        break;
      }
      const testId = cur.getAttribute("data-testid") || cur.getAttribute("aria-label");
      if (testId) {
        parts.unshift(part + '[aria-label="' + testId.replace(/"/g, '\\\\"') + '"]');
        break;
      }
      const siblings = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName) : [];
      if (siblings.length > 1) {
        part += ":nth-of-type(" + (siblings.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(" > ") || "body";
  }

  const host = document.createElement("div");
  host.id = "stagepin-shadow-host";
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = \`
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .sp-bar {
      position: fixed; bottom: 18px; right: 18px; pointer-events: auto;
      display: flex; align-items: center; gap: 8px; padding: 8px 12px;
      background: #0d1117; color: #e6edf3; border: 1px solid #30363d;
      border-radius: 999px; box-shadow: 0 10px 30px rgba(0,0,0,0.45); font-size: 13px;
    }
    .sp-btn {
      background: #1f6feb; color: #fff; border: 0; border-radius: 999px;
      padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .sp-btn.active { background: #f85149; }
    .sp-btn.ghost { background: #21262d; color: #e6edf3; border: 1px solid #30363d; }
    .sp-pin {
      position: fixed; pointer-events: auto; width: 28px; height: 28px;
      margin: -14px 0 0 -14px; border-radius: 50%; background: #f85149; color: #fff;
      border: 2px solid #fff; font-size: 12px; font-weight: 700; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .sp-pin.resolved { background: #2ea043; opacity: 0.8; }
    .sp-popover {
      position: fixed; right: 18px; bottom: 72px; width: 340px; max-height: 70vh;
      overflow-y: auto; pointer-events: auto; background: #0d1117; color: #e6edf3;
      border: 1px solid #30363d; border-radius: 12px; padding: 14px;
      box-shadow: 0 14px 36px rgba(0,0,0,0.55); font-size: 13px;
    }
    .sp-popover h4 { margin: 0 0 8px 0; font-size: 14px; color: #58a6ff; }
    .sp-meta { font-size: 11px; color: #8b949e; margin-bottom: 8px; word-break: break-all; }
    .sp-input, .sp-textarea {
      width: 100%; background: #161b22; color: #e6edf3; border: 1px solid #30363d;
      border-radius: 8px; padding: 8px; font-size: 12px; margin-bottom: 8px;
    }
    .sp-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .sp-reply { background: #161b22; border-radius: 8px; padding: 8px; margin: 6px 0; font-size: 12px; }
    .sp-diag { background: #1c1012; border: 1px solid #f85149; border-radius: 6px; padding: 6px; font-size: 11px; color: #ffa198; margin: 6px 0; }
  \`;
  shadow.appendChild(style);

  const pinsLayer = document.createElement("div");
  const popoverLayer = document.createElement("div");
  const bar = document.createElement("div");
  bar.className = "sp-bar";

  const brand = document.createElement("strong");
  brand.textContent = "stagepin";
  const countBadge = document.createElement("span");
  countBadge.textContent = "0 pins";
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "sp-btn";
  toggleBtn.textContent = "Pin Mode (Alt+Click)";

  bar.append(brand, countBadge, toggleBtn);
  shadow.append(pinsLayer, popoverLayer, bar);

  let pins = [];
  let pinMode = false;
  let activePinId = null;

  function setPinMode(next) {
    pinMode = next;
    toggleBtn.className = pinMode ? "sp-btn active" : "sp-btn";
    toggleBtn.textContent = pinMode ? "Click Element to Pin..." : "Pin Mode (Alt+Click)";
    document.body.style.cursor = pinMode ? "crosshair" : "";
  }

  toggleBtn.addEventListener("click", () => setPinMode(!pinMode));

  function getPinCoords(pin) {
    try {
      const target = document.querySelector(pin.selector);
      if (target) {
        const rect = target.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          return { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5 };
        }
      }
    } catch {}
    return { x: (pin.xPercent / 100) * window.innerWidth, y: (pin.yPercent / 100) * window.innerHeight };
  }

  function renderPins() {
    pinsLayer.replaceChildren();
    const pagePath = window.location.pathname || "/";
    const visible = pins.filter((p) => p.pagePath === pagePath);
    countBadge.textContent = visible.length + (visible.length === 1 ? " pin" : " pins");

    for (const pin of visible) {
      const pos = getPinCoords(pin);
      const btn = document.createElement("button");
      btn.className = pin.status === "resolved" ? "sp-pin resolved" : "sp-pin";
      btn.style.left = Math.max(16, Math.min(window.innerWidth - 16, pos.x)) + "px";
      btn.style.top = Math.max(16, Math.min(window.innerHeight - 16, pos.y)) + "px";
      btn.textContent = String(pin.id);
      btn.title = pin.body;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        activePinId = pin.id;
        renderPinDrawer(pin);
      });
      pinsLayer.appendChild(btn);
    }
  }

  function renderPinDrawer(pin) {
    popoverLayer.replaceChildren();
    const box = document.createElement("div");
    box.className = "sp-popover";

    const h4 = document.createElement("h4");
    h4.textContent = "Pin #" + pin.id + " (" + pin.status + ")";

    const meta = document.createElement("div");
    meta.className = "sp-meta";
    meta.textContent = pin.author + " | " + pin.selector + " | " + pin.diagnostics.viewportWidth + "x" + pin.diagnostics.viewportHeight;

    const body = document.createElement("p");
    body.style.margin = "0 0 8px 0";
    body.textContent = pin.body;

    box.append(h4, meta, body);

    if (pin.diagnostics && Array.isArray(pin.diagnostics.events) && pin.diagnostics.events.length > 0) {
      const diag = document.createElement("div");
      diag.className = "sp-diag";
      diag.textContent = "Diagnostics: " + pin.diagnostics.events.slice(-3).map((e) => (e.status ? "HTTP " + e.status + " " : "") + e.message).join(" | ");
      box.appendChild(diag);
    }

    if (pin.githubUrl) {
      const ghLink = document.createElement("a");
      ghLink.href = pin.githubUrl;
      ghLink.target = "_blank";
      ghLink.rel = "noopener noreferrer";
      ghLink.style.cssText = "display:block;color:#58a6ff;font-size:12px;margin-bottom:8px;";
      ghLink.textContent = "View on GitHub";
      box.appendChild(ghLink);
    }

    for (const r of pin.replies || []) {
      const rEl = document.createElement("div");
      rEl.className = "sp-reply";
      const rAuthor = document.createElement("strong");
      rAuthor.textContent = r.author + ": ";
      const rText = document.createElement("span");
      rText.textContent = r.body;
      rEl.append(rAuthor, rText);
      box.appendChild(rEl);
    }

    const replyInput = document.createElement("input");
    replyInput.className = "sp-input";
    replyInput.placeholder = "Add a reply...";

    const row = document.createElement("div");
    row.className = "sp-row";

    const replyBtn = document.createElement("button");
    replyBtn.className = "sp-btn";
    replyBtn.textContent = "Reply";
    replyBtn.addEventListener("click", async () => {
      if (!replyInput.value.trim()) return;
      await fetch(API_BASE + "/api/pins/" + pin.id + "/replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: "Reviewer", body: replyInput.value.trim() }),
      });
      replyInput.value = "";
      await loadPins();
    });

    const statusBtn = document.createElement("button");
    statusBtn.className = "sp-btn ghost";
    statusBtn.textContent = pin.status === "open" ? "Resolve" : "Reopen";
    statusBtn.addEventListener("click", async () => {
      await fetch(API_BASE + "/api/pins/" + pin.id + "/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: pin.status === "open" ? "resolved" : "open" }),
      });
      await loadPins();
    });

    if (GITHUB_ENABLED) {
      const ghBtn = document.createElement("button");
      ghBtn.className = "sp-btn ghost";
      ghBtn.textContent = "Push to GitHub";
      ghBtn.addEventListener("click", async () => {
        ghBtn.disabled = true;
        ghBtn.textContent = "Pushing...";
        await fetch(API_BASE + "/api/pins/" + pin.id + "/github", { method: "POST" });
        await loadPins();
      });
      row.appendChild(ghBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "sp-btn ghost";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => {
      activePinId = null;
      popoverLayer.replaceChildren();
    });

    row.prepend(replyBtn, statusBtn);
    row.appendChild(closeBtn);
    box.append(replyInput, row);
    popoverLayer.appendChild(box);
  }

  function renderCreateForm(targetEl, clientX, clientY) {
    popoverLayer.replaceChildren();
    const selector = buildSelector(targetEl);
    const anchorText = (targetEl.textContent || "").trim().slice(0, 120);
    const xPercent = (clientX / Math.max(1, window.innerWidth)) * 100;
    const yPercent = (clientY / Math.max(1, window.innerHeight)) * 100;

    const box = document.createElement("div");
    box.className = "sp-popover";
    const h4 = document.createElement("h4");
    h4.textContent = "New Visual Pin";
    const meta = document.createElement("div");
    meta.className = "sp-meta";
    meta.textContent = selector;

    const authorInput = document.createElement("input");
    authorInput.className = "sp-input";
    authorInput.placeholder = "Your name (optional)";
    authorInput.value = "Reviewer";

    const textarea = document.createElement("textarea");
    textarea.className = "sp-textarea";
    textarea.rows = 3;
    textarea.placeholder = "Describe the UI issue...";

    const row = document.createElement("div");
    row.className = "sp-row";

    const saveBtn = document.createElement("button");
    saveBtn.className = "sp-btn";
    saveBtn.textContent = "Save Pin";
    saveBtn.addEventListener("click", async () => {
      if (!textarea.value.trim()) return;
      const res = await fetch(API_BASE + "/api/pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pagePath: window.location.pathname || "/",
          selector,
          anchorText,
          xPercent,
          yPercent,
          author: authorInput.value.trim() || "Guest",
          body: textarea.value.trim(),
          diagnostics: {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            userAgent: navigator.userAgent,
            events: diagRing.slice(-20),
          },
        }),
      });
      if (res.ok) {
        const created = await res.json();
        activePinId = created.id;
        setPinMode(false);
        await loadPins();
      }
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "sp-btn ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      setPinMode(false);
      popoverLayer.replaceChildren();
    });

    row.append(saveBtn, cancelBtn);
    box.append(h4, meta, authorInput, textarea, row);
    popoverLayer.appendChild(box);
    textarea.focus();
  }

  document.addEventListener("click", (ev) => {
    if (!pinMode && !ev.altKey) return;
    if (ev.target === host || host.contains(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    renderCreateForm(ev.target, ev.clientX, ev.clientY);
  }, true);

  async function loadPins() {
    try {
      const res = await fetch(API_BASE + "/api/pins");
      if (!res.ok) return;
      pins = await res.json();
      renderPins();
      if (activePinId !== null) {
        const found = pins.find((p) => p.id === activePinId);
        if (found) renderPinDrawer(found);
      }
    } catch {}
  }

  window.addEventListener("resize", renderPins);
  window.addEventListener("scroll", renderPins, { passive: true });

  if (typeof EventSource !== "undefined") {
    const es = new EventSource(API_BASE + "/events");
    es.addEventListener("pins", () => { loadPins(); });
  }

  loadPins();
})();
`;
}
