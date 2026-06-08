const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { WebSocket } = require('ws');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function waitForServerStart(processRef) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (chunk.toString().includes('Server listening on')) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error('Server exited before startup.'));
    };
    const cleanup = () => {
      processRef.stdout.off('data', onData);
      processRef.off('exit', onExit);
    };

    processRef.stdout.on('data', onData);
    processRef.on('exit', onExit);
  });
}

function waitForMessage(socket, expectedType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${expectedType}" message.`));
    }, 5000);

    const onMessage = (rawMessage) => {
      const payload = JSON.parse(rawMessage.toString());
      if (payload.type === expectedType) {
        cleanup();
        resolve(payload);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };

    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

test('serves app and pairs ready websocket clients', async (t) => {
  const port = await getFreePort();
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForServerStart(serverProcess);

  t.after(() => {
    serverProcess.kill('SIGTERM');
  });

  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Burgarome/i);

  const socketA = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const socketB = new WebSocket(`ws://127.0.0.1:${port}/ws`);

  await Promise.all([
    new Promise((resolve, reject) => {
      socketA.once('open', resolve);
      socketA.once('error', reject);
    }),
    new Promise((resolve, reject) => {
      socketB.once('open', resolve);
      socketB.once('error', reject);
    }),
  ]);

  socketA.send(JSON.stringify({ type: 'ready' }));
  socketB.send(JSON.stringify({ type: 'ready' }));

  const [matchA, matchB] = await Promise.all([
    waitForMessage(socketA, 'matched'),
    waitForMessage(socketB, 'matched'),
  ]);

  assert.notEqual(matchA.initiator, matchB.initiator);

  socketA.close();
  socketB.close();
});
