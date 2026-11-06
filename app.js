(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const v = $("video");
const AC = window.AudioContext || window.webkitAudioContext;

/* ---------- state ---------- */
const S = {
  ws: null, me: null, peers: [], intent: null, online: false, backoff: 500, rt: null,
  state: { playing: false, pos: 0 }, ice: [{ urls: "stun:stun.l.google.com:19302" }], wake: null,
  // host
  hasFile: false, fileUrl: null, aud: null, actx: null, asrc: null, stream: null, pcs: new Map(), lead: 300,
  // guest
  gpc: null, gq: [], gctx: null, gsrc: null, gdelay: null, helloSent: false, delay: 0, listening: false,
};
const sget = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const sset = (k, x) => { try { sessionStorage.setItem(k, x); } catch {} };
const sdel = (k) => { try { sessionStorage.removeItem(k); } catch {} };
const lget = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lset = (k, x) => { try { localStorage.setItem(k, x); } catch {} };
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
};
let toastT;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3200);
}
fetch("/ice").then((r) => r.json()).then((x) => { if (Array.isArray(x)) S.ice = x; }).catch(() => {});

/* ---------- name + code ---------- */
$("name").value = lget("sc_name") || "";
const myName = () => {
  const n = $("name").value.trim();
  if (n) lset("sc_name", n);
  return n || "Guest " + (10 + Math.floor(Math.random() * 90));
};
const hash = (location.hash || "").replace("#", "");
if (/^\d{6}$/.test(hash)) $("code").value = hash;
$("code").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });
S.lead = +lget("sc_lead") || 300; $("lead").value = S.lead; $("lv").textContent = S.lead + " ms";

/* ---------- websocket ---------- */
function connect() {
  clearTimeout(S.rt);
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  S.ws = ws;
  ws.onopen = () => { S.backoff = 500; S.online = true; S.helloSent = false; setConn(); if (S.intent) send(S.intent); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.online = false; setConn();
    if (S.intent) { S.rt = setTimeout(connect, S.backoff); S.backoff = Math.min(S.backoff * 2, 5000); }
  };
  ws.onerror = () => {};
}
function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }
function setConn() {
  const p = $("conn"), b = p.querySelector("b");
  p.className = "pill " + (S.online ? "on" : "off");
  b.textContent = S.online ? "Connected" : "Reconnecting…";
}
function handle(m) {
  switch (m.t) {
    case "joined": onJoined(m); break;
    case "peers": S.peers = m.list || []; renderPeers(); afterPeers(); break;
    case "state": S.state = { playing: !!m.playing, pos: +m.pos || 0 }; renderGuest(); break;
    case "rtc": onRtc(m).catch(() => {}); break;
    case "ended": toast(m.reason || "The session ended."); resetToHome(); break;
    case "error":
      if (m.code === "gone") { toast(m.msg); resetToHome(); }
      else { $("homeErr").textContent = m.msg || "Something went wrong."; S.intent = null; if (S.ws) S.ws.close(); }
      break;
  }
}
function onJoined(m) {
  S.me = { code: m.code, id: m.id, token: m.token, host: m.host };
  S.intent = { t: "resume", code: m.code, id: m.id, token: m.token };
  sset("sc", JSON.stringify(S.me));
  S.state = m.state || S.state;
  showRoom();
  if (S.me.host && S.hasFile) { send({ t: "ready", ready: true }); pushState(); }
  if (!S.me.host && S.listening) send({ t: "ready", ready: true });
}

/* ---------- views ---------- */
function showRoom() {
  $("home").hidden = true; $("room").hidden = false;
  $("roomCode").textContent = S.me.code;
  const host = S.me.host;
  $("filePanel").hidden = !host; $("hostCtl").hidden = !host; $("guestCtl").hidden = host;
  $("stage").hidden = !(host && S.hasFile);
  setConn(); renderPeers(); updateHostUi(); renderGuest();
}
function resetToHome() {
  S.intent = null; S.me = null; S.peers = []; sdel("sc");
  clearTimeout(S.rt);
  if (S.ws) { const w = S.ws; S.ws = null; w.onclose = null; try { w.close(); } catch {} }
  S.pcs.forEach((pc) => { pc.onconnectionstatechange = null; pc.close(); }); S.pcs.clear();
  closeGuestPc(); S.listening = false; S.helloSent = false;
  v.pause(); v.removeAttribute("src"); v.load();
  if (S.aud) { S.aud.pause(); S.aud.removeAttribute("src"); }
  if (S.fileUrl) URL.revokeObjectURL(S.fileUrl);
  S.fileUrl = null; S.hasFile = false; $("file").value = ""; $("finfo").textContent = ""; $("finfo").className = "finfo";
  $("dropText").textContent = "Choose a movie file";
  $("room").hidden = true; $("home").hidden = false; $("stage").hidden = true;
  releaseWake();
}

