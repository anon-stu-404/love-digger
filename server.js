const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Game rooms
const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected', socket.id);

  // Player joins a room based on URL params
  socket.on('joinGame', ({ player, room }) => {
    if (!player || !room) return;

    socket.join(room);
    socket.data.player = player;
    socket.data.room = room;

    if (!rooms[room]) {
      rooms[room] = {
        players: {},          // socketId: playerName
        placements: {},       // playerName: [[row,col], ...]
        dugCells: {},         // playerName: Set(cellKey)
        currentPhase: 'placement',
        turn: null,
        digsLeft: 20,
        scores: { rizwan: 0, anha: 0 },
        timer: 120,
        interval: null,
        ready: { rizwan: false, anha: false },
      };
    }

    const game = rooms[room];
    game.players[socket.id] = player;

    // Send current game state to the new player
    socket.emit('gameState', {
      currentPhase: game.currentPhase,
      turn: game.turn,
      scores: game.scores,
      ready: game.ready,
    });

    // Notify everyone in the room about the updated player list
    io.to(room).emit('playerList', Object.values(game.players));

    // If both players are now in, start placement phase (already in placement)
    if (Object.keys(game.players).length === 2 && game.currentPhase === 'placement') {
      io.to(room).emit('placementStart', { players: Object.values(game.players) });
    }
  });

  // Player places loves (and becomes ready)
  socket.on('placeLoves', ({ room, loves }) => {
    const game = rooms[room];
    if (!game || game.currentPhase !== 'placement') return;

    const player = socket.data.player;
    game.placements[player] = loves;
    game.ready[player] = true;

    // Tell everyone that this player is now ready
    io.to(room).emit('playerReady', { player });

    // If both are ready, move to digging phase
    if (game.ready.rizwan && game.ready.anha) {
      game.currentPhase = 'digging';
      game.turn = 'rizwan'; // Rizwan starts digging
      game.digsLeft = 20;
      game.scores = { rizwan: 0, anha: 0 };
      game.dugCells = { rizwan: new Set(), anha: new Set() };
      startTimer(room, game);
      io.to(room).emit('phaseChange', {
        phase: 'digging',
        turn: game.turn,
        scores: game.scores,
      });
    }
  });

  // Player digs
  socket.on('dig', ({ room, row, col }) => {
    const game = rooms[room];
    if (!game || game.currentPhase !== 'digging') return;
    if (socket.data.player !== game.turn) return;
    if (game.digsLeft <= 0) return;

    const player = socket.data.player;
    const opponent = player === 'rizwan' ? 'anha' : 'rizwan';
    const cellKey = `${row},${col}`;

    if (game.dugCells[opponent].has(cellKey)) {
      socket.emit('digIgnored', 'Already dug here!');
      return;
    }
    game.dugCells[opponent].add(cellKey);

    const opponentLoves = game.placements[opponent] || [];
    const foundIndex = opponentLoves.findIndex(([r, c]) => r === row && c === col);
    const found = foundIndex !== -1;

    game.digsLeft--;
    if (found) {
      game.scores[player] = (game.scores[player] || 0) + 1;
      opponentLoves.splice(foundIndex, 1); // remove found love
    }

    // Hotness calculation
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

    io.to(room).emit('digResult', {
      player,
      row, col,
      found,
      hotness,
      digsLeft: game.digsLeft,
      scores: game.scores,
    });

    // Switch turn
    game.turn = opponent;
    io.to(room).emit('turnChange', game.turn);

    if (game.digsLeft <= 0) {
      endDiggingPhase(room, game);
    }
  });

  // Chat
  socket.on('chat', ({ room, message }) => {
    const game = rooms[room];
    if (!game) return;
    const player = socket.data.player;
    io.to(room).emit('chat', {
      player,
      message,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (const room in rooms) {
      const game = rooms[room];
      if (game.players[socket.id]) {
        delete game.players[socket.id];
        io.to(room).emit('playerLeft', { players: Object.values(game.players) });
        if (Object.keys(game.players).length === 0) {
          clearInterval(game.interval);
          delete rooms[room];
        }
        break;
      }
    }
  });
});

function startTimer(room, game) {
  if (game.interval) clearInterval(game.interval);
  game.timer = 120;
  game.interval = setInterval(() => {
    game.timer--;
    io.to(room).emit('timer', game.timer);
    if (game.timer <= 0) {
      endDiggingPhase(room, game);
    }
  }, 1000);
}

function endDiggingPhase(room, game) {
  clearInterval(game.interval);
  game.currentPhase = 'result';
  io.to(room).emit('phaseChange', { phase: 'result', scores: game.scores });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Love Digger running on port ${PORT}`);
});
