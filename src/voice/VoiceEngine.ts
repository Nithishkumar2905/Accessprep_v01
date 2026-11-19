/**
 * ACCESSPREP-X — Production Voice Engine
 * ============================================================
 * Robust, resilient Web Speech recognition engine tailored for
 * visually impaired and blind candidates.
 *
 * Key features:
 *  • Automatically requests browser audio permission via getUserMedia
 *  • Continuous recognition emulation with clean lifecycle transitions
 *  • Real-time speech interruption: Mic stays listening during TTS speech
 *    and immediately executes "STOP" / "Stop speaking" on ANY screen!
 *  • Transient error resilience (audio-capture, network, aborted, no-speech)
 *  • Echo-suppression: Non-stop transcripts are filtered out during TTS playback
 *  • Direct pipeline to NavigationController via onTranscript callback
 */

import {
  parseVisionWakeWord,
  parseStopListening,
  extractCommandFromConversationalPhrase
} from './commandParser.ts';

export type VoiceAssistantState = 'idle' | 'listening' | 'processing' | 'responding';

export interface VoiceEngineOptions {
  /** Dispatches transcript to the global NavigationController pipeline */
  onTranscript: (transcript: string) => Promise<void>;
  /** Notifies UI of microphone listening status */
  onListeningChange: (listening: boolean) => void;
  /** Notifies UI of conversational assistant state (idle -> listening -> processing -> responding -> idle) */
  onStateChange?: (state: VoiceAssistantState) => void;
  /** Live accumulated speech during conversational listening */
  onSpeechAccumulated?: (text: string) => void;
  /** Audio beacon sound prompt trigger */
  onPlayBeacon?: (type: 'listening' | 'success' | 'alert') => void;
  /** Immediately interrupts and halts active TTS speech */
  onStopSpeaking?: () => void;
  /** Notifies UI of microphone permission denial or unsupported speech recognition */
  onError?: (errorType: 'denied' | 'unsupported' | 'error', message: string) => void;
  /** Speech recognition language (defaults to 'en-IN') */
  lang?: string;
}

function isStopCommand(text: string): boolean {
  const t = text.toLowerCase().trim();
  const stops = [
    'stop',
    'stop speaking',
    'stop reading',
    'stop audio',
    'stop speech',
    'be quiet',
    'quiet',
    'silence',
    'shut up',
    'pause',
    'pause reading',
    'pause audio',
    'halt',
    'vision stop',
    'hey vision stop'
  ];
  return stops.some(
    (s) => t === s || t.startsWith(s + ' ') || t.endsWith(' ' + s) || t.includes(s)
  );
}

/**
 * Direct actionable exam/confirmation commands that should interrupt ongoing TTS
 * and immediately execute (barge-in) without waiting for long question/instruction reading to finish.
 */
function isActionableBargeInCommand(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;

  const exactCommands = new Set([
    'submit',
    'submit exam',
    'submit the exam',
    'submit examination',
    'submit the examination',
    'submit my examination',
    'submit test',
    'submit pilot demo',
    'submit pilot examination',
    'submit diagnostic',
    'finish exam',
    'finish examination',
    'finish test',
    'summit examination',
    'summit exam',
    'confirm submission',
    'cancel submission',
    'start examination',
    'start the examination',
    'begin test',
    'begin the test',
    'start pilot demo',
    'begin pilot examination',
    'start diagnostic',
    'begin diagnostic',
    'start exam',
    'begin exam',
    'yes',
    'yeah',
    'yep',
    'confirm',
    'i confirm',
    'confirmed',
    'start now',
    'submit now',
    'yes submit',
    'yes start',
    'no',
    'nope',
    'cancel',
    'not now',
    'go back',
    'next question',
    'previous question',
    'skip question',
    'mark for review',
    'repeat question',
    'read options',
    'repeat options',
    'option a',
    'option b',
    'option c',
    'option d',
    'select option a',
    'select option b',
    'select option c',
    'select option d',
    'choice a',
    'choice b',
    'choice c',
    'choice d',
    'answer a',
    'answer b',
    'answer c',
    'answer d',
    'hey vision',
    'hi vision',
    'hello vision'
  ]);

  if (exactCommands.has(t)) return true;

  return /^(?:please\s+)?(?:submit|summit|finish|start|begin)\s+(?:the\s+|my\s+)?(?:pilot\s+demo|pilot\s+examination|diagnostic|examination|exam|test)$/.test(
    t
  );
}

