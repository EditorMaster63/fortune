\
/**
 * Fortune Video Site (Express + SQLite + Socket.IO)
 * - 5 slots for videos
 * - admin uploads videos into slots, then "publish" to start a 24h round
 * - users spin one-by-one via queue lock
 * - winning video becomes claimed immediately (disappears)
 * - winner can watch/download via token (tied to their session)
 */

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const http = require("http");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");
const { nanoid } = require("nanoid");

const PORT = parseInt(process.env.PORT || "3000", 10);
const SESSION_SECRET = process.env.SESSION_SECRET || "change_me_please";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";
const SPIN_LOCK_MS = parseInt(process.env.SPIN_LOCK_MS || "8000", 10);
const ROUND_HOURS = parseInt(process.env.ROUND_HOURS || "24", 10);

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DB_PATH = path.join(ROOT, "data", "data.db");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// --- DB schema
db.exec(`
CREATE TABLE IF NOT EXISTS slots (
  slot_index INTEGER PRIMARY KEY,
  filename TEXT,
  original_name TEXT,
  uploaded_at INTEGER,
  claimed INTEGER DEFAULT 0,
  claimed_at INTEGER
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  published_at INTEGER,
  expires_at INTEGER,
  active INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS downloads (
  token TEXT PRIMARY KEY,
  slot_index INTEGER,
  session_id TEXT,
  created_at INTEGER
);
`);

for (let i = 0; i < 5; i++) {
  db.prepare(`INSERT OR IGNORE INTO slots(slot_index, claimed) VALUES(?, 0)`).run(i);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { sameSite: "lax" }
}));

// Static
app.use(express.static(path.join(ROOT, "public")));

// Multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const safe = file.originalname.replace(/[^\w.\-()+ ]+/g, "_");
    cb(null, `${Date.now()}_${nanoid(8)}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 } // 250MB (можно поменять)
});

// --- Queue / lock
let queue = [];                // session ids
let lock = { sessionId: null, until: 0 };
let activeSpinResult = new Map(); // sessionId -> {slotIndex, token}

function now() { return Date.now(); }

function getActiveRound() {
  const row = db.prepare(`SELECT * FROM rounds WHERE active=1 ORDER BY id DESC LIMIT 1`).get();
  if (!row) return null;
  if (row.expires_at <= now()) return null;
  return row;
}

function expireRoundIfNeeded() {
  const row = db.prepare(`SELECT * FROM rounds WHERE active=1 ORDER BY id DESC LIMIT 1`).get();
  if (!row) return;
  if (row.expires_at > now()) return;

  // expire: clear active, clear slots, delete files, clear downloads
  db.prepare(`UPDATE rounds SET active=0 WHERE id=?`).run(row.id);

  const slots = db.prepare(`SELECT slot_index, filename FROM slots`).all();
  for (const s of slots) {
    if (s.filename) {
      const p = path.join(UPLOAD_DIR, s.filename);
      try { fs.unlinkSync(p); } catch {}
    }
  }
  db.prepare(`UPDATE slots SET filename=NULL, original_name=NULL, uploaded_at=NULL, claimed=0, claimed_at=NULL`).run();
  db.prepare(`DELETE FROM downloads`).run();

  queue = [];
  lock = { sessionId: null, until: 0 };
  activeSpinResult.clear();

  broadcastState();
}

setInterval(expireRoundIfNeeded, 5000);

function listSlotsPublic() {
  const slots = db.prepare(`SELECT slot_index, original_name, filename, claimed FROM slots ORDER BY slot_index ASC`).all();
  return slots.map(s => ({
    slotIndex: s.slot_index,
    name: s.original_name || null,
    hasVideo: !!s.filename,
    claimed: !!s.claimed
  }));
}

function listSlotsAdmin() {
  return db.prepare(`SELECT slot_index, original_name, filename, uploaded_at, claimed, claimed_at FROM slots ORDER BY slot_index ASC`).all()
    .map(s => ({
      slotIndex: s.slot_index,
      name: s.original_name || null,
      hasVideo: !!s.filename,
      uploadedAt: s.uploaded_at,
      claimed: !!s.claimed,
      claimedAt: s.claimed_at
    }));
}

function broadcastState() {
  const round = getActiveRound();
  io.emit("state", {
    round: round ? { publishedAt: round.published_at, expiresAt: round.expires_at } : null,
    slots: listSlotsPublic(),
    queue: queue.length,
    locked: lock.sessionId != null && lock.until > now(),
    lockMsLeft: Math.max(0, lock.until - now())
  });
}

function adminOnly(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ ok: false, error: "ADMIN_ONLY" });
}

// --- API: state
app.get("/api/state", (req, res) => {
  const round = getActiveRound();
  res.json({
    ok: true,
    round: round ? { publishedAt: round.published_at, expiresAt: round.expires_at } : null,
    slots: listSlotsPublic(),
    queue: queue.length,
    locked: lock.sessionId != null && lock.until > now(),
    lockMsLeft: Math.max(0, lock.until - now())
  });
});

// --- Admin auth
app.post("/api/admin/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  return res.status(403).json({ ok: false, error: "BAD_CREDENTIALS" });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

app.get("/api/admin/status", (req, res) => {
  res.json({ ok: true, isAdmin: !!(req.session && req.session.isAdmin) });
});

app.get("/api/admin/slots", adminOnly, (req, res) => {
  res.json({ ok: true, slots: listSlotsAdmin(), round: getActiveRound() });
});

// Upload to a slot
app.post("/api/admin/upload/:slot", adminOnly, upload.single("video"), (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (!(slot >= 0 && slot < 5)) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    return res.status(400).json({ ok: false, error: "BAD_SLOT" });
  }

  // remove old file if exists
  const old = db.prepare(`SELECT filename FROM slots WHERE slot_index=?`).get(slot);
  if (old && old.filename) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, old.filename)); } catch {}
  }

  db.prepare(`
    UPDATE slots SET filename=?, original_name=?, uploaded_at=?, claimed=0, claimed_at=NULL
    WHERE slot_index=?
  `).run(req.file.filename, req.file.originalname, now(), slot);

  broadcastState();
  res.json({ ok: true });
});

// Publish round (24h)
app.post("/api/admin/publish", adminOnly, (req, res) => {
  // Require at least one video
  const count = db.prepare(`SELECT COUNT(*) as c FROM slots WHERE filename IS NOT NULL`).get().c;
  if (count === 0) return res.status(400).json({ ok: false, error: "NO_VIDEOS" });

  // deactivate previous
  db.prepare(`UPDATE rounds SET active=0 WHERE active=1`).run();

  const publishedAt = now();
  const expiresAt = publishedAt + ROUND_HOURS * 60 * 60 * 1000;

  db.prepare(`INSERT INTO rounds(published_at, expires_at, active) VALUES(?, ?, 1)`).run(publishedAt, expiresAt);

  // reset claims + downloads + queue/lock
  db.prepare(`UPDATE slots SET claimed=0, claimed_at=NULL`).run();
  db.prepare(`DELETE FROM downloads`).run();
  queue = [];
  lock = { sessionId: null, until: 0 };
  activeSpinResult.clear();

  broadcastState();
  res.json({ ok: true, publishedAt, expiresAt });
});

// Clear everything (stop round + delete files)
app.post("/api/admin/clear", adminOnly, (req, res) => {
  // stop active
  db.prepare(`UPDATE rounds SET active=0 WHERE active=1`).run();

  const slots = db.prepare(`SELECT slot_index, filename FROM slots`).all();
  for (const s of slots) {
    if (s.filename) {
      const p = path.join(UPLOAD_DIR, s.filename);
      try { fs.unlinkSync(p); } catch {}
    }
  }
  db.prepare(`UPDATE slots SET filename=NULL, original_name=NULL, uploaded_at=NULL, claimed=0, claimed_at=NULL`).run();
  db.prepare(`DELETE FROM downloads`).run();
  queue = [];
  lock = { sessionId: null, until: 0 };
  activeSpinResult.clear();

  broadcastState();
  res.json({ ok: true });
});

// --- Spin
function availableSlotIndexes() {
  // only with video and not claimed
  const rows = db.prepare(`SELECT slot_index FROM slots WHERE filename IS NOT NULL AND claimed=0 ORDER BY slot_index ASC`).all();
  return rows.map(r => r.slot_index);
}

function releaseLockFor(sessionId) {
  if (lock.sessionId === sessionId) {
    lock = { sessionId: null, until: 0 };
  }
  // Remove session from queue front if it matches
  if (queue.length && queue[0] === sessionId) queue.shift();
  activeSpinResult.delete(sessionId);
  broadcastState();
}

app.post("/api/spin", (req, res) => {
  expireRoundIfNeeded();

  const round = getActiveRound();
  if (!round) {
    return res.status(400).json({ ok: false, status: "inactive", error: "NO_ACTIVE_ROUND" });
  }

  const sid = req.sessionID;

  // Add to queue if not present
  if (!queue.includes(sid)) queue.push(sid);

  const lockActive = lock.sessionId != null && lock.until > now();
  const isMyTurn = queue[0] === sid;

  if (lockActive && lock.sessionId !== sid) {
    return res.json({ ok: true, status: "queued", position: queue.indexOf(sid) + 1, lockMsLeft: lock.until - now() });
  }

  // If no lock or lock expired, only first in queue can spin
  if (!isMyTurn) {
    // Ensure lock is held by someone else if needed
    return res.json({ ok: true, status: "queued", position: queue.indexOf(sid) + 1, lockMsLeft: Math.max(0, lock.until - now()) });
  }

  // If already has a result stored, return it (avoid double-claim)
  if (activeSpinResult.has(sid)) {
    const r = activeSpinResult.get(sid);
    return res.json({ ok: true, status: "ok", slotIndex: r.slotIndex, token: r.token, name: r.name, already: true, lockMsLeft: Math.max(0, lock.until - now()) });
  }

  const avail = availableSlotIndexes();
  if (avail.length === 0) {
    // No prizes left
    // Remove from queue (they can't spin)
    if (queue[0] === sid) queue.shift();
    broadcastState();
    return res.status(400).json({ ok: false, status: "empty", error: "NO_PRIZES_LEFT" });
  }

  // Acquire lock
  lock = { sessionId: sid, until: now() + SPIN_LOCK_MS };

  // Pick random available slot
  const slotIndex = avail[Math.floor(Math.random() * avail.length)];
  const slot = db.prepare(`SELECT slot_index, filename, original_name FROM slots WHERE slot_index=?`).get(slotIndex);

  // Claim immediately
  db.prepare(`UPDATE slots SET claimed=1, claimed_at=? WHERE slot_index=?`).run(now(), slotIndex);

  // Create token tied to this session
  const token = nanoid(24);
  db.prepare(`INSERT INTO downloads(token, slot_index, session_id, created_at) VALUES(?, ?, ?, ?)`)
    .run(token, slotIndex, sid, now());

  const result = { slotIndex, token, name: slot.original_name || `slot_${slotIndex+1}` };
  activeSpinResult.set(sid, result);

  // Release lock after SPIN_LOCK_MS (so others stay queued while animation plays)
  setTimeout(() => releaseLockFor(sid), SPIN_LOCK_MS + 50);

  broadcastState();
  res.json({ ok: true, status: "ok", ...result, lockMsLeft: Math.max(0, lock.until - now()) });
});

// --- Watch / Download by token (only for same session)
function getTokenRow(token) {
  return db.prepare(`SELECT token, slot_index, session_id FROM downloads WHERE token=?`).get(token);
}

function getSlotFile(slotIndex) {
  return db.prepare(`SELECT filename, original_name FROM slots WHERE slot_index=?`).get(slotIndex);
}

app.get("/watch/:token", (req, res) => {
  const token = req.params.token;
  const row = getTokenRow(token);
  if (!row) return res.status(404).send("Token not found");
  if (row.session_id !== req.sessionID) return res.status(403).send("Forbidden");

  const slot = getSlotFile(row.slot_index);
  if (!slot || !slot.filename) return res.status(410).send("File gone");

  // simple watch page
  const safeTitle = (slot.original_name || "video").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; background:#0b0f1a; color:#e8eefc; margin:0; padding:24px;}
    .card{max-width:900px; margin:0 auto; background:#121a2e; border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:16px;}
    a{color:#9bd1ff;}
    video{width:100%; border-radius:12px; background:#000;}
    .row{display:flex; gap:12px; flex-wrap:wrap; align-items:center; justify-content:space-between;}
    .btn{display:inline-block; padding:10px 14px; border-radius:12px; background:#1b2a4a; border:1px solid rgba(255,255,255,.12); text-decoration:none;}
    .btn:hover{filter:brightness(1.1);}
  </style>
</head>
<body>
  <div class="card">
    <div class="row">
      <h2 style="margin:0;">${safeTitle}</h2>
      <div>
        <a class="btn" href="/download/${token}">Скачать</a>
        <a class="btn" href="/">На главную</a>
      </div>
    </div>
    <div style="height:12px"></div>
    <video controls playsinline>
      <source src="/stream/${token}" />
      Твой браузер не поддерживает видео.
    </video>
  </div>
</body>
</html>`);
});

