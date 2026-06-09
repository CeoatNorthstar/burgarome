const statusElement = document.getElementById('status');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const nextButton = document.getElementById('nextButton');
const messages = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

// Backend base URL (set in config.js). Empty means same-origin (local dev).
const BACKEND = (window.BURGAROME_BACKEND || '').replace(/\/+$/, '');

// ICE servers are fetched from the backend at startup so we can use fresh TURN
// credentials. This is the fallback if that request fails.
const FALLBACK_ICE_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];
let rtcConfig = { iceServers: FALLBACK_ICE_SERVERS, bundlePolicy: 'max-bundle' };

function backendWsUrl() {
  if (BACKEND) {
    return `${BACKEND.replace(/^http/, 'ws')}/ws`;
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

async function loadIceServers() {
  try {
    const response = await fetch(`${BACKEND}/ice`, { cache: 'no-store' });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        rtcConfig = { iceServers: data.iceServers };
      }
    }
  } catch {
    // Keep the STUN-only fallback.
  }
}

let socket;
let localStream;
let peerConnection;
let connectedToPeer = false;
let pendingCandidates = [];

function setStatus(text) {
  statusElement.textContent = text;
}

function addMessage(text, sender = 'system') {
  const paragraph = document.createElement('p');
  paragraph.textContent = `${sender === 'self' ? 'You' : sender === 'peer' ? 'Stranger' : 'System'}: ${text}`;
  messages.appendChild(paragraph);
  messages.scrollTop = messages.scrollHeight;
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function attachRemoteTrack(event) {
  const [stream] = event.streams;
  if (stream) {
    remoteVideo.srcObject = stream;
  } else {
    let remoteStream = remoteVideo.srcObject;
    if (!(remoteStream instanceof MediaStream)) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    if (!remoteStream.getTracks().includes(event.track)) {
      remoteStream.addTrack(event.track);
    }
  }
  void remoteVideo.play();
}

function resetPeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.close();
  }

  peerConnection = new RTCPeerConnection(rtcConfig);
  pendingCandidates = [];

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = attachRemoteTrack;

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) {
      return;
    }
    if (peerConnection.connectionState === 'failed') {
      setStatus('Video connection failed. Try Next Stranger.');
      addMessage('Could not establish a video link. Skipping may help.', 'system');
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: 'signal', candidate: event.candidate });
    }
  };
}

async function handleMatch(initiator) {
  connectedToPeer = true;
  setStatus('Connected to a stranger');
  addMessage('You are now connected.', 'system');

  resetPeerConnection();

  if (!initiator) {
    return;
  }

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  send({ type: 'signal', description: peerConnection.localDescription });
}

async function addIceCandidateSafe(candidate) {
  if (!candidate || !candidate.candidate) {
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch {
    // Ignore stale/duplicate candidates after reconnects.
  }
}

async function handleSignal(payload) {
  if (!connectedToPeer || !peerConnection) {
    return;
  }

  try {
    if (payload.description) {
      const remoteDescription = new RTCSessionDescription(payload.description);
      await peerConnection.setRemoteDescription(remoteDescription);
      while (pendingCandidates.length > 0) {
        await addIceCandidateSafe(pendingCandidates.shift());
      }

      if (payload.description.type === 'offer') {
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        send({ type: 'signal', description: peerConnection.localDescription });
      }
    }

    if (payload.candidate) {
      if (!peerConnection.remoteDescription) {
        pendingCandidates.push(payload.candidate);
        return;
      }
      await addIceCandidateSafe(payload.candidate);
    }
  } catch (error) {
    setStatus('Signaling error. Try Next Stranger.');
    addMessage('Video negotiation failed. Please try again.', 'system');
    console.error(error);
  }
}

function disconnectPeer(notify = false) {
  connectedToPeer = false;
  remoteVideo.srcObject = null;

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  if (notify) {
    send({ type: 'next' });
  }
}

async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (error) {
    setStatus('Camera/mic permission is required.');
    addMessage('Please allow camera and microphone access to continue.', 'system');
    throw error;
  }
}

function connectSocket() {
  socket = new WebSocket(backendWsUrl());

  socket.addEventListener('open', () => {
    setStatus('Looking for a stranger...');
    send({ type: 'ready' });
  });

  socket.addEventListener('message', async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (payload.type) {
      case 'matched':
        await handleMatch(payload.initiator);
        break;
      case 'signal':
        await handleSignal(payload);
        break;
      case 'chat':
        addMessage(payload.message, 'peer');
        break;
      case 'partner-left':
        disconnectPeer(false);
        setStatus('Stranger disconnected. Finding a new one...');
        addMessage('Stranger disconnected.', 'system');
        send({ type: 'ready' });
        break;
      default:
        break;
    }
  });

  socket.addEventListener('close', () => {
    disconnectPeer(false);
    setStatus('Connection lost. Refresh to retry.');
  });
}

nextButton.addEventListener('click', () => {
  disconnectPeer(true);
  setStatus('Finding a new stranger...');
  addMessage('You skipped to the next stranger.', 'system');
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message || !connectedToPeer) {
    return;
  }

  send({ type: 'chat', message });
  addMessage(message, 'self');
  chatInput.value = '';
});

(async () => {
  await initMedia();
  await loadIceServers();
  connectSocket();
})();
