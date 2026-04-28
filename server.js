/**
 * RandoChat — Full-Stack Random Video Chat Server
 * Stack: Node.js + Express + Socket.io
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ✅ Socket.io with proper CORS
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Serve Frontend (IMPORTANT FIX) ─────────────────────────────
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─── State ─────────────────────────────────────────────────────
let waitingQueue = [];
const activePairs = new Map();
const onlineUsers = new Set();

// ─── Matching Logic ────────────────────────────────────────────
function isCompatible(userA, candidate) {
  if (candidate.socket.id === userA.socket.id) return false;
  if (activePairs.has(candidate.socket.id)) return false;

  const aAcceptsCandidate = !userA.wantsFemale || candidate.gender === 'female';
  const candidateAcceptsA = !candidate.wantsFemale || userA.gender === 'female';

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

// ─── Socket.io ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  onlineUsers.add(socket.id);
  broadcastOnlineCount();

  let myGender = 'other';
  let myWantsFemale = false;

  socket.on('joinQueue', ({ gender, wantsFemale }) => {
    myGender = gender || 'other';
    myWantsFemale = !!wantsFemale;

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
      activePairs.set(socket.id, partner.socket.id);
      activePairs.set(partner.socket.id, socket.id);

      socket.emit('matched', { partnerId: partner.socket.id, initiator: true });
      partner.socket.emit('matched', { partnerId: socket.id, initiator: false });
    } else {
      waitingQueue.push(newUser);
      socket.emit('waiting');
    }
  });

  socket.on('signal', ({ to, data }) => {
    const target = io.sockets.sockets.get(to);
    if (target) {
      target.emit('signal', { from: socket.id, data });
    }
  });

  socket.on('chatMessage', (text) => {
    if (typeof text !== 'string' || text.length > 1000) return;
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) partnerSocket.emit('chatMessage', { text });
    }
  });

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

  socket.on('typing', (isTyping) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) partnerSocket.emit('partnerTyping', isTyping);
    }
  });

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

// ─── API ───────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  res.json({
    online: onlineUsers.size,
    waiting: waitingQueue.length,
    activePairs: activePairs.size / 2,
  });
});

// ─── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