export class VoiceEngine {
  private opts: VoiceEngineOptions;
  private rec: any = null;
  private isAllowed: boolean = false;
  private isSpeaking: boolean = false;
  private isStarting: boolean = false;
  private isRunning: boolean = false;
  private isDestroyed: boolean = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private hasRequestedPermission: boolean = false;
  private assistantState: VoiceAssistantState = 'idle';
  private accumulatedSpeech: string = '';

  constructor(opts: VoiceEngineOptions) {
    this.opts = opts;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Current conversational assistant state */
  getState(): VoiceAssistantState {
    return this.assistantState;
  }

  /** Live speech accumulated in listening state before "Stop listening" */
  getAccumulatedSpeech(): string {
    return this.accumulatedSpeech;
  }

  /** Manual state override */
  setState(state: VoiceAssistantState): void {
    this.setAssistantState(state);
  }

  /** Manually trigger wake-word activation (e.g. from Alt+Space or UI button) */
  triggerWakeWordActivation(): void {
    this.accumulatedSpeech = '';
    this.setAssistantState('listening');
    this.opts.onPlayBeacon?.('listening');
    if (this.opts.onSpeechAccumulated) {
      this.opts.onSpeechAccumulated('');
    }
    if (!this.isRunning && !this.isStarting && this.isAllowed) {
      this._startRec();
    }
  }

  /** Manually finalize and stop listening (e.g. from Alt+Space or UI button) */
  triggerStopListening(): void {
    if (this.assistantState === 'listening') {
      this.setAssistantState('processing');
      const cmd = extractCommandFromConversationalPhrase(this.accumulatedSpeech);
      this.accumulatedSpeech = '';
      if (this.opts.onSpeechAccumulated) {
        this.opts.onSpeechAccumulated('');
      }
      this.opts.onTranscript(cmd).catch((err) => {
        console.error('[VoiceEngine] Transcript handling error:', err);
      });
    }
  }

  /** Start listening (called after login, or when candidate clicks mic / presses Alt+V) */
  async start(): Promise<void> {
    this.isAllowed = true;

    // First time in browser session: trigger getUserMedia to ensure native permission prompt appears
    if (!this.hasRequestedPermission && typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        this.hasRequestedPermission = true;
        // Release tracks immediately so SpeechRecognition has uncontended access
        stream.getTracks().forEach((t) => t.stop());
      } catch (err: any) {
        console.warn('[VoiceEngine] getUserMedia error:', err);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          console.error('[VoiceEngine] Microphone access denied by user.');
          this.opts.onListeningChange(false);
          this.opts.onError?.('denied', 'Microphone permission denied. Please allow microphone access or use keyboard input.');
          return;
        }
      }
    }

