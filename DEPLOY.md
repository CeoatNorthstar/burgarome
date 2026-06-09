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

## 2. (Optional but recommended) Add TURN so it connects on *any* network

Direct peer-to-peer video fails on a lot of restrictive networks (corporate
Wi-Fi, mobile carriers, strict firewalls). A TURN server relays the media so it
connects anyway. Cloudflare provides one:

1. In the Cloudflare dashboard go to **Realtime → TURN** and create a TURN key.
2. Note the **Turn Token ID** and the **API token**.
3. Store them as Worker secrets:

   ```bash
   npx wrangler secret put TURN_KEY_ID       # paste the Turn Token ID
   npx wrangler secret put TURN_API_TOKEN    # paste the API token
   npx wrangler deploy                       # redeploy to pick them up
   ```

Now `/ice` returns short-lived TURN credentials alongside STUN, and the browser
uses them automatically. Without these secrets the app still works on most
networks using STUN only.

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
