const statusElement = document.getElementById('status');
const statusText = statusElement.querySelector('.status-text');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remotePlaceholder = document.getElementById('remotePlaceholder');
const nextButton = document.getElementById('nextButton');
const messages = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

// Backend base URL (set in config.js). Empty means same-origin (local dev).
const BACKEND = (window.BURGAROME_BACKEND || '').replace(/\/+$/, '');

const FALLBACK_ICE_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];

const RTC_BASE_CONFIG = {
  bundlePolicy: 'max-bundle',
  iceCandidatePoolSize: 10,
};

let rtcConfig = { ...RTC_BASE_CONFIG, iceServers: FALLBACK_ICE_SERVERS };

function backendWsUrl() {
  if (BACKEND) {
    return `${BACKEND.replace(/^http/, 'ws')}/ws`;
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

async function refreshRtcConfig() {
  try {
    const response = await fetch(`${BACKEND}/ice`, { cache: 'no-store' });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        rtcConfig = { ...RTC_BASE_CONFIG, iceServers: data.iceServers };
        return;
      }
    }
  } catch {
    // Keep the current config.
  }
  rtcConfig = { ...RTC_BASE_CONFIG, iceServers: FALLBACK_ICE_SERVERS };
}

let socket;
let localStream;
let remoteStream;
let peerConnection;
let connectedToPeer = false;
let pendingCandidates = [];

function setStatus(text) {
  const lower = text.toLowerCase();
  let variant = 'connecting';
  if (lower.includes('active') || lower.includes('connected to a stranger')) {
    variant = 'active';
  } else if (
    lower.includes('failed') ||
    lower.includes('error') ||
    lower.includes('permission') ||
    lower.includes('limit') ||
    lower.includes('lost') ||
    lower.includes('full')
  ) {
    variant = 'error';
  }
  statusElement.className = `status status--${variant}`;
  statusText.textContent = text;
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function addMessage(text, sender = 'system') {
  const paragraph = document.createElement('p');
  paragraph.className = `msg msg--${sender === 'self' ? 'self' : sender === 'peer' ? 'peer' : 'system'}`;
  if (sender === 'system') {
    paragraph.textContent = text;
  } else {
    const label = sender === 'self' ? 'You' : 'Stranger';
    paragraph.innerHTML =
      `<span class="msg__label">${label}</span>${escapeHtml(text)}`;
  }
  messages.appendChild(paragraph);
  messages.scrollTop = messages.scrollHeight;
}

function showRemotePlaceholder(show) {
  if (remotePlaceholder) {
    remotePlaceholder.classList.toggle('is-hidden', !show);
  }
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function serializeDescription(sessionDescription) {
  return {
    type: sessionDescription.type,
    sdp: sessionDescription.sdp,
  };
}

function serializeCandidate(candidate) {
  if (!candidate) {
    return null;
  }
  return typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
}

function waitForIceGathering(pc, timeoutMs = 8000) {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

function attachRemoteTrack(event) {
  const track = event.track;
  if (!remoteStream.getTracks().includes(track)) {
    remoteStream.addTrack(track);
  }

  if (remoteVideo.srcObject !== remoteStream) {
    remoteVideo.srcObject = remoteStream;
  }
  showRemotePlaceholder(false);

  void remoteVideo.play().catch(() => {
    remoteVideo.muted = true;
    void remoteVideo.play().finally(() => {
      remoteVideo.muted = false;
    });
  });
}

function addLocalTracks(pc) {
  const kinds = new Set(localStream.getTracks().map((track) => track.kind));

  localStream.getTracks().forEach((track) => {
    pc.addTransceiver(track, { direction: 'sendrecv', streams: [localStream] });
  });

  if (!kinds.has('video')) {
    pc.addTransceiver('video', { direction: 'recvonly' });
  }
  if (!kinds.has('audio')) {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }
}

function resetPeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.close();
  }

  remoteStream = new MediaStream();
  peerConnection = new RTCPeerConnection(rtcConfig);
  pendingCandidates = [];

  addLocalTracks(peerConnection);

  peerConnection.ontrack = attachRemoteTrack;

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }
    send({ type: 'signal', candidate: serializeCandidate(event.candidate) });
  };

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) {
      return;
    }
    const state = peerConnection.connectionState;
    if (state === 'connected') {
      setStatus('Connected to a stranger');
    } else if (state === 'failed') {
      setStatus('Video connection failed. Try Next Stranger.');
      addMessage('Could not establish a video link. Skipping may help.', 'system');
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (!peerConnection) {
      return;
    }
    const state = peerConnection.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      setStatus('Video chat active');
    } else if (state === 'failed') {
      setStatus('Network blocked video. Try Next Stranger.');
      addMessage('Peer network could not connect. TURN may be required on strict networks.', 'system');
    }
  };
}

async function sendLocalDescription() {
  await waitForIceGathering(peerConnection);
  send({
    type: 'signal',
    description: serializeDescription(peerConnection.localDescription),
  });
}

async function handleMatch(initiator) {
  await refreshRtcConfig();
  connectedToPeer = true;
  setStatus('Matched. Starting video…');
  addMessage('You are now connected.', 'system');

  resetPeerConnection();

  if (!initiator) {
    return;
  }

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await sendLocalDescription();
  } catch (error) {
    setStatus('Could not start video. Try Next Stranger.');
    addMessage('Failed to create a video offer.', 'system');
    console.error(error);
  }
}

async function flushPendingCandidates() {
  while (pendingCandidates.length > 0) {
    await addIceCandidateSafe(pendingCandidates.shift());
  }
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
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.description));
      await flushPendingCandidates();

      if (payload.description.type === 'offer') {
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await sendLocalDescription();
      }
    } else if (payload.candidate) {
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
  remoteStream = null;
  showRemotePlaceholder(true);

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
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 854, max: 854 },
        height: { ideal: 480, max: 480 },
        frameRate: { ideal: 24, max: 30 },
      },
      audio: true,
    });
    localVideo.srcObject = localStream;
    await localVideo.play();
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
      case 'session-ended':
        disconnectPeer(false);
        if (payload.reason === 'time-limit') {
          setStatus('Call time limit reached. Finding a new stranger...');
          addMessage('This call reached the time limit.', 'system');
        } else {
          setStatus('Call ended. Finding a new stranger...');
          addMessage('Your call ended.', 'system');
        }
        send({ type: 'ready' });
        break;
      case 'capacity-full':
        setStatus(payload.message || 'Lobby is full. Try again shortly.');
        addMessage(payload.message || 'Lobby is full. Try again shortly.', 'system');
        break;
      case 'usage-limit':
        disconnectPeer(false);
        setStatus(payload.message || 'Usage limit reached for this month.');
        addMessage(payload.message || 'Usage limit reached for this month.', 'system');
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
  await refreshRtcConfig();
  connectSocket();
})();