    this._startRec();
  }

  /** Stop listening (e.g. on logout) */
  stop(): void {
    this.isAllowed = false;
    this.accumulatedSpeech = '';
    this.setAssistantState('idle');
    this._stopRec();
  }

  /** Inform engine whether TTS speech is currently playing */
  setSpeaking(speaking: boolean): void {
    this.isSpeaking = speaking;
    if (speaking) {
      if (this.assistantState === 'processing') {
        this.setAssistantState('responding');
      }
    } else {
      // Speech finished: return to idle state.
      // Crucial: Assistant does not auto-restart listening for commands!
      if (this.assistantState === 'responding') {
        this.setAssistantState('idle');
        this.accumulatedSpeech = '';
        if (this.opts.onSpeechAccumulated) {
          this.opts.onSpeechAccumulated('');
        }
      }
    }
  }

  /** Temporarily pause listening */
  pause(): void {
    this.isSpeaking = true;
  }

  /** Resume listening */
  resume(): void {
    this.isSpeaking = false;
    if (!this.isAllowed) return;

    if (!this.isRunning && !this.isStarting) {
      this._startRec();
    }
  }

  /** Free all resources */
  destroy(): void {
    this.isDestroyed = true;
    this.isAllowed = false;
    this.accumulatedSpeech = '';
    this.setAssistantState('idle');
    this._stopRec();
  }

  /** Whether the microphone is currently active */
  isListening(): boolean {
    return this.isRunning && this.isAllowed && this.assistantState === 'listening';
  }

  private setAssistantState(newState: VoiceAssistantState): void {
    this.assistantState = newState;
    this.opts.onStateChange?.(newState);
    this.opts.onListeningChange(newState === 'listening');
  }

  /**
   * Processes speech transcript through the conversational wake-word state machine.
   * Can be invoked directly in unit tests or by the browser speech recognition event.
   */
  handleSpeechTranscript(transcript: string): void {
    if (!transcript) return;

    // Emergency speech interruption: If currently speaking, stop commands halt TTS
    if (this.isSpeaking) {
      if (isStopCommand(transcript)) {
        console.log('[VoiceEngine Speech Interrupted by Stop Command]:', transcript);
        this.isSpeaking = false;
        this.setAssistantState('idle');
        this.opts.onStopSpeaking?.();
        return;
      }
      if (isActionableBargeInCommand(transcript)) {
        console.log('[VoiceEngine Barge-In Command During Speech]:', transcript);
        this.isSpeaking = false;
        this.opts.onStopSpeaking?.();
        // Proceed to dispatch
      } else {
        // Ignore speaker feedback/echo
        return;
      }
    }

    console.log(`[VoiceEngine Heard in state ${this.assistantState}]:`, transcript);

    // ─────────────────────────────────────────────────────────────
    // 1. IDLE STATE: Listen ONLY for wake phrase "Hey Vision"
    // ─────────────────────────────────────────────────────────────
    if (this.assistantState === 'idle') {
      const wakeWord = parseVisionWakeWord(transcript);
      const hasWakePhrase = wakeWord === 'activate_vision' || /hey\s+vision/i.test(transcript);

      if (!hasWakePhrase) {
        // SILENTLY DISCARD ordinary background speech or unrelated conversations
        return;
      }

      // Wake phrase detected!
      console.log('[VoiceEngine]: Wake phrase "Hey Vision" detected.');

      // Check if user combined wake word, command, and "stop listening" in one phrase:
      // E.g. "Hey Vision repeat question stop listening"
      if (parseStopListening(transcript)) {
        const command = extractCommandFromConversationalPhrase(transcript);
        this.accumulatedSpeech = '';
        if (this.opts.onSpeechAccumulated) this.opts.onSpeechAccumulated('');
        this.setAssistantState('processing');
        this.opts.onTranscript(command).catch((err) => {
          console.error('[VoiceEngine] Transcript handling error:', err);
        });
        return;
      }

      // Otherwise activate listening mode
      this.setAssistantState('listening');
      this.opts.onPlayBeacon?.('listening');

      // Extract remainder if command was started right after wake phrase:
      const remainder = transcript
        .replace(/^(?:hey\s+vision(?:\s+assistant)?|activate\s+vision(?:\s+assistant)?|turn\s+on\s+vision|start\s+vision|vision\s+assistant|vision|hi\s+vision|hello\s+vision|okay\s+vision|ok\s+vision|hai\s+vision)\s*/i, '')
        .trim();

      this.accumulatedSpeech = remainder;
      if (remainder && this.opts.onSpeechAccumulated) {
        this.opts.onSpeechAccumulated(remainder);
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // 2. LISTENING STATE: Capture user command until "Stop listening"
    // ─────────────────────────────────────────────────────────────
    if (this.assistantState === 'listening') {
      if (parseStopListening(transcript)) {
        // Finalize command!
        console.log('[VoiceEngine]: "Stop listening" received. Finalizing speech input.');
        const fullInput = (this.accumulatedSpeech ? this.accumulatedSpeech + ' ' : '') + transcript;
        const command = extractCommandFromConversationalPhrase(fullInput);
        this.accumulatedSpeech = '';
        if (this.opts.onSpeechAccumulated) this.opts.onSpeechAccumulated('');
        this.setAssistantState('processing');
        this.opts.onTranscript(command).catch((err) => {
          console.error('[VoiceEngine] Transcript handling error:', err);
        });
        return;
      }

      // Buffer user speech without premature execution
      this.accumulatedSpeech = (this.accumulatedSpeech ? this.accumulatedSpeech + ' ' : '') + transcript;
      if (this.opts.onSpeechAccumulated) {
        this.opts.onSpeechAccumulated(this.accumulatedSpeech);
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // 3. PROCESSING / RESPONDING: Mic is quiet while acting / speaking
    // ─────────────────────────────────────────────────────────────
    if (this.assistantState === 'processing' || this.assistantState === 'responding') {
      return;
    }
  }

  // ── Internal SpeechRecognition Engine ──────────────────────────────────────

  private _stopRec(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.rec) {
      try {
        this.rec.abort();
      } catch {
        /* ignore abort error on closed engine */
      }
      this.rec = null;
    }

    this.isRunning = false;
    this.isStarting = false;
    this.opts.onListeningChange(false);
  }

  private _startRec(): void {
    if (this.isDestroyed || !this.isAllowed || this.isStarting || this.isRunning) {
      return;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (typeof window === 'undefined') return;

    const SpeechRec =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRec) {
      console.warn('[VoiceEngine] Browser SpeechRecognition not supported.');
      this.opts.onError?.('unsupported', 'Speech recognition is not supported in this browser. Please use keyboard input.');
      return;
    }

    try {
      this.isStarting = true;
      const rec = new SpeechRec();

      // Continuous emulation mode: captures phrases cleanly without Chromium HAL deadlock
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = this.opts.lang || 'en-IN';
      rec.maxAlternatives = 5;

      rec.onstart = () => {
        this.isStarting = false;
        this.isRunning = true;
        this.opts.onListeningChange(this.assistantState === 'listening');
      };

      rec.onresult = (event: any) => {
        if (!this.isAllowed) return;

        const lastIdx = event.results.length - 1;
        const result = event.results[lastIdx];
        if (!result || !result[0]) return;

        let transcript = (result[0].transcript || '').trim();

        // Check alternatives for exact commands
        for (let i = 0; i < result.length; i++) {
          const alt = (result[i]?.transcript || '').trim();
          if (/^(ashwin|ashwin sharma|ashwin kumar|ashwin s|ashwin r)$/i.test(alt)) {
            transcript = alt;
            break;
          }
          if (isStopCommand(alt) || isActionableBargeInCommand(alt)) {
            transcript = alt;
            break;
          }
        }

        if (!transcript) return;
        this.handleSpeechTranscript(transcript);
      };

      rec.onerror = (e: any) => {
        const error = e.error;

        if (error === 'not-allowed' || error === 'service-not-allowed') {
          console.warn('[VoiceEngine] Mic permission not allowed.');
          this.isAllowed = false;
          this.setAssistantState('idle');
          this.opts.onListeningChange(false);
          this.opts.onError?.('denied', 'Microphone permission denied. Please allow microphone access or use keyboard input.');
          return;
        }

        // Transient audio contention error: wait 500ms and re-arm
        if (error === 'audio-capture') {
          console.warn('[VoiceEngine] Audio device busy. Scheduling restart...');
          if (this.restartTimer) clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => {
            this.isStarting = false;
            this.isRunning = false;
            this._startRec();
          }, 600);
          return;
        }

        // Network or service glitches: retry in 800ms
        if (error === 'network') {
          if (this.restartTimer) clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => {
            this.isStarting = false;
            this.isRunning = false;
            this._startRec();
          }, 800);
          return;
        }

        // 'no-speech' and 'aborted' are normal lifecycle events handled in onend
      };

      rec.onend = () => {
        this.isRunning = false;
        this.isStarting = false;
        this.rec = null;
        this.opts.onListeningChange(this.assistantState === 'listening');

        // Auto-restart recognition loop for wake-word detection or continued listening
        if (!this.isDestroyed && this.isAllowed) {
          if (this.restartTimer) clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => {
            this._startRec();
          }, 150);
        }
      };

      this.rec = rec;
      rec.start();
    } catch (err: any) {
      console.warn('[VoiceEngine] Could not start SpeechRecognition instance:', err);
      this.isStarting = false;
      this.isRunning = false;
      this.rec = null;

      if (!this.isDestroyed && this.isAllowed) {
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          this._startRec();
        }, 600);
      }
    }
  }
}
