import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  X,
} from 'lucide-react';
import { COLOR_SCHEMES } from '../data/colorSchemes';
import {
  checkHermesGateway,
  checkLocalBridge,
  FREE_GEMINI_TEXT_MODELS,
  FREE_LIVE_MODELS,
  testGeminiApiKey,
} from '../services/providers';
import {
  ColorSchemeId,
  OpenStudyState,
  ProviderConfig,
  ProviderKind,
} from '../types';

export type SettingsTab = 'appearance' | 'ai' | 'data';

export interface SettingsModalProps {
  open: boolean;
  initialTab?: SettingsTab;
  onClose: () => void;
  state: OpenStudyState;
  onUpdateProvider: (patch: Partial<ProviderConfig>) => void;
  onSetColorScheme: (scheme: ColorSchemeId) => void;
  onSetDailyGoalMinutes: (minutes: number) => void;
  onResetToDemo: () => void;
  onReopenOnboarding: () => void;
  canInstallPwa: boolean;
  isPwaInstalled: boolean;
  onInstallPwa: () => Promise<boolean>;
}

const DAILY_GOALS = [15, 30, 45, 60, 90] as const;

const ADVANCED_PROVIDERS: Array<{ id: ProviderKind; label: string }> = [
  { id: 'gemini-free', label: 'Google Gemini' },
  { id: 'hermes-gateway', label: 'Hermes Agent Gateway (Nous Research)' },
  { id: 'ollama', label: 'Ollama lokal' },
  { id: 'cli-bridge', label: 'CLI-Bridge' },
  { id: 'openai-compatible', label: 'OpenAI / OpenRouter' },
  { id: 'anthropic', label: 'Anthropic Claude' },
];

const BRIDGE_TOOLS: Array<{
  id: ProviderConfig['bridgeTool'];
  label: string;
  cli: string;
}> = [
  { id: 'antigravity', label: 'Antigravity', cli: 'agy' },
  { id: 'claude', label: 'Claude Code', cli: 'claude' },
  { id: 'codex', label: 'Codex CLI', cli: 'codex' },
];

const FIELD_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--bg-page)',
  border: '1px solid var(--border-strong)',
  color: 'var(--text-primary)',
};

function isLocalhostUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

interface SecretInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel?: string;
  onEnter?: () => void;
}

