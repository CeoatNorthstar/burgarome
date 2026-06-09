// Burgarome signaling server, running on Cloudflare Workers.
//
// Two responsibilities:
//   1. /ws   — WebSocket matchmaking + signaling relay (handled by the Lobby
//              Durable Object, which holds the shared queue across all clients).
//   2. /ice  — Hands the browser a fresh set of ICE servers (Google STUN plus,
//              if configured, short-lived Cloudflare TURN credentials) so the
//              video/voice connects even on locked-down networks.
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

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Asks Cloudflare's Realtime TURN API for ephemeral credentials. Returns null
// (so we fall back to plain STUN) unless TURN_KEY_ID + TURN_API_TOKEN are set.
async function generateTurnServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
    return null;
  }

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
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

    const data = await response.json();
    // The API returns { iceServers: { urls, username, credential } }.
    const servers = data.iceServers;
    if (!servers) {
      return null;
    }
    return Array.isArray(servers) ? servers : [servers];
  } catch {
    return null;
  }
}

async function iceResponse(env) {
  const turn = await generateTurnServers(env);
  const iceServers = turn ? [...DEFAULT_ICE_SERVERS, ...turn] : DEFAULT_ICE_SERVERS;
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

// Durable Object holding the shared matchmaking state. Mirrors the original
// Node `server.js` logic: a queue of waiting sockets and a partner map.
export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
    this.queue = [];
    this.partnerBySocket = new Map();
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  accept(socket) {
    socket.accept();
    this.clients.add(socket);
    this.send(socket, { type: 'connected' });

    socket.addEventListener('message', (event) => this.onMessage(socket, event.data));
    socket.addEventListener('close', () => this.onClose(socket));
    socket.addEventListener('error', () => this.onClose(socket));
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
      return;
    }
    this.queue.push(socket);
  }

  tryMatch() {
    while (this.queue.length >= 2) {
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

      this.send(first, { type: 'matched', initiator: true });
      this.send(second, { type: 'matched', initiator: false });
    }
  }

  onMessage(socket, raw) {
    let payload;
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (!payload || typeof payload.type !== 'string') {
      return;
    }

    switch (payload.type) {
      case 'ready':
        this.enqueue(socket);
        this.tryMatch();
        break;
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
        this.enqueue(socket);
        if (partner) {
          this.send(partner, { type: 'partner-left' });
          this.enqueue(partner);
        }
        this.tryMatch();
        break;
      }
      default:
        break;
    }
  }

  onClose(socket) {
    this.clients.delete(socket);
    this.removeFromQueue(socket);

    const partner = this.clearPartnering(socket);
    if (partner) {
      this.send(partner, { type: 'partner-left' });
      this.enqueue(partner);
      this.tryMatch();
    }
  }
}
