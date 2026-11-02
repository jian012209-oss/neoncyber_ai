# NeonCyber AI

A neon cyber AI chatbot website (black, electric lime and cyan) with its own accounts, chat history, Free and Premium plans, and GCash payments. It does not use Claude. NeonCyber answers with an open-source AI model that you choose and control.

**What's included**

- Sign up and log in (email and password)
- AI chat that types out live, with image analysis and saved history
- Free plan: unlimited messages, NeonCyber Spark model, chat history, 10 image uploads per day
- Premium plan: unlimited messages and images, Volt and Overdrive models, custom instructions, longer answers
- GCash payments two ways: **manual** (members send to your GCash number and type the reference number, you tap Approve) or **automatic** through PayMongo
- Owner console: members, Premium count, monthly GCash revenue, give or remove Premium
- Phone app: a **Get the NeonCyber app** button, home-screen icon, full-screen app and an offline screen, ready to turn into an Android APK and Google Play app (step 5)
- Database in Turso's free cloud, so members, chats and Premium are kept even on Render's free plan (or a local file when you test on your own computer)
- No packages to install. It runs on Node.js 22.13 or newer.

---

## 1. Choose NeonCyber's AI brain

NeonCyber's knowledge comes from an open-source AI model (for example Qwen, Gemma or gpt-oss). These models were trained on a large part of the internet, so they already know a lot, the same way any chatbot does. Bigger models give smarter answers but need stronger hardware.

**Option A: fully your own (no outside AI company)**

1. Get a computer or cloud server with an NVIDIA GPU (16 GB of GPU memory or more is a good start).
2. Install Ollama from ollama.com.
3. Download the models:
   ```
   ollama pull qwen3:8b
   ollama pull gpt-oss:20b
   ollama pull qwen3-vl:8b
   ```
4. In your settings, use `AI_BASE_URL=http://YOUR-SERVER-IP:11434/v1`.

**Option B: no GPU needed**

Use Ollama Cloud, which runs open models for you. Set `AI_BASE_URL=https://ollama.com/v1` and put your Ollama API key in `AI_API_KEY`. Check which model names your account offers and put them in `MODEL_CORE`, `MODEL_NOVA`, `MODEL_ULTRA` and `MODEL_VISION`.

**Option C: Groq (free key, no GPU)**

Get a key at console.groq.com. Set `AI_BASE_URL=https://api.groq.com/openai/v1`, put the key in `AI_API_KEY`, and use model names your Groq account offers, for example `MODEL_CORE=openai/gpt-oss-20b`, `MODEL_NOVA=openai/gpt-oss-120b` and `MODEL_ULTRA=openai/gpt-oss-120b`, with `MAX_TOKENS_CORE=2048` (these models think before they answer, so they need a little more room). Groq's Llama models are for Enterprise accounts only. Things to know:

- **Photos:** set `MODEL_VISION=qwen/qwen3.8-27b`, Groq's model that reads images, and leave `VISION_BASE_URL` and `VISION_API_KEY` empty so photos use the same Groq key. It reads up to 3 images per message (NeonCyber allows 3), and each image counts as about 2,000 tokens. It's a preview model, so Groq may replace it; if photos stop working, check Groq's model list.
- A free Groq key has **per-minute and daily limits shared by all your members**, counted separately for each model. When a model's limit runs out, NeonCyber can't answer with it until the limit resets. Groq's paid plan raises them.

Any other OpenAI-compatible AI service also works with the same two settings.

**Photos with a different AI service.** If your main AI can't read images, send only photos to a second service that can: set `VISION_BASE_URL`, `VISION_API_KEY` and `MODEL_VISION`. For OpenRouter that's `VISION_BASE_URL=https://openrouter.ai/api/v1`, your OpenRouter key, and a vision model such as `google/gemma-4-31b-it:free` (free models: about 50 requests a day). For Google Gemini it's `VISION_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`, your Gemini key, and a model your account offers. If a photo can't be read, the member sees a clear message and the photo isn't counted against their daily uploads.

## 2. Set up GCash payments

**Option A: manual GCash (no documents needed)**

1. Add two settings: `GCASH_NUMBER` (the GCash number members send to, for example `0917 123 4567`) and `GCASH_NAME` (the name GCash shows for it, for example `J•• R••`).
2. Members tap **Upgrade with GCash**, send the exact amount with **Express Send**, and type the **reference number** from their receipt.
3. You get a number badge on **Owner console**. Open it, find the payment in your GCash app's transactions, check that the reference number and amount match, and tap **Approve** (tap twice). Premium turns on right away: 30 days for monthly, 365 for yearly. Tap **Reject** if the payment isn't there; the member is told it wasn't approved.

