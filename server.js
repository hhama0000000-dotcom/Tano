// server.js — Synchronized Movie-Watching Room backend
// Run: npm install  →  node server.js  →  open http://<your-ip>:3000 on phones

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send('ok'));

// In-memory room store
// rooms[roomId] = {
//   hostId, hostName,
//   participants: { socketId: { name } },
//   state: { paused: bool, time: number, updatedAt: number }
// }
const rooms = {};

function genRoomId() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function publicParticipantList(room) {
  return Object.entries(room.participants).map(([id, p]) => ({
    id,
    name: p.name,
    isHost: id === room.hostId
  }));
}

function broadcastRoster(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('roster', publicParticipantList(room));
}

io.on('connection', (socket) => {

  socket.on('create-room', ({ name }, ack) => {
    let roomId;
    do { roomId = genRoomId(); } while (rooms[roomId]);

    rooms[roomId] = {
      hostId: socket.id,
      hostName: name || 'Host',
      participants: { [socket.id]: { name: name || 'Host' } },
      state: { paused: true, time: 0, updatedAt: Date.now() }
    };

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name || 'Host';

    ack && ack({ ok: true, roomId, isHost: true });
    broadcastRoster(roomId);
  });

  socket.on('join-room', ({ roomId, name }, ack) => {
    const room = rooms[roomId];
    if (!room) {
      ack && ack({ ok: false, error: 'Room not found.' });
      return;
    }
    room.participants[socket.id] = { name: name || 'Guest' };
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name || 'Guest';

    ack && ack({ ok: true, roomId, isHost: false, state: room.state });
    io.to(roomId).emit('chat-message', {
      system: true, text: `${name || 'Guest'} joined the room.`
    });
    broadcastRoster(roomId);
  });

  // Host-only playback control, relayed to everyone else
  socket.on('host-action', (payload) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return; // guests cannot control

    room.state = {
      paused: payload.type === 'pause' ? true : payload.type === 'play' ? false : room.state.paused,
      time: typeof payload.time === 'number' ? payload.time : room.state.time,
      updatedAt: Date.now()
    };

    socket.to(roomId).emit('sync', { type: payload.type, time: payload.time });
  });

  // A late joiner or resync request
  socket.on('request-sync', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    socket.emit('sync', {
      type: room.state.paused ? 'pause' : 'play',
      time: room.state.time
    });
  });

  socket.on('chat-message', ({ text }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !text) return;
    io.to(roomId).emit('chat-message', {
      system: false,
      name: socket.data.name,
      isHost: socket.id === room.hostId,
      text: String(text).slice(0, 500)
    });
  });

  socket.on('kick', ({ targetId }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.emit('kicked');
      target.leave(roomId);
      delete room.participants[targetId];
      target.data.roomId = null;
    }
    broadcastRoster(roomId);
  });

  socket.on('close-room', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    io.to(roomId).emit('room-closed');
    delete rooms[roomId];
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;

    if (socket.id === room.hostId) {
      // Host left -> close the room for everyone
      io.to(roomId).emit('room-closed');
      delete rooms[roomId];
    } else {
      const name = room.participants[socket.id]?.name;
      delete room.participants[socket.id];
      io.to(roomId).emit('chat-message', {
        system: true, text: `${name || 'A guest'} left the room.`
      });
      broadcastRoster(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sync-watch server running on port ${PORT}`));
