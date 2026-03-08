const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ✅ FIX: Serve index.html from the root directory
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Optional: if you have a public folder with assets (CSS, JS, images), uncomment the next line
// app.use(express.static('public'));

// In‑memory game rooms
const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected', socket.id);

  socket.on('createRoom', () => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms[roomCode] = {
      players: [socket.id],
      playerNames: { [socket.id]: '' },
      placements: {},
      dugCells: {},
      currentPhase: 'placement',
      turnIndex: 0,
      digsLeft: 20,
      scores: {},
      timer: 120,
      interval: null,
    };
    socket.join(roomCode);
    socket.emit('roomCreated', roomCode);
  });

  socket.on('joinRoom', ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error', 'Room not found');
    if (room.players.length >= 2) return socket.emit('error', 'Room full');

    room.players.push(socket.id);
    room.playerNames[socket.id] = name || 'Player 2';
    socket.join(roomCode);
    socket.emit('roomJoined', roomCode);

    if (room.players.length === 2) {
      const [p1, p2] = room.players;
      if (!room.playerNames[p1]) room.playerNames[p1] = 'Rizwan';
      if (!room.playerNames[p2]) room.playerNames[p2] = 'Anha';
      io.to(roomCode).emit('gameStart', {
        players: room.players,
        names: room.playerNames,
      });
    }
  });

  socket.on('setName', ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (room) {
      room.playerNames[socket.id] = name;
    }
  });

  socket.on('placeLoves', ({ roomCode, loves }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.placements[socket.id] = loves;

    if (Object.keys(room.placements).length === 2) {
      room.currentPhase = 'digging';
      room.turnIndex = 0;
      room.digsLeft = 20;
      room.scores = { [room.players[0]]: 0, [room.players[1]]: 0 };
      room.dugCells = { [room.players[0]]: new Set(), [room.players[1]]: new Set() };
      startTimer(roomCode, room);
      io.to(roomCode).emit('phaseChange', {
        phase: 'digging',
        turn: room.players[0],
        scores: room.scores,
      });
    }
  });

  socket.on('dig', ({ roomCode, row, col }) => {
    const room = rooms[roomCode];
    if (!room || room.currentPhase !== 'digging') return;
    if (socket.id !== room.players[room.turnIndex]) return;
    if (room.digsLeft <= 0) return;

    const opponentId = room.players.find(id => id !== socket.id);
    const cellKey = `${row},${col}`;

    if (room.dugCells[opponentId].has(cellKey)) {
      socket.emit('digIgnored', 'Already dug here!');
      return;
    }
    room.dugCells[opponentId].add(cellKey);

    const opponentLoves = room.placements[opponentId] || [];
    const foundIndex = opponentLoves.findIndex(([r, c]) => r === row && c === col);
    const found = foundIndex !== -1;

    room.digsLeft--;
    if (found) {
      room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;
      opponentLoves.splice(foundIndex, 1);
    }

    let hotness = 'cold';
    if (opponentLoves.length > 0) {
      const distances = opponentLoves.map(([r, c]) => Math.abs(r - row) + Math.abs(c - col));
      const minDist = Math.min(...distances);
      if (minDist === 0) hotness = 'found';
      else if (minDist <= 1) hotness = 'hot';
      else if (minDist <= 2) hotness = 'warm';
      else hotness = 'cold';
    } else {
      hotness = 'none';
    }

    io.to(roomCode).emit('digResult', {
      player: socket.id,
      row, col,
      found,
      hotness,
      digsLeft: room.digsLeft,
      scores: room.scores,
    });

    room.turnIndex = room.turnIndex === 0 ? 1 : 0;
    io.to(roomCode).emit('turnChange', room.players[room.turnIndex]);

    if (room.digsLeft <= 0) {
      endDiggingPhase(roomCode, room);
    }
  });

  socket.on('chat', ({ roomCode, message }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const name = room.playerNames[socket.id] || 'Someone';
    io.to(roomCode).emit('chat', {
      sender: socket.id,
      name,
      message,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  });

  socket.on('disconnect', () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const index = room.players.indexOf(socket.id);
      if (index !== -1) {
        io.to(roomCode).emit('playerLeft');
        delete rooms[roomCode];
        break;
      }
    }
  });
});

function startTimer(roomCode, room) {
  if (room.interval) clearInterval(room.interval);
  room.timer = 120;
  room.interval = setInterval(() => {
    room.timer--;
    io.to(roomCode).emit('timer', room.timer);
    if (room.timer <= 0) {
      endDiggingPhase(roomCode, room);
    }
  }, 1000);
}

function endDiggingPhase(roomCode, room) {
  clearInterval(room.interval);
  room.currentPhase = 'result';
  io.to(roomCode).emit('phaseChange', { phase: 'result', scores: room.scores });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Love Digger server running on port ${PORT}`);
});