/* ---------- home actions ---------- */
function begin(intent) { $("homeErr").textContent = ""; S.intent = intent; connect(); }
$("create").onclick = () => begin({ t: "create", name: myName() });
$("join").onclick = () => {
  const c = $("code").value.trim();
  if (!/^\d{6}$/.test(c)) { $("homeErr").textContent = "Enter the 6-digit code from your host."; return; }
  guestCtx();                                   // this tap lets the browser play audio later
  begin({ t: "join", code: c, name: myName() });
};
$("code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join").click(); });
$("leave").onclick = () => { send({ t: "leave" }); resetToHome(); };

/* ---------- WebRTC helpers ---------- */
function newPC(id, onFail) {
  const pc = new RTCPeerConnection({ iceServers: S.ice });
  pc.onicecandidate = (e) => { if (e.candidate) send({ t: "rtc", to: id, data: { cand: e.candidate } }); };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "failed" || st === "closed") onFail(pc);
    else if (st === "disconnected") setTimeout(() => { if (pc.connectionState === "disconnected") onFail(pc); }, 5000);
    renderPeers(); renderGuest();
  };
  return pc;
}
async function onRtc(m) {
  const d = m.data || {};
  if (S.me && S.me.host) {
    if (d.hello) { dropPc(m.from); await callGuest(m.from); }
    else if (d.sdp && d.sdp.type === "answer") { const pc = S.pcs.get(m.from); if (pc) await pc.setRemoteDescription(d.sdp); }
    else if (d.cand) { const pc = S.pcs.get(m.from); if (pc) try { await pc.addIceCandidate(d.cand); } catch {} }
    return;
  }
  if (d.sdp && d.sdp.type === "offer") {
    closeGuestPc();
    const pc = newPC(m.from, (p) => { if (S.gpc === p) { closeGuestPc(); S.listening = false; S.helloSent = false; send({ t: "ready", ready: false }); afterPeers(); } });
    S.gpc = pc;
    pc.ontrack = (e) => attachStream(e.streams[0] || new MediaStream([e.track]));
    await pc.setRemoteDescription(d.sdp);
    for (const c of S.gq.splice(0)) { try { await pc.addIceCandidate(c); } catch {} }
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
    send({ t: "rtc", to: m.from, data: { sdp: pc.localDescription } });
  } else if (d.cand) {
    if (S.gpc && S.gpc.remoteDescription) { try { await S.gpc.addIceCandidate(d.cand); } catch {} }
    else S.gq.push(d.cand);
  }
}

