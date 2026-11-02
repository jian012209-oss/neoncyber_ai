// NeonCyber app service worker.
// NeonCyber needs the internet for every answer, so nothing is cached for offline use and /api is never touched.
// Its one job: when a page can't load because the phone is offline, show a branded "You're offline" screen
// instead of the browser's error page.
const VERSION = "neoncyber-app-1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(req).catch(() => offlinePage()));
});

function offlinePage() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#030507"><title>NeonCyber AI · Offline</title>
<style>
  :root{color-scheme:dark}
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;padding:24px;box-sizing:border-box;text-align:center;color:#EAFFF6;
    font:400 15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
    background:radial-gradient(60% 50% at 50% 0%,rgba(0,229,255,.18),transparent 70%),#030507}
  .core{position:relative;width:84px;height:84px;margin:0 auto 26px;
    background:radial-gradient(circle,#F6FFD6 0 5%,#C6FF1A 6% 11%,rgba(198,255,26,.25) 12% 22%,transparent 23%);
    box-shadow:inset 0 0 0 1px rgba(0,229,255,.35);opacity:.75}
  .core::before{content:"";position:absolute;inset:20px;border:2px solid #C6FF1A;transform:rotate(45deg);box-shadow:0 0 14px rgba(198,255,26,.6)}
  h1{margin:0 0 8px;font:700 24px/1.2 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}
  p{margin:0 auto 22px;max-width:34ch;color:#9DB8B0}
  a{display:inline-block;padding:12px 26px;color:#020403;text-decoration:none;font-weight:700;letter-spacing:.1em;text-transform:uppercase;background:#C6FF1A;
    clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px))}
</style></head>
<body><main>
  <div class="core" aria-hidden="true"></div>
  <h1>You're offline</h1>
  <p>NeonCyber needs the internet to answer you. Check your Wi-Fi or mobile data, then try again.</p>
  <a href="/">Try again</a>
</main>
<script>addEventListener("online", () => location.reload());</script>
</body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
