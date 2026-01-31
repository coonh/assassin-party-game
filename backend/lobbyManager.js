/**
 * Lobby Manager - Handles all game state and logic
 * Supports session-based reconnection
 */

export class LobbyManager {
    constructor(maxLobbies = 100) {
        this.lobbies = new Map();
        this.playerToLobby = new Map();
        this.sessionToPlayer = new Map(); // sessionId -> { lobbyCode, playerId, playerName }
        this.maxLobbies = maxLobbies;
        this.maxPlayersPerLobby = 20;
    }

    /**
     * Generate a unique 4-digit lobby code
     */
    generateCode() {
        let code;
        let attempts = 0;
        do {
            code = String(Math.floor(1000 + Math.random() * 9000));
            attempts++;
            if (attempts > 100) {
                return null;
            }
        } while (this.lobbies.has(code));
        return code;
    }

    /**
     * Generate a unique session ID
     */
    generateSessionId() {
        return Math.random().toString(36).substring(2) + Date.now().toString(36);
    }

    /**
     * Create a new lobby
     */
    createLobby(socketId, hostName) {
        if (this.lobbies.size >= this.maxLobbies) {
            return { success: false, message: 'Maximum number of lobbies reached' };
        }

        const code = this.generateCode();
        if (!code) {
            return { success: false, message: 'Could not generate lobby code' };
        }

        const sessionId = this.generateSessionId();

        const lobby = {
            code,
            hostId: socketId,
            hostSessionId: sessionId,
            players: new Map([[socketId, {
                id: socketId,
                sessionId,
                name: hostName,
                alive: true,
                connected: true
            }]]),
            phase: 'waiting',
            targets: new Map(),
            pendingKills: new Map(),
            killTimeouts: new Map() // victimId -> timeoutObject
        };

        this.lobbies.set(code, lobby);
        this.playerToLobby.set(socketId, code);
        this.sessionToPlayer.set(sessionId, { lobbyCode: code, socketId, playerName: hostName });

        return {
            success: true,
            code,
            sessionId,
            players: this.getPlayersArray(lobby)
        };
    }

    /**
     * Join an existing lobby
     */
    joinLobby(code, socketId, playerName) {
        const lobby = this.lobbies.get(code);
        if (!lobby) {
            return { success: false, message: 'Lobby not found' };
        }

        if (lobby.phase !== 'waiting') {
            return { success: false, message: 'Game already in progress' };
        }

        if (lobby.players.size >= this.maxPlayersPerLobby) {
            return { success: false, message: 'Lobby is full' };
        }

        const sessionId = this.generateSessionId();

        lobby.players.set(socketId, {
            id: socketId,
            sessionId,
            name: playerName,
            alive: true,
            connected: true
        });
        this.playerToLobby.set(socketId, code);
        this.sessionToPlayer.set(sessionId, { lobbyCode: code, socketId, playerName });

        return {
            success: true,
            sessionId,
            players: this.getPlayersArray(lobby)
        };
    }

    /**
     * Rejoin using session ID
     */
    rejoinLobby(sessionId, newSocketId) {
        const sessionData = this.sessionToPlayer.get(sessionId);
        if (!sessionData) {
            return { success: false, message: 'Session not found' };
        }

        const lobby = this.lobbies.get(sessionData.lobbyCode);
        if (!lobby) {
            this.sessionToPlayer.delete(sessionId);
            return { success: false, message: 'Lobby no longer exists' };
        }

        // Find the player by session ID
        let player = null;
        let oldSocketId = null;
        for (const [id, p] of lobby.players) {
            if (p.sessionId === sessionId) {
                player = p;
                oldSocketId = id;
                break;
            }
        }

        if (!player) {
            this.sessionToPlayer.delete(sessionId);
            return { success: false, message: 'Player not found in lobby' };
        }

        // Update socket ID
        lobby.players.delete(oldSocketId);
        player.id = newSocketId;
        player.connected = true;
        lobby.players.set(newSocketId, player);

        // Update mappings
        this.playerToLobby.delete(oldSocketId);
        this.playerToLobby.set(newSocketId, sessionData.lobbyCode);
        this.sessionToPlayer.set(sessionId, { ...sessionData, socketId: newSocketId });

        // Update host ID if this was the host
        if (lobby.hostSessionId === sessionId) {
            lobby.hostId = newSocketId;
        }

        // Update targets map
        if (lobby.targets.has(oldSocketId)) {
            const target = lobby.targets.get(oldSocketId);
            lobby.targets.delete(oldSocketId);
            lobby.targets.set(newSocketId, target);
        }
        // Also update anyone targeting this player
        for (const [killerId, targetId] of lobby.targets) {
            if (targetId === oldSocketId) {
                lobby.targets.set(killerId, newSocketId);
            }
        }

        // Update pendingKills if this player is a victim
        if (lobby.pendingKills.has(oldSocketId)) {
            const killerId = lobby.pendingKills.get(oldSocketId);
            lobby.pendingKills.delete(oldSocketId);
            lobby.pendingKills.set(newSocketId, killerId);
        }

        // Update pendingKills if this player is a killer
        for (const [victimId, kId] of lobby.pendingKills) {
            if (kId === oldSocketId) {
                lobby.pendingKills.set(victimId, newSocketId);
            }
        }

        // Get current target name if in game
        let targetName = null;
        if (lobby.phase === 'playing' && player.alive) {
            const targetId = lobby.targets.get(newSocketId);
            if (targetId) {
                const targetPlayer = lobby.players.get(targetId);
                targetName = targetPlayer ? targetPlayer.name : null;
            }
        }

        return {
            success: true,
            code: sessionData.lobbyCode,
            phase: lobby.phase,
            players: this.getPlayersArray(lobby),
            isHost: lobby.hostSessionId === sessionId,
            isAlive: player.alive,
            target: targetName,
            aliveCount: this.getAliveCount(lobby),
            allPlayers: this.getAllPlayersWithStatus(lobby)
        };
    }

