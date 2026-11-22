import { GoogleGenAI, LiveServerMessage, Modality, Session } from '@google/genai';
import {
  ObsidianNote,
  ResponseDepth,
  SpeechPace,
  StudyLanguage,
  StudyNotePage,
  SubjectCourse,
  VoicePreferences,
} from '../types';
import {
  FREE_LIVE_MODELS,
  getVoiceCatalogEntry,
  getVoiceSampleText,
  VOICE_CATALOG,
} from './providers';

export type LiveConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

export interface VoiceTranscriptEntry {
  id: string;
  role: 'user' | 'model' | 'system';
  text: string;
  timestamp: number;
  finalized?: boolean;
}

export interface AudioTelemetryLevels {
  mic: number;
  speaker: number;
  bars: number[];
}

export interface OpenStudyVoiceCallbacks {
  onStateChange?: (state: LiveConnectionState, detail?: string) => void;
  onActiveModelChange?: (model: string) => void;
  onAudioLevels?: (levels: AudioTelemetryLevels) => void;
  onTranscript?: (entry: VoiceTranscriptEntry) => void;
  onError?: (message: string) => void;
  onToolCall?: (
    calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>
  ) => Promise<Array<{ id?: string; name: string; response: Record<string, unknown> }>>;
}

export interface OpenStudyVoiceConnectOptions {
  apiKey: string;
  preferredModel?: string;
  freeOnlyLock?: boolean;
  voiceName: VoicePreferences['voiceName'];
  languageLock: StudyLanguage;
  pace: SpeechPace;
  systemPrompt: string;
  tools?: Array<{ functionDeclarations: unknown[] }>;
}

export const PACE_PLAYBACK_RATE: Record<SpeechPace, number> = {
  slow: 0.88,
  calm: 0.94,
  normal: 1.0,
};

export const LANGUAGE_META: Record<
  StudyLanguage,
  { code: string; bcp47: string; nameDe: string; nativeName: string }
> = {
  de: { code: 'DE', bcp47: 'de-DE', nameDe: 'Deutsch', nativeName: 'Deutsch' },
  en: { code: 'EN', bcp47: 'en-US', nameDe: 'Englisch', nativeName: 'English' },
  fr: { code: 'FR', bcp47: 'fr-FR', nameDe: 'Französisch', nativeName: 'Français' },
  es: { code: 'ES', bcp47: 'es-ES', nameDe: 'Spanisch', nativeName: 'Español' },
  it: { code: 'IT', bcp47: 'it-IT', nameDe: 'Italienisch', nativeName: 'Italiano' },
};

const IDLE_BARS: number[] = Array.from({ length: 12 }, () => 0.08);

const WORKLET_PROCESSOR_SOURCE = `
class OpenStudyPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.phase = 0;
    this.lastSample = 0;
    this.chunkSize = 1600;
    this.buffer = new Int16Array(this.chunkSize);
    this.writeIndex = 0;
    this.sumSq = 0;
    this.rmsCount = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    const len = channel.length;
    for (let i = 0; i < len; i++) {
      const s = channel[i];
      this.sumSq += s * s;
      this.rmsCount++;
    }

    while (this.phase < len) {
      const idx = Math.floor(this.phase);
      const frac = this.phase - idx;
      const s0 = idx === 0 ? this.lastSample : channel[idx - 1];
      const s1 = channel[idx];
      let sample = s0 + (s1 - s0) * frac;
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;

      this.buffer[this.writeIndex++] =
        sample < 0 ? Math.max(-32768, Math.round(sample * 32768)) : Math.min(32767, Math.round(sample * 32767));

      if (this.writeIndex >= this.chunkSize) {
        const out = this.buffer;
        const rms = this.rmsCount > 0 ? Math.sqrt(this.sumSq / this.rmsCount) : 0;
        this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
        this.buffer = new Int16Array(this.chunkSize);
        this.writeIndex = 0;
        this.sumSq = 0;
        this.rmsCount = 0;
      }

      this.phase += this.ratio;
    }

    this.lastSample = channel[len - 1];
    this.phase -= len;
    return true;
  }
}

registerProcessor('openstudy-pcm-capture', OpenStudyPcmCaptureProcessor);
`;

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToFloat32Pcm(base64: string): Float32Array {
  const binary = atob(base64);
  const byteLen = binary.length;
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const sampleCount = Math.floor(byteLen / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }
  return float32;
}

function mergeTranscriptChunk(prev: string, incoming: string): string {
  if (!incoming) return prev;
  if (!prev) return incoming.trimStart();
  const trimmedIncoming = incoming.trimStart();
  if (trimmedIncoming.startsWith(prev)) {
    return trimmedIncoming;
  }
  const prevEndsSpace = /\s$/.test(prev);
  const nextStartsSpaceOrPunct = /^[\s.,!?;:)\]}]/.test(incoming);
  if (prevEndsSpace || nextStartsSpaceOrPunct) {
    return `${prev}${incoming}`;
  }
  return `${prev} ${incoming}`;
}

function formatNoteExcerpt(note: StudyNotePage, maxChars: number): string {
  const lines = note.blocks
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join(' | ');
  const clipped = lines.length > maxChars ? `${lines.slice(0, maxChars)}...` : lines;
  return `- ${note.title}: ${clipped}`;
}

