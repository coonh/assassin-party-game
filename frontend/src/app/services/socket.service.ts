import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject } from 'rxjs';

export interface Player {
    id: string;
    name: string;
    isHost: boolean;
}

export interface PlayerStatus {
    name: string;
    alive: boolean;
    connected: boolean;
}

export interface GameState {
    phase: 'idle' | 'lobby' | 'playing' | 'dead' | 'ended';
    lobbyCode: string | null;
    players: Player[];
    allPlayers: PlayerStatus[];
    isHost: boolean;
    target: string | null;
    aliveCount: number;
    winner: string | null;
    pendingKill: boolean;
    waitingForKillConfirmation: boolean;
    playerName: string | null;
    killDeadline?: number;
}

const SESSION_KEY = 'assassin_session';
const PLAYER_NAME_KEY = 'assassin_player_name';

@Injectable({
    providedIn: 'root'
})
export class SocketService {
    private socket: Socket;
    private gameState = new BehaviorSubject<GameState>({
        phase: 'idle',
        lobbyCode: null,
        players: [],
        allPlayers: [],
        isHost: false,
        target: null,
        aliveCount: 0,
        winner: null,
        pendingKill: false,
        waitingForKillConfirmation: false,
        playerName: null
    });

    private killTimeout: any = null;

    public gameState$ = this.gameState.asObservable();
    private errorSubject = new BehaviorSubject<string | null>(null);
    public error$ = this.errorSubject.asObservable();
    private eventSubject = new BehaviorSubject<any>(null);
    public events$ = this.eventSubject.asObservable();

    constructor() {
        const isLocal = window.location.hostname === 'localhost';
        const socketUrl = isLocal ? 'http://localhost:3000' : window.location.origin;
        this.socket = io(socketUrl, {
            path: isLocal ? undefined : '/hunt/socket.io'
        });
        this.setupListeners();
        this.tryRejoin();
    }

    private setupListeners(): void {
        this.socket.on('lobby-created', ({ code, sessionId, players }) => {
            this.saveSession(sessionId, code);
            this.updateState({
                phase: 'lobby',
                lobbyCode: code,
                players,
                isHost: true
            });
        });

        this.socket.on('lobby-joined', ({ code, sessionId, players }) => {
            this.saveSession(sessionId, code);
            this.updateState({
                phase: 'lobby',
                lobbyCode: code,
                players,
                isHost: false
            });
        });

        this.socket.on('rejoin-success', ({ code, phase, players, isHost, isAlive, target, aliveCount, allPlayers }) => {
            let gamePhase: GameState['phase'];
            if (phase === 'waiting') {
                gamePhase = 'lobby';
            } else if (phase === 'playing') {
                gamePhase = isAlive ? 'playing' : 'dead';
            } else {
                gamePhase = 'ended';
            }

            this.updateState({
                phase: gamePhase,
                lobbyCode: code,
                players,
                allPlayers: allPlayers || [],
                isHost,
                target,
                aliveCount
            });
        });

        this.socket.on('rejoin-failed', ({ message }) => {
            this.clearSession();
            // Stay on idle screen
        });

        this.socket.on('player-joined', ({ players }) => {
            this.updateState({ players });
        });

        this.socket.on('player-left', ({ players }) => {
            this.updateState({ players });
        });

        this.socket.on('player-reconnected', ({ players, allPlayers }) => {
            this.updateState({ players, allPlayers: allPlayers || [] });
        });

        this.socket.on('player-disconnected', ({ players, allPlayers }) => {
            this.updateState({ players, allPlayers: allPlayers || [] });
        });

        this.socket.on('lobby-deleted', () => {
            this.clearSession();
            this.resetState();
            this.errorSubject.next('Lobby was deleted');
            setTimeout(() => this.errorSubject.next(null), 5000);
        });

        this.socket.on('game-started', ({ target, allPlayers }) => {
            this.updateState({
                phase: 'playing',
                target,
                allPlayers: allPlayers || []
            });
            // Emit game started event for animation
            this.eventSubject.next({ type: 'game_started', target });
        });

        this.socket.on('game-status', ({ phase, aliveCount, winner, allPlayers }) => {
            const updates: Partial<GameState> = {
                aliveCount,
                allPlayers: allPlayers || this.gameState.getValue().allPlayers
            };
            if (phase === 'ended') {
                updates.phase = 'ended';
                updates.winner = winner;
            }
            this.updateState(updates);
        });

        this.socket.on('kill-pending', ({ deadline }) => {
            // No killer name - intentionally anonymous
            this.updateState({
                pendingKill: true,
                killDeadline: deadline
            });
        });

        this.socket.on('kill-initiated', ({ victimName, deadline }) => {
            // Killer waiting for confirmation
            this.updateState({
                waitingForKillConfirmation: true,
                killDeadline: deadline
            });

            // No local timeout needed as server handles it.
            // Client just shows the visual count down.
        });

        this.socket.on('kill-confirmed', ({ newTarget, isGameOver }) => {
            // Clear timeout
            if (this.killTimeout) {
                clearTimeout(this.killTimeout);
                this.killTimeout = null;
            }

            const oldTarget = this.gameState.getValue().target;

            // Emit animation event with context
            this.eventSubject.next({
                type: 'kill_confirmed',
                oldTarget,
                newTarget
            });
            setTimeout(() => this.eventSubject.next(null), 100);

            if (isGameOver) {
                this.updateState({
                    phase: 'ended',
                    target: null,
                    waitingForKillConfirmation: false
                });
            } else {
                this.updateState({
                    target: newTarget,
                    waitingForKillConfirmation: false
                });
            }
        });

        this.socket.on('kill-cancelled', () => {
            // Clear timeout
            if (this.killTimeout) {
                clearTimeout(this.killTimeout);
                this.killTimeout = null;
            }

            // Fix: Reset both states to handle both killer (waiting) and victim (pending) cases
            this.updateState({
                waitingForKillConfirmation: false,
                pendingKill: false
            });

            this.errorSubject.next('Kill denied/cancelled');
            setTimeout(() => this.errorSubject.next(null), 3000);
        });

        this.socket.on('you-died', () => {
            // Close dialog immediately
            this.updateState({ pendingKill: false });

            // Trigger death animation first
            this.eventSubject.next({ type: 'death_animation' });

            // Delay showing the dead screen to allow animation to play
            setTimeout(() => {
                this.updateState({
                    phase: 'dead',
                    target: null
                });
            }, 2000); // 2 second delay for drama
        });

        this.socket.on('error', ({ message }) => {
            this.errorSubject.next(message);
            setTimeout(() => this.errorSubject.next(null), 5000);
        });
    }