    /**
     * Start the game - creates a Hamiltonian cycle for targets
     */
    startGame(code, requesterId) {
        const lobby = this.lobbies.get(code);
        if (!lobby) {
            return { success: false, message: 'Lobby not found' };
        }

        if (lobby.hostId !== requesterId) {
            return { success: false, message: 'Only the host can start the game' };
        }

        if (lobby.players.size < 3) {
            return { success: false, message: 'Need at least 3 players to start' };
        }

        if (lobby.phase !== 'waiting') {
            return { success: false, message: 'Game already started' };
        }

        // Create Hamiltonian cycle
        const playerIds = Array.from(lobby.players.keys());
        this.shuffleArray(playerIds);

        for (let i = 0; i < playerIds.length; i++) {
            const killerId = playerIds[i];
            const targetId = playerIds[(i + 1) % playerIds.length];
            lobby.targets.set(killerId, targetId);
        }

        lobby.phase = 'playing';

        const assignments = [];
        for (const [playerId, targetId] of lobby.targets) {
            const targetPlayer = lobby.players.get(targetId);
            assignments.push({
                playerId,
                target: targetPlayer.name
            });
        }

        return {
            success: true,
            assignments,
            aliveCount: lobby.players.size,
            allPlayers: this.getAllPlayersWithStatus(lobby)
        };
    }

    /**
     * Initiate a kill (killer claims to have killed their target)
     */
    initiateKill(code, killerId) {
        const lobby = this.lobbies.get(code);
        if (!lobby || lobby.phase !== 'playing') {
            return { success: false, message: 'Game not in progress' };
        }

        const killer = lobby.players.get(killerId);
        if (!killer || !killer.alive) {
            return { success: false, message: 'You are not alive' };
        }

        const victimId = lobby.targets.get(killerId);
        if (!victimId) {
            return { success: false, message: 'No target assigned' };
        }

        const victim = lobby.players.get(victimId);
        if (!victim || !victim.alive) {
            return { success: false, message: 'Target is no longer alive' };
        }

        lobby.pendingKills.set(victimId, killerId);

        // Timeout logic is handled by server.js to ensure broadcast

        return {
            success: true,
            victimId,
            victimSessionId: victim.sessionId,
            victimName: victim.name,
            deadline: Date.now() + 15000
        };
    }

    /**
     * Confirm a kill (victim confirms they were killed, or auto-timeout)
     */
    confirmKill(code, victimId, isAuto = false) {
        const lobby = this.lobbies.get(code);
        if (!lobby || lobby.phase !== 'playing') {
            return { success: false, message: 'Game not in progress' };
        }

        const killerId = lobby.pendingKills.get(victimId);
        if (!killerId) {
            return { success: false, message: 'No pending kill to confirm' };
        }

        const victim = lobby.players.get(victimId);
        const killer = lobby.players.get(killerId);

        if (!victim || !killer) {
            return { success: false, message: 'Player not found' };
        }

        victim.alive = false;
        lobby.pendingKills.delete(victimId);

        lobby.pendingKills.delete(victimId);


        const victimsTarget = lobby.targets.get(victimId);
        lobby.targets.set(killerId, victimsTarget);
        lobby.targets.delete(victimId);

        const alivePlayers = Array.from(lobby.players.values()).filter(p => p.alive);
        const aliveCount = alivePlayers.length;

        const isGameOver = aliveCount === 1;
        let winner = null;
        let newTargetName = null;

        if (isGameOver) {
            lobby.phase = 'ended';
            winner = alivePlayers[0].name;
        } else {
            const newTargetId = lobby.targets.get(killerId);
            const newTarget = lobby.players.get(newTargetId);
            newTargetName = newTarget ? newTarget.name : null;
        }

        return {
            success: true,
            killerId,
            victimId, // Socket ID
            newTarget: newTargetName,
            aliveCount,
            isGameOver,
            winner,
            allPlayers: this.getAllPlayersWithStatus(lobby)
        };
    }

