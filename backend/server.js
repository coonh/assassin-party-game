import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { LobbyManager } from './lobbyManager.js';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

const lobbyManager = new LobbyManager(100);
const killTimeouts = new Map(); // victimSessionId -> timeout

// Helper to broadcast kill results
const broadcastKillResult = (code, result) => {
  if (result.success) {
    // Notify the killer of their new target
    io.to(result.killerId).emit('kill-confirmed', {
      newTarget: result.newTarget,
      isGameOver: result.isGameOver
    });

    // Notify all players of updated status
    io.to(code).emit('game-status', {
      phase: result.isGameOver ? 'ended' : 'playing',
      aliveCount: result.aliveCount,
      winner: result.winner,
      allPlayers: result.allPlayers
    });

    // Notify the dead player ONLY if game is not over
    if (!result.isGameOver) {
      // result.victimId is the Socket ID (resolved by LobbyManager)
      io.to(result.victimId).emit('you-died', {});
    }
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', lobbies: lobbyManager.getLobbyCount() });
});

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Try to rejoin with existing session
  socket.on('rejoin', ({ sessionId }) => {
    const result = lobbyManager.rejoinLobby(sessionId, socket.id);
    if (result.success) {
      socket.join(result.code);
      socket.emit('rejoin-success', {
        code: result.code,
        phase: result.phase,
        players: result.players,
        isHost: result.isHost,
        isAlive: result.isAlive,
        target: result.target,
        aliveCount: result.aliveCount,
        allPlayers: result.allPlayers
      });
      // Notify others that player reconnected
      socket.to(result.code).emit('player-reconnected', {
        players: result.players,
        allPlayers: result.allPlayers
      });
    } else {
      socket.emit('rejoin-failed', { message: result.message });
    }
  });

  // Create a new lobby
  socket.on('create-lobby', ({ playerName }) => {
    const result = lobbyManager.createLobby(socket.id, playerName);
    if (result.success) {
      socket.join(result.code);
      socket.emit('lobby-created', {
        code: result.code,
        sessionId: result.sessionId,
        players: result.players
      });
    } else {
      socket.emit('error', { message: result.message });
    }
  });

  // Join an existing lobby
  socket.on('join-lobby', ({ code, playerName }) => {
    const result = lobbyManager.joinLobby(code, socket.id, playerName);
    if (result.success) {
      socket.join(code);
      socket.emit('lobby-joined', {
        code,
        sessionId: result.sessionId,
        players: result.players
      });
      socket.to(code).emit('player-joined', { players: result.players });
    } else {
      socket.emit('error', { message: result.message });
    }
  });

  // Start the game (host only)
  socket.on('start-game', ({ code }) => {
    const result = lobbyManager.startGame(code, socket.id);
    if (result.success) {
      // Send each player their target privately
      result.assignments.forEach(({ playerId, target }) => {
        io.to(playerId).emit('game-started', {
          target,
          allPlayers: result.allPlayers
        });
      });
      io.to(code).emit('game-status', {
        phase: 'playing',
        aliveCount: result.aliveCount,
        allPlayers: result.allPlayers
      });
    } else {
      socket.emit('error', { message: result.message });
    }
  });

  // Initiate a kill
  socket.on('initiate-kill', ({ code }) => {
    const result = lobbyManager.initiateKill(code, socket.id);
    if (result.success) {
      // Notify the victim - NO killer name sent!
      io.to(result.victimId).emit('kill-pending', { deadline: result.deadline });
      socket.emit('kill-initiated', { victimName: result.victimName, deadline: result.deadline });

      // Start server-side timeout using SessionID
      const victimSessionId = result.victimSessionId;
      const timeout = setTimeout(() => {
        console.log(`Auto-confirming kill for lobby ${code}, victimSession ${victimSessionId}`);

        // Clear map entry (cleanup)
        if (killTimeouts.has(victimSessionId)) {
          killTimeouts.delete(victimSessionId);
        }

        const confirmResult = lobbyManager.confirmKillBySession(code, victimSessionId, true);
        broadcastKillResult(code, confirmResult);

      }, 15000); // 15s

      killTimeouts.set(victimSessionId, timeout);

    } else {
      socket.emit('error', { message: result.message });
    }
  });

  // Confirm being killed (victim confirms)
  socket.on('confirm-death', ({ code }) => {
    // Clear timeout
    const sessionId = lobbyManager.getSessionId(socket.id);
    if (sessionId && killTimeouts.has(sessionId)) {
      clearTimeout(killTimeouts.get(sessionId));
      killTimeouts.delete(sessionId);
    }

    const result = lobbyManager.confirmKill(code, socket.id, false);
    broadcastKillResult(code, result);
  });

  // Cancel pending kill
  socket.on('cancel-kill', ({ code }) => {
    const result = lobbyManager.cancelKill(code, socket.id);

    // Clear timeout
    const sessionId = lobbyManager.getSessionId(socket.id);
    if (sessionId && killTimeouts.has(sessionId)) {
      clearTimeout(killTimeouts.get(sessionId));
      killTimeouts.delete(sessionId);
    }

    if (result.success) {
      io.to(result.killerId).emit('kill-cancelled', {});
    }
  });

  // Cancel pending kill (from killer side) - Manual Cancel
  socket.on('cancel-kill-killer', ({ code }) => {
    const result = lobbyManager.cancelKillByKiller(code, socket.id);

    if (result.success) {
      // Clear server timeout for victim
      // result.victimId is SocketID. We need SessionID to clear timeout.
      const victimSessionId = lobbyManager.getSessionId(result.victimId);
      if (victimSessionId && killTimeouts.has(victimSessionId)) {
        clearTimeout(killTimeouts.get(victimSessionId));
        killTimeouts.delete(victimSessionId);
      }

      io.to(result.victimId).emit('kill-cancelled', {});
      socket.emit('kill-cancelled', {}); // Also notify killer to reset state
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    const result = lobbyManager.handleDisconnect(socket.id);
    if (result && result.code) {
      if (result.lobbyDeleted) {
        io.to(result.code).emit('lobby-deleted', {});
      } else {
        io.to(result.code).emit('player-disconnected', {
          players: result.players,
          allPlayers: result.allPlayers
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Assassin Party Server running on port ${PORT}`);
});
