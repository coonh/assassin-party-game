import { Component, inject, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SocketService } from './services/socket.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  private socketService = inject(SocketService);
  private cdr = inject(ChangeDetectorRef);
  @ViewChild('lobbyCodeInput') lobbyCodeInput!: ElementRef<HTMLInputElement>;

  gameState$ = this.socketService.gameState$;
  error$ = this.socketService.error$;

  playerName = '';
  lobbyCode = '';
  showJoinForm = false;
  isSlashing = false;
  isCardFlyingIn = false;
  showSplatters = false;
  showInstructions = false;
  displayTarget: string | null = null;
  timeLeft: number = 15;
  private timerInterval: any;
  private currentDeadline: number | undefined;

  constructor() {
    // Load saved player name for rejoin
    const savedName = this.socketService.getSavedPlayerName();
    if (savedName) {
      this.playerName = savedName;
    }

    // Subscribe to state to initialize displayTarget on load/rejoin
    this.gameState$.subscribe(state => {
      // Sync deadline to local property if present
      if (state.killDeadline) {
        this.currentDeadline = state.killDeadline;
      }

      // Handle countdown timer
      if ((state.pendingKill || state.waitingForKillConfirmation) && this.currentDeadline) {
        this.updateTimer(this.currentDeadline);

        if (!this.timerInterval) {
          this.timerInterval = setInterval(() => {
            if (this.currentDeadline) {
              this.updateTimer(this.currentDeadline);
            }
          }, 1000);
        }
      } else {
        // Clear timer if not needed
        if (this.timerInterval) {
          clearInterval(this.timerInterval);
          this.timerInterval = null;
          this.currentDeadline = undefined;
        }
      }

      // Sync target when state changes
      this.syncDisplayTarget(state);
    });

    // Subscribe to events for animation
    this.socketService.events$.subscribe(event => {
      if (!event) return;

      if (event.type === 'game_started') {
        this.displayTarget = event.target;
        this.isCardFlyingIn = true;
        setTimeout(() => this.isCardFlyingIn = false, 1500);
      }
      else if (event.type === 'kill_confirmed') {
        // Killer Logic: More dramatic slash
        this.displayTarget = event.oldTarget;
        this.isSlashing = true;
        this.triggerSplatters();

        setTimeout(() => {
          // 1. Swap target name while old card is invisible
          const currentState = this.socketService.getCurrentState();
          this.displayTarget = event.newTarget || currentState.target;

          // 2. Immediately reset slashing and start fly-in
          this.isSlashing = false;
          this.isCardFlyingIn = true;
          this.cdr.detectChanges();

          setTimeout(() => {
            this.isCardFlyingIn = false;
            // Final sync to be sure
            this.syncDisplayTarget(this.socketService.getCurrentState());
          }, 1500);
        }, 1600); // 1.6s delay allows rip animation (1.5s) to fully fade out
      }
      else if (event.type === 'death_animation') {
        // Victim Logic: You are dying
        this.isSlashing = true;
        this.triggerSplatters();
        this.cdr.detectChanges();

        setTimeout(() => {
          this.isSlashing = false;
        }, 1600);
      }
    });
  }

  createLobby(): void {
    if (this.playerName.trim()) {
      this.socketService.createLobby(this.playerName.trim());
    }
  }

  showJoin(): void {
    this.showJoinForm = true;
    setTimeout(() => {
      if (this.lobbyCodeInput) {
        this.lobbyCodeInput.nativeElement.focus();
      }
    }, 100);
  }

  hideJoin(): void {
    this.showJoinForm = false;
    this.lobbyCode = '';
  }

  joinLobby(): void {
    if (this.playerName.trim() && this.lobbyCode.trim().length === 4) {
      this.socketService.joinLobby(this.lobbyCode.trim(), this.playerName.trim());
    }
  }

  startGame(): void {
    this.socketService.startGame();
  }

  initiateKill(): void {
    this.socketService.initiateKill();
    // Animation now handled by event subscription
  }

  confirmDeath(): void {
    this.socketService.confirmDeath();
    // Victim side doesn't need slash animation
  }

  cancelKill(): void {
    this.socketService.cancelKill();
  }

  cancelKillByKiller(): void {
    this.socketService.cancelKillByKiller();
  }

  toggleInstructions(): void {
    this.showInstructions = !this.showInstructions;
  }

  triggerSplatters(): void {
    this.showSplatters = true;
    setTimeout(() => this.showSplatters = false, 2000);
  }

  copyLobbyCode(code: string | null): void {
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
      // Use existing error toast for feedback, but with success-like message
      this.socketService.showTemporaryMessage('Lobby code copied to clipboard!');
    });
  }

  playAgain(): void {
    this.socketService.resetState();
    this.playerName = this.socketService.getSavedPlayerName() || '';
    this.lobbyCode = '';
    this.showJoinForm = false;
  }

  private syncDisplayTarget(state: any) {
    if (!state.target) {
      this.displayTarget = null;
      return;
    }

    // Only update if not currently slashing
    // We allow update during fly-in if displayTarget is missing
    if (state.target !== this.displayTarget) {
      if (!this.isSlashing) {
        this.displayTarget = state.target;
        this.cdr.detectChanges();
      }
    }
  }

  private updateTimer(deadline: number) {
    const now = Date.now();
    const diff = Math.ceil((deadline - now) / 1000);
    this.timeLeft = diff > 0 ? diff : 0;
    this.cdr.detectChanges();
  }
}
