// Burgarome signaling server, running on Cloudflare Workers.
//
// Two responsibilities:
//   1. /ws   — WebSocket matchmaking + signaling relay (handled by the Lobby
//              Durable Object, which holds the shared queue across all clients).
//   2. /ice  — Hands the browser ICE servers (STUN + Cloudflare TURN when
//              configured). Option B: P2P video with TURN fallback only.
//
// The static frontend is hosted separately (e.g. GitHub Pages), so every
// response here is CORS-enabled for cross-origin browser access.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200) {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];

// Cloudflare's alternate STUN/TURN port 53 often times out in browsers.
function filterBrowserIceServers(iceServers) {
  return iceServers.map((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const filtered = urls.filter((url) => !String(url).includes(':53'));
    if (filtered.length === 0) {
      return server;
    }
    return { ...server, urls: filtered.length === 1 ? filtered[0] : filtered };
  });
}

function normalizeIceServers(data) {
  if (Array.isArray(data)) {
    return data.length > 0 ? filterBrowserIceServers(data) : null;
  }
  if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
    return filterBrowserIceServers(data.iceServers);
  }
  return null;
}

// Paid Cloudflare Realtime TURN (requires billing on file). Used when configured.
async function generateCloudflareTurnServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
    return null;
  }

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );

    if (!response.ok) {
      return null;
    }

    return normalizeIceServers(await response.json());
  } catch {
    return null;
  }
}

