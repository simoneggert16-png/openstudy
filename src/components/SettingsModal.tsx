import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Unlock,
  Wand2,
  X,
} from 'lucide-react';
import {
  checkLocalBridge,
  FREE_GEMINI_TEXT_MODELS,
  FREE_LIVE_MODELS,
  testGeminiApiKey,
} from '../services/providers';
import { OpenStudyState, ProviderConfig, ProviderKind } from '../types';

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  state: OpenStudyState;
  onUpdateProvider: (patch: Partial<ProviderConfig>) => void;
  onResetToDemo: () => void;
  onReopenOnboarding: () => void;
}

type SettingsTab = 'providers' | 'privacy';

const PROVIDER_OPTIONS: Array<{
  id: ProviderKind;
  title: string;
  subtitle: string;
  costTag: string;
}> = [
  {
    id: 'gemini-free',
    title: 'Google Gemini Free Tier',
    subtitle: 'Echtzeit-Voice-Tutor & Text-KI über Google AI Studio',
    costTag: '0 CHF Free Tier',
  },
  {
    id: 'ollama',
    title: 'Ollama (Lokal & Gratis)',
    subtitle: '100 % offline auf deinem eigenen Rechner',
    costTag: '0 CHF Offline',
  },
  {
    id: 'cli-bridge',
    title: 'Lokale Agent-Bridge (Antigravity / Claude Code / Codex)',
    subtitle: 'Nutzt deine lokal installierten CLI-Agents über 127.0.0.1',
    costTag: 'Eigene CLI',
  },
  {
    id: 'openai-compatible',
    title: 'OpenAI-kompatibel / OpenRouter',
    subtitle: 'Beliebige OpenAI-kompatible Endpunkte & :free-Modelle',
    costTag: 'BYOK / :free',
  },
  {
    id: 'anthropic',
    title: 'Anthropic Claude',
    subtitle: 'Direkte Verbindung mit eigenem Anthropic API-Key',
    costTag: 'BYOK (Kostenpflichtig)',
  },
];

const BRIDGE_TOOLS: Array<{
  id: ProviderConfig['bridgeTool'];
  label: string;
  cliCommand: string;
  note: string;
}> = [
  {
    id: 'antigravity',
    label: 'Antigravity',
    cliCommand: 'agy',
    note: 'Verbindet lokal angemeldetes Antigravity CLI',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    cliCommand: 'claude',
    note: 'Verbindet lokal angemeldetes Claude Code CLI',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    cliCommand: 'codex',
    note: 'Verbindet lokal angemeldetes ChatGPT Codex CLI',
  },
];

function isLocalhostUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
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

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  state,
  onUpdateProvider,
  onResetToDemo,
  onReopenOnboarding,
}) => {
  const [tab, setTab] = useState<SettingsTab>('providers');

  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showCustomKey, setShowCustomKey] = useState(false);
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);

  const [testingGemini, setTestingGemini] = useState(false);
  const [geminiResult, setGeminiResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );

  const [checkingBridge, setCheckingBridge] = useState(false);
  const [bridgeResult, setBridgeResult] = useState<{
    online: boolean;
    tools: string[];
  } | null>(null);

  const [checkingOllama, setCheckingOllama] = useState(false);
  const [ollamaResult, setOllamaResult] = useState<{
    ok: boolean;
    message: string;
    models: string[];
  } | null>(null);

  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const storageSizeKb = useMemo(() => {
    try {
      const bytes = new Blob([JSON.stringify(state)]).size;
      return Math.max(1, Math.round(bytes / 1024));
    } catch {
      return 1;
    }
  }, [state]);

  if (!open) return null;

  const { provider } = state;

  const handleTestGemini = async () => {
    setTestingGemini(true);
    setGeminiResult(null);
    try {
      const res = await testGeminiApiKey(provider.geminiApiKey);
      setGeminiResult(res);
    } finally {
      setTestingGemini(false);
    }
  };

  const handleCheckBridge = async () => {
    setCheckingBridge(true);
    try {
      const res = await checkLocalBridge(provider.bridgeUrl);
      setBridgeResult(res);
    } finally {
      setCheckingBridge(false);
    }
  };

  const handleCheckOllama = async () => {
    setCheckingOllama(true);
    setOllamaResult(null);
    const baseUrl = (provider.ollamaUrl.trim() || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!res.ok) {
        setOllamaResult({
          ok: false,
          message: `Ollama antwortete mit Status ${res.status}.`,
          models: [],
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        models?: Array<{ name?: string }>;
      };
      const models = (data.models ?? [])
        .map((m) => m.name)
        .filter((name): name is string => typeof name === 'string');
      setOllamaResult({
        ok: true,
        message:
          models.length > 0
            ? `Ollama erreichbar (${models.length} lokale Modelle gefunden).`
            : 'Ollama erreichbar. Lade bei Bedarf ein Modell, z. B. "ollama pull gemma3:4b".',
        models,
      });
    } catch {
      setOllamaResult({
        ok: false,
        message: `Unter ${baseUrl} nicht erreichbar. Starte lokal "ollama serve".`,
        models: [],
      });
    } finally {
      window.clearTimeout(timer);
      setCheckingOllama(false);
    }
  };

  const handleExportJson = () => {
    // Strip all sensitive API keys & tokens automatically before downloading
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
        },
      },
    };

    const blob = new Blob([JSON.stringify(sanitizedBackup, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const datePart = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `openstudy-backup-${datePart}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setExportMessage(
      'Backup gespeichert. Alle API-Keys und Tokens wurden vor dem Download automatisch entfernt.'
    );
  };

  const openaiBlockedByFreeLock =
    provider.freeOnlyLock &&
    !isLocalhostUrl(provider.customEndpoint) &&
    !provider.customModel.trim().toLowerCase().endsWith(':free');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      style={{
        backgroundColor: 'rgba(20, 18, 15, 0.56)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
    >
      <div
        className="surface-card animate-enter flex w-full max-w-[820px] flex-col overflow-hidden"
        style={{
          maxHeight: 'min(90vh, 860px)',
          borderColor: 'var(--border-strong)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        {/* Header */}
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
              <Settings2 size={16} strokeWidth={1.5} />
            </span>
            <div>
              <h2
                id="settings-modal-title"
                className="text-[15.5px] font-semibold leading-tight"
                style={{ color: 'var(--text-primary)' }}
              >
                Einstellungen
              </h2>
              <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                KI-Anbieter, 0-CHF-Schutz und lokale Datensicherung
              </p>
            </div>
          </div>

          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="Einstellungen schließen"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* Tabs */}
        <div
          className="flex items-center gap-2 px-6 py-2.5"
          style={{ borderBottom: '1px solid var(--border-hairline)' }}
          role="tablist"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'providers'}
            onClick={() => setTab('providers')}
            className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13.5px] font-medium transition-colors"
            style={{
              backgroundColor: tab === 'providers' ? 'var(--accent-soft)' : 'transparent',
              border: `1px solid ${
                tab === 'providers' ? 'var(--accent-border)' : 'transparent'
              }`,
              color: tab === 'providers' ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <SlidersHorizontal size={15} strokeWidth={1.5} />
            <span>KI-Anbieter (Multi-Provider)</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'privacy'}
            onClick={() => setTab('privacy')}
            className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13.5px] font-medium transition-colors"
            style={{
              backgroundColor: tab === 'privacy' ? 'var(--accent-soft)' : 'transparent',
              border: `1px solid ${
                tab === 'privacy' ? 'var(--accent-border)' : 'transparent'
              }`,
              color: tab === 'privacy' ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <ShieldCheck size={15} strokeWidth={1.5} />
            <span>Privatsphäre &amp; Daten</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === 'providers' && (
            <div className="space-y-5">
              {/* Prominent Free-Only Safety Switch */}
              <div
                className="flex flex-col justify-between gap-4 rounded-[12px] p-4 sm:flex-row sm:items-center"
                style={{
                  backgroundColor: provider.freeOnlyLock
                    ? 'var(--positive-soft)'
                    : 'var(--warning-soft)',
                  border: `1px solid ${
                    provider.freeOnlyLock ? 'var(--accent-border)' : 'var(--border-strong)'
                  }`,
                }}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      backgroundColor: 'var(--bg-card)',
                      color: provider.freeOnlyLock ? 'var(--positive)' : 'var(--warning)',
                    }}
                  >
                    {provider.freeOnlyLock ? (
                      <Lock size={16} strokeWidth={1.5} />
                    ) : (
                      <Unlock size={16} strokeWidth={1.5} />
                    )}
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="text-[14.5px] font-semibold"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Nur kostenlose Modelle verwenden
                      </span>
                      <span
                        className="font-mono-num rounded-md px-2 py-0.5 text-[11.5px] font-medium"
                        style={{
                          backgroundColor: 'var(--bg-card)',
                          color: provider.freeOnlyLock
                            ? 'var(--positive)'
                            : 'var(--warning)',
                        }}
                      >
                        {provider.freeOnlyLock ? '0 CHF Schutz aktiv' : 'Alle Anbieter offen'}
                      </span>
                    </div>
                    <p
                      className="mt-1 text-[13px] leading-relaxed"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {provider.freeOnlyLock
                        ? 'Blockiert kostenpflichtige Cloud-APIs automatisch. Erlaubt sind Google Gemini Free Tier, lokales Ollama, deine lokale CLI-Bridge sowie ":free"-Modelle.'
                        : 'Schutzschalter ist aus. Kostenpflichtige BYOK-Endpunkte wie Anthropic oder bezahlte OpenRouter-Modelle können direkt genutzt werden.'}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={provider.freeOnlyLock}
                  aria-label="Nur kostenlose Modelle verwenden"
                  onClick={() =>
                    onUpdateProvider({ freeOnlyLock: !provider.freeOnlyLock })
                  }
                  className="relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors"
                  style={{
                    backgroundColor: provider.freeOnlyLock
                      ? 'var(--accent)'
                      : 'var(--border-strong)',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '3px',
                  }}
                >
                  <span
                    className="block h-5 w-5 rounded-full transition-transform"
                    style={{
                      backgroundColor: 'var(--bg-card)',
                      transform: provider.freeOnlyLock
                        ? 'translateX(20px)'
                        : 'translateX(0px)',
                    }}
                  />
                </button>
              </div>

              {/* Active Provider Selector */}
              <div className="space-y-2.5">
                <span
                  className="block text-[13.5px] font-medium"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Aktiver Text-Anbieter
                </span>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {PROVIDER_OPTIONS.map((opt) => {
                    const selected = provider.activeTextProvider === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => onUpdateProvider({ activeTextProvider: opt.id })}
                        className="rounded-[10px] p-3 text-left transition-colors"
                        style={{
                          backgroundColor: selected
                            ? 'var(--accent-soft)'
                            : 'var(--bg-raised)',
                          border: `1px solid ${
                            selected ? 'var(--accent-border)' : 'var(--border-hairline)'
                          }`,
                          cursor: 'pointer',
                        }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span
                            className="text-[13.5px] font-semibold leading-snug"
                            style={{
                              color: selected ? 'var(--accent)' : 'var(--text-primary)',
                            }}
                          >
                            {opt.title}
                          </span>
                          <span
                            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium"
                            style={{
                              backgroundColor: 'var(--bg-card)',
                              color: 'var(--text-secondary)',
                              border: '1px solid var(--border-hairline)',
                            }}
                          >
                            {opt.costTag}
                          </span>
                        </div>
                        <p
                          className="mt-1 text-[12.5px]"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {opt.subtitle}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Provider-Specific Configuration Panel */}
              <div className="surface-raised space-y-4 p-4">
                {provider.activeTextProvider === 'gemini-free' && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Sparkles size={16} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                        <h3
                          className="text-[14.5px] font-semibold"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Google Gemini Free Tier Konfiguration
                        </h3>
                      </div>
                      <a
                        href="https://aistudio.google.com/apikey"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-ghost text-[12.5px]"
                        style={{ color: 'var(--accent)', textDecoration: 'none' }}
                      >
                        <KeyRound size={14} strokeWidth={1.5} />
                        <span>Google AI Studio öffnen</span>
                        <ExternalLink size={13} strokeWidth={1.5} />
                      </a>
                    </div>

                    <div className="space-y-2">
                      <label
                        htmlFor="settings-gemini-key"
                        className="block text-[12.5px] font-medium"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        Google AI Studio API-Key (wird nur lokal im Browser gespeichert)
                      </label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <div className="relative flex-1">
                          <input
                            id="settings-gemini-key"
                            type={showGeminiKey ? 'text' : 'password'}
                            value={provider.geminiApiKey}
                            onChange={(e) => {
                              setGeminiResult(null);
                              onUpdateProvider({ geminiApiKey: e.target.value });
                            }}
                            placeholder="Google AI Studio API-Key einfügen"
                            className="font-mono-num h-9 w-full rounded-lg pl-3 pr-9 text-[13px]"
                            style={{
                              backgroundColor: 'var(--bg-card)',
                              border: '1px solid var(--border-strong)',
                              color: 'var(--text-primary)',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowGeminiKey((v) => !v)}
                            aria-label={showGeminiKey ? 'Key verbergen' : 'Key anzeigen'}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1"
                            style={{
                              color: 'var(--text-muted)',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            {showGeminiKey ? (
                              <EyeOff size={15} strokeWidth={1.5} />
                            ) : (
                              <Eye size={15} strokeWidth={1.5} />
                            )}
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={handleTestGemini}
                          disabled={testingGemini || !provider.geminiApiKey.trim()}
                          className="btn-accent shrink-0"
                          style={{
                            opacity:
                              testingGemini || !provider.geminiApiKey.trim() ? 0.55 : 1,
                          }}
                        >
                          {testingGemini ? (
                            <Loader2 size={15} strokeWidth={1.5} className="animate-spin" />
                          ) : (
                            <CheckCircle2 size={15} strokeWidth={1.5} />
                          )}
                          <span>Key testen</span>
                        </button>
                      </div>

                      {geminiResult && (
                        <div
                          className="flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]"
                          style={{
                            backgroundColor: geminiResult.ok
                              ? 'var(--positive-soft)'
                              : 'var(--negative-soft)',
                            color: geminiResult.ok ? 'var(--positive)' : 'var(--negative)',
                          }}
                        >
                          {geminiResult.ok ? (
                            <CheckCircle2 size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                          ) : (
                            <AlertCircle size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                          )}
                          <span>{geminiResult.message}</span>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span
                          className="mb-1 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Text-Modell (Free Tier)
                        </span>
                        <select
                          value={
                            (FREE_GEMINI_TEXT_MODELS as readonly string[]).includes(
                              provider.geminiTextModel
                            )
                              ? provider.geminiTextModel
                              : FREE_GEMINI_TEXT_MODELS[0]
                          }
                          onChange={(e) =>
                            onUpdateProvider({ geminiTextModel: e.target.value })
                          }
                          className="font-mono-num h-9 w-full rounded-lg px-2.5 text-[13px]"
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
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
                          className="mb-1 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Voice-Live-Modell (Free Tier)
                        </span>
                        <select
                          value={
                            (FREE_LIVE_MODELS as readonly string[]).includes(
                              provider.geminiLiveModel
                            )
                              ? provider.geminiLiveModel
                              : FREE_LIVE_MODELS[0]
                          }
                          onChange={(e) =>
                            onUpdateProvider({ geminiLiveModel: e.target.value })
                          }
                          className="font-mono-num h-9 w-full rounded-lg px-2.5 text-[13px]"
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          {FREE_LIVE_MODELS.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </>
                )}

                {provider.activeTextProvider === 'ollama' && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Cpu size={16} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                        <h3
                          className="text-[14.5px] font-semibold"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Ollama lokal verbinden (100 % offline)
                        </h3>
                      </div>
                      <button
                        type="button"
                        onClick={handleCheckOllama}
                        disabled={checkingOllama}
                        className="btn-secondary h-8 px-3 text-[12.5px]"
                      >
                        <RefreshCw
                          size={13}
                          strokeWidth={1.5}
                          className={checkingOllama ? 'animate-spin' : ''}
                        />
                        <span>Status prüfen</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span
                          className="mb-1 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Ollama Server-URL
                        </span>
                        <input
                          type="text"
                          value={provider.ollamaUrl}
                          onChange={(e) => onUpdateProvider({ ollamaUrl: e.target.value })}
                          placeholder="http://127.0.0.1:11434"
                          className="font-mono-num h-9 w-full rounded-lg px-3 text-[13px]"
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        />
                      </label>

                      <label className="block">
                        <span
                          className="mb-1 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Lokales Modell
                        </span>
                        <input
                          type="text"
                          value={provider.ollamaModel}
                          onChange={(e) => onUpdateProvider({ ollamaModel: e.target.value })}
                          placeholder="gemma3:4b"
                          className="font-mono-num h-9 w-full rounded-lg px-3 text-[13px]"
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        />
                      </label>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                      <span style={{ color: 'var(--text-muted)' }}>Schnellwahl:</span>
                      {['gemma3:4b', 'llama3.2:3b', 'qwen2.5:7b'].map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => onUpdateProvider({ ollamaModel: m })}
                          className="font-mono-num rounded-md px-2 py-0.5"
                          style={{
                            backgroundColor:
                              provider.ollamaModel === m
                                ? 'var(--accent-soft)'
                                : 'var(--bg-card)',
                            border: `1px solid ${
                              provider.ollamaModel === m
                                ? 'var(--accent-border)'
                                : 'var(--border-hairline)'
                            }`,
                            color:
                              provider.ollamaModel === m
                                ? 'var(--accent)'
                                : 'var(--text-secondary)',
                            cursor: 'pointer',
                          }}
                        >
                          {m}
                        </button>
                      ))}
                    </div>

                    {ollamaResult && (
                      <div
                        className="rounded-lg px-3 py-2.5 text-[13px]"
                        style={{
                          backgroundColor: ollamaResult.ok
                            ? 'var(--positive-soft)'
                            : 'var(--negative-soft)',
                          color: ollamaResult.ok ? 'var(--positive)' : 'var(--negative)',
                        }}
                      >
                        <div className="flex items-start gap-2">
                          {ollamaResult.ok ? (
                            <CheckCircle2 size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                          ) : (
                            <AlertCircle size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                          )}
                          <span>{ollamaResult.message}</span>
                        </div>
                        {ollamaResult.models.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {ollamaResult.models.slice(0, 8).map((name) => (
                              <button
                                key={name}
                                type="button"
                                onClick={() => onUpdateProvider({ ollamaModel: name })}
                                className="font-mono-num rounded px-2 py-0.5 text-[11.5px]"
                                style={{
                                  backgroundColor: 'var(--bg-card)',
                                  color: 'var(--text-primary)',
                                  border: '1px solid var(--border-hairline)',
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
                  </>
                )}

                {provider.activeTextProvider === 'cli-bridge' && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Terminal size={16} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                        <h3
                          className="text-[14.5px] font-semibold"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          Lokale Agent-Bridge (Antigravity, Claude Code &amp; Codex)
                        </h3>
                      </div>
                      <button
                        type="button"
                        onClick={handleCheckBridge}
                        disabled={checkingBridge}
                        className="btn-accent h-8 px-3 text-[12.5px]"
                      >
                        <RefreshCw
                          size={13}
                          strokeWidth={1.5}
                          className={checkingBridge ? 'animate-spin' : ''}
                        />
                        <span>Bridge-Status prüfen</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                      {BRIDGE_TOOLS.map((tool) => {
                        const selected = provider.bridgeTool === tool.id;
                        return (
                          <button
                            key={tool.id}
                            type="button"
                            onClick={() => onUpdateProvider({ bridgeTool: tool.id })}
                            className="rounded-lg p-3 text-left transition-colors"
                            style={{
                              backgroundColor: selected
                                ? 'var(--accent-soft)'
                                : 'var(--bg-card)',
                              border: `1px solid ${
                                selected ? 'var(--accent-border)' : 'var(--border-hairline)'
                              }`,
                              cursor: 'pointer',
                            }}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span
                                className="text-[13.5px] font-semibold"
                                style={{
                                  color: selected ? 'var(--accent)' : 'var(--text-primary)',
                                }}
                              >
                                {tool.label}
                              </span>
                              <code
                                className="font-mono-num rounded px-1.5 py-0.5 text-[11px]"
                                style={{
                                  backgroundColor: 'var(--bg-raised)',
                                  color: 'var(--text-secondary)',
                                }}
                              >
                                {tool.cliCommand}
                              </code>
                            </div>
                            <p
                              className="mt-1 text-[12px]"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              {tool.note}
                            </p>
                          </button>
                        );
                      })}
                    </div>

                    <label className="block">
                      <span
                        className="mb-1 block text-[12.5px] font-medium"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        Lokale Bridge-Adresse (standardmäßig nur auf 127.0.0.1 erreichbar)
                      </span>
                      <input
                        type="text"
                        value={provider.bridgeUrl}
                        onChange={(e) => onUpdateProvider({ bridgeUrl: e.target.value })}
                        placeholder="http://127.0.0.1:4319"
                        className="font-mono-num h-9 w-full rounded-lg px-3 text-[13px]"
                        style={{
                          backgroundColor: 'var(--bg-card)',
                          border: '1px solid var(--border-strong)',
                          color: 'var(--text-primary)',
                        }}
                      />
                    </label>

                    {bridgeResult && (
                      <div
                        className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-[13px]"
                        style={{
                          backgroundColor: bridgeResult.online
                            ? 'var(--positive-soft)'
                            : 'var(--warning-soft)',
                          color: bridgeResult.online ? 'var(--positive)' : 'var(--warning)',
                        }}
                      >
                        {bridgeResult.online ? (
                          <CheckCircle2 size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                        ) : (
                          <AlertCircle size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                        )}
                        <div>
                          <div className="font-medium">
                            {bridgeResult.online
                              ? 'Lokale Bridge ist online und einsatzbereit.'
                              : 'Lokale Bridge antwortet derzeit nicht.'}
                          </div>
                          {bridgeResult.online && bridgeResult.tools.length > 0 && (
                            <div className="mt-0.5 text-[12.5px]">
                              Erkannte lokale Werkzeuge:{' '}
                              <span className="font-mono-num">
                                {bridgeResult.tools.join(', ')}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Explicit setup instructions */}
                    <div
                      className="rounded-lg p-3.5 text-[13px]"
                      style={{
                        backgroundColor: 'var(--bg-card)',
                        border: '1px solid var(--border-hairline)',
                      }}
                    >
                      <div
                        className="mb-1.5 font-semibold"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        So verbindest du Antigravity, Claude Code oder Codex sicher lokal
                      </div>
                      <ol
                        className="m-0 list-decimal space-y-1 pl-4 text-[12.5px] leading-relaxed"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <li>
                          Stelle sicher, dass dein gewünschtes CLI lokal installiert und
                          angemeldet ist (<code className="font-mono-num">agy</code>,{' '}
                          <code className="font-mono-num">claude</code> oder{' '}
                          <code className="font-mono-num">codex</code>).
                        </li>
                        <li>
                          Starte im OpenStudy-Ordner den Befehl{' '}
                          <code className="font-mono-num rounded bg-[var(--bg-raised)] px-1.5 py-0.5">
                            npm run bridge
                          </code>{' '}
                          (bei Nutzung des Desktop-Installers startet die lokale Bridge automatisch
                          mit).
                        </li>
                        <li>
                          Klicke oben auf «Bridge-Status prüfen». Die Bridge hört ausschließlich
                          auf <code className="font-mono-num">127.0.0.1</code> — deine lokalen
                          Logins verlassen deinen PC niemals.
                        </li>
                      </ol>
                    </div>
                  </>
                )}

                {provider.activeTextProvider === 'openai-compatible' && (
                  <>
                    <div className="flex items-center gap-2">
                      <SlidersHorizontal
                        size={16}
                        strokeWidth={1.5}
                        style={{ color: 'var(--accent)' }}
                      />
                      <h3
                        className="text-[14.5px] font-semibold"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        OpenAI-kompatibler Endpunkt / OpenRouter
                      </h3>
                    </div>

                    {openaiBlockedByFreeLock && (
                      <div
                        className="flex flex-col justify-between gap-2 rounded-lg px-3 py-2.5 text-[13px] sm:flex-row sm:items-center"
                        style={{
                          backgroundColor: 'var(--warning-soft)',
                          color: 'var(--warning)',
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <AlertCircle size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                          <span>
                            Der Free-Only-Schutz erlaubt externe Endpunkte nur mit{' '}
                            <code className="font-mono-num">:free</code>-Modellen oder über
                            localhost.
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => onUpdateProvider({ freeOnlyLock: false })}
                          className="btn-secondary h-8 shrink-0 px-2.5 text-[12px]"
                        >
                          Schutz aufheben
                        </button>
                      </div>
                    )}

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block sm:col-span-2">
                        <span
                          className="mb-1 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Chat-Completions Endpunkt URL
                        </span>
                        <input
                          type="text"
                          value={provider.customEndpoint}
                          onChange={(e) =>
                            onUpdateProvider({ customEndpoint: e.target.value })
                          }
                          placeholder="https://openrouter.ai/api/v1/chat/completions"
                          className="font-mono-num h-9 w-full rounded-lg px-3 text-[13px]"
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        />
                      </label>

                      <label className="block">
                        <span
                          className="mb-1 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Modell-ID
                        </span>
                        <input
                          type="text"
                          value={provider.customModel}
                          onChange={(e) => onUpdateProvider({ customModel: e.target.value })}
                          placeholder="google/gemma-3-27b-it:free"
                          className="font-mono-num h-9 w-full rounded-lg px-3 text-[13px]"
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        />
                      </label>

                      <label className="block">
                        <span
                          className="mb-1 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          API-Key (optional für localhost)
                        </span>
                        <div className="relative">
                          <input
                            type={showCustomKey ? 'text' : 'password'}
                            value={provider.customApiKey}
                            onChange={(e) =>
                              onUpdateProvider({ customApiKey: e.target.value })
                            }
                            placeholder="API-Key einfügen"
                            className="font-mono-num h-9 w-full rounded-lg pl-3 pr-9 text-[13px]"
                            style={{
                              backgroundColor: 'var(--bg-card)',
                              border: '1px solid var(--border-strong)',
                              color: 'var(--text-primary)',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowCustomKey((v) => !v)}
                            aria-label={showCustomKey ? 'Key verbergen' : 'Key anzeigen'}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1"
                            style={{
                              color: 'var(--text-muted)',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            {showCustomKey ? (
                              <EyeOff size={15} strokeWidth={1.5} />
                            ) : (
                              <Eye size={15} strokeWidth={1.5} />
                            )}
                          </button>
                        </div>
                      </label>
                    </div>
                  </>
                )}

                {provider.activeTextProvider === 'anthropic' && (
                  <>
                    <div className="flex items-center gap-2">
                      <KeyRound size={16} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                      <h3
                        className="text-[14.5px] font-semibold"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Anthropic Claude (Direkte API)
                      </h3>
                    </div>

                    {provider.freeOnlyLock && (
                      <div
                        className="flex flex-col justify-between gap-2 rounded-lg px-3 py-2.5 text-[13px] sm:flex-row sm:items-center"
                        style={{
                          backgroundColor: 'var(--warning-soft)',
                          color: 'var(--warning)',
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <Lock size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                          <span>
                            Der Free-Only-Schutz blockiert die kostenpflichtige Anthropic-API.
                            Deaktiviere den Schutz oben oder nutze Claude Code über die lokale
                            Agent-Bridge.
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => onUpdateProvider({ freeOnlyLock: false })}
                          className="btn-secondary h-8 shrink-0 px-2.5 text-[12px]"
                        >
                          Für BYOK freischalten
                        </button>
                      </div>
                    )}

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span
                          className="mb-1 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Anthropic API-Key
                        </span>
                        <div className="relative">
                          <input
                            type={showAnthropicKey ? 'text' : 'password'}
                            value={provider.anthropicApiKey}
                            onChange={(e) =>
                              onUpdateProvider({ anthropicApiKey: e.target.value })
                            }
                            placeholder="Anthropic API-Key einfügen"
                            className="font-mono-num h-9 w-full rounded-lg pl-3 pr-9 text-[13px]"
                            style={{
                              backgroundColor: 'var(--bg-card)',
                              border: '1px solid var(--border-strong)',
                              color: 'var(--text-primary)',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowAnthropicKey((v) => !v)}
                            aria-label={showAnthropicKey ? 'Key verbergen' : 'Key anzeigen'}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1"
                            style={{
                              color: 'var(--text-muted)',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            {showAnthropicKey ? (
                              <EyeOff size={15} strokeWidth={1.5} />
                            ) : (
                              <Eye size={15} strokeWidth={1.5} />
                            )}
                          </button>
                        </div>
                      </label>

                      <label className="block">
                        <span
                          className="mb-1 block text-[12.5px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          Claude Modell
                        </span>
                        <input
                          type="text"
                          value={provider.anthropicModel}
                          onChange={(e) =>
                            onUpdateProvider({ anthropicModel: e.target.value })
                          }
                          placeholder="claude-sonnet-4-5"
                          className="font-mono-num h-9 w-full rounded-lg px-3 text-[13px]"
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                        />
                      </label>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === 'privacy' && (
            <div className="space-y-5">
              {/* Local Storage Status Banner */}
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
                    className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      backgroundColor: 'var(--accent-soft)',
                      color: 'var(--accent)',
                    }}
                  >
                    <HardDrive size={17} strokeWidth={1.5} />
                  </span>
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3
                        className="text-[15px] font-semibold"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Nur lokal im Browser gespeichert · 0 Tracking · 0 Cloud-Zwang
                      </h3>
                    </div>
                    <p
                      className="mt-1 text-[13.5px] leading-relaxed"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      Alle Kurse, Notizen, Lernkarten, Fokus-Protokolle und deine persönlichen
                      API-Schlüssel bleiben ausschließlich im lokalen Speicher dieses Browsers.
                      OpenStudy sendet keine Nutzungsdaten an Dritte.
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                  <div className="surface-card px-3 py-2">
                    <div className="font-mono-num text-[16px] font-semibold">
                      {state.courses.length}
                    </div>
                    <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      Kurse
                    </div>
                  </div>
                  <div className="surface-card px-3 py-2">
                    <div className="font-mono-num text-[16px] font-semibold">
                      {state.notes.length}
                    </div>
                    <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      Notizseiten
                    </div>
                  </div>
                  <div className="surface-card px-3 py-2">
                    <div className="font-mono-num text-[16px] font-semibold">
                      {state.cards.length}
                    </div>
                    <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      Karteikarten
                    </div>
                  </div>
                  <div className="surface-card px-3 py-2">
                    <div className="font-mono-num text-[16px] font-semibold">
                      {state.obsidianNotes.length}
                    </div>
                    <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      Obsidian-Notizen
                    </div>
                  </div>
                  <div className="surface-card px-3 py-2">
                    <div className="font-mono-num text-[16px] font-semibold">
                      {storageSizeKb} KB
                    </div>
                    <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      Lokaler Speicher
                    </div>
                  </div>
                </div>
              </div>

              {/* JSON Backup Export */}
              <div className="surface-raised flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-center">
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      backgroundColor: 'var(--bg-card)',
                      border: '1px solid var(--border-hairline)',
                      color: 'var(--accent)',
                    }}
                  >
                    <Database size={16} strokeWidth={1.5} />
                  </span>
                  <div>
                    <h4
                      className="text-[14.5px] font-semibold"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Lokales JSON-Backup exportieren
                    </h4>
                    <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      Speichert deine Kurse, Notizen, Karten und Lernziele als Datei. Alle
                      API-Keys und Tokens werden beim Export automatisch entfernt.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleExportJson}
                  className="btn-accent shrink-0"
                >
                  <Download size={15} strokeWidth={1.5} />
                  <span>JSON-Backup laden</span>
                </button>
              </div>

              {exportMessage && (
                <div
                  className="flex items-center gap-2 rounded-lg px-3.5 py-2.5 text-[13px]"
                  style={{
                    backgroundColor: 'var(--positive-soft)',
                    color: 'var(--positive)',
                  }}
                >
                  <Check size={15} strokeWidth={1.75} className="shrink-0" />
                  <span>{exportMessage}</span>
                </div>
              )}

              {/* Reopen Onboarding */}
              <div className="surface-raised flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-center">
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      backgroundColor: 'var(--bg-card)',
                      border: '1px solid var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <Wand2 size={16} strokeWidth={1.5} />
                  </span>
                  <div>
                    <h4
                      className="text-[14.5px] font-semibold"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Einrichtungsassistent erneut öffnen
                    </h4>
                    <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      Starte den 3-Schritte-Assistenten noch einmal, um Sprache, Tagesziel oder
                      den kostenlosen KI-Start in Ruhe neu einzustellen.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onReopenOnboarding();
                  }}
                  className="btn-secondary shrink-0"
                >
                  <Wand2 size={15} strokeWidth={1.5} />
                  <span>Assistent öffnen</span>
                </button>
              </div>

              {/* Reset to Demo Data */}
              <div className="surface-raised flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-center">
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      backgroundColor: 'var(--negative-soft)',
                      color: 'var(--negative)',
                    }}
                  >
                    <RotateCcw size={16} strokeWidth={1.5} />
                  </span>
                  <div>
                    <h4
                      className="text-[14.5px] font-semibold"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Demo-Daten wiederherstellen
                    </h4>
                    <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      Setzt Kurse, Notizen, Karten und lokale Schlüssel auf den neutralen
                      Auslieferungszustand zurück.
                    </p>
                  </div>
                </div>

                {!confirmReset ? (
                  <button
                    type="button"
                    onClick={() => setConfirmReset(true)}
                    className="btn-secondary shrink-0"
                    style={{ color: 'var(--negative)' }}
                  >
                    <RotateCcw size={15} strokeWidth={1.5} />
                    <span>Demo-Daten wiederherstellen</span>
                  </button>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmReset(false)}
                      className="btn-ghost"
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
                      className="btn-secondary"
                      style={{
                        backgroundColor: 'var(--negative-soft)',
                        borderColor: 'var(--negative)',
                        color: 'var(--negative)',
                      }}
                    >
                      <span>Zurücksetzen bestätigen</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-3 px-6 py-3.5"
          style={{
            borderTop: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--bg-raised)',
          }}
        >
          <span className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Änderungen werden automatisch lokal gespeichert.
          </span>
          <button type="button" onClick={onClose} className="btn-primary">
            <span>Fertig</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
