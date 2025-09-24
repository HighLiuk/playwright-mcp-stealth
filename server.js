import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import CDP from "chrome-remote-interface";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

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

// ---------- Session discovery (macOS/Linux) ----------
const BROWSER_CMD_RE =
  /(chrome|chromium|brave|edge|msedge|electron|headless|arc|opera)/i;

async function listListeningPortsUnix() {
  // Use lsof machine-readable output to map PID -> COMMAND -> PORT
  // -F pcn prints fields: p=PID, c=COMMAND, n=NAME (contains host:port)
  const { stdout } = await execFileP("lsof", [
    "-nP",
    "-iTCP",
    "-sTCP:LISTEN",
    "-F",
    "pcn",
  ]);
  const lines = stdout.split(/\r?\n/);
  const rows = [];
  let cur = { pid: null, cmd: null };
  for (const line of lines) {
    if (!line) continue;
    const tag = line[0],
      val = line.slice(1);
    if (tag === "p") {
      cur = { pid: Number(val), cmd: cur.cmd };
    } else if (tag === "c") {
      cur.cmd = val;
    } else if (tag === "n") {
      // Expect ...:<port>
      const m = val.match(/:(\d+)\b/);
      if (m && cur.pid && cur.cmd) {
        rows.push({ pid: cur.pid, cmd: cur.cmd, port: Number(m[1]) });
      }
    }
  }
  return rows;
}

async function discoverSessions() {
  const sessions = [];
  if (process.platform === "darwin" || process.platform === "linux") {
    let ports = [];
    try {
      ports = await listListeningPortsUnix();
    } catch (e) {
      // lsof not available
      return sessions;
    }

    // Keep only browser-like commands
    const candidates = ports.filter((p) => BROWSER_CMD_RE.test(p.cmd));

    // Probe each port for DevTools /json/version
    const probes = await Promise.all(
      candidates.map(async ({ pid, cmd, port }) => {
        try {
          const j = await fetchJson(
            `http://127.0.0.1:${port}/json/version`,
            500
          );
          if (j && j.webSocketDebuggerUrl) {
            return {
              pid,
              port,
              cmd,
              browser: j.Browser || j["User-Agent"] || cmd,
              wsBrowserUrl: j.webSocketDebuggerUrl,
            };
          }
        } catch (_) {}
        return null;
      })
    );

    for (const s of probes) if (s) sessions.push(s);
  } else {
    // TODO: Implement Windows via netstat/PowerShell if needed
    return sessions;
  }
  // Deduplicate by wsBrowserUrl (just in case)
  const seen = new Set();
  return sessions.filter((s) => {
    if (seen.has(s.wsBrowserUrl)) return false;
    seen.add(s.wsBrowserUrl);
    return true;
  });
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
const app = express();
const server = http.createServer(app);
app.use(express.static("public"));

app.get("/sessions", async (req, res) => {
  try {
    const list = await discoverSessions();
    // Shape for UI
    const ui = list.map((s) => ({
      id: s.wsBrowserUrl,
      label: `${s.browser} (pid:${s.pid}, port:${s.port})`,
      browser: s.browser,
      pid: s.pid,
      port: s.port,
      ws: s.wsBrowserUrl,
    }));
    res.json({ sessions: ui });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- WebSocket bridge: streams the active tab for the selected session ---
const wss = new WebSocketServer({ server, path: "/bridge" });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(
    "CDP Embed Viewer v4 (sessions + active tab) -> http://localhost:" + PORT
  );
});
