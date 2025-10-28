/**
 * King in the Corner - WebSocket Server
 *
 * Responsibilities:
 * - Room management (public matchmaking & private rooms)
 * - Player connection handling
 * - Game action relay (play, draw, end turn)
 * - Countdown and game start coordination
 * - Automatic cleanup of stale rooms
 *
 * Architecture:
 * - Pure WebSocket relay (no WebRTC signaling)
 * - Supports 2-4 players per room
 * - Star topology: server relays all messages
 */

const WebSocket = require('ws');
const http = require('http');

// ==================== CONFIGURATION ====================
const CONFIG = {
  PORT: process.env.PORT || 3001,
  PING_INTERVAL: 30000,
  MAX_PLAYERS: 4,
  MIN_PLAYERS: 2,
  READY_TIMEOUT: 600000, // 10 Minutes
  ALONE_TIMEOUT: 300000 // 5 Minutes
};

// ==================== STATE ====================
const state = {
  publicQueue: [],
  privateRooms: new Map(),
  connections: new Map()
};

// ==================== SERVER SETUP ====================
const server = http.createServer();
const wss = new WebSocket.Server({ server });

console.log('🌐 WebSocket server (ws://) - TLS handled by Cloudflared');

// ==================== UTILITY FUNCTIONS ====================
const utils = {
  generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  },

  sendToClient(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  },

  cleanupConnection(ws) {
    const connData = state.connections.get(ws);
    if (!connData) return;

    const { roomId } = connData;

    // Clear any player timeouts
    if (connData.readyTimeout) {
      clearTimeout(connData.readyTimeout);
    }

    // Remove from public queue
    const queueIndex = state.publicQueue.indexOf(ws);
    if (queueIndex !== -1) {
      state.publicQueue.splice(queueIndex, 1);
      console.log(`📤 Removed from public queue (${state.publicQueue.length} waiting)`);
    }

    // Handle room cleanup
    if (roomId) {
      const room = state.privateRooms.get(roomId);
      if (room) {
        // Find player index before removing
        const playerIndex = room.players.indexOf(ws);

        // Remove player from room
        room.players = room.players.filter(p => p !== ws);

        // Check if remaining player is now alone
        if (room.players.length === 1 && !room.gameStarted) {
          const remainingPlayer = room.players[0];
          room.aloneTimeout = setTimeout(() => {
            if (room.players.length === 1 && !room.gameStarted) {
              utils.kickPlayerForInactivity(remainingPlayer, roomId, 'alone');
            }
          }, CONFIG.ALONE_TIMEOUT);
        }

        // Notify remaining players
        room.players.forEach(player => {
          if (player.readyState === WebSocket.OPEN) {
            if (room.gameStarted && playerIndex !== -1) {
              // During active game, send playerLeft with index
              this.sendToClient(player, {
                type: 'playerLeft',
                playerIndex: playerIndex,
                playersRemaining: room.players.length
              });
            } else {
              // Before game starts, just notify of disconnection
              this.sendToClient(player, {
                type: 'playerDisconnected',
                playersRemaining: room.players.length
              });
            }
          }
        });

        // Delete room if empty or game hasn't started
        if (room.players.length === 0 || !room.gameStarted) {
          if (room.countdownInterval) {
            clearInterval(room.countdownInterval);
          }
          if (room.startTimeout) {
            clearTimeout(room.startTimeout);
          }
          if (room.aloneTimeout) {
            clearTimeout(room.aloneTimeout);
          }
          state.privateRooms.delete(roomId);
          console.log(`🗑️  Room ${roomId} cleaned up`);
        }
      }
    }

    state.connections.delete(ws);
  },


  startRoomCountdown(roomId, room) {
    console.log(`⏱️  Starting countdown for room ${roomId}`);

    let countdown = 5;
    const countdownInterval = setInterval(() => {
      if (countdown > 0) {
        room.players.forEach(player => {
          utils.sendToClient(player, {
            type: 'countdown',
            countdown
          });
        });
        countdown--;
      } else {
        clearInterval(countdownInterval);
        utils.startGame(roomId, room);
      }
    }, 1000);

    room.countdownInterval = countdownInterval;
  },

  startGame(roomId, room) {
    room.gameStarted = true;

    // Clear all timeouts when game starts
    if (room.aloneTimeout) {
      clearTimeout(room.aloneTimeout);
      room.aloneTimeout = null;
    }
    room.players.forEach(player => {
      const connData = state.connections.get(player);
      if (connData?.readyTimeout) {
        clearTimeout(connData.readyTimeout);
        connData.readyTimeout = null;
      }
    });

    const playersList = room.players.map((p, index) => {
      const pData = state.connections.get(p);
      return {
        name: pData?.displayName || `Player ${index + 1}`,
        id: p,
        index
      };
    });

    console.log(`🎮 Starting game in room ${roomId} with ${room.players.length} players`);

    room.players.forEach((player, index) => {
      utils.sendToClient(player, {
        type: 'gameStart',
        roomId,
        players: playersList,
        myPlayerIndex: index
      });
    });
  },

  broadcastRoomUpdate(roomId, room) {
    const playersList = room.players.map(p => {
      const pData = state.connections.get(p);
      return {
        name: pData?.displayName || 'Player',
        id: p,
        ready: room.readyPlayers.has(p)
      };
    });

    room.players.forEach(player => {
      const isHost = room.host === player;
      utils.sendToClient(player, {
        type: 'roomUpdate',
        roomId,
        players: playersList,
        isPrivate: room.isPrivate,
        isHost: isHost,
        minPlayers: CONFIG.MIN_PLAYERS
      });
    });
  },

  broadcastRematchUpdate(roomId, room) {
    const playersList = room.players.map(p => {
      const pData = state.connections.get(p);
      return {
        name: pData?.displayName || 'Player',
        id: p,
        wantsRematch: room.rematchVotes ? room.rematchVotes.has(p) : false
      };
    });

    room.players.forEach(player => {
      if (player.readyState === WebSocket.OPEN) {
        utils.sendToClient(player, {
          type: 'rematchUpdate',
          roomId,
          players: playersList
        });
      }
    });
  },

  kickPlayerForInactivity(ws, roomId, reason) {
    const room = state.privateRooms.get(roomId);
    if (!room) return;

    const connData = state.connections.get(ws);
    const displayName = connData?.displayName || 'Player';

    console.log(`⏱️  Kicking ${displayName} from room ${roomId}: ${reason}`);

    // Send kick message to player
    this.sendToClient(ws, {
      type: 'kicked',
      reason: reason === 'alone'
        ? 'No other players joined'
        : 'Did not ready up in time'
    });

    // Close connection after a brief delay
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, 1000);
  },

  setupPlayerTimeouts(ws, roomId, room) {
    const connData = state.connections.get(ws);
    if (!connData) return;

    // Set ready timeout for this player
    connData.readyTimeout = setTimeout(() => {
      if (!room.readyPlayers.has(ws) && !room.gameStarted) {
        this.kickPlayerForInactivity(ws, roomId, 'not ready');
      }
    }, CONFIG.READY_TIMEOUT);

    // If player is alone, set alone timeout
    if (room.players.length === 1) {
      room.aloneTimeout = setTimeout(() => {
        if (room.players.length === 1 && !room.gameStarted) {
          this.kickPlayerForInactivity(ws, roomId, 'alone');
        }
      }, CONFIG.ALONE_TIMEOUT);
    } else if (room.aloneTimeout) {
      // Clear alone timeout if someone joined
      clearTimeout(room.aloneTimeout);
      room.aloneTimeout = null;
    }

    state.connections.set(ws, connData);
  },

  clearPlayerTimeouts(ws, roomId) {
    const connData = state.connections.get(ws);
    if (connData?.readyTimeout) {
      clearTimeout(connData.readyTimeout);
      connData.readyTimeout = null;
      state.connections.set(ws, connData);
    }

    const room = state.privateRooms.get(roomId);
    if (room?.aloneTimeout) {
      clearTimeout(room.aloneTimeout);
      room.aloneTimeout = null;
    }
  }
};

