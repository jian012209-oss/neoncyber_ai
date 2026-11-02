import crypto from "node:crypto";
import { config } from "./config.js";
import { db, q } from "./db.js";
import { requireUser } from "./auth.js";
import { HttpError } from "./http.js";
import { rateLimit } from "./ratelimit.js";

const DAY = 864e5;
export const PLAN_DAYS = { monthly: 30, annual: 365 };
export const planPrice = (plan) => (plan === "annual" ? config.plans.priceAnnual : config.plans.priceMonthly);
export const gcashReady = () => !!config.paymongo.secretKey;
// How members pay: "paymongo" (automatic), "manual" (send to your GCash number, you approve), or "off".
export const paymentMode = () => (gcashReady() ? "paymongo" : config.gcash.number ? "manual" : "off");

/* ---------- Manual GCash ---------- */

// GCash reference numbers are digits (13 on most receipts). Spaces and dashes are removed first.
const cleanReference = (s) => String(s || "").replace(/[\s-]/g, "");
const REFERENCE_RX = /^\d{8,20}$/;
const manualLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, key: (req) => "manual:" + req.user.id, message: "Too many tries. Wait a few minutes, then try again." });

async function submitManual(req, res) {
  if (paymentMode() !== "manual") throw new HttpError(503, "GCash payments aren't set up yet. Please try again later.", { code: "gcash_not_ready" });
  const body = await req.json();
  const plan = body.plan === "annual" ? "annual" : "monthly";
  const reference = cleanReference(body.reference);
  if (!REFERENCE_RX.test(reference)) throw new HttpError(400, "Enter the reference number from your GCash receipt (numbers only).", { code: "bad_reference" });
  const last = await q.lastRequestForUser.get(req.user.id);
  if (last && last.status === "pending") {
    throw new HttpError(409, "You already sent a payment that's waiting for approval.", { code: "request_pending" });
  }
  const amount = planPrice(plan);
  const now = Date.now();
  let info;
  try {
    info = await q.createRequest.run(req.user.id, plan, amount, reference, now);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new HttpError(409, "That reference number was already used. Check the number on your GCash receipt.", { code: "reference_used" });
    throw e;
  }
  res.json({ ok: true, request: { id: Number(info.lastInsertRowid), plan, amount, reference, status: "pending", created_at: now, decided_at: null } }, 201);
}

// The owner approves: Premium is added (30 or 365 days) and the request is marked approved, together.
export async function approveRequest(id) {
  const r = await q.request.get(id);
  if (!r) return { ok: false, reason: "not_found" };
  const now = Date.now();
  const [extended] = await db.batch([
    q.extendPremiumForRequest.bind(now, (PLAN_DAYS[r.plan] || 30) * DAY, r.user_id, r.id),
    q.decideRequest.bind("approved", now, r.id)
  ], { transaction: true });
  if (!extended.changes) return { ok: true, already: true, status: r.status };
  const user = await q.userById.get(r.user_id);
  return { ok: true, email: user.email, premiumUntil: Number(user.premium_until) };
}

export async function rejectRequest(id) {
  const r = await q.request.get(id);
  if (!r) return { ok: false, reason: "not_found" };
  const changed = (await q.decideRequest.run("rejected", Date.now(), r.id)).changes;
  return { ok: true, already: !changed, status: changed ? "rejected" : r.status };
}

// Extends a user's Premium. Safe to call more than once for the same payment, even at the same moment:
// in one transaction, Premium time is added only while the payment is still unpaid, then it's marked paid.
export async function activatePremium(paymentId, providerPaymentId) {
  const p = await q.payment.get(paymentId);
  if (!p) return { ok: false, reason: "unknown_payment" };
  const now = Date.now();
  const [extended] = await db.batch([
    q.extendPremiumForPayment.bind(now, (PLAN_DAYS[p.plan] || 30) * DAY, p.user_id, paymentId),
    q.markPaid.bind(now, providerPaymentId || null, paymentId)
  ], { transaction: true });
  if (!extended.changes) return { ok: true, already: true };
  const user = await q.userById.get(p.user_id);
  return { ok: true, until: Number(user.premium_until) };
}

const checkoutLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, key: (req) => "pay:" + (req.user?.id || req.ip) });