const SecretInput: React.FC<SecretInputProps> = ({
  id,
  value,
  onChange,
  placeholder,
  ariaLabel,
  onEnter,
}) => {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative flex-1">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) onEnter();
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        className="font-mono-num h-9 w-full rounded-[10px] pl-3 pr-9 text-[13px]"
        style={FIELD_STYLE}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Key verbergen' : 'Key anzeigen'}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1"
        style={{ color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        {visible ? <EyeOff size={15} strokeWidth={1.5} /> : <Eye size={15} strokeWidth={1.5} />}
      </button>
    </div>
  );
};

interface StatusLineProps {
  tone: 'positive' | 'negative' | 'warning';
  message: string;
}

const StatusLine: React.FC<StatusLineProps> = ({ tone, message }) => (
  <p
    role="status"
    className="flex items-start gap-1.5 text-[12.5px] leading-snug"
    style={{
      color:
        tone === 'positive'
          ? 'var(--positive)'
          : tone === 'warning'
            ? 'var(--warning)'
            : 'var(--negative)',
    }}
  >
    {tone === 'positive' ? (
      <Check size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" />
    ) : (
      <AlertCircle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" />
    )}
    <span>{message}</span>
  </p>
);

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  initialTab,
  onClose,
  state,
  onUpdateProvider,
  onSetColorScheme,
  onSetDailyGoalMinutes,
  onResetToDemo,
  onReopenOnboarding,
  canInstallPwa,
  isPwaInstalled,
  onInstallPwa,
}) => {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'appearance');
  const [advancedOpen, setAdvancedOpen] = useState(
    state.provider.activeTextProvider !== 'gemini-free'
  );

  const [testingGemini, setTestingGemini] = useState(false);
  const [geminiResult, setGeminiResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [checkingHermes, setCheckingHermes] = useState(false);
  const [hermesResult, setHermesResult] = useState<{
    online: boolean;
    mode: 'gateway' | 'cli' | 'builtin';
    message: string;
    skillsCount: number;
  } | null>(null);

  const [checkingBridge, setCheckingBridge] = useState(false);
  const [bridgeResult, setBridgeResult] = useState<{ online: boolean; tools: string[] } | null>(null);
  const [copiedBridgeCmd, setCopiedBridgeCmd] = useState(false);

  const [checkingOllama, setCheckingOllama] = useState(false);
  const [ollamaResult, setOllamaResult] = useState<{
    ok: boolean;
    message: string;
    models: string[];
  } | null>(null);

  const [installingPwa, setInstallingPwa] = useState(false);
  const [pwaFeedback, setPwaFeedback] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!open) {
      setConfirmReset(false);
      return;
    }
    if (initialTab) {
      setTab(initialTab);
    }
    if (state.provider.activeTextProvider !== 'gemini-free') {
      setAdvancedOpen(true);
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, initialTab, onClose, state.provider.activeTextProvider]);

  const storageSizeKb = useMemo(() => {
    try {
      return Math.max(1, Math.round(new Blob([JSON.stringify(state)]).size / 1024));
    } catch {
      return 1;
    }
  }, [state]);

  if (!open) return null;

  const { provider } = state;

  const openaiBlockedByFreeLock =
    provider.freeOnlyLock &&
    !isLocalhostUrl(provider.customEndpoint) &&
    !provider.customModel.trim().toLowerCase().endsWith(':free');

  const handleTestGemini = async () => {
    if (!provider.geminiApiKey.trim() || testingGemini) return;
    setTestingGemini(true);
    setGeminiResult(null);
    try {
      setGeminiResult(await testGeminiApiKey(provider.geminiApiKey));
    } finally {
      setTestingGemini(false);
    }
  };

  const handleCheckBridge = async () => {
    setCheckingBridge(true);
    try {
      setBridgeResult(await checkLocalBridge(provider.bridgeUrl));
    } finally {
      setCheckingBridge(false);
    }
  };

  const handleCheckHermes = async () => {
    setCheckingHermes(true);
    try {
      setHermesResult(
        await checkHermesGateway(provider.bridgeUrl, provider.hermesGatewayUrl)
      );
    } finally {
      setCheckingHermes(false);
    }
  };

  const handleCopyBridgeCommand = async () => {
    try {
      await navigator.clipboard.writeText('npm run bridge');
      setCopiedBridgeCmd(true);
      window.setTimeout(() => setCopiedBridgeCmd(false), 2000);
    } catch {
      setCopiedBridgeCmd(false);
    }
  };

  const handleCheckOllama = async () => {
    setCheckingOllama(true);
    setOllamaResult(null);
    const baseUrl = (provider.ollamaUrl.trim() || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { method: 'GET', signal: controller.signal });
      if (!res.ok) {
        setOllamaResult({ ok: false, message: `Ollama antwortete mit Status ${res.status}.`, models: [] });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { models?: Array<{ name?: string }> };
      const models = (data.models ?? [])
        .map((m) => m.name)
        .filter((name): name is string => typeof name === 'string');
      setOllamaResult({
        ok: true,
        message:
          models.length > 0
            ? `Erreichbar (${models.length} lokale Modelle gefunden).`
            : 'Erreichbar. Es ist noch kein lokales Modell geladen.',
        models,
      });
    } catch {
      setOllamaResult({ ok: false, message: `Unter ${baseUrl} nicht erreichbar.`, models: [] });
    } finally {
      window.clearTimeout(timer);
      setCheckingOllama(false);
    }
  };

  const handleInstallPwa = async () => {
    if (installingPwa) return;
    setInstallingPwa(true);
    setPwaFeedback(null);
    try {
      const accepted = await onInstallPwa();
      setPwaFeedback(
        accepted
          ? 'Installation gestartet.'
          : 'Installation abgebrochen — du kannst sie jederzeit erneut starten.'
      );
    } finally {
      setInstallingPwa(false);
    }
  };

  const handleExportJson = () => {
    const sanitizedBackup = {
      exportedAt: new Date().toISOString(),
      app: 'OpenStudy',
      keysStripped: true,
      data: {
        ...state,
        provider: {
          ...state.provider,
          geminiApiKey: '',
          customApiKey: '',
          anthropicApiKey: '',
          notionToken: '',
          hermesApiKey: '',
        },
      },
    };

    const blob = new Blob([JSON.stringify(sanitizedBackup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `openstudy-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    setExportMessage('Backup gespeichert. Alle API-Keys wurden vor dem Download automatisch entfernt.');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      style={{ backgroundColor: 'rgba(18, 22, 20, 0.48)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
    >
      <div
        className="surface-card animate-enter flex w-full max-w-[680px] flex-col overflow-hidden"
        style={{
          maxHeight: 'min(88vh, 800px)',
          borderColor: 'var(--border-strong)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-7 pb-3 pt-6">
          <h2
            id="settings-modal-title"
            className="font-display text-[26px] font-normal leading-tight"
            style={{ color: 'var(--text-primary)' }}
          >
            Einstellungen
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Einstellungen schliessen"
            className="btn-ghost -mr-2 -mt-1 h-8 w-8 p-0"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* Hairline underline tabs */}
        <div
          className="flex items-center gap-6 px-7"
          style={{ borderBottom: '1px solid var(--border-hairline)' }}
          role="tablist"
        >
          {(
            [
              { id: 'appearance', label: 'Erscheinungsbild' },
              { id: 'ai', label: 'KI & Sprache' },
              { id: 'data', label: 'Daten & App' },
            ] as const
          ).map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={`-mb-px pb-3 pt-1 text-[13.5px] font-medium transition-colors ${
                  active
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
                style={{
                  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                  background: 'transparent',
                  borderTop: 'none',
                  borderLeft: 'none',
                  borderRight: 'none',
                  cursor: 'pointer',
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-7 py-6">
          {tab === 'appearance' && (
            <div className="space-y-7">
              <section>
                <h3 className="text-[14.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  Farbschema
                </h3>
                <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  Wähle die Papier- oder Nachtpalette für dein Lernstudio.
                </p>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {COLOR_SCHEMES.map((scheme) => {
                    const active = state.colorScheme === scheme.id;
                    const [canvas, primary, warmAccent] = scheme.swatches;
                    return (
                      <button
                        key={scheme.id}
                        type="button"
                        onClick={() => onSetColorScheme(scheme.id)}
                        aria-pressed={active}
                        className={`rounded-[12px] p-3.5 text-left transition-colors ${
                          active ? '' : 'bg-transparent hover:bg-[var(--bg-raised)]'
                        }`}
                        style={{
                          ...(active ? { backgroundColor: 'var(--accent-soft)' } : {}),
                          border: active
                            ? '1.5px solid var(--accent)'
                            : '1px solid var(--border-hairline)',
                          cursor: 'pointer',
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span
                            className="flex h-4 w-16 overflow-hidden rounded-full"
                            style={{ border: '1px solid var(--border-strong)' }}
                            aria-hidden="true"
                          >
                            <span className="h-full w-1/2" style={{ backgroundColor: canvas }} />
                            <span className="h-full w-[30%]" style={{ backgroundColor: primary }} />
                            <span className="h-full w-[20%]" style={{ backgroundColor: warmAccent }} />
                          </span>
                          {active && <Check size={15} strokeWidth={1.75} style={{ color: 'var(--accent)' }} />}
                        </div>

                        <div
                          className="mt-2.5 text-[14px] font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {scheme.name}
                        </div>
                        <p
                          className="mt-0.5 text-[12.5px] leading-snug"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {scheme.tagline}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="pt-6" style={{ borderTop: '1px solid var(--border-hairline)' }}>
                <h3 className="text-[14.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  Tägliches Fokus-Ziel
                </h3>
                <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  Dein ruhiges Richtmass für konzentrierte Lernzeit pro Tag.
                </p>

                <div className="mt-4 flex flex-wrap gap-2">
                  {DAILY_GOALS.map((minutes) => {
                    const active = state.dailyGoalMinutes === minutes;
                    return (
                      <button
                        key={minutes}
                        type="button"
                        onClick={() => onSetDailyGoalMinutes(minutes)}
                        aria-pressed={active}
                        className="font-mono-num h-9 rounded-full px-4 text-[13px] font-medium transition-colors"
                        style={{
                          backgroundColor: active ? 'var(--accent)' : 'transparent',
                          color: active ? 'var(--accent-ink)' : 'var(--text-primary)',
                          border: active
                            ? '1px solid var(--accent)'
                            : '1px solid var(--border-strong)',
                          cursor: 'pointer',
                        }}
                      >
                        {minutes} Min
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          )}

          {tab === 'ai' && (
            <div className="space-y-6">
              <section className="space-y-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h3 className="text-[14.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      Standard: Google Gemini (Kostenlos)
                    </h3>
                    <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      Aktiviert den Live-Sprachtutor und KI-Erklärungen direkt im Browser.
                    </p>
                  </div>
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[13px] underline underline-offset-4 transition-opacity hover:opacity-80"
                    style={{ color: 'var(--accent)' }}
                  >
                    <span>Google AI Studio</span>
                    <ExternalLink size={12} strokeWidth={1.5} />
                  </a>
                </div>

                <div>
                  <label
                    htmlFor="settings-gemini-key"
                    className="mb-1.5 block text-[12.5px] font-medium"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Google AI Studio API-Key
                  </label>
                  <div className="flex items-center gap-2">
                    <SecretInput
                      id="settings-gemini-key"
                      value={provider.geminiApiKey}
                      onChange={(value) => {
                        setGeminiResult(null);
                        onUpdateProvider({ geminiApiKey: value });
                      }}
                      onEnter={() => void handleTestGemini()}
                      placeholder="API-Key einfügen"
                    />
                    <button
                      type="button"
                      onClick={() => void handleTestGemini()}
                      disabled={testingGemini || !provider.geminiApiKey.trim()}
                      className="btn-accent shrink-0"
                      style={{ opacity: testingGemini || !provider.geminiApiKey.trim() ? 0.5 : 1 }}
                    >
                      {testingGemini && <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />}
                      <span>Prüfen</span>
                    </button>
                  </div>

                  {geminiResult && (
                    <div className="mt-2">
                      <StatusLine
                        tone={geminiResult.ok ? 'positive' : 'negative'}
                        message={geminiResult.message}
                      />
                    </div>
                  )}
                </div>

                {/* Quiet hairline Free-Only toggle */}
                <div
                  className="flex items-center justify-between gap-4 py-3.5"
                  style={{
                    borderTop: '1px solid var(--border-hairline)',
                    borderBottom: '1px solid var(--border-hairline)',
                  }}
                >
                  <div>
                    <div className="text-[13.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      Nur kostenlose Modelle verwenden
                    </div>
                    <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                      Blockiert kostenpflichtige Cloud-APIs automatisch.
                    </p>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={provider.freeOnlyLock}
                    aria-label="Nur kostenlose Modelle verwenden"
                    onClick={() => onUpdateProvider({ freeOnlyLock: !provider.freeOnlyLock })}
                    className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
                    style={{
                      backgroundColor: provider.freeOnlyLock
                        ? 'var(--accent)'
                        : 'var(--border-strong)',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '2px',
                    }}
                  >
                    <span
                      className="block h-5 w-5 rounded-full transition-transform"
                      style={{
                        backgroundColor: 'var(--bg-card)',
                        transform: provider.freeOnlyLock ? 'translateX(20px)' : 'translateX(0px)',
                      }}
                    />
                  </button>
                </div>

                {/* Model dropdowns */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span
                      className="mb-1.5 block text-[12.5px] font-medium"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      Text-Modell
                    </span>
                    <select
                      value={
                        (FREE_GEMINI_TEXT_MODELS as readonly string[]).includes(provider.geminiTextModel)
                          ? provider.geminiTextModel
                          : FREE_GEMINI_TEXT_MODELS[0]
                      }
                      onChange={(e) => onUpdateProvider({ geminiTextModel: e.target.value })}
                      className="font-mono-num h-9 w-full rounded-[10px] px-2.5 text-[13px]"
                      style={FIELD_STYLE}
                    >
                      {FREE_GEMINI_TEXT_MODELS.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span
                      className="mb-1.5 block text-[12.5px] font-medium"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      Live-Sprachmodell
                    </span>
                    <select
                      value={
                        (FREE_LIVE_MODELS as readonly string[]).includes(provider.geminiLiveModel)
                          ? provider.geminiLiveModel
                          : FREE_LIVE_MODELS[0]
                      }
                      onChange={(e) => onUpdateProvider({ geminiLiveModel: e.target.value })}
                      className="font-mono-num h-9 w-full rounded-[10px] px-2.5 text-[13px]"
                      style={FIELD_STYLE}
                    >
                      {FREE_LIVE_MODELS.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>

              {/* Collapsed Advanced Section */}
              <details
                open={advancedOpen}
                className="pt-5"
                style={{ borderTop: '1px solid var(--border-hairline)' }}
              >
                <summary
                  onClick={(e) => {
                    e.preventDefault();
                    setAdvancedOpen((prev) => !prev);
                  }}
                  className="flex cursor-pointer list-none items-center gap-2 text-[13.5px] font-medium select-none [&::-webkit-details-marker]:hidden"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <ChevronRight
                    size={15}
                    strokeWidth={1.5}
                    className="shrink-0 transition-transform"
                    style={{
                      color: 'var(--text-muted)',
                      transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                    }}
                  />
                  <span>Für Fortgeschrittene — Lokale Modelle, Bridge &amp; eigene API-Keys</span>
                </summary>

                <div className="mt-5 space-y-5 pl-5">
                  <div>
                    <div
                      className="mb-2 text-[12.5px] font-medium"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      Aktiver Text-Anbieter
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {ADVANCED_PROVIDERS.map((opt) => {
                        const selected = provider.activeTextProvider === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => onUpdateProvider({ activeTextProvider: opt.id })}
                            aria-pressed={selected}
                            className="h-8 rounded-full px-3 text-[12.5px] font-medium transition-colors"
                            style={{
                              backgroundColor: selected ? 'var(--accent-soft)' : 'transparent',
                              border: selected
                                ? '1px solid var(--accent-border)'
                                : '1px solid var(--border-hairline)',
                              color: selected ? 'var(--accent)' : 'var(--text-secondary)',
                              cursor: 'pointer',
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {provider.activeTextProvider === 'gemini-free' && (
                    <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      Google Gemini ist aktiv und wird über die Felder oben verwaltet.
                    </p>
                  )}

                  {provider.activeTextProvider === 'hermes-gateway' && (
                    <div className="space-y-4">
                      <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        Verbindet OpenStudy mit deinem lokalen Nous Research Hermes Agent Gateway
                        (<code className="font-mono-num">127.0.0.1:9119</code>) oder der{' '}
                        <code className="font-mono-num">hermes</code>-CLI über die Companion-Bridge.
                      </p>

                      <label className="block">
                        <span
                          className="mb-1.5 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Hermes Gateway URL
                        </span>
                        <input
                          type="text"
                          value={provider.hermesGatewayUrl}
                          onChange={(e) => {
                            setHermesResult(null);
                            onUpdateProvider({ hermesGatewayUrl: e.target.value });
                          }}
                          placeholder="http://127.0.0.1:9119"
                          className="font-mono-num h-9 w-full rounded-[10px] px-3 text-[13px]"
                          style={FIELD_STYLE}
                        />
                      </label>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="block">
                          <span
                            className="mb-1.5 block text-[12.5px] font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            Modell
                          </span>
                          <input
                            type="text"
                            value={provider.hermesModel}
                            onChange={(e) => onUpdateProvider({ hermesModel: e.target.value })}
                            placeholder="hermes-default"
                            className="font-mono-num h-9 w-full rounded-[10px] px-3 text-[13px]"
                            style={FIELD_STYLE}
                          />
                        </label>

                        <label className="block">
                          <span
                            className="mb-1.5 block text-[12.5px] font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            API-Key (optional für localhost)
                          </span>
                          <SecretInput
                            value={provider.hermesApiKey}
                            onChange={(value) => onUpdateProvider({ hermesApiKey: value })}
                            onEnter={() => void handleCheckHermes()}
                            placeholder="Optionaler Schlüssel"
                          />
                        </label>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleCheckHermes()}
                          disabled={checkingHermes}
                          className="btn-secondary h-8 px-3 text-[12.5px]"
                        >
                          {checkingHermes && (
                            <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                          )}
                          <span>Hermes prüfen</span>
                        </button>
                      </div>

                      {hermesResult && (
                        <StatusLine
                          tone={hermesResult.online ? 'positive' : 'warning'}
                          message={
                            hermesResult.skillsCount > 0
                              ? `${hermesResult.message} (${hermesResult.skillsCount} Skills erkannt)`
                              : hermesResult.message
                          }
                        />
                      )}
                    </div>
                  )}

                  {provider.activeTextProvider === 'ollama' && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="block">
                          <span
                            className="mb-1.5 block text-[12.5px] font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            Ollama URL
                          </span>
                          <input
                            type="text"
                            value={provider.ollamaUrl}
                            onChange={(e) => onUpdateProvider({ ollamaUrl: e.target.value })}
                            placeholder="http://127.0.0.1:11434"
                            className="font-mono-num h-9 w-full rounded-[10px] px-3 text-[13px]"
                            style={FIELD_STYLE}
                          />
                        </label>

                        <label className="block">
                          <span
                            className="mb-1.5 block text-[12.5px] font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            Lokales Modell
                          </span>
                          <input
                            type="text"
                            value={provider.ollamaModel}
                            onChange={(e) => onUpdateProvider({ ollamaModel: e.target.value })}
                            placeholder="gemma3:4b"
                            className="font-mono-num h-9 w-full rounded-[10px] px-3 text-[13px]"
                            style={FIELD_STYLE}
                          />
                        </label>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                          <span style={{ color: 'var(--text-muted)' }}>Vorschläge:</span>
                          {['gemma3:4b', 'llama3.2:3b', 'qwen2.5:7b'].map((model) => (
                            <button
                              key={model}
                              type="button"
                              onClick={() => onUpdateProvider({ ollamaModel: model })}
                              className="font-mono-num rounded-full px-2.5 py-0.5 text-[12px]"
                              style={{
                                backgroundColor:
                                  provider.ollamaModel === model ? 'var(--accent-soft)' : 'transparent',
                                border:
                                  provider.ollamaModel === model
                                    ? '1px solid var(--accent-border)'
                                    : '1px solid var(--border-hairline)',
                                color:
                                  provider.ollamaModel === model
                                    ? 'var(--accent)'
                                    : 'var(--text-secondary)',
                                cursor: 'pointer',
                              }}
                            >
                              {model}
                            </button>
                          ))}
                        </div>

                        <button
                          type="button"
                          onClick={() => void handleCheckOllama()}
                          disabled={checkingOllama}
                          className="btn-secondary h-8 px-3 text-[12.5px]"
                        >
                          {checkingOllama && (
                            <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                          )}
                          <span>Verbindung prüfen</span>
                        </button>
                      </div>

                      {ollamaResult && (
                        <div className="space-y-2">
                          <StatusLine
                            tone={ollamaResult.ok ? 'positive' : 'negative'}
                            message={ollamaResult.message}
                          />
                          {ollamaResult.models.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {ollamaResult.models.slice(0, 8).map((name) => (
                                <button
                                  key={name}
                                  type="button"
                                  onClick={() => onUpdateProvider({ ollamaModel: name })}
                                  className="font-mono-num rounded-full px-2.5 py-0.5 text-[11.5px]"
                                  style={{
                                    backgroundColor: 'transparent',
                                    border: '1px solid var(--border-hairline)',
                                    color: 'var(--text-secondary)',
                                    cursor: 'pointer',
                                  }}
                                >
                                  {name}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {provider.activeTextProvider === 'cli-bridge' && (
                    <div className="space-y-4">
                      <div>
                        <div
                          className="mb-2 text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Lokales CLI-Werkzeug
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {BRIDGE_TOOLS.map((tool) => {
                            const selected = provider.bridgeTool === tool.id;
                            return (
                              <button
                                key={tool.id}
                                type="button"
                                onClick={() => onUpdateProvider({ bridgeTool: tool.id })}
                                aria-pressed={selected}
                                className="inline-flex h-8 items-center gap-2 rounded-full px-3 text-[12.5px] font-medium transition-colors"
                                style={{
                                  backgroundColor: selected ? 'var(--accent-soft)' : 'transparent',
                                  border: selected
                                    ? '1px solid var(--accent-border)'
                                    : '1px solid var(--border-hairline)',
                                  color: selected ? 'var(--accent)' : 'var(--text-primary)',
                                  cursor: 'pointer',
                                }}
                              >
                                <span>{tool.label}</span>
                                <code
                                  className="font-mono-num text-[11.5px]"
                                  style={{ color: 'var(--text-muted)' }}
                                >
                                  {tool.cli}
                                </code>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <label className="block">
                        <span
                          className="mb-1.5 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Bridge-Adresse (nur lokal auf 127.0.0.1)
                        </span>
                        <input
                          type="text"
                          value={provider.bridgeUrl}
                          onChange={(e) => onUpdateProvider({ bridgeUrl: e.target.value })}
                          placeholder="http://127.0.0.1:4319"
                          className="font-mono-num h-9 w-full rounded-[10px] px-3 text-[13px]"
                          style={FIELD_STYLE}
                        />
                      </label>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleCopyBridgeCommand()}
                          className="btn-secondary h-8 px-3 text-[12.5px]"
                        >
                          {copiedBridgeCmd ? (
                            <Check size={13} strokeWidth={1.75} />
                          ) : (
                            <Copy size={13} strokeWidth={1.5} />
                          )}
                          <span className="font-mono-num">npm run bridge</span>
                          <span>{copiedBridgeCmd ? 'kopiert' : 'kopieren'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleCheckBridge()}
                          disabled={checkingBridge}
                          className="btn-secondary h-8 px-3 text-[12.5px]"
                        >
                          {checkingBridge && (
                            <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                          )}
                          <span>Bridge prüfen</span>
                        </button>
                      </div>

                      {bridgeResult && (
                        <StatusLine
                          tone={bridgeResult.online ? 'positive' : 'warning'}
                          message={
                            bridgeResult.online
                              ? bridgeResult.tools.length > 0
                                ? `Bridge online (${bridgeResult.tools.join(', ')}).`
                                : 'Bridge online.'
                              : 'Bridge antwortet nicht. Starte den Befehl oben im Projektordner.'
                          }
                        />
                      )}
                    </div>
                  )}

                  {provider.activeTextProvider === 'openai-compatible' && (
                    <div className="space-y-4">
                      {openaiBlockedByFreeLock && (
                        <p
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]"
                          style={{ color: 'var(--warning)' }}
                        >
                          <span>
                            Im Kostenlos-Modus sind nur localhost oder Modelle mit{' '}
                            <code className="font-mono-num">:free</code> erlaubt.
                          </span>
                          <button
                            type="button"
                            onClick={() => onUpdateProvider({ freeOnlyLock: false })}
                            className="underline underline-offset-4"
                            style={{
                              color: 'var(--text-primary)',
                              background: 'transparent',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                            }}
                          >
                            Sperre aufheben
                          </button>
                        </p>
                      )}

                      <label className="block">
                        <span
                          className="mb-1.5 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Chat-Completions Endpunkt URL
                        </span>
                        <input
                          type="text"
                          value={provider.customEndpoint}
                          onChange={(e) => onUpdateProvider({ customEndpoint: e.target.value })}
                          placeholder="https://openrouter.ai/api/v1/chat/completions"
                          className="font-mono-num h-9 w-full rounded-[10px] px-3 text-[13px]"
                          style={FIELD_STYLE}
                        />
                      </label>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="block">
                          <span
                            className="mb-1.5 block text-[12.5px] font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            Modell-ID
                          </span>
                          <input
                            type="text"
                            value={provider.customModel}
                            onChange={(e) => onUpdateProvider({ customModel: e.target.value })}
                            placeholder="google/gemma-3-27b-it:free"
                            className="font-mono-num h-9 w-full rounded-[10px] px-3 text-[13px]"
                            style={FIELD_STYLE}
                          />
                        </label>

                        <label className="block">
                          <span
                            className="mb-1.5 block text-[12.5px] font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            API-Key (optional für localhost)
                          </span>
                          <SecretInput
                            value={provider.customApiKey}
                            onChange={(value) => onUpdateProvider({ customApiKey: value })}
                            placeholder="API-Key einfügen"
                          />
                        </label>
                      </div>
                    </div>
                  )}

                  {provider.activeTextProvider === 'anthropic' && (
                    <div className="space-y-4">
                      {provider.freeOnlyLock && (
                        <p
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]"
                          style={{ color: 'var(--warning)' }}
                        >
                          <span>
                            Die direkte Anthropic-API ist kostenpflichtig und aktuell gesperrt.
                          </span>
                          <button
                            type="button"
                            onClick={() => onUpdateProvider({ freeOnlyLock: false })}
                            className="underline underline-offset-4"
                            style={{
                              color: 'var(--text-primary)',
                              background: 'transparent',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                            }}
                          >
                            Sperre aufheben
                          </button>
                        </p>
                      )}

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="block">
                          <span
                            className="mb-1.5 block text-[12.5px] font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            Anthropic API-Key
                          </span>
                          <SecretInput
                            value={provider.anthropicApiKey}
                            onChange={(value) => onUpdateProvider({ anthropicApiKey: value })}
                            placeholder="API-Key einfügen"
                          />
                        </label>

                        <label className="block">
                          <span
                            className="mb-1.5 block text-[12.5px] font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            Claude Modell
                          </span>
                          <input
                            type="text"
                            value={provider.anthropicModel}
                            onChange={(e) => onUpdateProvider({ anthropicModel: e.target.value })}
                            placeholder="claude-sonnet-4-5"
                            className="font-mono-num h-9 w-full rounded-[10px] px-3 text-[13px]"
                            style={FIELD_STYLE}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              </details>
            </div>
          )}

          {tab === 'data' && (
            <div className="space-y-6">
              <section>
                <h3 className="text-[14.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  Als Desktop-App nutzen (ohne Download-Warnung)
                </h3>

                {isPwaInstalled ? (
                  <div className="mt-2">
                    <StatusLine tone="positive" message="OpenStudy läuft bereits als installierte App." />
                  </div>
                ) : canInstallPwa ? (
                  <div className="mt-2.5 space-y-2.5">
                    <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                      Öffnet OpenStudy in einem eigenen ruhigen Fenster direkt aus dem Startmenü oder
                      Dock.
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleInstallPwa()}
                      disabled={installingPwa}
                      className="btn-accent"
                      style={{ opacity: installingPwa ? 0.6 : 1 }}
                    >
                      {installingPwa && (
                        <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                      )}
                      <span>Als Desktop-App installieren</span>
                    </button>
                    {pwaFeedback && (
                      <p role="status" className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                        {pwaFeedback}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    Klicke in Chrome oder Edge rechts oben in der Adressleiste auf das
                    Install-Symbol — oder im Browser-Menü (⋮) auf «Streamen, speichern und teilen →
                    Seite als App installieren». In Safari: Teilen → Zum Dock oder Home-Bildschirm
                    hinzufügen.
                  </p>
                )}
              </section>

              <section className="space-y-4 pt-6" style={{ borderTop: '1px solid var(--border-hairline)' }}>
                <div>
                  <h3 className="text-[14.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    Lokaler Speicher &amp; Sicherung
                  </h3>
                  <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    Alle Fächer, Notizen, Karteikarten und Schlüssel bleiben ausschliesslich in diesem
                    Browser gespeichert.
                  </p>
                  <p className="font-mono-num mt-2 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                    {storageSizeKb} KB belegt · {state.courses.length} Fächer · {state.notes.length}{' '}
                    Notizen · {state.cards.length} Karten
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button type="button" onClick={handleExportJson} className="btn-secondary">
                    <Download size={14} strokeWidth={1.5} />
                    <span>Backup exportieren (JSON)</span>
                  </button>
                  <span className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                    API-Keys werden automatisch entfernt.
                  </span>
                </div>

                {exportMessage && <StatusLine tone="positive" message={exportMessage} />}
              </section>

              <section
                className="flex flex-wrap items-center justify-between gap-3 pt-6"
                style={{ borderTop: '1px solid var(--border-hairline)' }}
              >
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onReopenOnboarding();
                  }}
                  className="text-[13px] transition-colors hover:underline"
                  style={{
                    color: 'var(--text-secondary)',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    textUnderlineOffset: '4px',
                  }}
                >
                  Sprachtutor-Anleitung öffnen
                </button>

                {!confirmReset ? (
                  <button
                    type="button"
                    onClick={() => setConfirmReset(true)}
                    className="text-[13px] transition-opacity hover:opacity-80"
                    style={{
                      color: 'var(--negative)',
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                  >
                    Auf Demo-Daten zurücksetzen
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmReset(false)}
                      className="btn-ghost h-8 px-2.5 text-[12.5px]"
                    >
                      Abbrechen
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onResetToDemo();
                        setConfirmReset(false);
                        setExportMessage(null);
                      }}
                      className="h-8 rounded-full px-3 text-[12.5px] font-medium transition-opacity hover:opacity-90"
                      style={{
                        backgroundColor: 'var(--negative-soft)',
                        border: '1px solid var(--negative)',
                        color: 'var(--negative)',
                        cursor: 'pointer',
                      }}
                    >
                      Zurücksetzen bestätigen
                    </button>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-4 px-7 py-4"
          style={{ borderTop: '1px solid var(--border-hairline)' }}
        >
          <span className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Änderungen werden automatisch lokal gespeichert.
          </span>
          <button type="button" onClick={onClose} className="btn-primary">
            Fertig
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