    showTemporaryMessage(message: string): void {
        this.errorSubject.next(message);
        setTimeout(() => this.errorSubject.next(null), 3000);
    }

    getCurrentState(): GameState {
        return this.gameState.getValue();
    }

    private updateState(updates: Partial<GameState>): void {
        const current = this.gameState.getValue();
        this.gameState.next({ ...current, ...updates });
    }

    private saveSession(sessionId: string, lobbyCode: string): void {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId, lobbyCode }));
    }

    private clearSession(): void {
        localStorage.removeItem(SESSION_KEY);
    }

    private tryRejoin(): void {
        const savedSession = localStorage.getItem(SESSION_KEY);
        if (savedSession) {
            try {
                const { sessionId } = JSON.parse(savedSession);
                this.socket.emit('rejoin', { sessionId });
            } catch (e) {
                this.clearSession();
            }
        }
    }

    getSavedPlayerName(): string | null {
        return localStorage.getItem(PLAYER_NAME_KEY);
    }

    savePlayerName(name: string): void {
        localStorage.setItem(PLAYER_NAME_KEY, name);
        this.updateState({ playerName: name });
    }

    createLobby(playerName: string): void {
        this.savePlayerName(playerName);
        this.socket.emit('create-lobby', { playerName });
    }

    joinLobby(code: string, playerName: string): void {
        this.savePlayerName(playerName);
        this.socket.emit('join-lobby', { code: code.toUpperCase(), playerName });
    }

    startGame(): void {
        const state = this.gameState.getValue();
        if (state.lobbyCode) {
            this.socket.emit('start-game', { code: state.lobbyCode });
        }
    }

    initiateKill(): void {
        const state = this.gameState.getValue();
        if (state.lobbyCode) {
            this.socket.emit('initiate-kill', { code: state.lobbyCode });
        }
    }

    confirmDeath(): void {
        const state = this.gameState.getValue();
        if (state.lobbyCode) {
            this.socket.emit('confirm-death', { code: state.lobbyCode });
        }
    }

    cancelKill(): void {
        const state = this.gameState.getValue();
        if (state.lobbyCode) {
            this.socket.emit('cancel-kill', { code: state.lobbyCode });
            // Optimistically update state to close modal immediately
            this.updateState({ pendingKill: false });
        }
    }

    cancelKillByKiller(): void {
        const state = this.gameState.getValue();
        if (state.lobbyCode) {
            this.socket.emit('cancel-kill-killer', { code: state.lobbyCode });
            // Optimistically update
            this.updateState({ waitingForKillConfirmation: false });
        }
    }

    resetState(): void {
        this.clearSession();
        if (this.killTimeout) {
            clearTimeout(this.killTimeout);
            this.killTimeout = null;
        }
        this.gameState.next({
            phase: 'idle',
            lobbyCode: null,
            players: [],
            allPlayers: [],
            isHost: false,
            target: null,
            aliveCount: 0,
            winner: null,
            pendingKill: false,
            waitingForKillConfirmation: false,
            playerName: null
        });
    }
}
