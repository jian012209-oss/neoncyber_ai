import crypto from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";
import { q } from "./db.js";
import { HttpError } from "./http.js";
import { rateLimit } from "./ratelimit.js";

const scrypt = promisify(crypto.scrypt);
const COOKIE = "nc_session";
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function checkPassword(password, stored) {
  const [alg, N, r, p, saltB64, keyB64] = String(stored || "").split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}
const DUMMY_HASH = await hashPassword("not-a-real-password");

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}

function setCookie(req, res, value, maxAgeSec) {
  const secure = config.isProd || req.secure;
  const prev = res.getHeader("Set-Cookie");
  const cookie = `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", prev ? [].concat(prev, cookie) : cookie);
}

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  await q.createSession.run(sha256(token), userId, now, now + SESSION_DAYS * 864e5);
  setCookie(req, res, token, SESSION_DAYS * 86400);
}

export const isPremium = (u) => !!u && Number(u.premium_until) > Date.now();
export const isAdmin = (u) => !!u && config.adminEmails.includes(String(u.email).toLowerCase());

export async function loadUser(req) {
  const token = readCookie(req, COOKIE);
  req.user = token ? (await q.sessionUser.get(sha256(token), Date.now())) || null : null;
}

export function requireUser(req) {
  if (!req.user) throw new HttpError(401, "Please log in to continue.", { code: "auth_required" });
}

export function requireAdmin(req) {
  if (!isAdmin(req.user)) throw new HttpError(404, "Not found.");
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const authLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, key: (req) => "auth:" + req.ip, message: "Too many tries. Wait a few minutes, then try again." });

export function mountAuth(app) {
  app.post("/api/auth/signup", authLimit, async (req, res) => {
    const body = await req.json();
    const name = String(body.name || "").trim().slice(0, 60);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (name.length < 2) throw new HttpError(400, "Enter your name (at least 2 characters).");
    if (!EMAIL_RX.test(email) || email.length > 200) throw new HttpError(400, "Enter a valid email address.");
    if (password.length < 8 || password.length > 128) throw new HttpError(400, "Use a password with at least 8 characters.");
    const taken = new HttpError(409, "An account with this email already exists. Log in instead.");
    if (await q.userByEmail.get(email)) throw taken;
    let info;
    try {
      info = await q.createUser.run(email, name, await hashPassword(password), Date.now());
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw taken; // two sign-ups with the same email at the same moment
      throw e;
    }
    await startSession(req, res, Number(info.lastInsertRowid));
    res.json({ ok: true }, 201);
  });

  app.post("/api/auth/login", authLimit, async (req, res) => {
    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = await q.userByEmail.get(email);
    const ok = await checkPassword(password, user ? user.pass_hash : DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, "That email and password don't match. Try again.");
    await startSession(req, res, user.id);
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await q.deleteSession.run(sha256(token));
    setCookie(req, res, "", 0);
    res.json({ ok: true });
  });
}