// ==================== MESSAGE HANDLERS ====================
const handlers = {
  joinPublic(ws, data) {
    const displayName = data.displayName || 'Player';

    // Store display name
    const connData = state.connections.get(ws) || {};
    connData.displayName = displayName;
    state.connections.set(ws, connData);

    console.log(`👤 ${displayName} joined public queue`);

    // Find an existing public room that hasn't started
    let foundRoom = null;
    for (const [roomId, room] of state.privateRooms.entries()) {
      if (!room.isPrivate &&
          room.players.length < CONFIG.MAX_PLAYERS &&
          !room.gameStarted) {
        foundRoom = { roomId, room };
        break;
      }
    }

    if (foundRoom) {
      // Join existing room
      const { roomId, room } = foundRoom;
      room.players.push(ws);
      connData.roomId = roomId;
      state.connections.set(ws, connData);

      utils.setupPlayerTimeouts(ws, roomId, room);

      console.log(`🎮 ${displayName} joined room ${roomId} (${room.players.length}/${CONFIG.MAX_PLAYERS})`);

      // Start timeout when 2nd player joins
      if (room.players.length === 2 && !room.startTimeout) {
        room.startTimeout = setTimeout(() => {
          if (!room.gameStarted && room.players.length >= CONFIG.MIN_PLAYERS) {
            utils.startRoomCountdown(roomId, room);
          }
        }, 60000); // 60 second timeout
        console.log(`⏱️  Started 60s timeout for room ${roomId}`);
      }

      // If room is full (4 players), start immediately
      if (room.players.length === CONFIG.MAX_PLAYERS) {
        if (room.startTimeout) {
          clearTimeout(room.startTimeout);
          room.startTimeout = null;
        }
        utils.startRoomCountdown(roomId, room);
      } else {
        utils.broadcastRoomUpdate(roomId, room);
      }
    } else {
      // Create new room
      const roomId = utils.generateRoomId();
      const room = {
        id: roomId,
        players: [ws],
        isPrivate: false,
        createdAt: Date.now(),
        host: ws,
        gameStarted: false,
        readyPlayers: new Set()
      };

      state.privateRooms.set(roomId, room);
      connData.roomId = roomId;
      state.connections.set(ws, connData);

      utils.setupPlayerTimeouts(ws, roomId, room);

      utils.broadcastRoomUpdate(roomId, room);
      console.log(`🆕 Created new public room ${roomId}`);
    }
  },

  createPrivate(ws, data) {
    const roomId = data.roomId || utils.generateRoomId();
    const displayName = data.displayName || 'Player';

    // Check if room already exists
    if (state.privateRooms.has(roomId)) {
      utils.sendToClient(ws, { type: 'roomInvalid', roomId });
      return;
    }

    // Create room with one player
    const room = {
      id: roomId,
      players: [ws],
      isPrivate: true,
      createdAt: Date.now(),
      host: ws,
      gameStarted: false,
      readyPlayers: new Set()
    };

    state.privateRooms.set(roomId, room);
    state.connections.set(ws, { roomId, isPrivate: true, displayName });

    utils.setupPlayerTimeouts(ws, roomId, room);

    utils.sendToClient(ws, {
      type: 'roomCreated',
      roomId
    });
    utils.broadcastRoomUpdate(roomId, room);
    console.log(`🔐 Private room created: ${roomId} by ${displayName}`);
  },

  joinPrivate(ws, data) {
    const roomId = data.roomId?.toUpperCase();
    const displayName = data.displayName || 'Player';

    if (!roomId) {
      utils.sendToClient(ws, { type: 'roomInvalid', roomId: '' });
      return;
    }

    const room = state.privateRooms.get(roomId);

    if (!room) {
      utils.sendToClient(ws, { type: 'roomInvalid', roomId });
      console.log(`❌ Room not found: ${roomId}`);
      return;
    }

    if (room.players.length >= CONFIG.MAX_PLAYERS) {
      utils.sendToClient(ws, { type: 'roomFull', roomId });
      console.log(`❌ Room full: ${roomId}`);
      return;
    }

    // Add player to room
    room.players.push(ws);
    state.connections.set(ws, { roomId, isPrivate: true, displayName });

    utils.setupPlayerTimeouts(ws, roomId, room);

    console.log(`🎮 ${displayName} joined private room: ${roomId} (${room.players.length}/${CONFIG.MAX_PLAYERS})`);

    utils.broadcastRoomUpdate(roomId, room);
  },

  gameAction(ws, data) {
    const connData = state.connections.get(ws);
    if (!connData?.roomId) return;

    const room = state.privateRooms.get(connData.roomId);
    if (!room) return;

    // Relay the game action to all OTHER players in the room
    room.players.forEach(player => {
      if (player !== ws && player.readyState === WebSocket.OPEN) {
        utils.sendToClient(player, {
          type: 'gameAction',
          action: data.action
        });
      }
    });
  },

  playerReady(ws, data) {
    const connData = state.connections.get(ws);
    if (!connData?.roomId) return;

    const room = state.privateRooms.get(connData.roomId);
    if (!room) return;

    utils.clearPlayerTimeouts(ws, connData.roomId);

    room.readyPlayers.add(ws);
    console.log(`✓ Player ready in room ${connData.roomId} (${room.readyPlayers.size}/${room.players.length})`);

    utils.broadcastRoomUpdate(connData.roomId, room);

    // For public games: if all players ready, start game
    if (!room.isPrivate && room.readyPlayers.size === room.players.length && room.players.length >= CONFIG.MIN_PLAYERS) {
      if (room.startTimeout) {
        clearTimeout(room.startTimeout);
        room.startTimeout = null;
      }
      utils.startRoomCountdown(connData.roomId, room);
    }
  },

  startGame(ws, data) {
    const connData = state.connections.get(ws);
    if (!connData?.roomId) return;

    const room = state.privateRooms.get(connData.roomId);
    if (!room) return;

    // Only host can start in private games
    if (room.isPrivate && room.host === ws && room.players.length >= CONFIG.MIN_PLAYERS) {
      console.log(`🎮 Host starting game in room ${connData.roomId}`);
      utils.startRoomCountdown(connData.roomId, room);
    }
  },

  rematchVote(ws, data) {
    const connData = state.connections.get(ws);
    if (!connData?.roomId) return;

    const room = state.privateRooms.get(connData.roomId);
    if (!room) return;

    // Initialize rematch votes if not exists
    if (!room.rematchVotes) {
      room.rematchVotes = new Set();
    }

    // Add this player's vote
    room.rematchVotes.add(ws);
    console.log(`✓ Rematch vote in room ${connData.roomId} (${room.rematchVotes.size}/${room.players.length})`);

    // Broadcast rematch status to all players
    utils.broadcastRematchUpdate(connData.roomId, room);

    // If all players voted, start rematch
    if (room.rematchVotes.size === room.players.length) {
      console.log(`🔄 All players ready - starting rematch in room ${connData.roomId}`);

      // Reset room state for new game
      room.gameStarted = false;
      room.rematchVotes = new Set();
      room.readyPlayers = new Set();

      // Notify all players to start new game
      room.players.forEach(player => {
        if (player.readyState === WebSocket.OPEN) {
          utils.sendToClient(player, { type: 'rematchStart' });
        }
      });
    }
  },

  leaveRoom(ws, data) {
    const connData = state.connections.get(ws);
    if (!connData?.roomId) return;

    const room = state.privateRooms.get(connData.roomId);
    if (!room) return;

    // Remove player from room
    room.players = room.players.filter(p => p !== ws);

    console.log(`👋 Player left room ${connData.roomId} (${room.players.length} remaining)`);

    // If rematch voting was in progress, update remaining players
    if (room.rematchVotes) {
      room.rematchVotes.delete(ws);
      if (room.players.length > 0) {
        utils.broadcastRematchUpdate(connData.roomId, room);
      }
    }

    // Clean up room if empty
    if (room.players.length === 0) {
      if (room.countdownInterval) clearInterval(room.countdownInterval);
      if (room.startTimeout) clearTimeout(room.startTimeout);
      state.privateRooms.delete(connData.roomId);
      console.log(`🗑️  Room ${connData.roomId} deleted (empty)`);
    }

    // Clear connection data
    state.connections.delete(ws);
  }
};

