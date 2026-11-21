import { createServer, type Server } from "node:http";

const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AcmeCloud Staging Preview</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
    header { display: flex; justify-content: space-between; align-items: center; padding: 18px 32px; border-bottom: 1px solid #1e293b; }
    .grid { display: flex; gap: 24px; max-width: 960px; margin: 48px auto; padding: 0 24px; }
    .card { flex: 1; background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 24px; }
    .card.pro { border-color: #38bdf8; transform: translateY(18px); }
    button { background: #38bdf8; color: #0f172a; border: 0; border-radius: 8px; padding: 10px 16px; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <header>
    <strong>AcmeCloud Staging (PR #42)</strong>
    <nav>Alt+Click any element to drop a Stagepin comment</nav>
  </header>
  <main class="grid">
    <section id="starter-card" class="card">
      <h2>Starter</h2>
      <p>$19 / month</p>
      <button id="starter-btn">Choose Starter</button>
    </section>
    <section id="pro-card" class="card pro">
      <h2>Pro Plan (Misaligned Card)</h2>
      <p>$79 / month</p>
      <button id="checkout-btn">Upgrade Now</button>
      <p id="checkout-status" style="color:#fda4af;font-size:13px;"></p>
    </section>
  </main>
  <script>
    document.getElementById("checkout-btn").addEventListener("click", async () => {
      const res = await fetch("/api/checkout", { method: "POST" });
      if (!res.ok) {
        console.error("Checkout failed with HTTP " + res.status + " for plan=pro");
        document.getElementById("checkout-status").textContent = "Checkout error (HTTP " + res.status + ")";
      }
    });
  </script>
</body>
</html>`;

export interface DemoUpstream {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export async function startDemoUpstreamSite(): Promise<DemoUpstream> {
  const server = createServer((req, res) => {
    if (req.url === "/api/checkout") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Stripe price_pro_2026 not configured in staging" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline' 'self'; script-src 'self' 'unsafe-inline'",
    });
    res.end(DEMO_HTML);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