The same reference number can never be used twice, and a member can only have one payment waiting at a time.

**Option B: automatic GCash through PayMongo** (needs a fully verified PayMongo account: DTI registration, BIR Form 2303 and a government ID). If you set PayMongo up, it replaces the manual option.

1. Create a PayMongo account at paymongo.com and complete business verification so you can accept live payments.
2. In the PayMongo dashboard, make sure **GCash** is turned on under payment methods.
3. Copy your **secret key**. Use the `sk_test_` key first, then the `sk_live_` key when you go live. Put it in `PAYMONGO_SECRET_KEY`.
4. Create a **webhook**:
   - URL: `https://YOUR-WEBSITE/api/billing/webhook`
   - Event: `checkout_session.payment.paid`
5. Copy the webhook's **signing secret** into `PAYMONGO_WEBHOOK_SECRET`.

When a member pays, PayMongo tells NeonCyber and Premium turns on right away: 30 days for monthly, 365 days for yearly. Paying again extends the current Premium.

## 3. Put it online

**Option 1: Render's free plan + Turso's free database (recommended, ₱0)**

Render runs NeonCyber and Turso keeps its database, so nothing is lost when Render restarts or puts the site to sleep.

*Create the database on Turso*

1. Sign up at **turso.tech**. The free plan needs no credit card.
2. In the Turso dashboard, create a database, for example `neoncyber`. Pick the location closest to your members (for the Philippines, an Asia location).
3. Open the database and copy its **URL** (it starts with `libsql://`).
4. Create a **token** for the database and copy it. If Turso asks when the token should expire, choose no expiry. Otherwise NeonCyber stops working on that date.

   Prefer the command line? `turso db create neoncyber`, then `turso db show neoncyber --url` and `turso db tokens create neoncyber`.

*Put NeonCyber on Render*

1. Upload this folder to a new GitHub repository.
2. On render.com, create a **Web Service** from that repository. The **Free** instance type is fine.
3. Build command: leave empty. Start command: `npm start`.
4. Add the settings from `.env.example` as environment variables, including:
   - `TURSO_DATABASE_URL`: the `libsql://` URL from Turso
   - `TURSO_AUTH_TOKEN`: the token from Turso
   - `APP_URL`: your Render address (for example `https://neoncyber-ai.onrender.com`) or your own domain
5. Deploy. Render's **Logs** should show `Database: Turso (...)`. If you see a warning about a local file instead, the two Turso settings are missing. If the server stops with a Turso message, it names the setting to fix.

NeonCyber creates its tables in Turso by itself the first time it starts. On Render's free plan the site sleeps after 15 minutes without visitors, and the next visitor waits about a minute while it wakes up. Nothing is lost while it sleeps.

**Option 2: Render with a disk (paid, no Turso)**

Leave the Turso settings empty, add a **persistent disk** mounted at `/var/data`, and set `DATABASE_PATH=/var/data/neoncyber.db`. Without Turso or a disk, every account, chat and Premium payment is erased whenever the site restarts, redeploys or goes to sleep.

**Option 3: any VPS with Docker**

```
cp .env.example .env        # then edit .env
docker build -t neoncyber .
docker run -d --name neoncyber -p 3000:3000 --env-file .env -v neoncyber-data:/app/data --restart unless-stopped neoncyber
```

Put it behind HTTPS (for example Caddy or Nginx with a free certificate). GCash and logins need HTTPS.

## 4. Open the Owner console

Put your email in `ADMIN_EMAILS`, sign up on the website with that email, and an **Owner console** link appears at the bottom of the sidebar. Use it to see members and revenue, and to give Premium to testers or to people who paid you directly.

## 5. Turn NeonCyber into a phone app

The app is your NeonCyber website on the member's phone, with its own icon and no browser bar. Accounts, chats, Free and Premium all stay the same, so the website must be online first (step 3).