// ==================== WEBSOCKET CONNECTION ====================
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  console.log(`✅ New connection from ${ip}`);

  state.connections.set(ws, {
    connectedAt: Date.now(),
    ip
  });

  // Handle messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const handler = handlers[data.type];

      if (handler) {
        handler(ws, data);
      } else {
        console.log(`⚠️  Unknown message type: ${data.type}`);
      }
    } catch (err) {
      console.error('❌ Message parsing error:', err);
    }
  });

  // Handle disconnection
  ws.on('close', () => {
    console.log(`❌ Client disconnected from ${ip}`);
    utils.cleanupConnection(ws);
  });

  // Handle errors
  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
    utils.cleanupConnection(ws);
  });

  // Send initial connection confirmation
  utils.sendToClient(ws, { type: 'connected' });
});

// ==================== PERIODIC CLEANUP ====================
setInterval(() => {
  const now = Date.now();

  // Clean up old or invalid rooms
  for (const [roomId, room] of state.privateRooms.entries()) {
    const age = now - room.createdAt;
    const hasDisconnected = room.players.some(p => p.readyState !== WebSocket.OPEN);
    const isEmpty = room.players.length === 0;

    // Remove rooms that are: old (1hr+), have disconnected players, or are empty
    if (age > 3600000 || hasDisconnected || isEmpty) {
      if (room.countdownInterval) {
        clearInterval(room.countdownInterval);
      }
      state.privateRooms.delete(roomId);
      console.log(`🧹 Cleaned up old room: ${roomId}`);
    }
  }

  // Clean up disconnected clients from queue
  state.publicQueue = state.publicQueue.filter(ws => ws.readyState === WebSocket.OPEN);

}, 60000); // Every minute

