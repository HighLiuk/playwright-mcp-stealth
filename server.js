import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import CDP from "chrome-remote-interface";
import { execFile } from "node:child_process";
import getPort from "get-port";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin()); // stealth ON di default
const registry = new Map();
async function waitForDevtools(port, attempts = 40, sleepMs = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  throw new Error(`DevTools non raggiungibile su :${port}`);
}

async function createSession({
  durationSec = 3600,
  headless = true,
  windowSize = [1280, 939],
  locale = "it-IT",
  timezone = "Europe/Rome",
  stealth = true,
  extraArgs = [],
  port: fixedPort, // opzionale
} = {}) {
  const port = fixedPort || (await getPort());

  // Se vuoi disattivare stealth per debug:
  if (!stealth) chromium.plugins.clear();

  const browser = await chromium.launch({
    headless,
    args: [
      `--remote-debugging-port=${port}`,
      `--window-size=${windowSize[0]},${windowSize[1]}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      ...extraArgs,
    ],
  });
  await browser.newPage({
    locale,
    timezoneId: timezone,
    viewport: { width: windowSize[0], height: windowSize[1] },
  });

  // Assicuriamoci che il DevTools sia up e leggiamo l'endpoint WS
  const version = await waitForDevtools(port, 60, 150);
  const wsBrowserUrl = version.webSocketDebuggerUrl;
  const pid = await pidFromPort(port);

  const id = wsBrowserUrl.split("/").pop();
  const expiresAt =
    durationSec > 0
      ? new Date(Date.now() + durationSec * 1000).toISOString()
      : null;

  // Auto-shutdown
  let timer = null;
  if (durationSec > 0) {
    timer = setTimeout(
      () => destroySession(id).catch(() => {}),
      durationSec * 1000
    );
  }

  registry.set(id, {
    id,
    port,
    wsBrowserUrl,
    pid,
    expiresAt,
    timer,
    browser,
  });
  return registry.get(id);
}

async function destroySession(id) {
  const s = registry.get(id);
  if (!s) return false;
  try {
    await s.browser?.close();
  } catch {}
  if (s.timer) clearTimeout(s.timer);
  registry.delete(id);
  return true;
}

// ---------- Utilities ----------
function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout, stderr });
      }
    );
  });
}

async function pidFromPort(port) {
  try {
    const { stdout } = await execFileP("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
    const m = stdout.match(/p(\d+)/);
    if (m) return Number(m[1]);
  } catch {}

  // Fallback Linux con ss (se lsof non c’è)
  try {
    const { stdout } = await execFileP("ss", ["-ltnp"]);
    const line = stdout.split("\n").find((l) => l.includes(`:${port} `));
    // estrae pid da users:(("chrome",pid=1234,fd=...))
    const m = line && line.match(/pid=(\d+)/);
    if (m) return Number(m[1]);
  } catch {}
  return null;
}

function httpOriginFromWs(wsUrl) {
  const u = new URL(wsUrl);
  const proto = u.protocol === "wss:" ? "https:" : "http:";
  return `${proto}//${u.host}`;
}

async function fetchJson(url, timeoutMs = 500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------- Active tab detection ----------
async function listPages(browserWs) {
  const origin = httpOriginFromWs(browserWs);
  const j = await fetchJson(`${origin}/json/list`, 700);
  return (Array.isArray(j) ? j : [])
    .filter((x) => x.type === "page" && x.webSocketDebuggerUrl)
    .map((x) => ({
      id: x.id,
      url: x.url,
      title: x.title || "",
      ws: x.webSocketDebuggerUrl,
    }));
}

async function evalFocus(wsUrl) {
  let client;
  try {
    client = await CDP({ target: wsUrl });
    const { Runtime } = client;
    await Runtime.enable();
    const res = await Runtime.evaluate({
      expression: `({ visible: document.visibilityState==="visible", focus: document.hasFocus() })`,
      returnByValue: true,
    });
    return res?.result?.value || { visible: false, focus: false };
  } catch {
    return { visible: false, focus: false };
  } finally {
    try {
      await client?.close();
    } catch {}
  }
}

async function findActivePageWs(browserWs) {
  const pages = await listPages(browserWs);
  if (pages.length === 0)
    throw new Error("Nessun tab di tipo 'page' disponibile.");
  const checks = await Promise.all(
    pages.map(async (p) => ({ ...p, ...(await evalFocus(p.ws)) }))
  );
  const focused = checks.find((c) => c.focus);
  if (focused) return focused.ws;
  const visible = checks.find((c) => c.visible);
  if (visible) return visible.ws;
  return pages[0].ws;
}

// ---------- Server setup ----------
const ui = express();
const api = express();
const uiServer = http.createServer(ui);
const apiServer = http.createServer(api);

ui.use(express.static("public"));
api.use(express.json()); // per leggere body JSON nelle POST

// LIST: per la sidebar
ui.get("/sessions", (req, res) => {
  const sessions = [...registry.values()].map((s) => ({
    id: s.id,
    port: s.port,
    pid: s.pid,
    ws: s.wsBrowserUrl,
    expiresAt: s.expiresAt,
  }));
  res.json({ sessions });
});

// CREATE: avvia browser con Playwright+Stealth
api.post("/session", async (req, res) => {
  try {
    const sess = await createSession(req.body || {});
    res.status(201).json({
      id: sess.id,
      port: sess.port,
      pid: sess.pid,
      ws: sess.wsBrowserUrl,
      expiresAt: sess.expiresAt,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE: chiude e ripulisce
api.delete("/session/:id", async (req, res) => {
  try {
    const ok = await destroySession(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- WebSocket bridge: streams the active tab for the selected session ---
const wss = new WebSocketServer({ server: uiServer, path: "/bridge" });
wss.on("connection", (wsClient) => {
  let pageClient = null; // CDP client for current PAGE target
  let page = null;
  let currentWs = null;
  let watcher = null;

  const send = (obj) =>
    wsClient.readyState === 1 && wsClient.send(JSON.stringify(obj));
  const status = (m) => send({ type: "status", message: m });

  async function stopStream() {
    try {
      await page?.stopScreencast();
    } catch {}
    try {
      await pageClient?.close();
    } catch {}
    pageClient = page = null;
  }

  async function attachAndStream(targetWs) {
    if (targetWs === currentWs && pageClient) return;
    await stopStream();
    status("Connessione al tab attivo…");
    pageClient = await CDP({ target: targetWs });
    page = pageClient.Page;
    await page.enable();

    page.screencastFrame(({ data, metadata, sessionId }) => {
      const w = metadata?.deviceWidth,
        h = metadata?.deviceHeight;
      send({ type: "frame", data, w, h });
      page.screencastFrameAck({ sessionId });
    });
    await page.startScreencast({
      format: "jpeg",
      quality: 80,
      everyNthFrame: 1,
    });
    currentWs = targetWs;
    status("In diretta (tab attivo) ✔");
  }

  wsClient.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "connect") return;
      const { wsBrowserUrl } = msg;
      if (!wsBrowserUrl) throw new Error("Manca wsBrowserUrl della sessione.");

      // Primo attach
      const ws = await findActivePageWs(wsBrowserUrl);
      await attachAndStream(ws);

      // Segui cambi tab attivo ogni ~700ms
      clearInterval(watcher);
      watcher = setInterval(async () => {
        try {
          const next = await findActivePageWs(wsBrowserUrl);
          if (next !== currentWs) await attachAndStream(next);
        } catch (e) {
          status("Watcher: " + e.message);
        }
      }, 700);
    } catch (e) {
      status("Errore: " + e.message);
    }
  });

  wsClient.on("close", async () => {
    clearInterval(watcher);
    await stopStream();
  });
});

uiServer.listen(3000, () => {
  console.log("CDP Embed Viewer UI -> http://localhost:3000");
});
apiServer.listen(3001, () => {
  console.log("CDP Embed Viewer API -> http://localhost:3001");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    for (const { id } of [...registry.values()]) {
      try {
        await destroySession(id);
      } catch {}
    }
    process.exit(0);
  });
}
