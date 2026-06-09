# Deploying Burgarome

Burgarome has two pieces that deploy separately:

| Piece | Lives in | Hosted on | Why |
| --- | --- | --- | --- |
| **Frontend** (UI) | `public/` | GitHub Pages | Static files, free HTTPS, reachable anywhere |
| **Signaling server** + TURN | `worker/` | Cloudflare Workers | Runs the WebSocket matchmaking; GitHub Pages can't run code |

The frontend talks to the Worker for matchmaking (`/ws`) and for ICE/TURN
servers (`/ice`). Do the Worker first so you have its URL for the frontend.

---

## 1. Deploy the signaling server (Cloudflare Worker)

```bash
npx wrangler login        # opens the browser for a one-time Cloudflare login
npx wrangler deploy
```

`wrangler deploy` prints the live URL, e.g.:

```
https://burgarome-signaling.YOUR-SUBDOMAIN.workers.dev
```

Copy that URL. Sanity-check it:

```bash
curl https://burgarome-signaling.YOUR-SUBDOMAIN.workers.dev/ice
# -> {"iceServers":[{"urls":"stun:stun.l.google.com:19302"}]}
```

> Uses Cloudflare's **free** Workers plan. The matchmaking lobby is a
> SQLite-backed Durable Object, which is included in the free tier.

---

## 2. Add TURN (Option B: P2P + Cloudflare TURN)

Burgarome uses **peer-to-peer video** (no SFU). Cloudflare **TURN** relays media
only when a direct connection fails. Video is capped at **480p** to stay within
the free **1,000 GB/month** egress allowance.

### Cloudflare TURN setup

1. In the Cloudflare dashboard go to **Realtime → TURN** and create a TURN key.
   (A payment method on file is usually required; the first 1,000 GB/month is
   free, then $0.05/GB.)
2. Store **Turn Token ID** and **API token** as Worker secrets:

   ```bash
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_API_TOKEN
   npx wrangler deploy
   ```

3. Verify:

   ```bash
   curl https://burgarome-signaling.YOUR-SUBDOMAIN.workers.dev/ice
   ```

   You should see `turn:turn.cloudflare.com` URLs with `username` and
   `credential` fields.

### Usage limits (Option B)

Configured in `wrangler.toml` `[vars]`:

| Limit | Value |
| --- | --- |
| Max concurrent users | 80 |
| Max call length | 12 minutes |
| Max monthly pair-minutes | 50,000 (~833 pair-hours) |
| Max queue size | 50 |

When the monthly cap is hit, new matches are blocked and `/ice` falls back to
STUN only until next month.

### Fallback: Metered Open Relay (no credit card)

If Cloudflare TURN is not configured, you can use Metered’s free tier (20
GB/month) instead:

```bash
npx wrangler secret put METERED_TURN_API_KEY
npx wrangler deploy
```

Cloudflare TURN takes priority when both are set. Without any TURN secrets the
app still works on simple networks using STUN only.

---

## 3. Point the frontend at your Worker

Edit `public/config.js`:

```js
window.BURGAROME_BACKEND = "https://burgarome-signaling.YOUR-SUBDOMAIN.workers.dev";
```

Leave it `""` only for local development.

---

## 4. Publish the frontend to GitHub Pages

A workflow is already included at `.github/workflows/deploy-pages.yml`. It
publishes the `public/` folder on every push to `main`.

```bash
git add -A
git commit -m "Configure deployment"
git push
```

Then in the GitHub repo: **Settings → Pages → Build and deployment →
Source: GitHub Actions**. The next push (or re-run the workflow) deploys it to:

```
https://YOUR-USERNAME.github.io/burgarome/
```

Open that URL on any device, allow camera + mic, and share it. Two people who
load it get matched into a random video chat.

---

## Local development

The original Node server still runs the whole thing on one machine:

```bash
npm install
npm start          # http://localhost:3000  (open in two tabs)
npm test
```

With `BURGAROME_BACKEND` empty, the frontend uses this local server for both
signaling and `/ice`.
