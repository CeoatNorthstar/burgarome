const statusElement = document.getElementById('status');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const nextButton = document.getElementById('nextButton');
const messages = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

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

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
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

async function handleSignal(payload) {
  if (!connectedToPeer || !peerConnection) {
    return;
  }

  if (payload.description) {
    const remoteDescription = new RTCSessionDescription(payload.description);
    await peerConnection.setRemoteDescription(remoteDescription);
    while (pendingCandidates.length > 0) {
      await peerConnection.addIceCandidate(pendingCandidates.shift());
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
    await peerConnection.addIceCandidate(payload.candidate);
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
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.addEventListener('open', () => {
    setStatus('Looking for a stranger...');
    send({ type: 'ready' });
  });

  socket.addEventListener('message', async (event) => {
    const payload = JSON.parse(event.data);

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
  connectSocket();
})();
