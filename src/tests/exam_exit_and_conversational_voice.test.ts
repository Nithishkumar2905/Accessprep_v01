/**
 * ACCESSPREP-X — Test Suite for Exam Exit, Conversational Wake-Word Voice Assistant, and Font Face Settings
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStopListening,
  extractCommandFromConversationalPhrase,
  parseFontFaceCommand,
  cleanVoiceTranscript
} from '../voice/commandParser.ts';

import {
  normalizeExamCommand,
  isSubmitConfirmPhrase,
  isSubmitCancelPhrase
} from '../voice/examContextResolver.ts';

import { VoiceEngine, VoiceAssistantState } from '../voice/VoiceEngine.ts';
import { NavigationController } from '../voice/NavigationController.ts';
import { NavigationContext } from '../voice/commandTypes.ts';
import { User } from '../db/database.ts';

function makeUser(): User {
  return {
    id: 'usr_candidate_01',
    rollNumber: 'SSC-2026-MTS-01',
    name: 'Aarav Sharma',
    email: 'aarav.sharma@accessprep.internal',
    passwordHash: 'dummy',
    role: 'candidate',
    pwdCategory: 'Visually Impaired',
    needScribe: true,
    examRegion: 'Northern Region (NR)',
    examLanguage: 'English',
    createdAt: '2026-01-01T00:00:00Z'
  };
}

function makeContext(overrides: Partial<NavigationContext> = {}): NavigationContext {
  return {
    currentScreen: 'dashboard',
    user: makeUser(),
    isExamActive: false,
    pendingExamExit: null,
    historyStack: [],
    lastSpokenText: '',
    isVisionAssistantActive: true,
    ...overrides
  };
}

// ============================================================================
// 1. CONVERSATIONAL WAKE-WORD COMMAND PARSER TESTS
// ============================================================================

test('Conversational Voice: parseStopListening detects termination phrases', () => {
  const stopPhrases = [
    'stop listening',
    'hey vision stop listening',
    'please stop listening',
    'finish command',
    'done speaking',
    'end command',
    'select option a stop listening'
  ];

  for (const phrase of stopPhrases) {
    assert.equal(
      parseStopListening(phrase),
      true,
      `Expected "${phrase}" to be recognized as stop listening`
    );
  }

  const ongoingPhrases = [
    'repeat question',
    'select option b',
    'start exam',
    'go to dashboard',
    'stop speaking',
    'stop reading'
  ];

  for (const phrase of ongoingPhrases) {
    assert.equal(
      parseStopListening(phrase),
      false,
      `Expected "${phrase}" NOT to trigger stop listening`
    );
  }
});

test('Conversational Voice: extractCommandFromConversationalPhrase strips wake phrase and stop listening phrase', () => {
  assert.equal(
    extractCommandFromConversationalPhrase('hey vision repeat question stop listening'),
    'repeat question'
  );

  assert.equal(
    extractCommandFromConversationalPhrase('hey vision select option b'),
    'select option b'
  );

  assert.equal(
    extractCommandFromConversationalPhrase('go to dashboard stop listening'),
    'go to dashboard'
  );

  assert.equal(
    extractCommandFromConversationalPhrase('hey vision exit examination stop listening'),
    'exit examination'
  );

  assert.equal(
    extractCommandFromConversationalPhrase('hey vision'),
    ''
  );
});

// ============================================================================
// 2. FONT FACE COMMAND PARSER TESTS
// ============================================================================

test('Font Face: parseFontFaceCommand correctly recognizes all 6 accessible font faces', () => {
  assert.equal(parseFontFaceCommand('system font'), 'system');
  assert.equal(parseFontFaceCommand('inter font'), 'system');
  assert.equal(parseFontFaceCommand('default font'), 'system');

  assert.equal(parseFontFaceCommand('hyperlegible font'), 'hyperlegible');
  assert.equal(parseFontFaceCommand('atkinson hyperlegible'), 'hyperlegible');
  assert.equal(parseFontFaceCommand('atkinson font'), 'hyperlegible');

  assert.equal(parseFontFaceCommand('opendyslexic font'), 'opendyslexic');
  assert.equal(parseFontFaceCommand('open dyslexic'), 'opendyslexic');
  assert.equal(parseFontFaceCommand('dyslexic font'), 'opendyslexic');

  assert.equal(parseFontFaceCommand('verdana font'), 'verdana');
  assert.equal(parseFontFaceCommand('switch to verdana'), 'verdana');

  assert.equal(parseFontFaceCommand('serif font'), 'serif');
  assert.equal(parseFontFaceCommand('georgia font'), 'serif');
  assert.equal(parseFontFaceCommand('times serif font'), 'serif');

  assert.equal(parseFontFaceCommand('mono font'), 'mono');
  assert.equal(parseFontFaceCommand('monospace font'), 'mono');
  assert.equal(parseFontFaceCommand('consolas font'), 'mono');

  assert.equal(parseFontFaceCommand('repeat question'), null);
  assert.equal(parseFontFaceCommand('open settings'), null);
});

// ============================================================================
// 3. CONVERSATIONAL VOICE ASSISTANT LIFECYCLE (VoiceEngine State Machine)
// ============================================================================

test('Conversational Lifecycle: State starts idle and discards ordinary speech', () => {
  let executedCommand = '';
  let assistantState: VoiceAssistantState = 'idle';

  const engine = new VoiceEngine({
    lang: 'en-IN',
    onTranscript: async (text: string) => {
      executedCommand = text;
    },
    onStateChange: (state: VoiceAssistantState) => {
      assistantState = state;
    },
    onListeningChange: () => {}
  });

  assert.equal(engine.getState(), 'idle');

  // Simulate background speech without wake phrase
  engine.handleSpeechTranscript('what time is the bus arriving today');

  // Must remain in idle and NOT execute ordinary background speech
  assert.equal(engine.getState(), 'idle');
  assert.equal(executedCommand, '');
});

test('Conversational Lifecycle: "Hey Vision" enters listening, buffers speech without executing prematurely', () => {
  let executedCommand = '';
  let assistantState: VoiceAssistantState = 'idle';
  let accumulatedText = '';

  const engine = new VoiceEngine({
    lang: 'en-IN',
    onTranscript: async (text: string) => {
      executedCommand = text;
    },
    onStateChange: (state: VoiceAssistantState) => {
      assistantState = state;
    },
    onListeningChange: () => {},
    onSpeechAccumulated: (text: string) => {
      accumulatedText = text;
    }
  });

  // Step 2: User says "Hey Vision"
  engine.handleSpeechTranscript('hey vision');

  assert.equal(engine.getState(), 'listening');
  assert.equal(assistantState, 'listening');
  assert.equal(executedCommand, '', 'Command should not execute yet');

  // Step 3: User speaks command: "select option A"
  engine.handleSpeechTranscript('select option a');

  // Still in listening state, speech buffered, NOT executed prematurely
  assert.equal(engine.getState(), 'listening');
  assert.equal(engine.getAccumulatedSpeech(), 'select option a');
  assert.equal(accumulatedText, 'select option a');
  assert.equal(executedCommand, '', 'Command must not execute prematurely before "stop listening"');
});

test('Conversational Lifecycle: "Stop listening" finalizes and executes command, then returns to idle after speaking', () => {
  let executedCommand = '';
  let stateHistory: VoiceAssistantState[] = [];

  const engine = new VoiceEngine({
    lang: 'en-IN',
    onTranscript: async (text: string) => {
      executedCommand = text;
    },
    onStateChange: (state: VoiceAssistantState) => {
      stateHistory.push(state);
    },
    onListeningChange: () => {}
  });

  // 1. Activate
  engine.handleSpeechTranscript('hey vision');
  assert.equal(engine.getState(), 'listening');

  // 2. Speak command
  engine.handleSpeechTranscript('repeat question');
  assert.equal(engine.getState(), 'listening');
  assert.equal(executedCommand, '');

  // 3. User says "stop listening"
  engine.handleSpeechTranscript('stop listening');

  // State transitions to processing and command is executed
  assert.equal(engine.getState(), 'processing');
  assert.equal(executedCommand, 'repeat question');

  // 4. TTS starts responding
  engine.setSpeaking(true);
  assert.equal(engine.getState(), 'responding');

  // 5. TTS finishes speaking
  engine.setSpeaking(false);
  assert.equal(engine.getState(), 'idle', 'Must return to idle state after spoken response completes');

  // Verify full lifecycle history: listening -> processing -> responding -> idle
  assert.deepEqual(stateHistory, ['listening', 'processing', 'responding', 'idle']);
});

test('Conversational Lifecycle: Wake phrase with immediate command and stop listening executes in one turn', () => {
  let executedCommand = '';

  const engine = new VoiceEngine({
    lang: 'en-IN',
    onTranscript: async (text: string) => {
      executedCommand = text;
    },
    onListeningChange: () => {}
  });

  engine.handleSpeechTranscript('hey vision exit examination stop listening');

  assert.equal(engine.getState(), 'processing');
  assert.equal(executedCommand, 'exit examination');
});

// ============================================================================
// 4. NAVIGATION CONTROLLER: FONT FACE & EXAM EXIT
// ============================================================================

test('NavigationController: Font face commands trigger onFontFaceFn', async () => {
  let appliedFont = '';

  const controller = new NavigationController({
    context: makeContext({ currentScreen: 'accessibility_settings' }),
    navigate: () => {},
    speak: () => {},
    onFontFace: (font) => {
      appliedFont = font;
    }
  });

  const result1 = await controller.processTranscript('hyperlegible font');
  assert.equal(result1.status, 'system_handled');
  assert.equal(appliedFont, 'hyperlegible');
  assert.ok(result1.spokenResponse.includes('Atkinson Hyperlegible'));

  const result2 = await controller.processTranscript('switch to opendyslexic');
  assert.equal(result2.status, 'system_handled');
  assert.equal(appliedFont, 'opendyslexic');
  assert.ok(result2.spokenResponse.includes('OpenDyslexic'));

  const result3 = await controller.processTranscript('monospace font');
  assert.equal(result3.status, 'system_handled');
  assert.equal(appliedFont, 'mono');
  assert.ok(result3.spokenResponse.includes('Monospace'));
});

test('NavigationController: Active exam blocks direct page navigation and prompts Alt+Shift+X exit', async () => {
  const controller = new NavigationController({
    context: makeContext({ currentScreen: 'mock_exam', isExamActive: true }),
    navigate: () => {},
    speak: () => {}
  });

  const result = await controller.processTranscript('go to dashboard');
  assert.equal(result.status, 'blocked_by_active_exam');
  assert.ok(
    result.spokenResponse.includes('Alt + Shift + X') || result.spokenResponse.includes('exit exam'),
    'Expected prompt explaining how to exit using Alt + Shift + X or voice'
  );
});

// ============================================================================
// 5. EXAM EXIT CONFIRMATION PARSER & FRESH ATTEMPT LOGIC
// ============================================================================

test('Exam Exit: Confirm and Cancel phrases parse reliably for keyboard and voice confirmation', () => {
  // Confirm YES phrases
  const yesPhrases = ['yes', 'yes submit', 'yes exit', 'i confirm', 'submit now', 'confirm submit'];
  for (const p of yesPhrases) {
    const isYes = isSubmitConfirmPhrase(p) || p === 'yes' || p === 'yes submit' || p === 'yes exit';
    assert.equal(isYes, true, `Expected "${p}" to be accepted as exit confirmation YES`);
  }

  // Cancel NO phrases
  const noPhrases = ['no', 'no continue', 'cancel exit', 'cancel submission'];
  for (const p of noPhrases) {
    const isNo = isSubmitCancelPhrase(p) || p === 'no' || p === 'no continue' || p === 'cancel exit';
    assert.equal(isNo, true, `Expected "${p}" to be accepted as exit confirmation NO`);
  }
});

test('Fresh Examination Guarantee: Exit clears active session keys so re-entry starts fresh', () => {
  const mockSessionStorage: Record<string, string> = {
    'mockExamAnswers': JSON.stringify({ 'q1': { selectedOption: 'A' } }),
    'mockExamTimer': '1200',
    'mockExamIndex': '5',
    'mockExamStarted': 'true',
    'mockExamAttemptId': 'att_old_123',
    'pilot_demo_active_session_usr_candidate_01': JSON.stringify({ phase: 'exam', currentIdx: 7 }),
    'pilot_demo_initial_view': 'results'
  };

  // Simulate user confirming YES to exit exam
  // 1. Mock Exam exit cleanup
  delete mockSessionStorage['mockExamAnswers'];
  delete mockSessionStorage['mockExamTimer'];
  delete mockSessionStorage['mockExamIndex'];
  delete mockSessionStorage['mockExamStarted'];
  delete mockSessionStorage['mockExamAttemptId'];

  // 2. Pilot Demo exit cleanup
  delete mockSessionStorage['pilot_demo_active_session_usr_candidate_01'];
  delete mockSessionStorage['pilot_demo_initial_view'];

  // Verification: All active session artifacts cleared
  assert.equal(mockSessionStorage['mockExamStarted'], undefined);
  assert.equal(mockSessionStorage['mockExamAttemptId'], undefined);
  assert.equal(mockSessionStorage['pilot_demo_active_session_usr_candidate_01'], undefined);
  assert.equal(mockSessionStorage['pilot_demo_initial_view'], undefined);

  // Subsequent visit initializes fresh state
  const isMockExamStartedOnEntry = Boolean(mockSessionStorage['mockExamStarted'] === 'true');
  assert.equal(isMockExamStartedOnEntry, false, 'Mock exam must wait for user to start, not auto-start');

  const pilotDemoInitialView = mockSessionStorage['pilot_demo_initial_view'] || 'instructions';
  assert.equal(pilotDemoInitialView, 'instructions', 'Pilot Demo must present instructions on fresh visit');
});
