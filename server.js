/**
 * RandoChat — Full-Stack Random Video Chat Server
 * Stack: Node.js + Express + Socket.io
 * Signaling: WebRTC offer/answer/ICE via Socket.io relay
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Static Files ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Server is running");
});

// ─── State ─────────────────────────────────────────────────────────────────────
// waitingQueue: Array<{ socket, gender: 'male'|'female'|'other', wantsFemale: boolean }>
let waitingQueue = [];

// activePairs: Map<socketId, partnerId>
const activePairs = new Map();

// onlineUsers: Set<socketId>
const onlineUsers = new Set();

// ─── Matching Logic ────────────────────────────────────────────────────────────
/**
 * Returns true if userA and candidate are compatible partners.
 * Compatibility rules:
 *  - If userA.wantsFemale → candidate must have gender === 'female'
 *  - If candidate.wantsFemale → userA must have gender === 'female'
 *  - Neither can be in an active pair already
 */
function isCompatible(userA, candidate) {
  if (candidate.socket.id === userA.socket.id) return false;
  if (activePairs.has(candidate.socket.id)) return false;

  const aAcceptsCandidate = !userA.wantsFemale || candidate.gender === 'female';
  const candidateAcceptsA  = !candidate.wantsFemale || userA.gender === 'female';

  return aAcceptsCandidate && candidateAcceptsA;
}

function findPartner(newUser) {
  for (let i = 0; i < waitingQueue.length; i++) {
    const candidate = waitingQueue[i];
    if (isCompatible(newUser, candidate)) {
      waitingQueue.splice(i, 1);
      return candidate;
    }
  }
  return null;
}

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter(u => u.socket.id !== socketId);
}

function broadcastOnlineCount() {
  io.emit('onlineCount', onlineUsers.size);
}

// ─── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  onlineUsers.add(socket.id);
  broadcastOnlineCount();

  let myGender = 'other';
  let myWantsFemale = false;

  // ── Join Queue ──────────────────────────────────────────────────────────────
  socket.on('joinQueue', ({ gender, wantsFemale }) => {
    myGender = gender || 'other';
    myWantsFemale = !!wantsFemale;

    // Clean up any existing pair
    const existingPartner = activePairs.get(socket.id);
    if (existingPartner) {
      const partnerSocket = io.sockets.sockets.get(existingPartner);
      if (partnerSocket) partnerSocket.emit('partnerLeft');
      activePairs.delete(existingPartner);
      activePairs.delete(socket.id);
    }

    removeFromQueue(socket.id);

    const newUser = { socket, gender: myGender, wantsFemale: myWantsFemale };
    const partner = findPartner(newUser);

    if (partner) {
      // Pair established
      activePairs.set(socket.id, partner.socket.id);
      activePairs.set(partner.socket.id, socket.id);

      // The newer socket (initiator) creates the offer
      socket.emit('matched', { partnerId: partner.socket.id, initiator: true });
      partner.socket.emit('matched', { partnerId: socket.id, initiator: false });
    } else {
      waitingQueue.push(newUser);
      socket.emit('waiting');
    }
  });

  // ── WebRTC Signaling Relay ──────────────────────────────────────────────────
  socket.on('signal', ({ to, data }) => {
    const target = io.sockets.sockets.get(to);
    if (target) {
      target.emit('signal', { from: socket.id, data });
    }
  });

  // ── Text Message Relay ──────────────────────────────────────────────────────
  socket.on('chatMessage', (text) => {
    if (typeof text !== 'string' || text.length > 1000) return;
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) partnerSocket.emit('chatMessage', { text });
    }
  });

  // ── Leave / Next ────────────────────────────────────────────────────────────
  socket.on('leaveChat', () => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) partnerSocket.emit('partnerLeft');
      activePairs.delete(partnerId);
    }
    activePairs.delete(socket.id);
    removeFromQueue(socket.id);
  });

  // ── Typing Indicator ────────────────────────────────────────────────────────
  socket.on('typing', (isTyping) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) partnerSocket.emit('partnerTyping', isTyping);
    }
  });

  // ── Disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    broadcastOnlineCount();

    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) partnerSocket.emit('partnerLeft');
      activePairs.delete(partnerId);
    }
    activePairs.delete(socket.id);
    removeFromQueue(socket.id);
  });
});

// ─── Health Check ──────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  res.json({
    online: onlineUsers.size,
    waiting: waitingQueue.length,
    activePairs: activePairs.size / 2,
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎥  RandoChat server running at http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop\n`);
});