    /**
     * Confirm kill using Session ID (robust against reconnects)
     */
    confirmKillBySession(code, victimSessionId, isAuto) {
        const lobby = this.lobbies.get(code);
        if (!lobby) return { success: false, message: 'Lobby not found' };

        // Find player by session
        let victimSocketId = null;
        for (const [id, p] of lobby.players) {
            if (p.sessionId === victimSessionId) {
                victimSocketId = id;
                break;
            }
        }

        if (!victimSocketId) {
            return { success: false, message: 'Victim session not found in lobby' };
        }

        return this.confirmKill(code, victimSocketId, isAuto);
    }

    /**
     * Cancel a pending kill (called by victim)
     */
    cancelKill(code, victimId) {
        const lobby = this.lobbies.get(code);
        if (!lobby) {
            return { success: false, message: 'Lobby not found' };
        }

        const killerId = lobby.pendingKills.get(victimId);
        if (!killerId) {
            return { success: false, message: 'No pending kill to cancel' };
        }

        lobby.pendingKills.delete(victimId);

        // Clear timeout logic handled in server.js now


        return { success: true, killerId };
    }

    /**
     * Cancel a pending kill by killer (timeout or manual cancel)
     */
    cancelKillByKiller(code, killerId) {
        const lobby = this.lobbies.get(code);
        if (!lobby) {
            return { success: false, message: 'Lobby not found' };
        }

        // Find victim by killer ID
        let victimId = null;
        for (const [vId, kId] of lobby.pendingKills) {
            if (kId === killerId) {
                victimId = vId;
                break;
            }
        }

        if (!victimId) {
            return { success: false, message: 'No pending kill to cancel' };
        }

        lobby.pendingKills.delete(victimId);
        return { success: true, victimId };
    }

    /**
     * Handle player disconnect - mark as disconnected but don't remove
     */
    handleDisconnect(socketId) {
        const code = this.playerToLobby.get(socketId);
        if (!code) return null;

        const lobby = this.lobbies.get(code);
        if (!lobby) return null;

        const player = lobby.players.get(socketId);
        if (!player) return null;

        // During waiting phase, just remove them
        if (lobby.phase === 'waiting') {
            this.playerToLobby.delete(socketId);
            this.sessionToPlayer.delete(player.sessionId);
            lobby.players.delete(socketId);

            if (socketId === lobby.hostId) {
                // If host leaves during waiting, delete lobby
                this.lobbies.delete(code);
                return { code, players: [], lobbyDeleted: true };
            }

            if (lobby.players.size === 0) {
                this.lobbies.delete(code);
                return { code, players: [], lobbyDeleted: true };
            }

            return {
                code,
                players: this.getPlayersArray(lobby)
            };
        }

        // During game, just mark as disconnected (they can rejoin)
        player.connected = false;

        return {
            code,
            players: this.getPlayersArray(lobby),
            allPlayers: this.getAllPlayersWithStatus(lobby)
        };
    }

    /**
     * Get lobby count
     */
    getLobbyCount() {
        return this.lobbies.size;
    }

    /**
     * Get alive count for a lobby
     */
    getAliveCount(lobby) {
        return Array.from(lobby.players.values()).filter(p => p.alive).length;
    }

    /**
     * Get Session ID provided socket ID
     */
    getSessionId(socketId) {
        const code = this.playerToLobby.get(socketId);
        if (!code) return null;
        const lobby = this.lobbies.get(code);
        if (!lobby) return null;
        const player = lobby.players.get(socketId);
        return player ? player.sessionId : null;
    }

    /**
     * Helper: Convert players Map to array (for lobby display)
     */
    getPlayersArray(lobby) {
        return Array.from(lobby.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            isHost: p.sessionId === lobby.hostSessionId
        }));
    }

    /**
     * Helper: Get all players with alive/connected status (for game display)
     */
    getAllPlayersWithStatus(lobby) {
        return Array.from(lobby.players.values()).map(p => ({
            name: p.name,
            alive: p.alive,
            connected: p.connected
        }));
    }

    /**
     * Helper: Fisher-Yates shuffle
     */
    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
}
