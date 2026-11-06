"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const MAX_SESSIONS = 500;
const MAX_MEMBERS = 12;
const GUEST_GRACE_MS = 90 * 1000;      // keep a dropped guest's seat this long
const HOST_GRACE_MS = 10 * 60 * 1000;  // keep a session alive this long without its host

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".json": "application/json", ".ico": "image/x-icon", ".png": "image/png",
};

/* ---------- WebRTC ICE servers (set ICE_SERVERS env var to add TURN) ---------- */
let ICE = [{ urls: "stun:stun.l.google.com:19302" }];
try { if (process.env.ICE_SERVERS) ICE = JSON.parse(process.env.ICE_SERVERS); } catch { console.error("Bad ICE_SERVERS JSON, using default STUN."); }

/* ---------- static files ---------- */
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent((req.url || "/").split("?")[0]); } catch { res.writeHead(400).end(); return; }
  if (p === "/healthz") { res.writeHead(200).end("ok"); return; }
  if (p === "/ice") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(ICE)); return;
  }
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUB, p));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  });
});

/* ---------- sessions ---------- */
const sessions = new Map(); // code -> session
const rand = (n) => crypto.randomBytes(n).toString("hex");

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(crypto.randomInt(100000, 1000000));
    if (!sessions.has(c)) return c;
  }
  return null;
}
function cleanName(n) {
  const s = String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 20);
  return s || "Guest";
}
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(s, obj, except) {
  const data = JSON.stringify(obj);
  for (const m of s.members.values()) {
    if (m.ws && m.ws !== except && m.ws.readyState === 1) m.ws.send(data);
  }
}
function peersMsg(s) {
  return {
    t: "peers",
    list: [...s.members.values()].map((m) => ({
      id: m.id, name: m.name, host: m.id === s.hostId, ready: m.ready, online: !!m.ws,
    })),
  };
}
function attach(ws, s, m) {
  if (m.ws && m.ws !== ws) { m.ws.ctx = null; m.ws.close(4000, "replaced"); }
  m.ws = ws; m.lastSeen = Date.now(); ws.ctx = { s, m };
  send(ws, { t: "joined", code: s.code, id: m.id, token: m.token, host: m.id === s.hostId, state: s.state });
  broadcast(s, peersMsg(s));
}
function endSession(s, reason) {
  broadcast(s, { t: "ended", reason });
  for (const m of s.members.values()) if (m.ws) { m.ws.ctx = null; m.ws.close(1000, "ended"); }
  sessions.delete(s.code);
}
function fail(ws, code, msg) { send(ws, { t: "error", code, msg }); }

function handle(ws, m) {
  if (m.t === "ping") { send(ws, { t: "pong", c: String(m.c).slice(0, 16), s: Date.now() }); return; }

  if (!ws.ctx) {
    if (m.t === "create") {
      if (sessions.size >= MAX_SESSIONS) return fail(ws, "busy", "The server is full. Try again in a few minutes.");
      const code = newCode();
      if (!code) return fail(ws, "busy", "Couldn’t create a session. Try again.");
      const id = rand(6);
      const s = { code, hostId: id, members: new Map(), state: { playing: false, pos: 0, at: Date.now() }, hostGone: 0 };
      const mem = { id, name: cleanName(m.name), token: rand(16), ws: null, ready: false, lastSeen: Date.now() };
      s.members.set(id, mem); sessions.set(code, s);
      attach(ws, s, mem);
    } else if (m.t === "join") {
      const s = sessions.get(String(m.code));
      if (!s) return fail(ws, "nocode", "No session with that code. Check the digits and try again.");
      if (s.members.size >= MAX_MEMBERS) return fail(ws, "full", "This session is full.");
      const id = rand(6);
      const mem = { id, name: cleanName(m.name), token: rand(16), ws: null, ready: false, lastSeen: Date.now() };
      s.members.set(id, mem);
      attach(ws, s, mem);
    } else if (m.t === "resume") {
      const s = sessions.get(String(m.code));
      const mem = s && s.members.get(String(m.id));
      if (!mem || mem.token !== m.token) return fail(ws, "gone", "This session has ended.");
      s.hostGone = 0;
      attach(ws, s, mem);
    }
    return;
  }

  const { s, m: me } = ws.ctx;
  const isHost = me.id === s.hostId;
  switch (m.t) {
    case "state": {
      if (!isHost) return;
      const pos = Number(m.pos), now = Date.now();
      if (!Number.isFinite(pos) || pos < 0) return;
      let at = Number(m.at);
      if (!Number.isFinite(at) || Math.abs(at - now) > 5000) at = now;
      s.state = { playing: !!m.playing, pos, at };
      broadcast(s, { t: "state", ...s.state }, ws);
      break;
    }
    case "rtc": {            // relay WebRTC signalling: guests talk to the host, the host talks to anyone
      const to = s.members.get(String(m.to));
      if (!to || !to.ws || !m.data || typeof m.data !== "object") return;
      if (!isHost && to.id !== s.hostId) return;
      send(to.ws, { t: "rtc", from: me.id, data: m.data });
      break;
    }
    case "ready": me.ready = !!m.ready; broadcast(s, peersMsg(s)); break;
    case "rename": me.name = cleanName(m.name); broadcast(s, peersMsg(s)); break;
    case "leave":
      ws.ctx = null;
      if (isHost) endSession(s, "The host ended the session.");
      else { s.members.delete(me.id); me.ws = null; broadcast(s, peersMsg(s)); }
      break;
  }
}

/* ---------- websocket ---------- */
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16384 });
wss.on("connection", (ws) => {
  ws.isAlive = true; ws.ctx = null;
  let count = 0;
  const rl = setInterval(() => { count = 0; }, 1000);
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => {
    if (++count > 150) { ws.close(1008, "rate limit"); return; }
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== "string") return;
    try { handle(ws, m); } catch (e) { console.error(e); }
  });
  ws.on("close", () => {
    clearInterval(rl);
    if (ws.ctx) {
      const { s, m } = ws.ctx;
      if (m.ws === ws) { m.ws = null; m.lastSeen = Date.now(); broadcast(s, peersMsg(s)); }
    }
  });
  ws.on("error", () => {});
});

setInterval(() => {            // drop dead sockets
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25000);

setInterval(() => {            // tidy up sessions
  const now = Date.now();
  for (const s of sessions.values()) {
    let changed = false;
    for (const m of [...s.members.values()]) {
      if (m.id !== s.hostId && !m.ws && now - m.lastSeen > GUEST_GRACE_MS) { s.members.delete(m.id); changed = true; }
    }
    const host = s.members.get(s.hostId);
    if (host && !host.ws) {
      if (!s.hostGone) s.hostGone = now;
      if (now - s.hostGone > HOST_GRACE_MS) { endSession(s, "The host left."); continue; }
    } else s.hostGone = 0;
    if (changed) broadcast(s, peersMsg(s));
  }
}, 15000);

server.listen(PORT, () => console.log("Silent Cinema running on http://localhost:" + PORT));
