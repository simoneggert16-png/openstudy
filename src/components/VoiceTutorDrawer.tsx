import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Gauge,
  GraduationCap,
  KeyRound,
  Languages,
  Layers,
  Loader2,
  Lock,
  Maximize2,
  Mic,
  MicOff,
  PhoneOff,
  Play,
  RefreshCw,
  Send,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import {
  AgentStance,
  OpenStudyState,
  ProviderConfig,
  ResponseDepth,
  SpeechPace,
  StudyLanguage,
  TutorMode,
  VoicePreferences,
} from '../types';
import { getVoiceCatalogEntry, VOICE_CATALOG } from '../services/providers';
import {
  AudioTelemetryLevels,
  buildVoiceSystemPrompt,
  LANGUAGE_META,
  LiveConnectionState,
  OpenStudyVoiceClient,
  PACE_PLAYBACK_RATE,
  playVoicePreview,
  stopVoicePreview,
  VoiceTranscriptEntry,
} from '../services/voiceEngine';

export interface VoiceTutorDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: OpenStudyState;
  currentViewLabel: string;
  onUpdateVoice: (patch: Partial<VoicePreferences>) => void;
  onUpdateProvider: (patch: Partial<ProviderConfig>) => void;
  onOpenSettings: () => void;
  onConnectionStateChange?: (status: LiveConnectionState) => void;
}

const LANGUAGES: StudyLanguage[] = ['de', 'en', 'fr', 'es', 'it'];

const MODES: Array<{ id: TutorMode; label: string; icon: React.FC<{ size?: number; strokeWidth?: number }> }> = [
  { id: 'explain', label: 'Erklären', icon: BookOpen },
  { id: 'exam', label: 'Prüfung', icon: GraduationCap },
  { id: 'language', label: 'Sprachen', icon: Languages },
];

const PACES: Array<{ id: SpeechPace; label: string }> = [
  { id: 'slow', label: 'Langsam' },
  { id: 'calm', label: 'Ruhig' },
  { id: 'normal', label: 'Normal' },
];

const IDLE_TELEMETRY: AudioTelemetryLevels = {
  mic: 0,
  speaker: 0,
  bars: Array.from({ length: 12 }, () => 0.08),
};

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function buildQuickImpulseText(
  kind: 'indepth' | 'exam' | 'grammar',
  language: StudyLanguage,
  courseTitle?: string
): string {
  const topicRef = courseTitle ? ` (${courseTitle})` : '';
  const langName = LANGUAGE_META[language].nativeName;

  if (kind === 'indepth') {
    return `Explain this topic${topicRef} in depth step by step with concrete examples. Stay strictly in ${langName}.`;
  }
  if (kind === 'exam') {
    return `Ask me one realistic oral exam question about my active course${topicRef}, wait for my spoken answer, and score my response. Stay strictly in ${langName}.`;
  }
  return `Review and gently correct my grammar, word choice, and phrasing, and suggest a natural alternative I can repeat aloud. Stay strictly in ${langName}.`;
}