async function checkout(req, res) {
  if (!gcashReady()) throw new HttpError(503, "GCash payments aren't set up yet. Please try again later.", { code: "gcash_not_ready" });
  const body0 = await req.json();
  const plan = body0.plan === "annual" ? "annual" : "monthly";
  const pesos = planPrice(plan);
  const reference = "NX-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();

  const body = {
    data: {
      attributes: {
        line_items: [{
          name: plan === "annual" ? "NeonCyber Premium (1 year)" : "NeonCyber Premium (1 month)",
          amount: Math.round(pesos * 100), // centavos
          currency: "PHP",
          quantity: 1
        }],
        payment_method_types: config.paymongo.methods,
        success_url: `${config.appUrl}/?checkout=success`,
        cancel_url: `${config.appUrl}/?checkout=cancelled`,
        reference_number: reference,
        metadata: { user_id: String(req.user.id), plan, reference }
      }
    }
  };

  try {
    const r = await fetch(`${config.paymongo.apiBase}/v2/checkout_sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Basic " + Buffer.from(config.paymongo.secretKey + ":").toString("base64")
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    const json = await r.json().catch(() => ({}));
    const id = json?.data?.id;
    const url = json?.data?.attributes?.checkout_url;
    if (!r.ok || !id || !url) {
      console.error("[billing] checkout failed", r.status, JSON.stringify(json).slice(0, 500));
      throw new HttpError(502, "Couldn't open the GCash payment page. Try again in a moment.");
    }
    await q.createPayment.run(id, req.user.id, plan, pesos, reference, Date.now());
    res.json({ url });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("[billing] checkout error", e);
    throw new HttpError(502, "Couldn't reach the payment service. Check your connection and try again.");
  }
}

function verifySignature(rawBody, header, livemode) {
  const secret = config.paymongo.webhookSecret;
  if (!secret || !header) return false;
  const parts = {};
  for (const piece of String(header).split(",")) {
    const i = piece.indexOf("=");
    if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
  }
  const given = livemode ? parts.li : parts.te;
  if (!parts.t || !given) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(given, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Reads the raw body so the signature is checked against the exact bytes PayMongo sent.
async function webhook(req, res) {
  const raw = (await req.raw(1024 * 1024)).toString("utf8");
  let event;
  try { event = JSON.parse(raw); } catch { return res.json({ error: "Bad payload" }, 400); }
  const attrs = event?.data?.attributes || {};
  if (!verifySignature(raw, req.get("Paymongo-Signature"), !!attrs.livemode)) {
    console.warn("[billing] webhook signature check failed");
    return res.json({ error: "Invalid signature" }, 401);
  }
  if (attrs.type !== "checkout_session.payment.paid") return res.json({ received: true, ignored: attrs.type || null });

  const session = attrs.data || {};
  const sessionId = session.id;
  const sAttrs = session.attributes || {};
  const record = sessionId && (await q.payment.get(sessionId));
  if (!record) {
    console.warn("[billing] paid event for unknown checkout session", sessionId);
    return res.json({ received: true, matched: false });
  }
  if (sAttrs.metadata?.user_id && String(sAttrs.metadata.user_id) !== String(record.user_id)) {
    console.error("[billing] user mismatch on", sessionId);
    return res.json({ received: true, matched: false });
  }
  const payments = Array.isArray(sAttrs.payments) ? sAttrs.payments : [];
  const paid = payments.find((p) => p?.attributes?.status === "paid") || payments[0];
  const paidCentavos = Number(paid?.attributes?.amount);
  if (Number.isFinite(paidCentavos) && paidCentavos > 0 && paidCentavos < record.amount * 100) {
    console.error("[billing] amount too low on", sessionId, paidCentavos);
    return res.json({ received: true, activated: false });
  }
  const result = await activatePremium(sessionId, paid?.id);
  console.log("[billing] premium activated", sessionId, result);
  res.json({ received: true, activated: result.ok });
}

export function mountBilling(app) {
  app.post("/api/billing/checkout", requireUser, checkoutLimit, checkout);
  app.post("/api/billing/manual", requireUser, manualLimit, submitManual);
  app.post("/api/billing/webhook", webhook);
}