/* ---------- host: movie file and audio stream ---------- */
function loadFile(f) {
  if (!f || !S.me || !S.me.host) return;
  const fi = $("finfo");
  fi.className = "finfo"; fi.textContent = "Loading " + f.name + "…";
  if (S.fileUrl) URL.revokeObjectURL(S.fileUrl);
  S.hasFile = false;
  v.onloadedmetadata = () => {
    S.hasFile = true;
    fi.className = "finfo ok"; fi.textContent = "✓ " + f.name + " · " + fmt(v.duration);
    $("dropText").textContent = "Change movie";
    $("stage").hidden = false;
    $("seek").max = Math.floor(v.duration || 0); $("tDur").textContent = fmt(v.duration);
    setupHostAudio();
    send({ t: "ready", ready: true });
    updateHostUi(); pushState(); afterPeers();
  };
  v.onerror = () => {
    const unsupported = v.error && v.error.code === 4;
    S.hasFile = false; send({ t: "ready", ready: false });
    fi.className = "finfo bad";
    fi.textContent = "✗ Can’t play " + f.name + ". " + (unsupported
      ? "Your browser doesn’t support this format. Convert it to MP4 (H.264 video + AAC audio) and try again."
      : "Playback error. Try another file.");
  };
  S.fileUrl = URL.createObjectURL(f);
  v.src = S.fileUrl; v.load();
}
$("file").onchange = (e) => loadFile(e.target.files && e.target.files[0]);
const drop = $("drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files && e.dataTransfer.files[0]));

// A hidden audio-only copy of the movie plays slightly AHEAD of the picture.
// Its sound goes to friends over WebRTC; the lead cancels the network + Bluetooth delay.
function setupHostAudio() {
  if (!S.actx) {
    S.actx = new AC();
    S.aud = new Audio(); S.aud.preload = "auto";
    S.asrc = S.actx.createMediaElementSource(S.aud);
    const dest = S.actx.createMediaStreamDestination();
    S.asrc.connect(dest);                       // only to the stream, never to this phone's speaker
    S.stream = dest.stream;
  }
  S.aud.src = S.fileUrl; S.aud.load();
  S.actx.resume().catch(() => {});
  mirrorAudio();
}
function mirrorAudio() {
  const a = S.aud; if (!a || !S.me || !S.me.host) return;
  if (v.paused || v.ended) {
    if (!a.paused) a.pause();
    if (Math.abs(a.currentTime - v.currentTime) > 0.05) a.currentTime = v.currentTime;
    a.playbackRate = 1; return;
  }
  const want = Math.min(v.currentTime + S.lead / 1000, (v.duration || 1e9) - 0.05), d = a.currentTime - want;
  if (Math.abs(d) > 0.25) { a.currentTime = Math.max(0, want); a.playbackRate = 1; }
  else a.playbackRate = Math.abs(d) > 0.03 ? (d > 0 ? 0.98 : 1.02) : 1;
  if (a.paused) a.play().catch(() => {});
}
["play", "pause", "seeked", "ended", "timeupdate"].forEach((ev) => v.addEventListener(ev, mirrorAudio));
setInterval(mirrorAudio, 400);

async function callGuest(id) {
  if (!S.stream || S.pcs.has(id)) return;
  const pc = newPC(id, (p) => {
    if (S.pcs.get(id) !== p) return;
    dropPc(id);
    setTimeout(() => { const g = S.peers.find((x) => x.id === id); if (g && g.online) callGuest(id); }, 1500);
  });
  S.pcs.set(id, pc);
  S.stream.getAudioTracks().forEach((t) => pc.addTrack(t, S.stream));
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  send({ t: "rtc", to: id, data: { sdp: pc.localDescription } });
}
function dropPc(id) { const pc = S.pcs.get(id); if (pc) { pc.onconnectionstatechange = null; pc.close(); S.pcs.delete(id); } }

function pushState() {
  if (!S.me || !S.me.host || !S.hasFile) return;
  send({ t: "state", playing: !v.paused && !v.ended, pos: v.currentTime, at: Date.now() });
}
["play", "pause", "seeked", "ended"].forEach((ev) => v.addEventListener(ev, () => {
  if (S.me && S.me.host) { pushState(); updateHostUi(); if (ev === "play") requestWake(); else if (ev !== "seeked") releaseWake(); }
}));
function updateHostUi() {
  const en = !!(S.me && S.me.host && S.hasFile);
  ["play", "back", "fwd", "seek"].forEach((id) => { $(id).disabled = !en; });
  $("play").textContent = v.paused ? "▶" : "⏸";
  $("play").setAttribute("aria-label", v.paused ? "Play" : "Pause");
}
$("play").onclick = () => {
  if (S.actx) S.actx.resume().catch(() => {});
  if (v.paused) v.play().catch(() => toast("Tap again to start playback.")); else v.pause();
};
$("back").onclick = () => { v.currentTime = Math.max(0, v.currentTime - 10); };
$("fwd").onclick = () => { v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10); };
$("seek").oninput = (e) => { $("tCur").textContent = fmt(+e.target.value); };
$("seek").onchange = (e) => { v.currentTime = +e.target.value; };
v.addEventListener("timeupdate", () => {
  if (document.activeElement !== $("seek")) { $("seek").value = Math.floor(v.currentTime); $("tCur").textContent = fmt(v.currentTime); }
});
$("lead").oninput = (e) => { S.lead = +e.target.value; lset("sc_lead", S.lead); $("lv").textContent = S.lead + " ms"; mirrorAudio(); };