app.get("/stream/:token", (req, res) => {
  const token = req.params.token;
  const row = getTokenRow(token);
  if (!row) return res.status(404).send("Token not found");
  if (row.session_id !== req.sessionID) return res.status(403).send("Forbidden");

  const slot = getSlotFile(row.slot_index);
  if (!slot || !slot.filename) return res.status(410).send("File gone");

  const filePath = path.join(UPLOAD_DIR, slot.filename);
  // Let express handle range requests? We'll do simple stream; for large videos, range is better, but this is ok for MVP.
  res.sendFile(filePath);
});

app.get("/download/:token", (req, res) => {
  const token = req.params.token;
  const row = getTokenRow(token);
  if (!row) return res.status(404).send("Token not found");
  if (row.session_id !== req.sessionID) return res.status(403).send("Forbidden");

  const slot = getSlotFile(row.slot_index);
  if (!slot || !slot.filename) return res.status(410).send("File gone");

  const filePath = path.join(UPLOAD_DIR, slot.filename);
  res.download(filePath, slot.original_name || "video.mp4");
});

// --- Socket.IO
io.on("connection", (socket) => {
  socket.emit("state", {
    round: getActiveRound() ? { publishedAt: getActiveRound().published_at, expiresAt: getActiveRound().expires_at } : null,
    slots: listSlotsPublic(),
    queue: queue.length,
    locked: lock.sessionId != null && lock.until > now(),
    lockMsLeft: Math.max(0, lock.until - now())
  });
});

// Start
server.listen(PORT, () => {
  console.log(`Fortune Video Site running on http://localhost:${PORT}`);
});
