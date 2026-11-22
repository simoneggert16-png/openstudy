import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
  X,
} from 'lucide-react';
import {
  checkLocalBridge,
  FREE_GEMINI_TEXT_MODELS,
  FREE_LIVE_MODELS,
  testGeminiApiKey,
} from '../services/providers';
import {
  AgentStance,
  OpenStudyState,
  ProviderConfig,
  StudyLanguage,
  VoicePreferences,
} from '../types';

export interface OnboardingWizardProps {
  open: boolean;
  state: OpenStudyState;
  onUpdateProvider: (patch: Partial<ProviderConfig>) => void;
  onUpdateVoice: (patch: Partial<VoicePreferences>) => void;
  onSetDailyGoalMinutes: (minutes: number) => void;
  onComplete: () => void;
  onOpenImport: () => void;
}

type SetupPath = 'gemini' | 'no-key' | 'advanced';
type StorageChoice = 'builtin' | 'obsidian';

const LANGUAGES: Array<{ code: StudyLanguage; label: string; hint: string }> = [
  { code: 'de', label: 'Deutsch', hint: 'Erklärungen & Oberfläche' },
  { code: 'en', label: 'English', hint: 'Explanations & practice' },
  { code: 'fr', label: 'Français', hint: 'Explications & pratique' },
  { code: 'es', label: 'Español', hint: 'Explicaciones y práctica' },
  { code: 'it', label: 'Italiano', hint: 'Spiegazioni e pratica' },
];

const DAILY_GOALS: Array<{ minutes: number; label: string }> = [
  { minutes: 15, label: 'Locker einsteigen' },
  { minutes: 30, label: 'Alltagstauglich' },
  { minutes: 45, label: 'Fokussiert lernen' },
  { minutes: 60, label: 'Prüfungsphase' },
];

const STANCES: Array<{
  id: AgentStance;
  title: string;
  description: string;
}> = [
  {
    id: 'coach',
    title: 'Coach — hilft beim Verstehen',
    description:
      'Stellt gezielte Rückfragen, gibt kleine Hinweise und hilft dir, Zusammenhänge selbst sicher zu durchdringen.',
  },
  {
    id: 'assistant',
    title: 'Assistenz — hilft & erstellt Material',
    description:
      'Erklärt direkt und klar, fasst Inhalte zusammen und hilft beim Erstellen von Karteikarten, Beispielen und Lernplänen.',
  },
];