**Install from your website (works as soon as it's online)**

- **Android:** members open your website in Chrome and tap **Get the NeonCyber app** on the login page or in the chats menu, then **Install**. NeonCyber appears with their other apps.
- **iPhone:** the same button shows the three **Add to Home Screen** steps for Safari.
- If someone opens your link inside Facebook or Messenger, the button first tells them to open it in Chrome or Safari, because those in-app browsers can't install apps.

**Get an APK and a Google Play file (free, with PWABuilder)**

1. Make sure NeonCyber is online and opens at its `https://` address.
2. Go to **pwabuilder.com**, type your website address and tap **Start**.
3. Choose **Package for stores**, then **Android**, then **Generate**. For the package ID use something like `com.yourname.neoncyber` (it can never change once it's on Google Play) and keep **Signing key: New**.
4. Download the zip. It contains:
   - an **.apk** you can install on Android phones or share directly
   - an **.aab** for uploading to Google Play
   - the **signing key** and its passwords. Keep both safe; every future update needs them.
   - an **assetlinks.json** file
5. Open `assetlinks.json`. Copy `package_name` into the `ANDROID_PACKAGE_ID` setting and the `sha256_cert_fingerprints` value into `ANDROID_CERT_SHA256`, then redeploy. Without this step the app shows a browser address bar at the top.
6. To publish on **Google Play**, you need a Google Play developer account (one-time US$25). Google signs your app with its own key, so copy the **App signing key** SHA-256 from Play Console (under App integrity) and add it to `ANDROID_CERT_SHA256`, separated by a comma. New personal developer accounts must run a closed test with at least 12 testers for 14 days before the app can go public.

The icons for the app and the Play Store listing are in `public/icons` (`icon-512.png` is the 512 × 512 store icon).

## Run it on your own computer

```
cp .env.example .env    # set APP_URL=http://localhost:3000 and NODE_ENV=development
npm start
```

Then open http://localhost:3000. Without the Turso settings, the database is a local file, `data/neoncyber.db`. With them, your computer uses the same online Turso database as your website.

## Good to know

- The website's design and code are one file: `public/index.html`. After you edit it, restart the server so its security check accepts the new code. Next to it, `manifest.webmanifest` and `icons/` give the installed app its name and icon, and `sw.js` shows the offline screen.
- Free image uploads reset at midnight Philippine time.
- Neither plan has a daily message limit. To stop spam bots, Free members can send up to 20 messages a minute and Premium members up to 60 (one per second).
- When Premium runs out (or you remove it), the member goes back to Free automatically and keeps their chats.
- Every account, chat and payment is in your database (Turso, or the local file). Turso keeps it safe across restarts. To keep your own copy too, run `turso db shell neoncyber .dump > backup.sql` now and then.
- Turso's free plan includes 5 GB of storage and 500 million row reads a month, far more than a new chatbot needs.
- Images are shrunk on the member's phone before upload and are not stored; only the count is saved.
- Passwords are stored as salted scrypt hashes. Sessions use secure, HTTP-only cookies.

## Settings

| Setting | What it does |
|---|---|
| `APP_URL` | Your website address, used for GCash return links |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Your Turso database (`libsql://...`) and its token. Set both to keep the database online. |
| `DATABASE_PATH` | Local database file, used only when the Turso settings are empty |
| `ADMIN_EMAILS` | Emails that can open the Owner console |
| `AI_BASE_URL`, `AI_API_KEY` | Your AI server and its key |
| `MODEL_CORE`, `MODEL_NOVA`, `MODEL_ULTRA` | Model behind each NeonCyber tier: Spark (Free), Volt and Overdrive (Premium) |
| `MODEL_VISION` | Model used for messages with images |
| `VISION_BASE_URL`, `VISION_API_KEY` | Optional separate AI service just for photos |
| `MAX_TOKENS_*` | Longest answer per tier |
| `FREE_IMAGES_PER_DAY` | Free image uploads per day (default 10) |
| `FREE_MESSAGES_PER_MINUTE`, `PREMIUM_MESSAGES_PER_MINUTE` | Anti-spam speed limit (default 20 and 60). There is no daily message limit. |
| `PRICE_MONTHLY`, `PRICE_ANNUAL` | Premium prices in pesos (default ₱199 and ₱1,910) |
| `GCASH_NUMBER`, `GCASH_NAME` | Manual GCash: the number members send to, and the name GCash shows for it |
| `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` | Your PayMongo keys |
| `PAYMONGO_METHODS` | Payment methods on the checkout page (default `gcash`) |
| `ANDROID_PACKAGE_ID`, `ANDROID_CERT_SHA256` | From PWABuilder's `assetlinks.json`, so the Android app opens without a browser bar |
