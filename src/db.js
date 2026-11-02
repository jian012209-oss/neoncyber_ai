// NeonCyber's database. Two places it can live, using exactly the same SQL:
//
// - Turso (use this online): set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN. Everything is stored in Turso's
//   cloud, so accounts, chats and Premium survive restarts, redeploys and Render's free plan going to sleep.
//   NeonCyber talks to Turso over its HTTP API with plain fetch, so no packages are needed.
// - A local SQLite file (DATABASE_PATH), for running on your own computer or on a server with a disk.
//
// Every query is async: await q.userById.get(id), await q.createUser.run(...), await db.batch([...]).
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    premium_until INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT 'core',
    persona TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)",
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS conv_user ON conversations(user_id, updated_at DESC)",
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    images INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id, id)",
  `CREATE TABLE IF NOT EXISTS usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    images INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reference TEXT NOT NULL,
    provider_payment_id TEXT,
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS pay_user ON payments(user_id, created_at DESC)",
  // Manual GCash: a member says "I sent ₱199, reference 1234…", and the owner approves or rejects it.
  `CREATE TABLE IF NOT EXISTS premium_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reference TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )`,
  // The same GCash reference number can only ever be used once.
  "CREATE UNIQUE INDEX IF NOT EXISTS req_reference ON premium_requests(reference)",
  "CREATE INDEX IF NOT EXISTS req_user ON premium_requests(user_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS req_status ON premium_requests(status, created_at DESC)"
];

export class DbError extends Error {
  constructor(message, code) { super(message); this.name = "DbError"; this.code = code || ""; }
}

/* ---------- Turso, over its HTTP API (Hrana v2 "pipeline") ---------- */

// Turso sends and expects typed values. Integers travel as strings so big numbers keep their precision.
function toValue(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "bigint") return { type: "integer", value: v.toString() };
  if (typeof v === "number") {
    if (Number.isSafeInteger(v)) return { type: "integer", value: String(v) };
    if (Number.isFinite(v)) return { type: "float", value: v };
    return { type: "null" };
  }
  if (v instanceof Uint8Array) return { type: "blob", base64: Buffer.from(v).toString("base64") };
  return { type: "text", value: String(v) };
}
function fromValue(v) {
  switch (v && v.type) {
    case "integer": { const n = Number(v.value); return Number.isSafeInteger(n) ? n : BigInt(v.value); }
    case "float": return Number(v.value);
    case "text": return v.value;
    case "blob": return Buffer.from(v.base64 || "", "base64");
    default: return null;
  }
}
function toResult(r) {
  if (!r) return { rows: [], changes: 0, lastInsertRowid: null };
  const names = (r.cols || []).map((c) => c.name);
  const rows = (r.rows || []).map((row) => {
    const o = {};
    row.forEach((v, i) => { o[names[i]] = fromValue(v); });
    return o;
  });
  return {
    rows,
    changes: Number(r.affected_row_count || 0),
    lastInsertRowid: r.last_insert_rowid == null ? null : Number(r.last_insert_rowid)
  };
}

function tursoBackend({ url, authToken }) {
  const endpoint = url + "/v2/pipeline";
  const toStmt = ({ sql, args = [] }) => ({ sql, args: args.map(toValue) });

  // One HTTP request = one short-lived Turso connection. "close" ends it, so nothing is left open.
  async function pipeline(requests) {
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ baton: null, requests: [...requests, { type: "close" }] }),
        signal: AbortSignal.timeout(20000)
      });
    } catch (e) {
      throw new DbError(`Couldn't reach Turso at ${url} (${e.cause?.code || e.name}).`, "DB_UNREACHABLE");
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      const hint = res.status === 401 || res.status === 403 ? " Check TURSO_AUTH_TOKEN."
        : res.status === 404 ? " Check TURSO_DATABASE_URL." : "";
      throw new DbError(`Turso answered ${res.status}.${hint} ${text}`.trim(), "DB_HTTP_" + res.status);
    }
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.results)) throw new DbError("Turso sent an answer NeonCyber couldn't read.", "DB_BAD_RESPONSE");
    return body.results;
  }
  const unwrap = (r) => {
    if (!r || r.type !== "ok") throw new DbError(r?.error?.message || "Database error", r?.error?.code);
    return r.response;
  };

  return {
    name: "Turso (" + url.replace(/^https?:\/\//, "") + ")",
    async execute(sql, args) {
      const [r] = await pipeline([{ type: "execute", stmt: toStmt({ sql, args }) }]);
      return toResult(unwrap(r).result);
    },
    async batch(list, { transaction = false } = {}) {
      if (!list.length) return [];
      if (!transaction) {
        const results = await pipeline(list.map((s) => ({ type: "execute", stmt: toStmt(s) })));
        return list.map((_, i) => toResult(unwrap(results[i]).result));
      }
      // All or nothing: BEGIN, each statement only if the step before it worked, COMMIT,
      // and ROLLBACK whenever COMMIT didn't happen.
      const steps = [{ stmt: { sql: "BEGIN IMMEDIATE" } }];
      list.forEach((s, i) => steps.push({ condition: { type: "ok", step: i }, stmt: toStmt(s) }));
      const commit = steps.length;
      steps.push({ condition: { type: "ok", step: commit - 1 }, stmt: { sql: "COMMIT" } });
      steps.push({ condition: { type: "not", cond: { type: "ok", step: commit } }, stmt: { sql: "ROLLBACK" } });
      const [r] = await pipeline([{ type: "batch", batch: { steps } }]);
      const out = unwrap(r).result || {};
      const errors = out.step_errors || [];
      for (let i = 0; i <= commit; i++) if (errors[i]) throw new DbError(errors[i].message, errors[i].code);
      if (!(out.step_results || [])[commit]) throw new DbError("Turso didn't commit the transaction.", "TRANSACTION_NOT_COMMITTED");
      return list.map((_, i) => toResult((out.step_results || [])[i + 1]));
    },
    async exec(statements) {
      const results = await pipeline(statements.map((sql) => ({ type: "execute", stmt: { sql } })));
      statements.forEach((_, i) => unwrap(results[i]));
    }
  };
}