// Free Open Relay TURN from Metered (20 GB/month, no credit card).
// Sign up at https://dashboard.metered.ca/signup and set METERED_TURN_API_KEY.
async function generateMeteredTurnServers(env) {
  if (!env.METERED_TURN_API_KEY) {
    return null;
  }

  const appName = env.METERED_TURN_APP_NAME || 'openrelayproject';
  const url = `https://${appName}.metered.ca/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_TURN_API_KEY)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    return normalizeIceServers(await response.json());
  } catch {
    return null;
  }
}

function parseLimit(env, key, fallback) {
  const value = Number.parseInt(env[key] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function isTurnAllowed(env) {
  const monthlyLimit = parseLimit(env, 'MAX_MONTHLY_CONNECTION_MINUTES', 0);
  if (monthlyLimit <= 0) {
    return true;
  }

  try {
    const id = env.LOBBY.idFromName('global');
    const stub = env.LOBBY.get(id);
    const response = await stub.fetch('https://lobby/internal/usage');
    if (!response.ok) {
      return true;
    }
    const data = await response.json();
    return Boolean(data.turnAllowed);
  } catch {
    return true;
  }
}

async function iceResponse(env) {
  let iceServers = DEFAULT_ICE_SERVERS;
  if (await isTurnAllowed(env)) {
    iceServers =
      (await generateCloudflareTurnServers(env)) ??
      (await generateMeteredTurnServers(env)) ??
      DEFAULT_ICE_SERVERS;
  }
  return json({ iceServers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/ice') {
      return iceResponse(env);
    }

    if (url.pathname === '/health') {
      return withCors(new Response('ok'));
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade request.', { status: 426 });
      }
      // One shared lobby instance handles all matchmaking.
      const id = env.LOBBY.idFromName('global');
      const stub = env.LOBBY.get(id);
      return stub.fetch(request);
    }

    return withCors(new Response('Burgarome signaling server is running.'));
  },
};

function parseLobbyLimit(env, key, fallback) {
  const value = Number.parseInt(env[key] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Durable Object holding the shared matchmaking state. Mirrors the original
// Node `server.js` logic: a queue of waiting sockets and a partner map.
export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
    this.queue = [];
    this.partnerBySocket = new Map();
    this.sessionStartedAt = new Map();
    this.maxConcurrentUsers = parseLobbyLimit(env, 'MAX_CONCURRENT_USERS', 40);
    this.maxCallMinutes = parseLobbyLimit(env, 'MAX_CALL_MINUTES', 10);
    this.maxMonthlyMinutes = parseLobbyLimit(env, 'MAX_MONTHLY_CONNECTION_MINUTES', 2500);
    this.maxQueueSize = parseLobbyLimit(env, 'MAX_QUEUE_SIZE', 30);
  }

  monthlyUsageKey() {
    return `usage:${new Date().toISOString().slice(0, 7)}`;
  }

  async getMonthlyMinutes() {
    return (await this.state.storage.get(this.monthlyUsageKey())) ?? 0;
  }

  async addMonthlyMinutes(minutes) {
    if (minutes <= 0) {
      return;
    }
    const key = this.monthlyUsageKey();
    const current = await this.getMonthlyMinutes();
    await this.state.storage.put(key, current + minutes);
  }

  async canAcceptMoreUsers() {
    return this.clients.size < this.maxConcurrentUsers;
  }

  async canStartNewSession() {
    return (await this.getMonthlyMinutes()) < this.maxMonthlyMinutes;
  }

  async usageSnapshot() {
    const minutes = await this.getMonthlyMinutes();
    return {
      minutes,
      limit: this.maxMonthlyMinutes,
      turnAllowed: minutes < this.maxMonthlyMinutes,
      concurrentUsers: this.clients.size,
      concurrentLimit: this.maxConcurrentUsers,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/usage') {
      return Response.json(await this.usageSnapshot());
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  accept(socket) {
    socket.accept();
    this.clients.add(socket);
    this.send(socket, { type: 'connected' });

    socket.addEventListener('message', (event) => void this.onMessage(socket, event.data));
    socket.addEventListener('close', () => void this.onClose(socket));
    socket.addEventListener('error', () => void this.onClose(socket));
  }

  send(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Socket already closing/closed; the close handler will clean it up.
    }
  }

  isConnected(socket) {
    return this.clients.has(socket);
  }

  removeFromQueue(socket) {
    const index = this.queue.indexOf(socket);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  hasPartner(socket) {
    return this.partnerBySocket.has(socket);
  }

  clearPartnering(socket) {
    const partner = this.partnerBySocket.get(socket);
    if (!partner) {
      return null;
    }
    this.partnerBySocket.delete(socket);
    if (this.partnerBySocket.get(partner) === socket) {
      this.partnerBySocket.delete(partner);
    }
    return partner;
  }

  enqueue(socket) {
    if (!this.isConnected(socket) || this.hasPartner(socket) || this.queue.includes(socket)) {
      return false;
    }
    if (this.queue.length >= this.maxQueueSize) {
      return false;
    }
    this.queue.push(socket);
    return true;
  }

  startSession(first, second) {
    const now = Date.now();
    this.sessionStartedAt.set(first, now);
    this.sessionStartedAt.set(second, now);
  }

  clearSession(socket) {
    if (socket) {
      this.sessionStartedAt.delete(socket);
    }
  }

  async finalizePairMinutes(socket) {
    if (!socket) {
      return 0;
    }
    const started = this.sessionStartedAt.get(socket);
    this.clearSession(socket);
    if (!started) {
      return 0;
    }
    return Math.max(1, Math.ceil((Date.now() - started) / 60000));
  }

  async endPairedSession(socket, reason) {
    const partner = this.clearPartnering(socket);
    const minutes = await this.finalizePairMinutes(socket);
    this.clearSession(partner);
    if (minutes > 0) {
      await this.addMonthlyMinutes(minutes);
    }

    this.send(socket, { type: 'session-ended', reason });
    if (partner && this.isConnected(partner)) {
      this.send(partner, { type: 'session-ended', reason });
      this.enqueue(partner);
    }
    this.enqueue(socket);
    this.tryMatch();
  }

  checkSessionTimeout(socket) {
    const started = this.sessionStartedAt.get(socket);
    if (!started) {
      return;
    }
    if (Date.now() - started <= this.maxCallMinutes * 60 * 1000) {
      return;
    }
    const partner = this.partnerBySocket.get(socket);
    void this.endPairedSession(socket, 'time-limit');
    if (partner) {
      this.clearSession(partner);
    }
  }

  async tryMatch() {
    while (this.queue.length >= 2) {
      if (!(await this.canStartNewSession())) {
        const waiting = [...this.queue];
        for (const socket of waiting) {
          this.removeFromQueue(socket);
          const minutes = await this.getMonthlyMinutes();
          if (minutes >= this.maxMonthlyMinutes) {
            this.send(socket, {
              type: 'usage-limit',
              message: 'Monthly usage cap reached. Try again next month.',
            });
          } else {
            this.send(socket, {
              type: 'capacity-full',
              message: 'Lobby is full right now. Please try again shortly.',
            });
          }
        }
        return;
      }

      const first = this.queue.shift();
      const second = this.queue.shift();

      const firstOk = this.isConnected(first);
      const secondOk = this.isConnected(second);
      if (!firstOk || !secondOk) {
        if (firstOk) this.enqueue(first);
        if (secondOk) this.enqueue(second);
        continue;
      }

      this.partnerBySocket.set(first, second);
      this.partnerBySocket.set(second, first);
      this.startSession(first, second);

      this.send(first, { type: 'matched', initiator: true });
      this.send(second, { type: 'matched', initiator: false });
    }
  }

  async onMessage(socket, raw) {
    let payload;
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (!payload || typeof payload.type !== 'string') {
      return;
    }

    this.checkSessionTimeout(socket);

    switch (payload.type) {
      case 'ready': {
        if (!(await this.canAcceptMoreUsers())) {
          this.send(socket, {
            type: 'capacity-full',
            message: 'Lobby is full right now. Please try again shortly.',
          });
          break;
        }
        if ((await this.getMonthlyMinutes()) >= this.maxMonthlyMinutes) {
          this.send(socket, {
            type: 'usage-limit',
            message: 'Monthly usage cap reached. Try again next month.',
          });
          break;
        }
        if (!this.enqueue(socket)) {
          this.send(socket, {
            type: 'capacity-full',
            message: 'Queue is full right now. Please try again shortly.',
          });
          break;
        }
        await this.tryMatch();
        break;
      }
      case 'signal':
      case 'chat': {
        const partner = this.partnerBySocket.get(socket);
        if (partner) {
          this.send(partner, payload);
        }
        break;
      }
      case 'next': {
        const partner = this.clearPartnering(socket);
        const minutes = await this.finalizePairMinutes(socket);
        this.clearSession(partner);
        if (minutes > 0) {
          await this.addMonthlyMinutes(minutes);
        }
        this.enqueue(socket);
        if (partner) {
          this.send(partner, { type: 'partner-left' });
          this.enqueue(partner);
        }
        await this.tryMatch();
        break;
      }
      default:
        break;
    }
  }

  async onClose(socket) {
    this.clients.delete(socket);
    this.removeFromQueue(socket);

    const partner = this.clearPartnering(socket);
    const minutes = await this.finalizePairMinutes(socket);
    if (minutes > 0) {
      await this.addMonthlyMinutes(minutes);
    }
    this.clearSession(partner);

    if (partner) {
      this.send(partner, { type: 'partner-left' });
      this.enqueue(partner);
      await this.tryMatch();
    }
  }
}
