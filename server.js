const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const clients = new Set();
const queue = [];
const partnerBySocket = new Map();

function removeFromQueue(socket) {
  const index = queue.indexOf(socket);
  if (index >= 0) {
    queue.splice(index, 1);
  }
}

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function hasPartner(socket) {
  return partnerBySocket.has(socket);
}

function clearPartnering(socket) {
  const partner = partnerBySocket.get(socket);
  if (!partner) {
    return null;
  }

  partnerBySocket.delete(socket);
  if (partnerBySocket.get(partner) === socket) {
    partnerBySocket.delete(partner);
  }
  return partner;
}

function enqueue(socket) {
  if (socket.readyState !== socket.OPEN || hasPartner(socket) || queue.includes(socket)) {
    return;
  }
  queue.push(socket);
}

function tryMatch() {
  while (queue.length >= 2) {
    const first = queue.shift();
    const second = queue.shift();

    if (first.readyState !== first.OPEN || second.readyState !== second.OPEN) {
      if (first.readyState === first.OPEN) enqueue(first);
      if (second.readyState === second.OPEN) enqueue(second);
      continue;
    }

    partnerBySocket.set(first, second);
    partnerBySocket.set(second, first);

    send(first, { type: 'matched', initiator: true });
    send(second, { type: 'matched', initiator: false });
  }
}

function requeueDisconnectedPartner(socket, messageType) {
  const partner = clearPartnering(socket);
  if (!partner) {
    return;
  }

  send(partner, { type: messageType });
  enqueue(partner);
  tryMatch();
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Mirrors the Cloudflare Worker's /ice endpoint for local development.
  if (requestUrl.pathname === '/ice') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }],
      }),
    );
    return;
  }

  const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const relativePath = path.normalize(pathname).replace(/^\/+/, '');
  const fullPath = path.resolve(PUBLIC_DIR, relativePath);

  if (!fullPath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  fs.readFile(fullPath, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500);
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Internal server error');
      return;
    }

    const extension = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extension] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  clients.add(socket);
  send(socket, { type: 'connected' });

  socket.on('message', (message) => {
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      return;
    }

    if (!payload || typeof payload.type !== 'string') {
      return;
    }

    switch (payload.type) {
      case 'ready':
        enqueue(socket);
        tryMatch();
        break;
      case 'signal':
      case 'chat': {
        const partner = partnerBySocket.get(socket);
        if (partner) {
          send(partner, payload);
        }
        break;
      }
      case 'next': {
        const partner = clearPartnering(socket);
        enqueue(socket);
        if (partner) {
          send(partner, { type: 'partner-left' });
          enqueue(partner);
        }
        tryMatch();
        break;
      }
      default:
        break;
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
    removeFromQueue(socket);
    requeueDisconnectedPartner(socket, 'partner-left');
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