export function buildVoiceSystemPrompt(params: {
  voice: VoicePreferences;
  activeCourse?: SubjectCourse;
  courseNotes?: StudyNotePage[];
  obsidianNotes?: ObsidianNote[];
  currentViewLabel: string;
}): string {
  const { voice, activeCourse, courseNotes = [], obsidianNotes = [], currentViewLabel } = params;
  const targetLang = LANGUAGE_META[voice.languageLock];
  const explainLang = LANGUAGE_META[voice.explainLanguage];

  const languageRule = voice.bilingualCoach
    ? [
        `STRICT BILINGUAL LANGUAGE LOCK:`,
        `- Conduct all conversation, practice questions, roleplay, and examples STRICTLY in ${targetLang.nativeName} (${targetLang.bcp47}).`,
        `- Use ${explainLang.nativeName} (${explainLang.bcp47}) ONLY for brief, targeted grammar, vocabulary, or pronunciation explanations when correcting or clarifying a rule, then immediately return to ${targetLang.nativeName}.`,
        `- NEVER drift into any other language, even if the learner has an accent, hesitates, or pauses.`,
      ].join('\n')
    : [
        `STRICT LANGUAGE LOCK:`,
        `- Speak EXCLUSIVELY in ${targetLang.nativeName} (${targetLang.bcp47}).`,
        `- NEVER switch away from ${targetLang.nativeName}, even if the learner has an accent, pauses, mispronounces words, or momentarily says a word in another language.`,
        `- Only switch language if the user explicitly commands you to unlock the language setting.`,
      ].join('\n');

  const paceRule =
    voice.pace === 'slow'
      ? 'PACE CONTROL: Speak slowly, calmly, and clearly with crisp enunciation and brief natural pauses between ideas. Never rush.'
      : voice.pace === 'calm'
        ? 'PACE CONTROL: Speak at a calm, unhurried, well-enunciated tutor cadence with comfortable breathing room between thoughts.'
        : 'PACE CONTROL: Speak at a natural, fluent, conversational pace while keeping every word clear and easy to follow.';

  const depthRule =
    voice.depth === 'concise'
      ? [
          'ADAPTIVE RESPONSE DEPTH (CONCISE MODE):',
          '- By default, give crisp, focused spoken answers of 2 to 4 sentences so the conversation stays interactive.',
          '- CRITICAL TRIGGER: If the learner says "in depth", "genauer erklären", "erklär in depth", "ausführlich", or asks for a deeper breakdown, IMMEDIATELY give a thorough, well-structured step-by-step explanation with concrete examples and check understanding at the end.',
        ].join('\n')
      : [
          'ADAPTIVE RESPONSE DEPTH (IN-DEPTH MODE):',
          '- Always give thorough, well-structured step-by-step explanations with underlying intuition, key rules, and concrete examples.',
          '- Keep spoken structure clear using natural signposts ("First...", "Second...", "For example...") instead of raw markdown formatting.',
        ].join('\n');

  const modeRule =
    voice.mode === 'exam'
      ? 'TUTOR MODE (ORAL EXAM): Act as a fair, encouraging oral examiner. Ask one realistic oral exam question at a time grounded in the active course and study notes. Wait for the learner’s spoken answer, then give concise score feedback (e.g. 4/5 points), highlight strengths, mention 1 to 2 missing precision points, and offer the next question.'
      : voice.mode === 'language'
        ? `TUTOR MODE (LANGUAGE COACH): Act as a patient speaking and phrasing coach for ${targetLang.nativeName}. Keep a natural dialogue flowing, gently correct grammar, tense, or phrasing mistakes with a cleaner natural alternative, and invite the learner to try the improved phrasing aloud.`
        : 'TUTOR MODE (EXPLAIN): Act as a clear, patient conceptual tutor. Break concepts down intuitively, link ideas to the learner’s course objectives and notes, and confirm understanding with short check-in questions.';

  const stanceRule =
    voice.stance === 'coach'
      ? 'AGENT STANCE (SOCRATIC COACH): Guide the learner to discover solutions themselves using targeted hints, analogies, and scaffolding questions. Do not simply solve homework for them without involving their thinking.'
      : 'AGENT STANCE (DIRECT ASSISTANT): When asked for summaries, study plans, explanations, or worked examples, deliver concrete, complete, well-structured help directly without unnecessary detours.';

  const contextSections: string[] = [
    `CURRENT APP VIEW: ${currentViewLabel}`,
  ];

  if (activeCourse) {
    const objLines = activeCourse.objectives.map(
      (o) => `  - [${o.mastery}] ${o.title}: ${o.summary}`
    );
    contextSections.push(
      [
        `ACTIVE COURSE: ${activeCourse.title} (${activeCourse.category})`,
        activeCourse.examDate ? `Upcoming exam date: ${activeCourse.examDate}` : '',
        activeCourse.description ? `Focus: ${activeCourse.description}` : '',
        objLines.length > 0 ? `Learning objectives:\n${objLines.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  const relevantLocalNotes = activeCourse
    ? courseNotes.filter((n) => n.courseId === activeCourse.id).slice(0, 4)
    : courseNotes.slice(0, 3);

  if (relevantLocalNotes.length > 0) {
    const formatted = relevantLocalNotes.map((n) => formatNoteExcerpt(n, 450)).join('\n');
    contextSections.push(`LOCAL STUDY NOTES:\n${formatted}`);
  }

  const selectedObsidian = obsidianNotes.filter((n) => n.selectedForContext).slice(0, 4);
  if (selectedObsidian.length > 0) {
    const formatted = selectedObsidian
      .map((n) => {
        const text = (n.content || n.excerpt || '').replace(/\s+/g, ' ').trim();
        const clipped = text.length > 480 ? `${text.slice(0, 480)}...` : text;
        return `- ${n.title}: ${clipped}`;
      })
      .join('\n');
    contextSections.push(`SELECTED OBSIDIAN VAULT CONTEXT:\n${formatted}`);
  }

  return [
    'You are the OpenStudy Voice Tutor — a calm, thoughtful, human-sounding study partner.',
    'Speak naturally for audio output. Never read raw markdown characters like asterisks, hashes, or code fences aloud.',
    '',
    languageRule,
    '',
    paceRule,
    '',
    depthRule,
    '',
    modeRule,
    '',
    stanceRule,
    '',
    'STUDY CONTEXT:',
    ...contextSections,
  ].join('\n');
}

// ---------- Voice Preview (Gemini Live One-Shot with Instant SpeechSynthesis Fallback) ----------

let activePreviewCleanup: (() => void) | null = null;

export function stopVoicePreview(): void {
  if (activePreviewCleanup) {
    const fn = activePreviewCleanup;
    activePreviewCleanup = null;
    try {
      fn();
    } catch {
      // ignore cleanup errors
    }
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

function playBrowserSpeechPreview(
  voiceId: VoicePreferences['voiceName'],
  language: StudyLanguage,
  pace: SpeechPace,
  onRegisterCleanup: (fn: () => void) => void
): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      resolve();
      return;
    }

    const entry = getVoiceCatalogEntry(voiceId);
    const sampleText = getVoiceSampleText(entry, language);
    const langMeta = LANGUAGE_META[language];
    const voiceIndex = Math.max(
      0,
      VOICE_CATALOG.findIndex((v) => v.id === voiceId)
    );

    let finished = false;
    let safetyTimer: number | null = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (safetyTimer !== null) {
        window.clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      resolve();
    };

    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }

    const utterance = new SpeechSynthesisUtterance(sampleText);
    utterance.lang = langMeta.bcp47;
    utterance.pitch = entry.pitchHint;
    utterance.rate = PACE_PLAYBACK_RATE[pace];

    const allVoices = window.speechSynthesis.getVoices();
    const langPrefix = langMeta.bcp47.slice(0, 2).toLowerCase();
    const matching = allVoices.filter((v) => v.lang.toLowerCase().startsWith(langPrefix));
    if (matching.length > 0) {
      utterance.voice = matching[voiceIndex % matching.length];
    }

    utterance.onend = finish;
    utterance.onerror = finish;

    onRegisterCleanup(() => {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
      finish();
    });

    safetyTimer = window.setTimeout(finish, 9000);
    window.speechSynthesis.speak(utterance);
  });
}

async function tryGeminiLivePreview(
  voiceId: VoicePreferences['voiceName'],
  language: StudyLanguage,
  pace: SpeechPace,
  apiKey: string,
  onRegisterCleanup: (fn: () => void) => void
): Promise<boolean> {
  const entry = getVoiceCatalogEntry(voiceId);
  const sampleText = getVoiceSampleText(entry, language);
  const langMeta = LANGUAGE_META[language];
  const playbackRate = PACE_PLAYBACK_RATE[pace];

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return false;

  const ctx = new AudioCtx();
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => undefined);
  }

  let session: Session | null = null;
  let receivedAudio = false;
  let settled = false;
  let cancelled = false;
  let nextPlayTime = 0;
  const activeSources = new Set<AudioBufferSourceNode>();
  let initialTimeout: number | null = null;
  let playbackTimeout: number | null = null;
  let turnFinishTimer: number | null = null;

  const cleanupResources = () => {
    if (initialTimeout !== null) {
      window.clearTimeout(initialTimeout);
      initialTimeout = null;
    }
    if (playbackTimeout !== null) {
      window.clearTimeout(playbackTimeout);
      playbackTimeout = null;
    }
    if (turnFinishTimer !== null) {
      window.clearTimeout(turnFinishTimer);
      turnFinishTimer = null;
    }
    for (const src of activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore
      }
    }
    activeSources.clear();
    if (session) {
      try {
        session.close();
      } catch {
        // ignore
      }
      session = null;
    }
    if (ctx.state !== 'closed') {
      ctx.close().catch(() => undefined);
    }
  };

  return new Promise<boolean>((resolve) => {
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cleanupResources();
      resolve(ok);
    };

    onRegisterCleanup(() => {
      cancelled = true;
      settle(true);
    });

    initialTimeout = window.setTimeout(() => {
      if (!receivedAudio && !cancelled) {
        settle(false);
      }
    }, 4000);

    const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
    const model = FREE_LIVE_MODELS[0];

    ai.live
      .connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voiceId,
              },
            },
          },
          systemInstruction: {
            parts: [
              {
                text: `You are a concise voice sample reader. Read ONLY the exact sentence provided by the user aloud in ${langMeta.nativeName} (${langMeta.bcp47}) with calm, clear enunciation. Do not add any extra words, greetings, or commentary.`,
              },
            ],
          },
        },
        callbacks: {
          onopen: () => {
            // Wait briefly for setup or trigger immediately after connect resolves
          },
          onmessage: (msg: LiveServerMessage) => {
            if (cancelled || settled) return;
            const content = msg.serverContent;
            if (content?.modelTurn?.parts) {
              for (const part of content.modelTurn.parts) {
                if (part.inlineData?.data) {
                  if (!receivedAudio) {
                    receivedAudio = true;
                    if (initialTimeout !== null) {
                      window.clearTimeout(initialTimeout);
                      initialTimeout = null;
                    }
                    playbackTimeout = window.setTimeout(() => settle(true), 10000);
                  }
                  const samples = base64ToFloat32Pcm(part.inlineData.data);
                  if (samples.length > 0 && ctx.state !== 'closed') {
                    const buffer = ctx.createBuffer(1, samples.length, 24000);
                    buffer.getChannelData(0).set(samples);
                    const source = ctx.createBufferSource();
                    source.buffer = buffer;
                    source.playbackRate.value = playbackRate;
                    source.connect(ctx.destination);
                    const startAt = Math.max(ctx.currentTime + 0.015, nextPlayTime);
                    source.start(startAt);
                    nextPlayTime = startAt + buffer.duration / playbackRate;
                    activeSources.add(source);
                    source.onended = () => {
                      activeSources.delete(source);
                    };
                  }
                }
              }
            }
            if (content?.turnComplete) {
              if (session) {
                try {
                  session.close();
                } catch {
                  // ignore
                }
                session = null;
              }
              const remainingMs = Math.max(80, (nextPlayTime - ctx.currentTime) * 1000 + 120);
              turnFinishTimer = window.setTimeout(() => settle(receivedAudio), remainingMs);
            }
          },
          onerror: () => {
            if (!receivedAudio) {
              settle(false);
            }
          },
          onclose: () => {
            if (!receivedAudio && !cancelled) {
              settle(false);
            }
          },
        },
      })
      .then((connectedSession) => {
        if (cancelled || settled) {
          try {
            connectedSession.close();
          } catch {
            // ignore
          }
          return;
        }
        session = connectedSession;
        session.sendRealtimeInput({
          text: `Read this sentence verbatim in ${langMeta.nativeName}: "${sampleText}"`,
        });
      })
      .catch(() => {
        settle(false);
      });
  });
}

export async function playVoicePreview(
  voiceId: VoicePreferences['voiceName'],
  language: StudyLanguage,
  pace: SpeechPace,
  apiKey?: string
): Promise<void> {
  stopVoicePreview();

  let cancelled = false;
  let innerCleanup: (() => void) | null = null;

  const registerCleanup = (fn: () => void) => {
    innerCleanup = fn;
  };

  activePreviewCleanup = () => {
    cancelled = true;
    if (innerCleanup) {
      innerCleanup();
      innerCleanup = null;
    }
  };

  const trimmedKey = apiKey?.trim();
  if (trimmedKey) {
    const liveOk = await tryGeminiLivePreview(
      voiceId,
      language,
      pace,
      trimmedKey,
      registerCleanup
    );
    if (liveOk || cancelled) {
      if (activePreviewCleanup) activePreviewCleanup = null;
      return;
    }
  }

  if (!cancelled) {
    await playBrowserSpeechPreview(voiceId, language, pace, registerCleanup);
  }
  if (activePreviewCleanup) activePreviewCleanup = null;
}

// ---------- OpenStudyVoiceClient (Gemini Live API v1beta) ----------

function isFallbackCloseOrError(code?: number, reason?: string): boolean {
  const lower = (reason ?? '').toLowerCase();
  return (
    code === 1008 ||
    code === 1003 ||
    code === 1011 ||
    lower.includes('not found') ||
    lower.includes('not supported') ||
    lower.includes('unavailable') ||
    lower.includes('not enabled') ||
    lower.includes('invalid model') ||
    lower.includes('policy')
  );
}

function isAuthErrorMessage(reason?: string): boolean {
  const lower = (reason ?? '').toLowerCase();
  return (
    lower.includes('api key') ||
    lower.includes('api_key') ||
    lower.includes('unauthenticated') ||
    lower.includes('permission denied') ||
    lower.includes('401') ||
    lower.includes('403')
  );
}

export class OpenStudyVoiceClient {
  private callbacks: OpenStudyVoiceCallbacks;
  private session: Session | null = null;
  private state: LiveConnectionState = 'idle';
  private modelName: string | null = null;
  private muted = false;
  private playbackRate = 0.94;
  private connectingToken = 0;

  // Audio capture
  private mediaStream: MediaStream | null = null;
  private inputCtx: AudioContext | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private latestMicRms = 0;

  // Audio playback (24 kHz)
  private outputCtx: AudioContext | null = null;
  private speakerGain: GainNode | null = null;
  private speakerAnalyser: AnalyserNode | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private nextPlayTime = 0;

  // Telemetry loop
  private telemetryRafId: number | null = null;
  private smoothedBars: number[] = [...IDLE_BARS];

  // Transcript turn tracking
  private currentUserTurnId: string | null = null;
  private currentUserText = '';
  private currentModelTurnId: string | null = null;
  private currentModelText = '';

  constructor(callbacks: OpenStudyVoiceCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get connectionState(): LiveConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get activeModel(): string | null {
    return this.modelName;
  }

  private setState(next: LiveConnectionState, detail?: string): void {
    this.state = next;
    this.callbacks.onStateChange?.(next, detail);
  }

  setPace(pace: SpeechPace): void {
    this.playbackRate = PACE_PLAYBACK_RATE[pace];
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
    if (muted) {
      this.latestMicRms = 0;
      if (this.session && this.state === 'connected') {
        try {
          this.session.sendRealtimeInput({ audioStreamEnd: true });
        } catch {
          // ignore send errors on closing socket
        }
      }
    }
  }

  sendText(text: string, options?: { silent?: boolean }): void {
    const trimmed = text.trim();
    if (!trimmed || !this.session || this.state !== 'connected') return;

    this.finalizeModelTurn();
    this.finalizeUserTurn();

    if (!options?.silent) {
      this.callbacks.onTranscript?.({
        id: `user-text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'user',
        text: trimmed,
        timestamp: Date.now(),
        finalized: true,
      });
    }

    try {
      this.session.sendRealtimeInput({ text: trimmed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Nachricht konnte nicht gesendet werden.';
      this.callbacks.onError?.(msg);
    }
  }

  sendVideoFrame(base64Jpeg: string): boolean {
    if (this.state !== 'connected' || !this.session || !base64Jpeg) {
      return false;
    }
    const cleaned = base64Jpeg.includes(',')
      ? base64Jpeg.slice(base64Jpeg.indexOf(',') + 1)
      : base64Jpeg;
    if (!cleaned) return false;
    try {
      this.session.sendRealtimeInput({
        video: {
          data: cleaned,
          mimeType: 'image/jpeg',
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  notifyDepthChange(depth: ResponseDepth, languageLock: StudyLanguage): void {
    if (!this.session || this.state !== 'connected') return;
    const langName = LANGUAGE_META[languageLock].nativeName;
    const instruction =
      depth === 'indepth'
        ? `[Session update: Switch to IN-DEPTH mode immediately. Stay strictly in ${langName}. Give thorough, structured step-by-step explanations with concrete examples from now on. Acknowledge briefly only if currently asked, otherwise apply to the next reply.]`
        : `[Session update: Switch back to CONCISE mode immediately. Stay strictly in ${langName}. Keep upcoming spoken answers crisp in 2 to 4 sentences unless asked for in-depth detail.]`;

    try {
      this.session.sendRealtimeInput({ text: instruction });
    } catch {
      // ignore if closing
    }
  }

  interruptPlayback(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore
      }
    }
    this.activeSources.clear();
    this.nextPlayTime = 0;
  }

  async connect(options: OpenStudyVoiceConnectOptions): Promise<void> {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      const msg = 'Bitte hinterlege zuerst deinen kostenlosen Google AI Studio API-Key.';
      this.setState('error', msg);
      this.callbacks.onError?.(msg);
      return;
    }

    stopVoicePreview();
    this.disconnectInternal(true);

    const token = ++this.connectingToken;
    this.muted = false;
    this.playbackRate = PACE_PLAYBACK_RATE[options.pace];
    this.setState('connecting', 'Mikrofon und Live-Verbindung werden vorbereitet...');

    // 1. Setup audio hardware while inside user gesture
    try {
      await this.initAudioPipelines();
    } catch (err) {
      if (token !== this.connectingToken) return;
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Mikrofonzugriff wurde verweigert. Erlaube das Mikrofon im Browser und versuche es erneut.'
          : err instanceof Error
            ? `Audio-Initialisierung fehlgeschlagen: ${err.message}`
            : 'Mikrofon konnte nicht gestartet werden.';
      this.disconnectInternal(true);
      this.setState('error', msg);
      this.callbacks.onError?.(msg);
      return;
    }

    if (token !== this.connectingToken) {
      this.teardownAudio();
      return;
    }

    // 2. Build strict Free-Tier whitelist with fallback chain
    const freeOnly = options.freeOnlyLock !== false;
    const preferred = options.preferredModel?.trim() ?? '';
    const isPreferredFree = (FREE_LIVE_MODELS as readonly string[]).includes(preferred);

    const candidateModels: string[] = [];
    if (preferred && (isPreferredFree || !freeOnly)) {
      candidateModels.push(preferred);
    }
    for (const m of FREE_LIVE_MODELS) {
      if (!candidateModels.includes(m)) {
        candidateModels.push(m);
      }
    }

    const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
    let lastError = 'Verbindung zum Gemini Live-Server fehlgeschlagen.';

    for (let i = 0; i < candidateModels.length; i++) {
      if (token !== this.connectingToken) {
        this.teardownAudio();
        return;
      }
      const model = candidateModels[i];
      this.setState('connecting', `Verbinde mit ${model}...`);

      try {
        const connectedSession = await this.connectSingleModel(ai, model, options, token);
        if (token !== this.connectingToken) {
          try {
            connectedSession.close();
          } catch {
            // ignore
          }
          return;
        }

        this.session = connectedSession;
        this.modelName = model;
        this.callbacks.onActiveModelChange?.(model);
        this.setState('connected', model);
        this.startTelemetryLoop();
        return;
      } catch (err) {
        if (token !== this.connectingToken) return;
        const fallbackErr = err as { recoverable?: boolean; message?: string };
        lastError = fallbackErr?.message || (err instanceof Error ? err.message : lastError);

        if (isAuthErrorMessage(lastError)) {
          lastError =
            'API-Key wurde von Gemini Live abgelehnt. Prüfe deinen Google AI Studio Schlüssel in den Einstellungen.';
          break;
        }

        if (fallbackErr?.recoverable && i < candidateModels.length - 1) {
          continue;
        }
        break;
      }
    }

    if (token !== this.connectingToken) return;
    this.disconnectInternal(true);
    this.setState('error', lastError);
    this.callbacks.onError?.(lastError);
  }

  private connectSingleModel(
    ai: GoogleGenAI,
    model: string,
    options: OpenStudyVoiceConnectOptions,
    token: number
  ): Promise<Session> {
    return new Promise<Session>((resolve, reject) => {
      let settled = false;
      let opened = false;
      let sessionRef: Session | null = null;
      let openGraceTimer: number | null = null;
      let hardTimeout: number | null = null;

      const clearTimers = () => {
        if (openGraceTimer !== null) {
          window.clearTimeout(openGraceTimer);
          openGraceTimer = null;
        }
        if (hardTimeout !== null) {
          window.clearTimeout(hardTimeout);
          hardTimeout = null;
        }
      };

      const finishResolve = () => {
        if (settled) return;
        if (!sessionRef) return;
        settled = true;
        clearTimers();
        resolve(sessionRef);
      };

      const finishReject = (recoverable: boolean, message: string) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (sessionRef) {
          try {
            sessionRef.close();
          } catch {
            // ignore
          }
          sessionRef = null;
        }
        reject({ recoverable, message });
      };

      hardTimeout = window.setTimeout(() => {
        finishReject(true, `Zeitüberschreitung beim Verbinden mit ${model}.`);
      }, 9000);

      ai.live
        .connect({
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: options.voiceName,
                },
              },
            },
            systemInstruction: {
              parts: [{ text: options.systemPrompt }],
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            contextWindowCompression: {
              slidingWindow: {},
            },
            ...(options.tools && options.tools.length > 0
              ? { tools: options.tools as never }
              : {}),
          },
          callbacks: {
            onopen: () => {
              if (token !== this.connectingToken) return;
              opened = true;
              // Some servers send setupComplete quickly; keep a brief grace window to catch immediate 1008 closes
              openGraceTimer = window.setTimeout(() => {
                if (opened && sessionRef && !settled) {
                  finishResolve();
                }
              }, 1200);
            },
            onmessage: (message: LiveServerMessage) => {
              if (token !== this.connectingToken) return;
              if (message.setupComplete && !settled && sessionRef) {
                finishResolve();
              }
              this.handleServerMessage(message);
            },
            onerror: (event: ErrorEvent) => {
              if (token !== this.connectingToken) return;
              const errMsg = event.message || `WebSocket-Fehler bei ${model}.`;
              if (!settled) {
                finishReject(true, errMsg);
              } else {
                this.callbacks.onError?.(errMsg);
              }
            },
            onclose: (event: CloseEvent) => {
              if (token !== this.connectingToken) return;
              const reason = event.reason || `Verbindung geschlossen (Code ${event.code}).`;
              if (!settled) {
                const recoverable = isFallbackCloseOrError(event.code, event.reason);
                finishReject(recoverable, reason);
              } else if (this.state === 'connected') {
                this.teardownAudio();
                this.session = null;
                if (event.code === 1000) {
                  this.setState('idle');
                } else {
                  const cleanMsg = isAuthErrorMessage(event.reason)
                    ? 'API-Key ungültig oder abgelaufen.'
                    : `Live-Verbindung beendet (${event.code}${event.reason ? `: ${event.reason}` : ''}).`;
                  this.setState('error', cleanMsg);
                  this.callbacks.onError?.(cleanMsg);
                }
              }
            },
          },
        })
        .then((session) => {
          if (token !== this.connectingToken || settled) {
            try {
              session.close();
            } catch {
              // ignore
            }
            return;
          }
          sessionRef = session;
          if (session.setupComplete) {
            finishResolve();
          } else if (opened && openGraceTimer === null) {
            openGraceTimer = window.setTimeout(() => finishResolve(), 600);
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : `Verbindung zu ${model} fehlgeschlagen.`;
          finishReject(isFallbackCloseOrError(undefined, msg), msg);
        });
    });
  }

  private async initAudioPipelines(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Dieser Browser unterstützt keinen Mikrofonzugriff (getUserMedia).');
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    if (!AudioCtx) {
      throw new Error('Web Audio API ist in diesem Browser nicht verfügbar.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.mediaStream = stream;

    // Input AudioContext + inline AudioWorklet 16kHz Int16 PCM resampler
    const inputCtx = new AudioCtx();
    if (inputCtx.state === 'suspended') {
      await inputCtx.resume();
    }
    this.inputCtx = inputCtx;

    const micSource = inputCtx.createMediaStreamSource(stream);
    this.micSource = micSource;

    const micAnalyser = inputCtx.createAnalyser();
    micAnalyser.fftSize = 64;
    micAnalyser.smoothingTimeConstant = 0.65;
    this.micAnalyser = micAnalyser;
    micSource.connect(micAnalyser);

    const blob = new Blob([WORKLET_PROCESSOR_SOURCE], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    try {
      await inputCtx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    const workletNode = new AudioWorkletNode(inputCtx, 'openstudy-pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    this.workletNode = workletNode;

    workletNode.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      const payload = event.data;
      if (!payload?.pcm) return;
      this.latestMicRms = this.muted ? 0 : payload.rms;

      if (this.muted || !this.session || this.state !== 'connected') return;

      const bytes = new Uint8Array(payload.pcm);
      const base64 = uint8ToBase64(bytes);
      try {
        this.session.sendRealtimeInput({
          audio: {
            data: base64,
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      } catch {
        // socket may be closing
      }
    };

    const silentGain = inputCtx.createGain();
    silentGain.gain.value = 0;
    this.silentGain = silentGain;

    micSource.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(inputCtx.destination);

    // Output AudioContext (24 kHz PCM playback with AnalyserNode telemetry)
    const outputCtx = new AudioCtx();
    if (outputCtx.state === 'suspended') {
      await outputCtx.resume();
    }
    this.outputCtx = outputCtx;

    const speakerGain = outputCtx.createGain();
    speakerGain.gain.value = 1;
    this.speakerGain = speakerGain;

    const speakerAnalyser = outputCtx.createAnalyser();
    speakerAnalyser.fftSize = 64;
    speakerAnalyser.smoothingTimeConstant = 0.65;
    this.speakerAnalyser = speakerAnalyser;

    speakerGain.connect(speakerAnalyser);
    speakerAnalyser.connect(outputCtx.destination);
    this.nextPlayTime = 0;
  }

  private handleServerMessage(message: LiveServerMessage): void {
    if (message.goAway) {
      this.callbacks.onTranscript?.({
        id: `sys-goaway-${Date.now()}`,
        role: 'system',
        text: 'Hinweis: Die Live-Sitzung erreicht bald das Zeitlimit und kann jederzeit neu verbunden werden.',
        timestamp: Date.now(),
        finalized: true,
      });
    }

    if (
      message.toolCall?.functionCalls &&
      message.toolCall.functionCalls.length > 0 &&
      this.callbacks.onToolCall
    ) {
      const normalizedCalls = message.toolCall.functionCalls
        .filter((fc): fc is typeof fc & { name: string } => typeof fc.name === 'string' && fc.name.length > 0)
        .map((fc) => ({
          id: fc.id,
          name: fc.name,
          args:
            fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args)
              ? (fc.args as Record<string, unknown>)
              : {},
        }));

      if (normalizedCalls.length > 0) {
        const activeToken = this.connectingToken;
        void (async () => {
          try {
            const responses = await this.callbacks.onToolCall?.(normalizedCalls);
            if (
              !responses ||
              responses.length === 0 ||
              activeToken !== this.connectingToken ||
              this.state !== 'connected'
            ) {
              return;
            }
            this.session?.sendToolResponse({
              functionResponses: responses.map((res) => ({
                id: res.id,
                name: res.name,
                response: res.response,
              })),
            });
          } catch {
            if (activeToken !== this.connectingToken || this.state !== 'connected') {
              return;
            }
            try {
              this.session?.sendToolResponse({
                functionResponses: normalizedCalls.map((call) => ({
                  id: call.id,
                  name: call.name,
                  response: {
                    ok: false,
                    error: 'Aktion konnte nicht ausgeführt werden.',
                  },
                })),
              });
            } catch {
              // ignore socket error so voice call stays alive
            }
          }
        })();
      }
    }

    const content = message.serverContent;
    if (!content) return;

    // Barge-in interruption: clear queued speaker playback immediately
    if (content.interrupted) {
      this.interruptPlayback();
      this.finalizeModelTurn();
    }

    // Input audio transcription (learner)
    const inputText = content.inputTranscription?.text;
    if (inputText) {
      this.finalizeModelTurn();
      if (!this.currentUserTurnId) {
        this.currentUserTurnId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this.currentUserText = '';
      }
      this.currentUserText = mergeTranscriptChunk(this.currentUserText, inputText);
      this.callbacks.onTranscript?.({
        id: this.currentUserTurnId,
        role: 'user',
        text: this.currentUserText,
        timestamp: Date.now(),
        finalized: false,
      });
    }

    // Process ALL parts in modelTurn
    if (content.modelTurn?.parts && content.modelTurn.parts.length > 0) {
      this.finalizeUserTurn();
      for (const part of content.modelTurn.parts) {
        if (part.inlineData?.data) {
          this.enqueueOutputPcm(part.inlineData.data);
        }
      }
    }

    // Output audio transcription (tutor)
    const outputText = content.outputTranscription?.text;
    if (outputText) {
      this.finalizeUserTurn();
      if (!this.currentModelTurnId) {
        this.currentModelTurnId = `model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this.currentModelText = '';
      }
      this.currentModelText = mergeTranscriptChunk(this.currentModelText, outputText);
      this.callbacks.onTranscript?.({
        id: this.currentModelTurnId,
        role: 'model',
        text: this.currentModelText,
        timestamp: Date.now(),
        finalized: false,
      });
    }

    if (content.turnComplete) {
      this.finalizeModelTurn();
    }
  }

  private finalizeUserTurn(): void {
    if (this.currentUserTurnId && this.currentUserText.trim()) {
      this.callbacks.onTranscript?.({
        id: this.currentUserTurnId,
        role: 'user',
        text: this.currentUserText.trim(),
        timestamp: Date.now(),
        finalized: true,
      });
    }
    this.currentUserTurnId = null;
    this.currentUserText = '';
  }

  private finalizeModelTurn(): void {
    if (this.currentModelTurnId && this.currentModelText.trim()) {
      this.callbacks.onTranscript?.({
        id: this.currentModelTurnId,
        role: 'model',
        text: this.currentModelText.trim(),
        timestamp: Date.now(),
        finalized: true,
      });
    }
    this.currentModelTurnId = null;
    this.currentModelText = '';
  }

  private enqueueOutputPcm(base64: string): void {
    if (!this.outputCtx || !this.speakerGain || this.outputCtx.state === 'closed') return;

    const samples = base64ToFloat32Pcm(base64);
    if (samples.length === 0) return;

    const buffer = this.outputCtx.createBuffer(1, samples.length, 24000);
    buffer.getChannelData(0).set(samples);

    const source = this.outputCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.playbackRate;
    source.connect(this.speakerGain);

    const now = this.outputCtx.currentTime;
    const startAt = Math.max(now + 0.018, this.nextPlayTime);
    source.start(startAt);
    this.nextPlayTime = startAt + buffer.duration / this.playbackRate;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };
  }

  private startTelemetryLoop(): void {
    this.stopTelemetryLoop();

    const micTimeData = new Uint8Array(64);
    const micFreqData = new Uint8Array(32);
    const spkTimeData = new Uint8Array(64);
    const spkFreqData = new Uint8Array(32);

    const computeRms = (timeData: Uint8Array): number => {
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) {
        const centered = (timeData[i] - 128) / 128;
        sum += centered * centered;
      }
      return Math.sqrt(sum / timeData.length);
    };

    const tick = () => {
      if (this.state !== 'connected') {
        this.callbacks.onAudioLevels?.({ mic: 0, speaker: 0, bars: [...IDLE_BARS] });
        return;
      }

      let micLevel = 0;
      if (!this.muted && this.micAnalyser) {
        this.micAnalyser.getByteTimeDomainData(micTimeData);
        this.micAnalyser.getByteFrequencyData(micFreqData);
        micLevel = Math.min(1, Math.max(computeRms(micTimeData), this.latestMicRms) * 3.8);
      }

      let speakerLevel = 0;
      if (this.speakerAnalyser && this.activeSources.size > 0) {
        this.speakerAnalyser.getByteTimeDomainData(spkTimeData);
        this.speakerAnalyser.getByteFrequencyData(spkFreqData);
        speakerLevel = Math.min(1, computeRms(spkTimeData) * 3.6);
      }

      const speakerActive = speakerLevel > 0.035;
      const sourceFreq = speakerActive ? spkFreqData : !this.muted ? micFreqData : null;
      const activeRms = speakerActive ? speakerLevel : micLevel;

      const nextBars = new Array<number>(12);
      for (let i = 0; i < 12; i++) {
        let target = 0.08;
        if (sourceFreq && activeRms > 0.015) {
          const bin = Math.min(sourceFreq.length - 1, Math.floor((i * 18) / 12) + 1);
          const freqNorm = sourceFreq[bin] / 255;
          target = Math.max(0.1, Math.min(1, freqNorm * 0.72 + activeRms * 0.48));
        }
        const prev = this.smoothedBars[i];
        const eased = target > prev ? prev + (target - prev) * 0.45 : prev + (target - prev) * 0.22;
        this.smoothedBars[i] = eased;
        nextBars[i] = eased;
      }

      this.callbacks.onAudioLevels?.({
        mic: micLevel,
        speaker: speakerLevel,
        bars: nextBars,
      });

      this.telemetryRafId = window.requestAnimationFrame(tick);
    };

    this.telemetryRafId = window.requestAnimationFrame(tick);
  }

  private stopTelemetryLoop(): void {
    if (this.telemetryRafId !== null) {
      window.cancelAnimationFrame(this.telemetryRafId);
      this.telemetryRafId = null;
    }
    this.smoothedBars = [...IDLE_BARS];
    this.callbacks.onAudioLevels?.({ mic: 0, speaker: 0, bars: [...IDLE_BARS] });
  }

  private teardownAudio(): void {
    this.stopTelemetryLoop();
    this.interruptPlayback();

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      try {
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        // ignore
      }
      this.micSource = null;
    }
    if (this.micAnalyser) {
      try {
        this.micAnalyser.disconnect();
      } catch {
        // ignore
      }
      this.micAnalyser = null;
    }
    if (this.silentGain) {
      try {
        this.silentGain.disconnect();
      } catch {
        // ignore
      }
      this.silentGain = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
    if (this.inputCtx && this.inputCtx.state !== 'closed') {
      this.inputCtx.close().catch(() => undefined);
    }
    this.inputCtx = null;

    if (this.speakerGain) {
      try {
        this.speakerGain.disconnect();
      } catch {
        // ignore
      }
      this.speakerGain = null;
    }
    if (this.speakerAnalyser) {
      try {
        this.speakerAnalyser.disconnect();
      } catch {
        // ignore
      }
      this.speakerAnalyser = null;
    }
    if (this.outputCtx && this.outputCtx.state !== 'closed') {
      this.outputCtx.close().catch(() => undefined);
    }
    this.outputCtx = null;
    this.latestMicRms = 0;
  }

  private disconnectInternal(silentState: boolean): void {
    this.connectingToken++;
    this.finalizeUserTurn();
    this.finalizeModelTurn();

    if (this.session) {
      const s = this.session;
      this.session = null;
      try {
        s.close();
      } catch {
        // ignore
      }
    }

    this.teardownAudio();
    this.modelName = null;
    this.muted = false;

    if (!silentState) {
      this.setState('idle');
    }
  }

  disconnect(): void {
    this.disconnectInternal(false);
  }
}

export const OpenStudyVoiceSession = OpenStudyVoiceClient;
export type OpenStudyVoiceSession = OpenStudyVoiceClient;
