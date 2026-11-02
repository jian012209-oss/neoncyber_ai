import { config } from "./config.js";
import { db, q, stmt } from "./db.js";
import { requireUser, requireAdmin, isPremium } from "./auth.js";
import { HttpError } from "./http.js";
import { approveRequest, rejectRequest } from "./billing.js";

const monthStart = () => {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone, year: "numeric", month: "2-digit" }).format(new Date()).split("-");
  // Start of the month in the configured time zone (Asia/Manila has no daylight saving time).
  return new Date(`${y}-${m}-01T00:00:00+08:00`).getTime();
};

const stmts = {
  users: stmt("SELECT COUNT(*) AS n FROM users"),
  premium: stmt("SELECT COUNT(*) AS n FROM users WHERE premium_until > ?"),
  revenue: stmt("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payments WHERE status = 'paid' AND paid_at >= ?"),
  recentPayments: stmt(`SELECT p.id, p.plan, p.amount, p.status, p.reference, p.created_at, p.paid_at, u.email
    FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 50`),
  recentUsers: stmt("SELECT id, name, email, premium_until, created_at FROM users ORDER BY created_at DESC LIMIT 50"),
  manualRevenue: stmt("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM premium_requests WHERE status = 'approved' AND decided_at >= ?"),
  // Waiting ones first, then the newest.
  requests: stmt(`SELECT r.id, r.plan, r.amount, r.reference, r.status, r.created_at, r.decided_at, u.email, u.name
    FROM premium_requests r JOIN users u ON u.id = r.user_id
    ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 50`)
};

export function mountAdmin(app) {
const guard = [requireUser, requireAdmin];
app.get("/api/admin/overview", ...guard, async (_req, res) => {
  const now = Date.now();
  // Everything for the Owner console in one round trip.
  const since = monthStart();
  const [users, premium, revenue, payments, recent, manualRev, requests] = await db.batch([
    stmts.users.bind(), stmts.premium.bind(now), stmts.revenue.bind(since), stmts.recentPayments.bind(), stmts.recentUsers.bind(),
    stmts.manualRevenue.bind(since), stmts.requests.bind()
  ]);
  const rev = revenue.rows[0], man = manualRev.rows[0];
  res.json({
    stats: {
      users: users.rows[0].n, premium: premium.rows[0].n,
      revenueThisMonth: rev.total + man.total, paidThisMonth: rev.n + man.n,
      pendingRequests: requests.rows.filter((r) => r.status === "pending").length
    },
    payments: payments.rows,
    requests: requests.rows,
    users: recent.rows.map((u) => ({ ...u, premium: u.premium_until > now }))
  });
});

// Manual GCash: check the payment in your GCash app, then approve (Premium turns on) or reject it.
app.post("/api/admin/requests/:id/approve", ...guard, async (req, res) => {
  const r = await approveRequest(Number(req.params.id));
  if (!r.ok) throw new HttpError(404, "That payment request doesn't exist.");
  if (r.already) throw new HttpError(409, `That payment was already ${r.status}.`, { code: "already_decided" });
  res.json(r);
});

app.post("/api/admin/requests/:id/reject", ...guard, async (req, res) => {
  const r = await rejectRequest(Number(req.params.id));
  if (!r.ok) throw new HttpError(404, "That payment request doesn't exist.");
  if (r.already) throw new HttpError(409, `That payment was already ${r.status}.`, { code: "already_decided" });
  res.json(r);
});

app.post("/api/admin/grant", ...guard, async (req, res) => {
  const body = await req.json();
  const email = String(body.email || "").trim().toLowerCase();
  const days = Math.min(3650, Math.max(1, parseInt(body.days, 10) || 30));
  const user = await q.userByEmail.get(email);
  if (!user) throw new HttpError(404, "No account uses that email.");
  const until = Math.max(Date.now(), Number(user.premium_until) || 0) + days * 864e5;
  await q.setPremiumUntil.run(until, user.id);
  res.json({ ok: true, email, premiumUntil: until });
});

app.post("/api/admin/revoke", ...guard, async (req, res) => {
  const body = await req.json();
  const email = String(body.email || "").trim().toLowerCase();
  const user = await q.userByEmail.get(email);
  if (!user) throw new HttpError(404, "No account uses that email.");
  if (!isPremium(user)) return res.json({ ok: true, email, premiumUntil: 0 });
  await q.setPremiumUntil.run(0, user.id);
  res.json({ ok: true, email, premiumUntil: 0 });
});
}