/* ---------- local SQLite file ---------- */

async function sqliteBackend(file) {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = sqlite.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const clean = (args) => args.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
  const runOne = ({ sql, args = [] }) => {
    const s = prep(sql);
    if (s.columns().length) return { rows: s.all(...clean(args)), changes: 0, lastInsertRowid: null };
    const info = s.run(...clean(args));
    return { rows: [], changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
  };
  return {
    name: "local file " + file,
    async execute(sql, args) { return runOne({ sql, args }); },
    async batch(list, { transaction = false } = {}) {
      if (!transaction) return list.map(runOne);
      sqlite.exec("BEGIN IMMEDIATE");
      try { const out = list.map(runOne); sqlite.exec("COMMIT"); return out; }
      catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
    async exec(statements) { for (const sql of statements) sqlite.exec(sql); }
  };
}

/* ---------- pick one and prepare the tables ---------- */

if (config.turso.url && !config.turso.authToken) {
  throw new Error("TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is empty. Add the token from your Turso database.");
}
const backend = config.turso.url ? tursoBackend(config.turso) : await sqliteBackend(config.dbPath);
try {
  await backend.exec(SCHEMA);
} catch (e) {
  console.error(`\nNeonCyber couldn't open its database (${backend.name}): ${e.message}\n`);
  throw e;
}

export const db = {
  backend: backend.name,
  isTurso: !!config.turso.url,
  get: async (sql, args = []) => (await backend.execute(sql, args)).rows[0],
  all: async (sql, args = []) => (await backend.execute(sql, args)).rows,
  run: async (sql, args = []) => {
    const r = await backend.execute(sql, args);
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  },
  // Several statements in one round trip. With { transaction: true } they all happen or none do.
  batch: (list, opts) => backend.batch(list, opts)
};

// A named statement: q.userById.get(id), .all(...), .run(...), or .bind(...) to put it in a db.batch.
export const stmt = (sql) => ({
  sql,
  get: (...args) => db.get(sql, args),
  all: (...args) => db.all(sql, args),
  run: (...args) => db.run(sql, args),
  bind: (...args) => ({ sql, args })
});

export const dayKey = (t = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));

export const q = {
  userByEmail: stmt("SELECT * FROM users WHERE email = ?"),
  userById: stmt("SELECT * FROM users WHERE id = ?"),
  createUser: stmt("INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)"),
  setPrefs: stmt("UPDATE users SET model = ?, persona = ? WHERE id = ?"),
  setPremiumUntil: stmt("UPDATE users SET premium_until = ? WHERE id = ?"),

  createSession: stmt("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
  sessionUser: stmt("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"),
  deleteSession: stmt("DELETE FROM sessions WHERE token_hash = ?"),
  purgeSessions: stmt("DELETE FROM sessions WHERE expires_at <= ?"),

  listConversations: stmt("SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 300"),
  conversation: stmt("SELECT * FROM conversations WHERE id = ? AND user_id = ?"),
  createConversation: stmt("INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"),
  touchConversation: stmt("UPDATE conversations SET updated_at = ? WHERE id = ?"),
  // Messages are deleted explicitly (not left to ON DELETE CASCADE), so a deleted chat is really gone everywhere.
  deleteConversationMessages: stmt("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE id = ? AND user_id = ?)"),
  deleteConversation: stmt("DELETE FROM conversations WHERE id = ? AND user_id = ?"),

  messages: stmt("SELECT id, role, content, images, model, error, created_at FROM messages WHERE conversation_id = ? ORDER BY id"),
  recentMessages: stmt("SELECT role, content, images FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?"),
  addMessage: stmt("INSERT INTO messages (conversation_id, role, content, images, model, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),

  usage: stmt("SELECT images, messages FROM usage WHERE user_id = ? AND day = ?"),
  // Counts one message and its images, and refuses in the same statement if that would pass the image limit.
  // Doing both at once means two messages sent at the same moment can't sneak past the Free limit.
  countUsage: stmt(`INSERT INTO usage (user_id, day, images, messages) SELECT ?, ?, ?, 1 WHERE ? <= ?
    ON CONFLICT(user_id, day) DO UPDATE SET images = images + excluded.images, messages = messages + 1
    WHERE excluded.images = 0 OR usage.images + excluded.images <= ?`),
  // Gives images back when the AI couldn't look at them, so a failed try doesn't use up the day's uploads.
  refundImages: stmt("UPDATE usage SET images = MAX(0, images - ?) WHERE user_id = ? AND day = ?"),

  createPayment: stmt("INSERT INTO payments (id, user_id, plan, amount, status, reference, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"),
  payment: stmt("SELECT * FROM payments WHERE id = ?"),
  // Used together in one transaction: add Premium time only while the payment is still unpaid, then mark it paid.
  // A repeated "paid" message from PayMongo therefore never adds Premium twice.
  extendPremiumForPayment: stmt("UPDATE users SET premium_until = MAX(premium_until, ?) + ? WHERE id = ? AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status <> 'paid')"),
  markPaid: stmt("UPDATE payments SET status = 'paid', paid_at = ?, provider_payment_id = ? WHERE id = ? AND status <> 'paid'"),

  // Manual GCash requests.
  createRequest: stmt("INSERT INTO premium_requests (user_id, plan, amount, reference, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"),
  request: stmt("SELECT * FROM premium_requests WHERE id = ?"),
  lastRequestForUser: stmt("SELECT id, plan, amount, reference, status, created_at, decided_at FROM premium_requests WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"),
  pendingRequestCount: stmt("SELECT COUNT(*) AS n FROM premium_requests WHERE status = 'pending'"),
  // Used together in one transaction, like PayMongo payments: add Premium only while the request is still
  // pending, then mark it approved. Tapping Approve twice never adds Premium twice.
  extendPremiumForRequest: stmt("UPDATE users SET premium_until = MAX(premium_until, ?) + ? WHERE id = ? AND EXISTS (SELECT 1 FROM premium_requests WHERE id = ? AND status = 'pending')"),
  decideRequest: stmt("UPDATE premium_requests SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
};

// Returns true if the message was counted, false if it would pass today's image limit.
export async function countUsage(userId, day, images, imageLimit) {
  const r = await q.countUsage.run(userId, day, images, images, imageLimit, imageLimit);
  return r.changes > 0;
}

setInterval(() => { q.purgeSessions.run(Date.now()).catch(() => { /* try again next time */ }); }, 6 * 3600 * 1000).unref();