/* ---------- guest: play the host's audio ---------- */
function guestCtx() {
  if (!S.gctx && AC) {
    S.gctx = new AC();
    S.gdelay = S.gctx.createDelay(2); S.gdelay.delayTime.value = S.delay / 1000;
    S.gdelay.connect(S.gctx.destination);
  }
  if (S.gctx && S.gctx.state !== "running") S.gctx.resume().catch(() => {});
  return S.gctx;
}
function attachStream(stream) {
  const a = $("audio"); a.srcObject = stream; a.muted = true; a.play().catch(() => {}); // keeps the stream flowing in Chrome
  const ctx = guestCtx(); if (!ctx) return;
  try { if (S.gsrc) S.gsrc.disconnect(); } catch {}
  S.gsrc = ctx.createMediaStreamSource(stream); S.gsrc.connect(S.gdelay);
  S.listening = true; send({ t: "ready", ready: true });
  renderGuest(); renderPeers();
}
function closeGuestPc() {
  if (S.gpc) { S.gpc.onconnectionstatechange = null; S.gpc.close(); S.gpc = null; }
  S.gq = [];
  try { if (S.gsrc) S.gsrc.disconnect(); } catch {} S.gsrc = null;
  $("audio").srcObject = null;
}
const hostPeer = () => S.peers.find((p) => p.host);
function afterPeers() {
  if (!S.me) return;
  if (S.me.host) { if (S.stream) S.peers.forEach((p) => { if (!p.host && p.online && !S.pcs.has(p.id)) callGuest(p.id).catch(() => {}); }); return; }
  const hp = hostPeer();
  if (hp && hp.online && hp.ready && !S.helloSent && !S.listening) { S.helloSent = true; send({ t: "rtc", to: hp.id, data: { hello: 1 } }); }
}
function renderGuest() {
  if (!S.me || S.me.host) return;
  const hp = hostPeer();
  let text, live = false;
  if (!hp || !hp.online) text = "Host is offline. Waiting…";
  else if (!hp.ready) text = "Waiting for the host to choose a movie";
  else if (!S.listening) text = "Connecting to the host’s audio…";
  else if (S.state.playing) { text = "Listening live"; live = true; }
  else text = "Paused by host";
  $("gState").textContent = text; $("ring").classList.toggle("live", live);
  $("unlock").hidden = !(S.listening && S.gctx && S.gctx.state !== "running");
  if (live) requestWake(); else releaseWake();
}
setInterval(renderGuest, 1000);
$("nudge").oninput = (e) => {
  S.delay = +e.target.value; $("nv").textContent = S.delay + " ms";
  if (S.gdelay) S.gdelay.delayTime.value = S.delay / 1000;
};
$("unlock").onclick = () => { guestCtx(); $("audio").play().catch(() => {}); renderGuest(); };
$("resync").onclick = () => { closeGuestPc(); S.listening = false; S.helloSent = false; send({ t: "ready", ready: false }); toast("Reconnecting audio…"); setTimeout(afterPeers, 400); };

async function requestWake() {
  try { if (!S.wake && navigator.wakeLock) { S.wake = await navigator.wakeLock.request("screen"); S.wake.onrelease = () => { S.wake = null; }; } } catch {}
}
function releaseWake() { try { if (S.wake) S.wake.release(); } catch {} S.wake = null; }

/* ---------- people list ---------- */
function renderPeers() {
  const ul = $("list"); ul.textContent = "";
  if (!S.me) return;
  S.peers.slice().sort((a, b) => (b.host - a.host)).forEach((p) => {
    const li = document.createElement("li"); if (!p.online) li.className = "offline";
    const av = document.createElement("span"); av.className = "av" + (p.host ? " host" : "");
    av.textContent = (p.name || "?").trim().charAt(0).toUpperCase();
    const who = document.createElement("span"); who.className = "who";
    who.textContent = p.name + (p.id === S.me.id ? " (you)" : "");
    if (p.host) { const s = document.createElement("small"); s.textContent = "  host"; who.appendChild(s); }
    const tag = document.createElement("span"); tag.className = "tag" + (p.online && p.ready ? " ok" : "");
    tag.textContent = !p.online ? "reconnecting" : p.host ? (p.ready ? "movie ready" : "choosing movie") : (p.ready ? "listening" : "connecting");
    li.append(av, who, tag); ul.appendChild(li);
  });
  $("cnt").textContent = "(" + S.peers.filter((p) => p.online).length + ")";
}

/* ---------- invite ---------- */
const dlg = $("invite");
$("inviteBtn").onclick = () => {
  if (!S.me) return;
  const link = location.origin + "/#" + S.me.code;
  $("link").value = link;
  try { const q = qrcode(0, "M"); q.addData(link); q.make(); $("qr").innerHTML = q.createSvgTag(4); } catch { $("qr").textContent = ""; }
  $("share").hidden = !navigator.share; $("copy").textContent = "Copy link";
  dlg.showModal();
};
$("closeInvite").onclick = () => dlg.close();
$("copy").onclick = async () => {
  const link = $("link").value;
  try { await navigator.clipboard.writeText(link); } catch { $("link").select(); try { document.execCommand("copy"); } catch {} }
  $("copy").textContent = "Copied ✓";
};
$("share").onclick = () => { navigator.share({ title: "Silent Cinema", text: "Join my movie night. Code " + S.me.code, url: $("link").value }).catch(() => {}); };

/* ---------- resume after refresh ---------- */
(() => {
  let saved = null;
  try { saved = JSON.parse(sget("sc")); } catch {}
  if (saved && saved.code && saved.id && saved.token) {
    S.me = saved; S.intent = { t: "resume", code: saved.code, id: saved.id, token: saved.token };
    showRoom(); connect();
  }
})();
})();