// ==================== HEARTBEAT ====================
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  });
}, CONFIG.PING_INTERVAL);

// ==================== SERVER START ====================
server.listen(CONFIG.PORT, () => {
  console.log('');
  console.log('👑 ================================');
  console.log('   King in the Corner Server');
  console.log('   ================================');
  console.log('');
  console.log(`   🌐 Protocol: ws://`);
  console.log(`   📡 Port: ${CONFIG.PORT}`);
  console.log(`   ⏱️  Ping interval: ${CONFIG.PING_INTERVAL}ms`);
  console.log(`   🔒 TLS: Handled by Cloudflared`);
  console.log('');
  console.log('   Ready for connections!');
  console.log('👑 ================================');
  console.log('');
});

// ==================== GRACEFUL SHUTDOWN ====================
const shutdown = () => {
  console.log('\n🛑 Shutting down server...');

  // Notify all clients
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      utils.sendToClient(ws, { type: 'serverShutdown' });
      ws.close();
    }
  });

  server.close(() => {
    console.log('✅ Server shut down gracefully');
    process.exit(0);
  });

  // Force shutdown after 5 seconds
  setTimeout(() => {
    console.log('⚠️  Forced shutdown');
    process.exit(1);
  }, 5000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ==================== STATUS ENDPOINT (HTTP) ====================
server.on('request', (req, res) => {
  if (req.url === '/status' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      connections: wss.clients.size,
      publicQueue: state.publicQueue.length,
      rooms: state.privateRooms.size,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('King in the Corner WebSocket Server\n');
  }
});
