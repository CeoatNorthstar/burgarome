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
  rtcpMuxPolicy: 'require',
  iceCandidatePoolSize: 10,
};

let rtcConfig = { ...RTC_BASE_CONFIG, iceServers: FALLBACK_ICE_SERVERS };
let isInitiator = false;
let iceRestartAttempts = 0;
let iceDisconnectTimer = null;
let connectionWatchdog = null;
let hasRemoteVideo = false;

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
  if (
    lower.includes('active') ||
    lower.includes('connected to a stranger') ||
    lower.includes('stranger connected')
  ) {
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

async function tuneVideoSender(pc) {
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
  if (!sender) {
    return;
  }
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = 2_500_000;
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
  } catch {
    // Browser may reject before negotiation completes.
  }
}

function clearIceDisconnectTimer() {
  if (iceDisconnectTimer) {
    clearTimeout(iceDisconnectTimer);
    iceDisconnectTimer = null;
  }
}

function clearConnectionWatchdog() {
  if (connectionWatchdog) {
    clearTimeout(connectionWatchdog);
    connectionWatchdog = null;
  }
}

function startConnectionWatchdog() {
  clearConnectionWatchdog();
  hasRemoteVideo = false;
  connectionWatchdog = setTimeout(() => {
    if (!connectedToPeer || hasRemoteVideo) {
      return;
    }
    setStatus('Still connecting video…');
    if (isInitiator) {
      void sendOffer(true);
    } else {
      send({ type: 'signal', renegotiate: true });
    }
  }, 5000);
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

  if (track.kind === 'video') {
    hasRemoteVideo = true;
    clearConnectionWatchdog();
    setStatus('Stranger connected');
  }

  track.onunmute = () => {
    if (track.kind === 'video') {
      hasRemoteVideo = true;
      setStatus('Stranger connected');
      showRemotePlaceholder(false);
    }
  };

  void remoteVideo.play().catch(() => {
    remoteVideo.muted = true;
    void remoteVideo.play().finally(() => {
      remoteVideo.muted = false;
    });
  });
}

function addLocalTracks(pc) {
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });
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
      void tuneVideoSender(peerConnection);
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
      clearIceDisconnectTimer();
      iceRestartAttempts = 0;
      setStatus('Video chat active');
      void tuneVideoSender(peerConnection);
    } else if (state === 'disconnected') {
      setStatus('Reconnecting…');
      clearIceDisconnectTimer();
      iceDisconnectTimer = setTimeout(() => {
        if (peerConnection?.iceConnectionState === 'disconnected') {
          void tryIceRestart();
        }
      }, 2000);
    } else if (state === 'failed') {
      clearIceDisconnectTimer();
      void tryIceRestart();
    }
  };
}

function sendLocalDescription() {
  if (!peerConnection?.localDescription) {
    return;
  }
  send({
    type: 'signal',
    description: serializeDescription(peerConnection.localDescription),
  });
}

async function sendOffer(iceRestart = false) {
  if (!peerConnection || !connectedToPeer || !isInitiator) {
    return;
  }
  if (iceRestart) {
    iceRestartAttempts += 1;
    if (iceRestartAttempts > 3) {
      setStatus('Connection lost. Try Next.');
      addMessage('Video link dropped. Press Next to reconnect.', 'system');
      return;
    }
  }

  try {
    const offer = await peerConnection.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await peerConnection.setLocalDescription(offer);
    sendLocalDescription();
    if (iceRestart) {
      setStatus('Reconnecting video…');
    }
    void tuneVideoSender(peerConnection);
  } catch (error) {
    console.error(error);
  }
}

async function tryIceRestart() {
  await sendOffer(true);
}

async function applyRemoteDescription(description) {
  const remote = new RTCSessionDescription(description);
  const needsRollback =
    remote.type === 'offer' &&
    (peerConnection.signalingState === 'have-local-offer' ||
      peerConnection.signalingState === 'have-remote-offer');

  if (needsRollback) {
    await Promise.all([
      peerConnection.setLocalDescription({ type: 'rollback' }),
      peerConnection.setRemoteDescription(remote),
    ]);
  } else {
    await peerConnection.setRemoteDescription(remote);
  }
}

async function handleMatch(initiator) {
  isInitiator = initiator;
  iceRestartAttempts = 0;
  clearIceDisconnectTimer();
  connectedToPeer = true;
  setStatus('Matched. Starting video…');
  addMessage('You are now connected.', 'system');

  resetPeerConnection();
  startConnectionWatchdog();

  if (!initiator) {
    return;
  }

  try {
    await sendOffer(false);
  } catch (error) {
    setStatus('Could not start video. Try Next.');
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
    if (payload.renegotiate) {
      if (isInitiator) {
        await sendOffer(true);
      }
      return;
    }

    if (payload.description) {
      await applyRemoteDescription(payload.description);
      await flushPendingCandidates();

      if (payload.description.type === 'offer') {
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        sendLocalDescription();
        void tuneVideoSender(peerConnection);
        startConnectionWatchdog();
      }
    } else if (payload.candidate) {
      if (!peerConnection.remoteDescription) {
        pendingCandidates.push(payload.candidate);
        return;
      }
      await addIceCandidateSafe(payload.candidate);
    }
  } catch (error) {
    setStatus('Signaling error. Try Next.');
    addMessage('Video negotiation failed. Please try again.', 'system');
    console.error(error);
  }
}

function disconnectPeer(notify = false) {
  connectedToPeer = false;
  isInitiator = false;
  iceRestartAttempts = 0;
  hasRemoteVideo = false;
  clearIceDisconnectTimer();
  clearConnectionWatchdog();
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
        width: { ideal: 1280, min: 640 },
        height: { ideal: 720, min: 360 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
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
    setStatus('Looking for a stranger…');
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
  await Promise.all([initMedia(), refreshRtcConfig()]);
  connectSocket();
  setInterval(() => {
    void refreshRtcConfig();
  }, 30 * 60 * 1000);
})();