export function VoiceTutorDrawer({
  open,
  onOpenChange,
  state,
  currentViewLabel,
  onUpdateVoice,
  onUpdateProvider,
  onOpenSettings,
  onConnectionStateChange,
}: VoiceTutorDrawerProps) {
  const { voice, provider, courses, notes, obsidianNotes, activeCourseId } = state;

  const activeCourse = useMemo(
    () => courses.find((c) => c.id === activeCourseId) ?? courses[0],
    [courses, activeCourseId]
  );

  const localCourseNotes = useMemo(
    () => (activeCourse ? notes.filter((n) => n.courseId === activeCourse.id) : notes),
    [notes, activeCourse]
  );

  const selectedObsidianCount = useMemo(
    () => obsidianNotes.filter((n) => n.selectedForContext).length,
    [obsidianNotes]
  );

  const hasApiKey = provider.geminiApiKey.trim().length > 0;
  const activeVoiceMeta = useMemo(() => getVoiceCatalogEntry(voice.voiceName), [voice.voiceName]);

  const [connectionState, setConnectionState] = useState<LiveConnectionState>('idle');
  const [statusDetail, setStatusDetail] = useState<string>('');
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [muted, setMuted] = useState<boolean>(false);
  const [audioLevels, setAudioLevels] = useState<AudioTelemetryLevels>(IDLE_TELEMETRY);
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  const [textInput, setTextInput] = useState<string>('');
  const [inlineKeyInput, setInlineKeyInput] = useState<string>('');
  const [voiceListOpen, setVoiceListOpen] = useState<boolean>(false);
  const [controlsCollapsed, setControlsCollapsed] = useState<boolean>(false);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<VoicePreferences['voiceName'] | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState<boolean>(false);

  const clientRef = useRef<OpenStudyVoiceClient | null>(null);
  const previewTokenRef = useRef<number>(0);
  const pendingImpulseRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const onConnChangeRef = useRef(onConnectionStateChange);
  onConnChangeRef.current = onConnectionStateChange;

  const upsertTranscript = useCallback((entry: VoiceTranscriptEntry) => {
    setTranscript((prev) => {
      const idx = prev.findIndex((item) => item.id === entry.id);
      if (idx === -1) {
        return [...prev, entry];
      }
      const next = prev.slice();
      next[idx] = entry;
      return next;
    });
  }, []);

  const getClient = useCallback(() => {
    if (!clientRef.current) {
      clientRef.current = new OpenStudyVoiceClient({
        onStateChange: (nextState, detail) => {
          setConnectionState(nextState);
          setStatusDetail(detail ?? '');
          onConnChangeRef.current?.(nextState);
          if (nextState === 'connected') {
            setErrorMessage(null);
            setNeedsReconnect(false);
            if (pendingImpulseRef.current) {
              const queued = pendingImpulseRef.current;
              pendingImpulseRef.current = null;
              window.setTimeout(() => {
                clientRef.current?.sendText(queued);
              }, 260);
            }
          }
          if (nextState === 'idle') {
            setMuted(false);
            setActiveModel(null);
            setNeedsReconnect(false);
            setAudioLevels(IDLE_TELEMETRY);
          }
        },
        onActiveModelChange: (model) => {
          setActiveModel(model);
        },
        onAudioLevels: (levels) => {
          setAudioLevels(levels);
        },
        onTranscript: (entry) => {
          upsertTranscript(entry);
        },
        onError: (msg) => {
          setErrorMessage(msg);
        },
      });
    }
    return clientRef.current;
  }, [upsertTranscript]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopVoicePreview();
      clientRef.current?.disconnect();
    };
  }, []);

  // Call duration timer
  useEffect(() => {
    if (connectionState !== 'connected') {
      setElapsedSeconds(0);
      return;
    }
    const timer = window.setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [connectionState]);

  // Auto-scroll transcript
  useEffect(() => {
    if (open) {
      transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [transcript, open]);

  const handleStartCall = useCallback(async () => {
    if (!provider.geminiApiKey.trim()) {
      setErrorMessage(
        'Füge zuerst deinen kostenlosen Google AI Studio API-Key ein, um das Sprachgespräch zu starten.'
      );
      return;
    }
    setErrorMessage(null);
    stopVoicePreview();
    setPreviewingVoiceId(null);

    const systemPrompt = buildVoiceSystemPrompt({
      voice,
      activeCourse,
      courseNotes: localCourseNotes,
      obsidianNotes,
      currentViewLabel,
    });

    const client = getClient();
    await client.connect({
      apiKey: provider.geminiApiKey,
      preferredModel: provider.geminiLiveModel,
      freeOnlyLock: provider.freeOnlyLock,
      voiceName: voice.voiceName,
      languageLock: voice.languageLock,
      pace: voice.pace,
      systemPrompt,
    });
  }, [
    provider.geminiApiKey,
    provider.geminiLiveModel,
    provider.freeOnlyLock,
    voice,
    activeCourse,
    localCourseNotes,
    obsidianNotes,
    currentViewLabel,
    getClient,
  ]);

  const handleEndCall = useCallback(() => {
    pendingImpulseRef.current = null;
    clientRef.current?.disconnect();
    setMuted(false);
    setNeedsReconnect(false);
  }, []);

  const handleToggleMute = useCallback(() => {
    if (connectionState !== 'connected') return;
    const nextMuted = !muted;
    setMuted(nextMuted);
    clientRef.current?.setMuted(nextMuted);
  }, [connectionState, muted]);

  // Keyboard shortcuts (Escape closes drawer; M toggles mute during live call)
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (!isTyping && (event.key === 'm' || event.key === 'M') && connectionState === 'connected') {
        event.preventDefault();
        handleToggleMute();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onOpenChange, connectionState, handleToggleMute]);

  const handlePreviewVoice = useCallback(
    async (voiceId: VoicePreferences['voiceName']) => {
      if (previewingVoiceId === voiceId) {
        previewTokenRef.current++;
        stopVoicePreview();
        setPreviewingVoiceId(null);
        return;
      }

      const token = ++previewTokenRef.current;
      setPreviewingVoiceId(voiceId);
      try {
        await playVoicePreview(voiceId, voice.languageLock, voice.pace, provider.geminiApiKey);
      } finally {
        if (previewTokenRef.current === token) {
          setPreviewingVoiceId(null);
        }
      }
    },
    [previewingVoiceId, voice.languageLock, voice.pace, provider.geminiApiKey]
  );

  const handleVoiceSettingChange = useCallback(
    (patch: Partial<VoicePreferences>, requiresReconnect: boolean) => {
      onUpdateVoice(patch);
      if (requiresReconnect && connectionState === 'connected') {
        setNeedsReconnect(true);
      }
    },
    [onUpdateVoice, connectionState]
  );

  const handlePaceChange = useCallback(
    (pace: SpeechPace) => {
      onUpdateVoice({ pace });
      clientRef.current?.setPace(pace);
    },
    [onUpdateVoice]
  );

  const handleDepthChange = useCallback(
    (depth: ResponseDepth) => {
      onUpdateVoice({ depth });
      if (connectionState === 'connected') {
        clientRef.current?.notifyDepthChange(depth, voice.languageLock);
        upsertTranscript({
          id: `sys-depth-${Date.now()}`,
          role: 'system',
          text:
            depth === 'indepth'
              ? 'Antworttiefe auf In Depth umgestellt (ausführliche Schritt-für-Schritt-Erklärungen).'
              : 'Antworttiefe auf Kurz umgestellt (kompakte 2–4 Sätze).',
          timestamp: Date.now(),
          finalized: true,
        });
      }
    },
    [onUpdateVoice, connectionState, voice.languageLock, upsertTranscript]
  );

  const handleSendText = useCallback(
    (event?: React.FormEvent) => {
      event?.preventDefault();
      const trimmed = textInput.trim();
      if (!trimmed) return;
      if (connectionState === 'connected') {
        clientRef.current?.sendText(trimmed);
        setTextInput('');
        return;
      }
      if (hasApiKey && connectionState !== 'connecting') {
        pendingImpulseRef.current = trimmed;
        setTextInput('');
        void handleStartCall();
      }
    },
    [textInput, connectionState, hasApiKey, handleStartCall]
  );

  const handleQuickImpulse = useCallback(
    (kind: 'indepth' | 'exam' | 'grammar') => {
      if (kind === 'indepth' && voice.depth !== 'indepth') {
        onUpdateVoice({ depth: 'indepth' });
      }
      const promptText = buildQuickImpulseText(kind, voice.languageLock, activeCourse?.title);
      if (connectionState === 'connected') {
        if (kind === 'indepth') {
          clientRef.current?.notifyDepthChange('indepth', voice.languageLock);
        }
        clientRef.current?.sendText(promptText);
        return;
      }
      if (!hasApiKey) {
        setErrorMessage('Hinterlege zuerst einen kostenlosen Google AI Studio API-Key, um den Impuls zu starten.');
        return;
      }
      if (connectionState !== 'connecting') {
        pendingImpulseRef.current = promptText;
        void handleStartCall();
      }
    },
    [voice.depth, voice.languageLock, activeCourse?.title, onUpdateVoice, connectionState, hasApiKey, handleStartCall]
  );

  const handleSaveInlineKey = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = inlineKeyInput.trim();
      if (!trimmed) return;
      onUpdateProvider({ geminiApiKey: trimmed });
      setInlineKeyInput('');
      setErrorMessage(null);
    },
    [inlineKeyInput, onUpdateProvider]
  );

  const isLive = connectionState === 'connected';
  const isConnecting = connectionState === 'connecting';
  const speakerSpeaking = isLive && audioLevels.speaker > 0.04;
  const micSpeaking = isLive && !muted && !speakerSpeaking && audioLevels.mic > 0.04;

  const telemetryStatusLabel = isConnecting
    ? statusDetail || 'Verbindet mit Gemini Live...'
    : isLive
      ? muted
        ? 'Mikrofon stummgeschaltet'
        : speakerSpeaking
          ? `${voice.voiceName} spricht`
          : micSpeaking
            ? 'Hört zu'
            : 'Verbindung aktiv'
      : 'Bereit für Sprachgespräch';

  const statusBadgeColor = isLive
    ? 'var(--positive)'
    : isConnecting
      ? 'var(--warning)'
      : connectionState === 'error'
        ? 'var(--negative)'
        : 'var(--text-muted)';

  const statusBadgeLabel = isLive
    ? 'Live'
    : isConnecting
      ? 'Verbindet'
      : connectionState === 'error'
        ? 'Fehler'
        : 'Bereit';

  return (
    <>
      {/* Minimized Active Call Floating Pill when drawer is closed while connected/connecting */}
      {!open && (isLive || isConnecting) && (
        <div
          className="surface-card fixed bottom-5 right-5 z-50 flex items-center gap-3 px-3.5 py-2.5 animate-enter"
          style={{
            borderColor: 'var(--accent-border)',
            boxShadow: 'var(--shadow-md)',
          }}
          role="region"
          aria-label="Aktives Voice-Tutor-Gespräch"
        >
          <button
            type="button"
            onClick={() => onOpenChange(true)}
            className="flex items-center gap-2.5 text-left cursor-pointer"
            style={{ background: 'transparent', border: 'none', padding: 0 }}
          >
            <span
              className="inline-block h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: isLive ? 'var(--positive)' : 'var(--warning)' }}
            />
            <div className="flex items-end gap-[2px] h-4 w-5" aria-hidden="true">
              {[1, 4, 7, 10].map((barIdx) => {
                const val = audioLevels.bars[barIdx] ?? 0.1;
                return (
                  <span
                    key={barIdx}
                    className="w-[3px] rounded-full transition-all duration-75"
                    style={{
                      height: `${Math.max(20, Math.round(val * 100))}%`,
                      backgroundColor: speakerSpeaking
                        ? 'var(--accent)'
                        : muted
                          ? 'var(--text-muted)'
                          : 'var(--positive)',
                    }}
                  />
                );
              })}
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                Voice Tutor · {isLive ? 'Live' : 'Verbindet'}
              </span>
              <span className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-mono-num">{formatDuration(elapsedSeconds)}</span>
                <span>·</span>
                <span>{LANGUAGE_META[voice.languageLock].code}</span>
                <span>·</span>
                <span>{voice.voiceName}</span>
              </span>
            </div>
          </button>

          <div
            className="h-5 w-px mx-0.5"
            style={{ backgroundColor: 'var(--border-hairline)' }}
            aria-hidden="true"
          />

          <div className="flex items-center gap-1">
            {isLive && (
              <button
                type="button"
                onClick={handleToggleMute}
                className="btn-ghost"
                style={{
                  padding: '0 8px',
                  color: muted ? 'var(--warning)' : 'var(--text-primary)',
                  backgroundColor: muted ? 'var(--warning-soft)' : 'transparent',
                }}
                title={muted ? 'Mikrofon aktivieren' : 'Stummschalten'}
                aria-label={muted ? 'Mikrofon aktivieren' : 'Stummschalten'}
              >
                {muted ? <MicOff size={15} strokeWidth={1.5} /> : <Mic size={15} strokeWidth={1.5} />}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenChange(true)}
              className="btn-ghost"
              style={{ padding: '0 8px' }}
              title="Drawer öffnen"
              aria-label="Voice Tutor öffnen"
            >
              <Maximize2 size={15} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={handleEndCall}
              className="btn-ghost"
              style={{
                padding: '0 8px',
                color: 'var(--negative)',
                backgroundColor: 'var(--negative-soft)',
              }}
              title="Gespräch beenden"
              aria-label="Gespräch beenden"
            >
              <PhoneOff size={15} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      )}

      {/* Slide-Over Drawer Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 transition-opacity duration-200"
          style={{ backgroundColor: 'rgba(15, 16, 17, 0.28)' }}
          onClick={() => onOpenChange(false)}
          aria-hidden="true"
        />
      )}

      {/* Slide-Over Drawer Panel */}
      <aside
        role="dialog"
        aria-modal="false"
        aria-label="Voice Tutor"
        aria-hidden={!open}
        className={`fixed top-0 right-0 z-50 h-full w-full sm:w-[432px] flex flex-col transition-transform duration-200 ${
          open ? 'translate-x-0 pointer-events-auto' : 'translate-x-full pointer-events-none'
        }`}
        style={{
          backgroundColor: 'var(--bg-card)',
          borderLeft: '1px solid var(--border-hairline)',
          boxShadow: open ? 'var(--shadow-md)' : 'none',
          transitionTimingFunction: 'var(--ease)',
        }}
      >
        {/* Header */}
        <header
          className="flex items-start justify-between gap-3 px-4 py-3.5 shrink-0"
          style={{ borderBottom: '1px solid var(--border-hairline)' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[16px] font-semibold tracking-tight m-0" style={{ color: 'var(--text-primary)' }}>
                Voice Tutor
              </h2>
              <span
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-medium"
                style={{
                  backgroundColor: isLive
                    ? 'var(--positive-soft)'
                    : isConnecting
                      ? 'var(--warning-soft)'
                      : connectionState === 'error'
                        ? 'var(--negative-soft)'
                        : 'var(--bg-raised)',
                  color: statusBadgeColor,
                }}
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: statusBadgeColor }}
                />
                {statusBadgeLabel}
              </span>
              {activeModel && (
                <span
                  className="font-mono-num text-[11px] truncate max-w-[135px]"
                  style={{ color: 'var(--text-muted)' }}
                  title={activeModel}
                >
                  {activeModel}
                </span>
              )}
            </div>

            <div className="mt-1 flex items-center gap-1.5 text-[12px] truncate" style={{ color: 'var(--text-secondary)' }}>
              <span className="truncate">{activeCourse ? activeCourse.title : currentViewLabel}</span>
              <span style={{ color: 'var(--text-muted)' }}>·</span>
              <span className="shrink-0 font-mono-num">
                {localCourseNotes.length} {localCourseNotes.length === 1 ? 'Notiz' : 'Notizen'}
              </span>
              {selectedObsidianCount > 0 && (
                <>
                  <span style={{ color: 'var(--text-muted)' }}>·</span>
                  <span className="shrink-0 font-mono-num">{selectedObsidianCount} Obsidian</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setControlsCollapsed((v) => !v)}
              className="btn-ghost"
              style={{ padding: '0 8px' }}
              title={controlsCollapsed ? 'Steuerung einblenden' : 'Steuerung kompakt ausblenden'}
              aria-label={controlsCollapsed ? 'Steuerung einblenden' : 'Steuerung ausblenden'}
            >
              <SlidersHorizontal size={15} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="btn-ghost"
              style={{ padding: '0 8px' }}
              title={isLive ? 'Minimieren (Gespräch läuft weiter)' : 'Schliessen'}
              aria-label="Voice Tutor schliessen"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>
        </header>

        {/* Scrollable Controls + API Key Notice */}
        <div
          className="px-4 py-3 space-y-3 shrink-0 overflow-y-auto max-h-[54vh]"
          style={{
            borderBottom: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--bg-page)',
          }}
        >
          {/* Friendly 60-Second API Key Prompt when no Gemini key is set */}
          {!hasApiKey && (
            <div
              className="surface-raised p-3 space-y-2.5"
              style={{ borderColor: 'var(--accent-border)' }}
            >
              <div className="flex items-start gap-2.5">
                <KeyRound
                  size={16}
                  strokeWidth={1.5}
                  className="shrink-0 mt-0.5"
                  style={{ color: 'var(--accent)' }}
                />
                <div className="min-w-0 space-y-1">
                  <p className="text-[13px] font-medium m-0" style={{ color: 'var(--text-primary)' }}>
                    Kostenloser Google AI Studio Key in 60 Sekunden
                  </p>
                  <p className="text-[12px] m-0 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    Für Echtzeit-Sprachgespräche nutzt OpenStudy das kostenlose Gemini Free Tier direkt aus deinem Browser. Probehören funktioniert bereits jetzt.
                  </p>
                </div>
              </div>

              <form onSubmit={handleSaveInlineKey} className="flex items-center gap-1.5">
                <input
                  type="password"
                  value={inlineKeyInput}
                  onChange={(e) => setInlineKeyInput(e.target.value)}
                  placeholder="AIza... API-Key einfügen"
                  className="flex-1 h-8 px-2.5 rounded-lg text-[13px]"
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                />
                <button
                  type="submit"
                  disabled={!inlineKeyInput.trim()}
                  className="btn-accent"
                  style={{
                    height: 32,
                    padding: '0 12px',
                    fontSize: 13,
                    opacity: inlineKeyInput.trim() ? 1 : 0.55,
                  }}
                >
                  Speichern
                </button>
              </form>

              <div className="flex items-center justify-between gap-2 pt-0.5">
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[12px] font-medium hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  Google AI Studio öffnen
                  <ExternalLink size={12} strokeWidth={1.5} />
                </a>
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="btn-ghost"
                  style={{ height: 26, padding: '0 8px', fontSize: 12 }}
                >
                  <Settings size={13} strokeWidth={1.5} />
                  Einstellungen
                </button>
              </div>
            </div>
          )}

          {/* Collapsible Tuning Controls */}
          {!controlsCollapsed && (
            <div className="space-y-2.5">
              {/* Row 1: Mode Tabs + Stance Toggle */}
              <div className="flex items-center gap-2">
                <div
                  className="flex-1 grid grid-cols-3 p-0.5 rounded-lg"
                  style={{
                    backgroundColor: 'var(--bg-raised)',
                    border: '1px solid var(--border-hairline)',
                  }}
                  role="tablist"
                  aria-label="Tutor-Modus"
                >
                  {MODES.map((m) => {
                    const Icon = m.icon;
                    const active = voice.mode === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => handleVoiceSettingChange({ mode: m.id }, true)}
                        className="flex items-center justify-center gap-1.5 h-7 rounded-md text-[12px] font-medium transition-colors cursor-pointer"
                        style={{
                          backgroundColor: active ? 'var(--bg-card)' : 'transparent',
                          color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                          border: active ? '1px solid var(--border-hairline)' : '1px solid transparent',
                        }}
                      >
                        <Icon size={14} strokeWidth={1.5} />
                        <span className="truncate">{m.label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Stance toggle: Coach vs Assistenz */}
                <div
                  className="inline-flex p-0.5 rounded-lg shrink-0"
                  style={{
                    backgroundColor: 'var(--bg-raised)',
                    border: '1px solid var(--border-hairline)',
                  }}
                  role="group"
                  aria-label="Haltung des Tutors"
                >
                  {(
                    [
                      { id: 'coach', label: 'Coach' },
                      { id: 'assistant', label: 'Assistenz' },
                    ] as Array<{ id: AgentStance; label: string }>
                  ).map((item) => {
                    const active = voice.stance === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleVoiceSettingChange({ stance: item.id }, true)}
                        className="h-7 px-2 rounded-md text-[12px] font-medium transition-colors cursor-pointer"
                        style={{
                          backgroundColor: active ? 'var(--accent-soft)' : 'transparent',
                          color: active ? 'var(--accent)' : 'var(--text-secondary)',
                          border: active ? '1px solid var(--accent-border)' : '1px solid transparent',
                        }}
                        title={
                          item.id === 'coach'
                            ? 'Sokratischer Coach: leitet dich mit Fragen zur eigenen Lösung'
                            : 'Direkte Assistenz: erstellt auf Wunsch konkrete Zusammenfassungen und Pläne'
                        }
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Row 2: Language-Lock Bar */}
              <div
                className="surface-card px-2.5 py-2 space-y-2"
                style={{ borderRadius: 10, boxShadow: 'none' }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Lock size={14} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                    <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      Sprach-Sperre
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    {LANGUAGES.map((lang) => {
                      const active = voice.languageLock === lang;
                      return (
                        <button
                          key={lang}
                          type="button"
                          onClick={() => handleVoiceSettingChange({ languageLock: lang }, true)}
                          className="h-6 px-2 rounded-md text-[12px] font-medium transition-colors cursor-pointer"
                          style={{
                            backgroundColor: active ? 'var(--accent)' : 'var(--bg-raised)',
                            color: active ? 'var(--accent-ink)' : 'var(--text-secondary)',
                            border: '1px solid transparent',
                          }}
                          title={`Strikt auf ${LANGUAGE_META[lang].nameDe} fixieren`}
                        >
                          {LANGUAGE_META[lang].code}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      handleVoiceSettingChange({ bilingualCoach: !voice.bilingualCoach }, true)
                    }
                    className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md text-[12px] font-medium transition-colors cursor-pointer"
                    style={{
                      backgroundColor: voice.bilingualCoach ? 'var(--accent-soft)' : 'var(--bg-raised)',
                      color: voice.bilingualCoach ? 'var(--accent)' : 'var(--text-secondary)',
                      border: voice.bilingualCoach
                        ? '1px solid var(--accent-border)'
                        : '1px solid var(--border-hairline)',
                    }}
                  >
                    <ArrowLeftRight size={13} strokeWidth={1.5} />
                    <span>Zweisprachig</span>
                  </button>

                  {voice.bilingualCoach ? (
                    <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      <span>Erklären auf</span>
                      <select
                        value={voice.explainLanguage}
                        onChange={(e) =>
                          handleVoiceSettingChange(
                            { explainLanguage: e.target.value as StudyLanguage },
                            true
                          )
                        }
                        aria-label="Erklärsprache"
                        className="h-6 px-1.5 rounded-md text-[12px] font-medium cursor-pointer"
                        style={{
                          backgroundColor: 'var(--bg-raised)',
                          border: '1px solid var(--border-hairline)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        {LANGUAGES.map((lang) => (
                          <option key={lang} value={lang}>
                            {LANGUAGE_META[lang].nameDe}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                      Kein Sprachwechsel trotz Akzent
                    </span>
                  )}
                </div>
              </div>

              {/* Row 3: Tempo & Tiefe */}
              <div className="flex items-center gap-1.5">
                <div
                  className="flex-1 flex items-center justify-between gap-1 px-2 py-1.5 rounded-[10px] min-w-0"
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium shrink-0" style={{ color: 'var(--text-secondary)' }}>
                    <Gauge size={13} strokeWidth={1.5} />
                    Tempo
                  </span>
                  <div className="flex items-center gap-0.5">
                    {PACES.map((p) => {
                      const active = voice.pace === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handlePaceChange(p.id)}
                          className="h-6 px-1.5 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer"
                          style={{
                            backgroundColor: active ? 'var(--bg-raised)' : 'transparent',
                            color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                            border: active
                              ? '1px solid var(--border-strong)'
                              : '1px solid transparent',
                          }}
                          title={`${p.label} (${PACE_PLAYBACK_RATE[p.id]}x)`}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div
                  className="flex items-center gap-0.5 px-2 py-1.5 rounded-[10px] shrink-0"
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  <Layers size={13} strokeWidth={1.5} className="shrink-0 mr-0.5" style={{ color: 'var(--text-secondary)' }} />
                  {(
                    [
                      { id: 'concise', label: 'Kurz' },
                      { id: 'indepth', label: 'In Depth' },
                    ] as Array<{ id: ResponseDepth; label: string }>
                  ).map((d) => {
                    const active = voice.depth === d.id;
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => handleDepthChange(d.id)}
                        className="h-6 px-2 rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                        style={{
                          backgroundColor: active ? 'var(--accent-soft)' : 'transparent',
                          color: active ? 'var(--accent)' : 'var(--text-muted)',
                          border: active
                            ? '1px solid var(--accent-border)'
                            : '1px solid transparent',
                        }}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Row 4: Voice Selector + Real Probehören + Expandable Catalog */}
              <div
                className="rounded-[10px] overflow-hidden"
                style={{
                  backgroundColor: 'var(--bg-card)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                  <button
                    type="button"
                    onClick={() => setVoiceListOpen((v) => !v)}
                    className="flex-1 flex items-center justify-between gap-2 min-w-0 text-left cursor-pointer"
                    style={{ background: 'transparent', border: 'none', padding: 0 }}
                    aria-expanded={voiceListOpen}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                          Stimme
                        </span>
                        <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                          {activeVoiceMeta.label}
                        </span>
                      </div>
                      <p className="text-[11px] m-0 truncate" style={{ color: 'var(--text-muted)' }}>
                        {activeVoiceMeta.tone}
                      </p>
                    </div>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {voiceListOpen ? (
                        <ChevronUp size={15} strokeWidth={1.5} />
                      ) : (
                        <ChevronDown size={15} strokeWidth={1.5} />
                      )}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handlePreviewVoice(voice.voiceName)}
                    className="btn-secondary shrink-0"
                    style={{
                      height: 30,
                      padding: '0 10px',
                      fontSize: 12,
                      color:
                        previewingVoiceId === voice.voiceName
                          ? 'var(--accent)'
                          : 'var(--text-primary)',
                      borderColor:
                        previewingVoiceId === voice.voiceName
                          ? 'var(--accent-border)'
                          : 'var(--border-hairline)',
                    }}
                    title="Aktuelle Stimme probehören"
                  >
                    {previewingVoiceId === voice.voiceName ? (
                      <>
                        <Square size={13} strokeWidth={1.5} />
                        Stopp
                      </>
                    ) : (
                      <>
                        <Volume2 size={14} strokeWidth={1.5} />
                        Probehören
                      </>
                    )}
                  </button>
                </div>

                {voiceListOpen && (
                  <div
                    className="px-2 py-1.5 space-y-1"
                    style={{
                      borderTop: '1px solid var(--border-hairline)',
                      backgroundColor: 'var(--bg-page)',
                    }}
                  >
                    {VOICE_CATALOG.map((item) => {
                      const selected = item.id === voice.voiceName;
                      const isPlayingThis = previewingVoiceId === item.id;
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg transition-colors"
                          style={{
                            backgroundColor: selected ? 'var(--accent-soft)' : 'transparent',
                            border: selected
                              ? '1px solid var(--accent-border)'
                              : '1px solid transparent',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => handleVoiceSettingChange({ voiceName: item.id }, true)}
                            className="flex-1 flex items-center gap-2 min-w-0 text-left cursor-pointer"
                            style={{ background: 'transparent', border: 'none', padding: 0 }}
                          >
                            <span
                              className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                              style={{
                                backgroundColor: selected ? 'var(--accent)' : 'var(--bg-raised)',
                                color: selected ? 'var(--accent-ink)' : 'transparent',
                              }}
                            >
                              <Check size={11} strokeWidth={2} />
                            </span>
                            <div className="min-w-0">
                              <div className="text-[13px] font-medium leading-tight" style={{ color: 'var(--text-primary)' }}>
                                {item.label}
                              </div>
                              <div className="text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
                                {item.tone}
                              </div>
                            </div>
                          </button>

                          <button
                            type="button"
                            onClick={() => void handlePreviewVoice(item.id)}
                            className="btn-ghost shrink-0"
                            style={{
                              height: 26,
                              padding: '0 8px',
                              fontSize: 12,
                              color: isPlayingThis ? 'var(--accent)' : 'var(--text-secondary)',
                              backgroundColor: isPlayingThis ? 'var(--bg-card)' : 'transparent',
                            }}
                            title={`${item.label} probehören`}
                            aria-label={`${item.label} probehören`}
                          >
                            {isPlayingThis ? (
                              <Square size={12} strokeWidth={1.5} />
                            ) : (
                              <Play size={12} strokeWidth={1.5} />
                            )}
                            <span>{isPlayingThis ? 'Stopp' : 'Hören'}</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Reconnect cue if voice/language/mode changed mid-call */}
          {needsReconnect && isLive && (
            <div
              className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-[12px]"
              style={{
                backgroundColor: 'var(--warning-soft)',
                color: 'var(--warning)',
              }}
            >
              <span>Neue Sprach- oder Modus-Optionen aktivieren</span>
              <button
                type="button"
                onClick={() => void handleStartCall()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-medium cursor-pointer"
                style={{
                  backgroundColor: 'var(--bg-card)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <RefreshCw size={12} strokeWidth={1.5} />
                Neu verbinden
              </button>
            </div>
          )}

          {/* Real 12-Bar Audio Telemetry Strip & Primary Call Controls */}
          <div
            className="surface-card p-3 space-y-2.5"
            style={{ borderRadius: 12, boxShadow: 'none' }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {telemetryStatusLabel}
                </div>
                <div className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                  <span>{LANGUAGE_META[voice.languageLock].nameDe}</span>
                  <span>·</span>
                  <span className="font-mono-num">{PACE_PLAYBACK_RATE[voice.pace]}x</span>
                  <span>·</span>
                  <span>{voice.depth === 'indepth' ? 'In Depth' : 'Kurz'}</span>
                </div>
              </div>

              {/* 12-Bar Real Telemetry Meter */}
              <div className="flex items-center gap-2.5 shrink-0">
                <div
                  className="flex items-end gap-[3px] h-7 px-1"
                  aria-label="Live-Audiopegel"
                >
                  {audioLevels.bars.map((level, index) => {
                    const heightPct = Math.max(12, Math.min(100, Math.round(level * 100)));
                    const barColor = !isLive
                      ? 'var(--border-strong)'
                      : muted
                        ? 'var(--border-strong)'
                        : speakerSpeaking
                          ? 'var(--accent)'
                          : 'var(--positive)';
                    return (
                      <span
                        key={index}
                        className="w-[3px] rounded-full transition-all duration-75"
                        style={{
                          height: `${heightPct}%`,
                          backgroundColor: barColor,
                        }}
                      />
                    );
                  })}
                </div>
                {isLive && (
                  <span
                    className="font-mono-num text-[12px] min-w-[40px] text-right"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {formatDuration(elapsedSeconds)}
                  </span>
                )}
              </div>
            </div>

            {/* Call Action Row */}
            <div className="flex items-center gap-2">
              {!isLive && !isConnecting && (
                <button
                  type="button"
                  onClick={() => void handleStartCall()}
                  className="btn-accent flex-1"
                  disabled={!hasApiKey}
                  style={{ opacity: hasApiKey ? 1 : 0.55 }}
                >
                  <Mic size={16} strokeWidth={1.5} />
                  <span>Gespräch starten</span>
                </button>
              )}

              {isConnecting && (
                <>
                  <button
                    type="button"
                    disabled
                    className="btn-secondary flex-1"
                    style={{ opacity: 0.85, cursor: 'wait' }}
                  >
                    <Loader2 size={15} strokeWidth={1.5} className="animate-spin" />
                    <span>Verbindet...</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleEndCall}
                    className="btn-secondary"
                    style={{ color: 'var(--negative)' }}
                  >
                    Abbrechen
                  </button>
                </>
              )}

              {isLive && (
                <>
                  <button
                    type="button"
                    onClick={handleToggleMute}
                    className="btn-secondary flex-1"
                    style={{
                      backgroundColor: muted ? 'var(--warning-soft)' : 'var(--bg-raised)',
                      color: muted ? 'var(--warning)' : 'var(--text-primary)',
                      borderColor: muted ? 'var(--warning)' : 'var(--border-hairline)',
                    }}
                  >
                    {muted ? (
                      <MicOff size={15} strokeWidth={1.5} />
                    ) : (
                      <Mic size={15} strokeWidth={1.5} />
                    )}
                    <span>{muted ? 'Stumm aktiv' : 'Stumm'}</span>
                    <span className="keycap">M</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleEndCall}
                    className="btn-secondary"
                    style={{
                      backgroundColor: 'var(--negative-soft)',
                      color: 'var(--negative)',
                      borderColor: 'transparent',
                    }}
                  >
                    <PhoneOff size={15} strokeWidth={1.5} />
                    <span>Beenden</span>
                  </button>
                </>
              )}
            </div>

            {errorMessage && (
              <div
                className="px-2.5 py-2 rounded-lg text-[12px] leading-snug"
                style={{
                  backgroundColor: 'var(--negative-soft)',
                  color: 'var(--negative)',
                }}
                role="alert"
              >
                {errorMessage}
              </div>
            )}
          </div>
        </div>

        {/* Live Transcript Feed */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              Live-Transkript
            </span>
            {transcript.length > 0 && (
              <button
                type="button"
                onClick={() => setTranscript([])}
                className="btn-ghost"
                style={{ height: 24, padding: '0 6px', fontSize: 12 }}
                title="Transkript leeren"
              >
                <Trash2 size={13} strokeWidth={1.5} />
                Leeren
              </button>
            )}
          </div>

          {transcript.length === 0 ? (
            <div
              className="surface-raised px-3.5 py-4 text-[13px] space-y-2 leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              <p className="m-0 font-medium" style={{ color: 'var(--text-primary)' }}>
                Gesprächsbereit mit Sprach-Sperre ({LANGUAGE_META[voice.languageLock].nameDe})
              </p>
              <p className="m-0 text-[12px]">
                Antworten bleiben standardmässig kompakt. Sage jederzeit «in depth» oder «genauer erklären», um sofort eine ausführliche Schritt-für-Schritt-Erklärung zu erhalten.
              </p>
              <p className="m-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Tipp: Du kannst dem Tutor auch während er spricht ins Wort fallen — die Wiedergabe stoppt sofort.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {transcript.map((item) => {
                if (item.role === 'system') {
                  return (
                    <div key={item.id} className="flex justify-center py-0.5">
                      <span
                        className="px-2.5 py-1 rounded-full text-[11px]"
                        style={{
                          backgroundColor: 'var(--bg-raised)',
                          color: 'var(--text-muted)',
                        }}
                      >
                        {item.text}
                      </span>
                    </div>
                  );
                }

                const isUser = item.role === 'user';
                return (
                  <div
                    key={item.id}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                  >
                    <span
                      className="text-[11px] mb-0.5 px-1"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {isUser ? 'Du' : voice.voiceName}
                    </span>
                    <div
                      className="max-w-[88%] px-3 py-2 rounded-xl text-[13px] leading-relaxed whitespace-pre-wrap"
                      style={{
                        backgroundColor: isUser ? 'var(--accent-soft)' : 'var(--bg-raised)',
                        border: isUser
                          ? '1px solid var(--accent-border)'
                          : '1px solid var(--border-hairline)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {item.text}
                    </div>
                  </div>
                );
              })}
              <div ref={transcriptEndRef} />
            </div>
          )}
        </div>

        {/* Footer: Quick-Impulse Buttons + Text Input */}
        <footer
          className="px-4 py-3 space-y-2.5 shrink-0"
          style={{
            borderTop: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--bg-page)',
          }}
        >
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => handleQuickImpulse('indepth')}
              className="btn-secondary"
              style={{ height: 28, padding: '0 10px', fontSize: 12 }}
            >
              In Depth erklären
            </button>
            <button
              type="button"
              onClick={() => handleQuickImpulse('exam')}
              className="btn-secondary"
              style={{ height: 28, padding: '0 10px', fontSize: 12 }}
            >
              Mündliche Prüfungsfrage
            </button>
            <button
              type="button"
              onClick={() => handleQuickImpulse('grammar')}
              className="btn-secondary"
              style={{ height: 28, padding: '0 10px', fontSize: 12 }}
            >
              Grammatik korrigieren
            </button>
          </div>

          <form onSubmit={handleSendText} className="flex items-center gap-2">
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder={
                isLive
                  ? 'Nachricht oder Stichwort senden...'
                  : 'Frage tippen (startet bei Senden das Gespräch)...'
              }
              className="flex-1 h-9 px-3 rounded-lg text-[13px]"
              style={{
                backgroundColor: 'var(--bg-card)',
                border: '1px solid var(--border-strong)',
                color: 'var(--text-primary)',
              }}
            />
            <button
              type="submit"
              disabled={!textInput.trim() || (!isLive && !hasApiKey) || isConnecting}
              className="btn-primary shrink-0"
              style={{
                width: 36,
                padding: 0,
                opacity:
                  textInput.trim() && (isLive || hasApiKey) && !isConnecting ? 1 : 0.45,
              }}
              title="Senden"
              aria-label="Nachricht senden"
            >
              <Send size={15} strokeWidth={1.5} />
            </button>
          </form>
        </footer>
      </aside>
    </>
  );
}

export default VoiceTutorDrawer;
