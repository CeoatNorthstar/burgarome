# burgarome

Random one-on-one video chat app (Omegle-style) where users can:

- See each other with webcam video
- Talk with microphone audio
- Chat with text messages
- Skip to a new random stranger

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in two separate browser windows/tabs (or on two devices) to test random matching.

## Test

```bash
npm test
```

## Deploy (use it anywhere)

The frontend (`public/`) goes on **GitHub Pages** and the WebSocket signaling
server (`worker/`) goes on **Cloudflare Workers**, with optional TURN so the
video connects even on restrictive networks. Full step-by-step in
[DEPLOY.md](DEPLOY.md).