const STEP_LABELS = [
  { num: 1, title: 'Willkommen & Ziel' },
  { num: 2, title: 'Gratis KI-Start' },
  { num: 3, title: 'Wissensspeicher' },
] as const;

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  open,
  state,
  onUpdateProvider,
  onUpdateVoice,
  onSetDailyGoalMinutes,
  onComplete,
  onOpenImport,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [setupPath, setSetupPath] = useState<SetupPath>(() => {
    if (
      state.provider.activeTextProvider === 'cli-bridge' ||
      state.provider.activeTextProvider === 'openai-compatible' ||
      state.provider.activeTextProvider === 'anthropic'
    ) {
      return 'advanced';
    }
    if (state.provider.activeTextProvider === 'ollama') {
      return 'no-key';
    }
    return 'gemini';
  });
  const [useOllamaOffline, setUseOllamaOffline] = useState(
    state.provider.activeTextProvider === 'ollama'
  );
  const [showKey, setShowKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyTestResult, setKeyTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const [checkingBridge, setCheckingBridge] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<{
    online: boolean;
    tools: string[];
  } | null>(null);

  const [storageChoice, setStorageChoice] = useState<StorageChoice>('builtin');

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onComplete();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onComplete]);

  if (!open) return null;

  const selectPath = (next: SetupPath) => {
    setSetupPath(next);
    setKeyTestResult(null);

    if (next === 'gemini') {
      setUseOllamaOffline(false);
      onUpdateProvider({
        activeTextProvider: 'gemini-free',
        freeOnlyLock: true,
        geminiTextModel: state.provider.geminiTextModel || FREE_GEMINI_TEXT_MODELS[0],
        geminiLiveModel: state.provider.geminiLiveModel || FREE_LIVE_MODELS[0],
      });
    } else if (next === 'no-key') {
      if (useOllamaOffline) {
        onUpdateProvider({
          activeTextProvider: 'ollama',
          freeOnlyLock: true,
        });
      } else {
        onUpdateProvider({
          activeTextProvider: 'gemini-free',
          freeOnlyLock: true,
        });
      }
    } else {
      if (
        state.provider.activeTextProvider === 'gemini-free' ||
        state.provider.activeTextProvider === 'ollama'
      ) {
        onUpdateProvider({
          activeTextProvider: 'cli-bridge',
        });
      }
    }
  };

  const handleTestGemini = async () => {
    setTestingKey(true);
    setKeyTestResult(null);
    try {
      const res = await testGeminiApiKey(state.provider.geminiApiKey);
      setKeyTestResult(res);
    } finally {
      setTestingKey(false);
    }
  };

  const handleCheckBridge = async () => {
    setCheckingBridge(true);
    try {
      const res = await checkLocalBridge(state.provider.bridgeUrl);
      setBridgeStatus(res);
    } finally {
      setCheckingBridge(false);
    }
  };

  const handleFinish = (openObsidianAfter: boolean) => {
    onComplete();
    if (openObsidianAfter) {
      onOpenImport();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      style={{
        backgroundColor: 'rgba(20, 18, 15, 0.56)',
        backdropFilter: 'blur(4px)',
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-wizard-title"
    >
      <div
        className="surface-card animate-enter flex w-full max-w-[760px] flex-col overflow-hidden"
        style={{
          maxHeight: 'min(90vh, 840px)',
          borderColor: 'var(--border-strong)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        {/* Top bar */}
        <div
          className="flex items-center justify-between gap-4 px-6 py-4"
          style={{
            borderBottom: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--bg-raised)',
          }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{
                backgroundColor: 'var(--accent-soft)',
                border: '1px solid var(--accent-border)',
                color: 'var(--accent)',
              }}
            >
              <BookOpen size={16} strokeWidth={1.5} />
            </span>
            <div>
              <h2
                id="onboarding-wizard-title"
                className="text-[15px] font-semibold leading-tight"
                style={{ color: 'var(--text-primary)' }}
              >
                OpenStudy einrichten
              </h2>
              <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                Schritt {step} von 3 · Alles lässt sich später jederzeit anpassen
              </p>
            </div>
          </div>

          <button
            type="button"
            className="btn-ghost"
            onClick={onComplete}
            aria-label="Assistent schließen"
          >
            <span>Später einrichten</span>
            <X size={15} strokeWidth={1.5} />
          </button>
        </div>

        {/* Step Indicator */}
        <div
          className="grid grid-cols-3 gap-2 px-6 py-3"
          style={{ borderBottom: '1px solid var(--border-hairline)' }}
        >
          {STEP_LABELS.map((item) => {
            const isActive = step === item.num;
            const isDone = step > item.num;
            return (
              <button
                key={item.num}
                type="button"
                onClick={() => setStep(item.num)}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors"
                style={{
                  backgroundColor: isActive ? 'var(--accent-soft)' : 'transparent',
                  border: `1px solid ${isActive ? 'var(--accent-border)' : 'transparent'}`,
                  cursor: 'pointer',
                }}
              >
                <span
                  className="font-mono-num flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-medium"
                  style={{
                    backgroundColor: isDone
                      ? 'var(--positive-soft)'
                      : isActive
                        ? 'var(--accent)'
                        : 'var(--bg-raised)',
                    color: isDone
                      ? 'var(--positive)'
                      : isActive
                        ? 'var(--accent-ink)'
                        : 'var(--text-secondary)',
                  }}
                >
                  {isDone ? <Check size={13} strokeWidth={1.75} /> : item.num}
                </span>
                <span
                  className="truncate text-[13px] font-medium"
                  style={{
                    color: isActive || isDone ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                >
                  {item.title}
                </span>
              </button>
            );
          })}
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h3
                  className="text-[20px] font-semibold tracking-[-0.015em]"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Willkommen in deinem persönlichen Lernstudio
                </h3>
                <p className="mt-1 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
                  Wähle Sprache, Tagesziel und Begleitstil. Es wird kein Konto benötigt und alle
                  Einstellungen bleiben lokal auf deinem Gerät.
                </p>
              </div>

              {/* Primary Learning Language */}
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <Globe size={15} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                  <span className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    Deine bevorzugte Lernsprache
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {LANGUAGES.map((lang) => {
                    const selected = state.voice.explainLanguage === lang.code;
                    return (
                      <button
                        key={lang.code}
                        type="button"
                        onClick={() =>
                          onUpdateVoice({
                            explainLanguage: lang.code,
                            languageLock: lang.code,
                          })
                        }
                        className="rounded-[10px] px-3 py-2.5 text-left transition-colors"
                        style={{
                          backgroundColor: selected ? 'var(--accent-soft)' : 'var(--bg-raised)',
                          border: `1px solid ${
                            selected ? 'var(--accent-border)' : 'var(--border-hairline)'
                          }`,
                          cursor: 'pointer',
                        }}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span
                            className="text-[14px] font-medium"
                            style={{
                              color: selected ? 'var(--accent)' : 'var(--text-primary)',
                            }}
                          >
                            {lang.label}
                          </span>
                          {selected && (
                            <Check size={14} strokeWidth={1.75} style={{ color: 'var(--accent)' }} />
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                          {lang.hint}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Daily Study Goal */}
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <Timer size={15} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                  <span className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    Dein tägliches Lernziel
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {DAILY_GOALS.map((goal) => {
                    const selected = state.dailyGoalMinutes === goal.minutes;
                    return (
                      <button
                        key={goal.minutes}
                        type="button"
                        onClick={() => onSetDailyGoalMinutes(goal.minutes)}
                        className="rounded-[10px] px-3.5 py-3 text-left transition-colors"
                        style={{
                          backgroundColor: selected ? 'var(--accent-soft)' : 'var(--bg-raised)',
                          border: `1px solid ${
                            selected ? 'var(--accent-border)' : 'var(--border-hairline)'
                          }`,
                          cursor: 'pointer',
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className="font-mono-num text-[16px] font-semibold"
                            style={{
                              color: selected ? 'var(--accent)' : 'var(--text-primary)',
                            }}
                          >
                            {goal.minutes} Min
                          </span>
                          {selected && (
                            <Check size={14} strokeWidth={1.75} style={{ color: 'var(--accent)' }} />
                          )}
                        </div>
                        <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                          {goal.label}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Agent Stance */}
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <MessageSquare size={15} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                  <span className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    Wie soll dich der KI-Tutor unterstützen?
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {STANCES.map((stance) => {
                    const selected = state.voice.stance === stance.id;
                    return (
                      <button
                        key={stance.id}
                        type="button"
                        onClick={() => onUpdateVoice({ stance: stance.id })}
                        className="rounded-[12px] p-4 text-left transition-colors"
                        style={{
                          backgroundColor: selected ? 'var(--accent-soft)' : 'var(--bg-raised)',
                          border: `1px solid ${
                            selected ? 'var(--accent-border)' : 'var(--border-hairline)'
                          }`,
                          cursor: 'pointer',
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className="text-[14px] font-semibold"
                            style={{
                              color: selected ? 'var(--accent)' : 'var(--text-primary)',
                            }}
                          >
                            {stance.title}
                          </span>
                          {selected && (
                            <CheckCircle2
                              size={16}
                              strokeWidth={1.5}
                              style={{ color: 'var(--accent)', flexShrink: 0 }}
                            />
                          )}
                        </div>
                        <p
                          className="mt-1.5 text-[13px] leading-relaxed"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {stance.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h3
                  className="text-[20px] font-semibold tracking-[-0.015em]"
                  style={{ color: 'var(--text-primary)' }}
                >
                  100 % Gratis KI-Start — oder dein eigener Anbieter
                </h3>
                <p className="mt-1 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
                  Für den Sprachtutor und KI-Erklärungen kannst du kostenlos starten oder OpenStudy
                  auch komplett ohne API-Key verwenden.
                </p>
              </div>

              {/* Card 1: Google AI Studio Free Tier */}
              <div
                className="rounded-[12px] p-4 transition-colors"
                style={{
                  backgroundColor:
                    setupPath === 'gemini' ? 'var(--bg-card)' : 'var(--bg-raised)',
                  border: `1px solid ${
                    setupPath === 'gemini' ? 'var(--accent-border)' : 'var(--border-hairline)'
                  }`,
                }}
              >
                <button
                  type="button"
                  onClick={() => selectPath('gemini')}
                  className="flex w-full items-start justify-between gap-3 text-left"
                  style={{ cursor: 'pointer', background: 'transparent', border: 'none', padding: 0 }}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                      style={{
                        backgroundColor: 'var(--accent-soft)',
                        color: 'var(--accent)',
                      }}
                    >
                      <Sparkles size={17} strokeWidth={1.5} />
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="text-[15px] font-semibold"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Google AI Studio Free Tier
                        </span>
                        <span
                          className="rounded-md px-2 py-0.5 text-[12px] font-medium"
                          style={{
                            backgroundColor: 'var(--positive-soft)',
                            color: 'var(--positive)',
                          }}
                        >
                          Empfohlen · 0 CHF
                        </span>
                      </div>
                      <p className="mt-1 text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>
                        Aktiviert den Echtzeit-Voice-Tutor und KI-Erklärungen kostenlos. Der
                        Free-Only-Schutz bleibt automatisch eingeschaltet.
                      </p>
                    </div>
                  </div>
                  <span
                    className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                    style={{
                      border: `1.5px solid ${
                        setupPath === 'gemini' ? 'var(--accent)' : 'var(--border-strong)'
                      }`,
                      backgroundColor: setupPath === 'gemini' ? 'var(--accent)' : 'transparent',
                      color: 'var(--accent-ink)',
                    }}
                  >
                    {setupPath === 'gemini' && <Check size={12} strokeWidth={2} />}
                  </span>
                </button>

                {setupPath === 'gemini' && (
                  <div
                    className="mt-4 space-y-4 pt-4"
                    style={{ borderTop: '1px solid var(--border-hairline)' }}
                  >
                    {/* Dead-simple 3-step visual guide */}
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                      <div className="surface-raised p-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="font-mono-num flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium"
                            style={{
                              backgroundColor: 'var(--accent-soft)',
                              color: 'var(--accent)',
                            }}
                          >
                            1
                          </span>
                          <span
                            className="text-[13px] font-medium"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            Key-Seite öffnen
                          </span>
                        </div>
                        <p className="mt-1.5 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                          Klicke auf «Kostenlosen Key holen» und melde dich normal mit deinem
                          Google-Konto an.
                        </p>
                      </div>

                      <div className="surface-raised p-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="font-mono-num flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium"
                            style={{
                              backgroundColor: 'var(--accent-soft)',
                              color: 'var(--accent)',
                            }}
                          >
                            2
                          </span>
                          <span
                            className="text-[13px] font-medium"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            «Create API key» drücken
                          </span>
                        </div>
                        <p className="mt-1.5 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                          Erstelle mit einem Klick einen kostenlosen Schlüssel und kopiere den Text.
                        </p>
                      </div>

                      <div className="surface-raised p-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="font-mono-num flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium"
                            style={{
                              backgroundColor: 'var(--accent-soft)',
                              color: 'var(--accent)',
                            }}
                          >
                            3
                          </span>
                          <span
                            className="text-[13px] font-medium"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            Hier einfügen &amp; testen
                          </span>
                        </div>
                        <p className="mt-1.5 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                          Füge den Schlüssel unten ein. Er bleibt ausschließlich lokal in deinem
                          Browser gespeichert.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <a
                        href="https://aistudio.google.com/apikey"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-secondary"
                        style={{ textDecoration: 'none' }}
                      >
                        <KeyRound size={15} strokeWidth={1.5} />
                        <span>Kostenlosen Key holen</span>
                        <ExternalLink size={14} strokeWidth={1.5} />
                      </a>

                      <span
                        className="inline-flex items-center gap-1.5 text-[12.5px]"
                        style={{ color: 'var(--positive)' }}
                      >
                        <Lock size={13} strokeWidth={1.5} />
                        <span>Free-Only-Schutz aktiv (0 CHF)</span>
                      </span>
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row">
                      <div className="relative flex-1">
                        <input
                          type={showKey ? 'text' : 'password'}
                          value={state.provider.geminiApiKey}
                          onChange={(e) => {
                            setKeyTestResult(null);
                            onUpdateProvider({
                              activeTextProvider: 'gemini-free',
                              freeOnlyLock: true,
                              geminiApiKey: e.target.value,
                            });
                          }}
                          placeholder="Google AI Studio Key hier einfügen"
                          aria-label="Google AI Studio API-Key"
                          className="font-mono-num h-9 w-full rounded-lg pl-3 pr-9 text-[13px]"
                          style={{
                            backgroundColor: 'var(--bg-page)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setShowKey((prev) => !prev)}
                          aria-label={showKey ? 'Key verbergen' : 'Key anzeigen'}
                          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1"
                          style={{
                            color: 'var(--text-muted)',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          {showKey ? (
                            <EyeOff size={15} strokeWidth={1.5} />
                          ) : (
                            <Eye size={15} strokeWidth={1.5} />
                          )}
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={handleTestGemini}
                        disabled={testingKey || !state.provider.geminiApiKey.trim()}
                        className="btn-accent shrink-0"
                        style={{
                          opacity:
                            testingKey || !state.provider.geminiApiKey.trim() ? 0.55 : 1,
                        }}
                      >
                        {testingKey ? (
                          <Loader2 size={15} strokeWidth={1.5} className="animate-spin" />
                        ) : (
                          <CheckCircle2 size={15} strokeWidth={1.5} />
                        )}
                        <span>Key testen</span>
                      </button>
                    </div>

                    {keyTestResult && (
                      <div
                        className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-[13px]"
                        style={{
                          backgroundColor: keyTestResult.ok
                            ? 'var(--positive-soft)'
                            : 'var(--negative-soft)',
                          color: keyTestResult.ok ? 'var(--positive)' : 'var(--negative)',
                        }}
                      >
                        {keyTestResult.ok ? (
                          <CheckCircle2
                            size={15}
                            strokeWidth={1.5}
                            className="mt-0.5 shrink-0"
                          />
                        ) : (
                          <AlertCircle
                            size={15}
                            strokeWidth={1.5}
                            className="mt-0.5 shrink-0"
                          />
                        )}
                        <span>{keyTestResult.message}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Card 2: Completely without API Key (+ optional Ollama) */}
              <div
                className="rounded-[12px] p-4 transition-colors"
                style={{
                  backgroundColor:
                    setupPath === 'no-key' ? 'var(--bg-card)' : 'var(--bg-raised)',
                  border: `1px solid ${
                    setupPath === 'no-key' ? 'var(--accent-border)' : 'var(--border-hairline)'
                  }`,
                }}
              >
                <button
                  type="button"
                  onClick={() => selectPath('no-key')}
                  className="flex w-full items-start justify-between gap-3 text-left"
                  style={{ cursor: 'pointer', background: 'transparent', border: 'none', padding: 0 }}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                      style={{
                        backgroundColor: 'var(--bg-page)',
                        border: '1px solid var(--border-hairline)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <Cpu size={17} strokeWidth={1.5} />
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="text-[15px] font-semibold"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Komplett ohne API-Key starten
                        </span>
                        <span
                          className="rounded-md px-2 py-0.5 text-[12px] font-medium"
                          style={{
                            backgroundColor: 'var(--bg-page)',
                            border: '1px solid var(--border-hairline)',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          Sofort &amp; Offline
                        </span>
                      </div>
                      <p className="mt-1 text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>
                        Notizen, Karteikarten, Fokus-Timer und Sprach-Drills funktionieren sofort.
                        Optional kannst du lokales Ollama (0 CHF, 100 % offline) verbinden.
                      </p>
                    </div>
                  </div>
                  <span
                    className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                    style={{
                      border: `1.5px solid ${
                        setupPath === 'no-key' ? 'var(--accent)' : 'var(--border-strong)'
                      }`,
                      backgroundColor: setupPath === 'no-key' ? 'var(--accent)' : 'transparent',
                      color: 'var(--accent-ink)',
                    }}
                  >
                    {setupPath === 'no-key' && <Check size={12} strokeWidth={2} />}
                  </span>
                </button>

                {setupPath === 'no-key' && (
                  <div
                    className="mt-4 space-y-3 pt-4"
                    style={{ borderTop: '1px solid var(--border-hairline)' }}
                  >
                    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 surface-raised">
                      <div>
                        <span
                          className="block text-[13.5px] font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Lokales Ollama für Offline-KI verwenden (0 CHF)
                        </span>
                        <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                          Aktiviere dies, falls Ollama bereits auf deinem PC läuft.
                        </span>
                      </div>
                      <input
                        type="checkbox"
                        checked={useOllamaOffline}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setUseOllamaOffline(checked);
                          onUpdateProvider({
                            activeTextProvider: checked ? 'ollama' : 'gemini-free',
                            freeOnlyLock: true,
                          });
                        }}
                        className="h-4 w-4 accent-[var(--accent)]"
                      />
                    </label>

                    {useOllamaOffline && (
                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        <label className="block">
                          <span
                            className="mb-1 block text-[12px] font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            Lokale Ollama-Adresse
                          </span>
                          <input
                            type="text"
                            value={state.provider.ollamaUrl}
                            onChange={(e) =>
                              onUpdateProvider({
                                activeTextProvider: 'ollama',
                                ollamaUrl: e.target.value,
                              })
                            }
                            className="font-mono-num h-9 w-full rounded-lg px-3 text-[13px]"
                            style={{
                              backgroundColor: 'var(--bg-page)',
                              border: '1px solid var(--border-strong)',
                              color: 'var(--text-primary)',
                            }}
                          />
                        </label>
                        <label className="block">
                          <span
                            className="mb-1 block text-[12px] font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            Ollama-Modell
                          </span>
                          <input
                            type="text"
                            value={state.provider.ollamaModel}
                            onChange={(e) =>
                              onUpdateProvider({
                                activeTextProvider: 'ollama',
                                ollamaModel: e.target.value,
                              })
                            }
                            placeholder="gemma3:4b"
                            className="font-mono-num h-9 w-full rounded-lg px-3 text-[13px]"
                            style={{
                              backgroundColor: 'var(--bg-page)',
                              border: '1px solid var(--border-strong)',
                              color: 'var(--text-primary)',
                            }}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Card 3: Advanced BYOK & Local CLI Agents */}
              <div
                className="rounded-[12px] p-4 transition-colors"
                style={{
                  backgroundColor:
                    setupPath === 'advanced' ? 'var(--bg-card)' : 'var(--bg-raised)',
                  border: `1px solid ${
                    setupPath === 'advanced' ? 'var(--accent-border)' : 'var(--border-hairline)'
                  }`,
                }}
              >
                <button
                  type="button"
                  onClick={() => selectPath('advanced')}
                  className="flex w-full items-start justify-between gap-3 text-left"
                  style={{ cursor: 'pointer', background: 'transparent', border: 'none', padding: 0 }}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                      style={{
                        backgroundColor: 'var(--bg-page)',
                        border: '1px solid var(--border-hairline)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <Terminal size={17} strokeWidth={1.5} />
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="text-[15px] font-semibold"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Für Fortgeschrittene (BYOK &amp; eigene Agents)
                        </span>
                      </div>
                      <p className="mt-1 text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>
                        Verbinde Antigravity, Claude Code oder ChatGPT Codex über die lokale Bridge
                        — oder nutze OpenRouter, Anthropic oder OpenAI.
                      </p>
                    </div>
                  </div>
                  <span
                    className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                    style={{
                      border: `1.5px solid ${
                        setupPath === 'advanced' ? 'var(--accent)' : 'var(--border-strong)'
                      }`,
                      backgroundColor:
                        setupPath === 'advanced' ? 'var(--accent)' : 'transparent',
                      color: 'var(--accent-ink)',
                    }}
                  >
                    {setupPath === 'advanced' && <Check size={12} strokeWidth={2} />}
                  </span>
                </button>

                {setupPath === 'advanced' && (
                  <div
                    className="mt-4 space-y-3 pt-4"
                    style={{ borderTop: '1px solid var(--border-hairline)' }}
                  >
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          { id: 'cli-bridge', label: 'Lokale Agent-Bridge' },
                          { id: 'openai-compatible', label: 'OpenRouter / OpenAI' },
                          { id: 'anthropic', label: 'Anthropic Claude' },
                        ] as const
                      ).map((opt) => {
                        const active = state.provider.activeTextProvider === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => onUpdateProvider({ activeTextProvider: opt.id })}
                            className="rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors"
                            style={{
                              backgroundColor: active
                                ? 'var(--accent-soft)'
                                : 'var(--bg-raised)',
                              border: `1px solid ${
                                active ? 'var(--accent-border)' : 'var(--border-hairline)'
                              }`,
                              color: active ? 'var(--accent)' : 'var(--text-secondary)',
                              cursor: 'pointer',
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>

                    {state.provider.activeTextProvider === 'cli-bridge' && (
                      <div className="space-y-3 rounded-lg p-3 surface-raised">
                        <div className="flex flex-wrap items-center gap-2">
                          {(
                            [
                              { id: 'antigravity', label: 'Antigravity (agy)' },
                              { id: 'claude', label: 'Claude Code (claude)' },
                              { id: 'codex', label: 'Codex CLI (codex)' },
                            ] as const
                          ).map((tool) => {
                            const active = state.provider.bridgeTool === tool.id;
                            return (
                              <button
                                key={tool.id}
                                type="button"
                                onClick={() => onUpdateProvider({ bridgeTool: tool.id })}
                                className="rounded-md px-2.5 py-1 text-[12.5px] font-medium"
                                style={{
                                  backgroundColor: active
                                    ? 'var(--bg-card)'
                                    : 'transparent',
                                  border: `1px solid ${
                                    active ? 'var(--accent-border)' : 'var(--border-hairline)'
                                  }`,
                                  color: active ? 'var(--accent)' : 'var(--text-secondary)',
                                  cursor: 'pointer',
                                }}
                              >
                                {tool.label}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                          <span style={{ color: 'var(--text-secondary)' }}>
                            Starte im Terminal{' '}
                            <code className="font-mono-num px-1.5 py-0.5 rounded bg-[var(--bg-card)]">
                              npm run bridge
                            </code>{' '}
                            auf deinem Computer.
                          </span>
                          <button
                            type="button"
                            onClick={handleCheckBridge}
                            disabled={checkingBridge}
                            className="btn-secondary h-8 px-2.5 text-[12.5px]"
                          >
                            <RefreshCw
                              size={13}
                              strokeWidth={1.5}
                              className={checkingBridge ? 'animate-spin' : ''}
                            />
                            <span>Bridge prüfen</span>
                          </button>
                        </div>
                        {bridgeStatus && (
                          <div
                            className="flex items-center gap-2 text-[12.5px]"
                            style={{
                              color: bridgeStatus.online
                                ? 'var(--positive)'
                                : 'var(--warning)',
                            }}
                          >
                            {bridgeStatus.online ? (
                              <CheckCircle2 size={14} strokeWidth={1.5} />
                            ) : (
                              <AlertCircle size={14} strokeWidth={1.5} />
                            )}
                            <span>
                              {bridgeStatus.online
                                ? `Bridge erreichbar${
                                    bridgeStatus.tools.length
                                      ? ` (${bridgeStatus.tools.join(', ')})`
                                      : ''
                                  }.`
                                : 'Bridge aktuell nicht aktiv. Du kannst sie jederzeit später starten.'}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {state.provider.activeTextProvider === 'openai-compatible' && (
                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        <input
                          type="text"
                          value={state.provider.customEndpoint}
                          onChange={(e) =>
                            onUpdateProvider({ customEndpoint: e.target.value })
                          }
                          placeholder="https://openrouter.ai/api/v1/chat/completions"
                          aria-label="OpenAI-kompatibler Endpunkt"
                          className="font-mono-num h-9 rounded-lg px-3 text-[12.5px]"
                          style={{
                            backgroundColor: 'var(--bg-page)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        />
                        <input
                          type="text"
                          value={state.provider.customModel}
                          onChange={(e) =>
                            onUpdateProvider({ customModel: e.target.value })
                          }
                          placeholder="google/gemma-3-27b-it:free"
                          aria-label="Modellname"
                          className="font-mono-num h-9 rounded-lg px-3 text-[12.5px]"
                          style={{
                            backgroundColor: 'var(--bg-page)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        />
                        <input
                          type="password"
                          value={state.provider.customApiKey}
                          onChange={(e) =>
                            onUpdateProvider({ customApiKey: e.target.value })
                          }
                          placeholder="API-Key (bleibt lokal gespeichert)"
                          aria-label="OpenAI-kompatibler API-Key"
                          className="font-mono-num h-9 rounded-lg px-3 text-[12.5px] sm:col-span-2"
                          style={{
                            backgroundColor: 'var(--bg-page)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        />
                      </div>
                    )}

                    {state.provider.activeTextProvider === 'anthropic' && (
                      <div className="space-y-2.5">
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                          <input
                            type="password"
                            value={state.provider.anthropicApiKey}
                            onChange={(e) =>
                              onUpdateProvider({ anthropicApiKey: e.target.value })
                            }
                            placeholder="Anthropic API-Key"
                            aria-label="Anthropic API-Key"
                            className="font-mono-num h-9 rounded-lg px-3 text-[12.5px]"
                            style={{
                              backgroundColor: 'var(--bg-page)',
                              border: '1px solid var(--border-strong)',
                              color: 'var(--text-primary)',
                            }}
                          />
                          <input
                            type="text"
                            value={state.provider.anthropicModel}
                            onChange={(e) =>
                              onUpdateProvider({ anthropicModel: e.target.value })
                            }
                            placeholder="claude-sonnet-4-5"
                            aria-label="Anthropic Modell"
                            className="font-mono-num h-9 rounded-lg px-3 text-[12.5px]"
                            style={{
                              backgroundColor: 'var(--bg-page)',
                              border: '1px solid var(--border-strong)',
                              color: 'var(--text-primary)',
                            }}
                          />
                        </div>
                        <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                          Hinweis: Da Anthropic direkt kostenpflichtig ist, kannst du den
                          Free-Only-Schutz in den Einstellungen bewusst deaktivieren.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div>
                <h3
                  className="text-[20px] font-semibold tracking-[-0.015em]"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Dein Wissensspeicher
                </h3>
                <p className="mt-1 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
                  Entscheide, wie du deine Lernnotizen führen möchtest. Du kannst beides auch
                  jederzeit kombinieren.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setStorageChoice('builtin')}
                  className="rounded-[12px] p-4 text-left transition-colors"
                  style={{
                    backgroundColor:
                      storageChoice === 'builtin' ? 'var(--accent-soft)' : 'var(--bg-raised)',
                    border: `1px solid ${
                      storageChoice === 'builtin'
                        ? 'var(--accent-border)'
                        : 'var(--border-hairline)'
                    }`,
                    cursor: 'pointer',
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className="flex h-9 w-9 items-center justify-center rounded-lg"
                      style={{
                        backgroundColor: 'var(--bg-card)',
                        border: '1px solid var(--border-hairline)',
                        color: 'var(--accent)',
                      }}
                    >
                      <FileText size={17} strokeWidth={1.5} />
                    </span>
                    <span
                      className="rounded-md px-2 py-0.5 text-[12px] font-medium"
                      style={{
                        backgroundColor: 'var(--positive-soft)',
                        color: 'var(--positive)',
                      }}
                    >
                      Sofort bereit
                    </span>
                  </div>
                  <h4
                    className="mt-3 text-[15px] font-semibold"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    Integrierte Notizen im Notion-Stil
                  </h4>
                  <p
                    className="mt-1 text-[13.5px] leading-relaxed"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Schreibe direkt in OpenStudy mit Überschriften, Merksätzen, Checklisten und
                    Code-Blöcken. Keine zusätzliche App erforderlich.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setStorageChoice('obsidian')}
                  className="rounded-[12px] p-4 text-left transition-colors"
                  style={{
                    backgroundColor:
                      storageChoice === 'obsidian' ? 'var(--accent-soft)' : 'var(--bg-raised)',
                    border: `1px solid ${
                      storageChoice === 'obsidian'
                        ? 'var(--accent-border)'
                        : 'var(--border-hairline)'
                    }`,
                    cursor: 'pointer',
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className="flex h-9 w-9 items-center justify-center rounded-lg"
                      style={{
                        backgroundColor: 'var(--bg-card)',
                        border: '1px solid var(--border-hairline)',
                        color: 'var(--accent)',
                      }}
                    >
                      <FolderOpen size={17} strokeWidth={1.5} />
                    </span>
                    <span
                      className="rounded-md px-2 py-0.5 text-[12px] font-medium"
                      style={{
                        backgroundColor: 'var(--bg-card)',
                        border: '1px solid var(--border-hairline)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      Lokaler Ordner
                    </span>
                  </div>
                  <h4
                    className="mt-3 text-[15px] font-semibold"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    Lokalen Obsidian-Ordner verknüpfen
                  </h4>
                  <p
                    className="mt-1 text-[13.5px] leading-relaxed"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Binde deinen bestehenden Obsidian-Vault direkt als Lernkontext ein, inklusive
                    Markdown-Notizen und [[Wikilinks]].
                  </p>
                </button>
              </div>

              {storageChoice === 'obsidian' && (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] px-4 py-3"
                  style={{
                    backgroundColor: 'var(--bg-raised)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  <span className="text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>
                    Im nächsten Schritt öffnet sich direkt der lokale Obsidian- &amp; Datei-Import.
                  </span>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleFinish(true)}
                  >
                    <FolderOpen size={15} strokeWidth={1.5} />
                    <span>Obsidian-Ordner jetzt auswählen</span>
                  </button>
                </div>
              )}

              {/* Privacy Promise Card */}
              <div
                className="rounded-[12px] p-4"
                style={{
                  backgroundColor: 'var(--bg-raised)',
                  border: '1px solid var(--border-hairline)',
                  borderLeft: '3px solid var(--accent)',
                }}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      backgroundColor: 'var(--accent-soft)',
                      color: 'var(--accent)',
                    }}
                  >
                    <ShieldCheck size={17} strokeWidth={1.5} />
                  </span>
                  <div>
                    <h4
                      className="text-[14.5px] font-semibold"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Privatsphäre-Versprechen
                    </h4>
                    <p
                      className="mt-1 text-[13.5px] leading-relaxed"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      Deine Daten, Lernnotizen und API-Keys verlassen deinen PC nicht und landen
                      niemals in öffentlichen Repositories oder fremden Servern. Du kannst deine
                      Daten jederzeit lokal sichern oder vollständig zurücksetzen.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Sticky Footer */}
        <div
          className="flex items-center justify-between gap-3 px-6 py-4"
          style={{
            borderTop: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--bg-raised)',
          }}
        >
          <div>
            {step > 1 ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setStep((prev) => (prev === 3 ? 2 : 1))}
              >
                <ArrowLeft size={15} strokeWidth={1.5} />
                <span>Zurück</span>
              </button>
            ) : (
              <span className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                0 CHF · Kein Konto nötig
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            {step < 3 ? (
              <button
                type="button"
                className="btn-accent"
                onClick={() => setStep((prev) => (prev === 1 ? 2 : 3))}
              >
                <span>Weiter</span>
                <ArrowRight size={15} strokeWidth={1.5} />
              </button>
            ) : (
              <button
                type="button"
                className="btn-accent"
                onClick={() => handleFinish(storageChoice === 'obsidian')}
              >
                <span>
                  {storageChoice === 'obsidian'
                    ? 'Weiter zum Obsidian-Import'
                    : 'Lernstudio starten'}
                </span>
                <ArrowRight size={15} strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnboardingWizard;
