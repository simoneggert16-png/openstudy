import React, { useEffect, useState } from 'react';
import { AlertCircle, Check, ExternalLink, Eye, EyeOff, Loader2, X } from 'lucide-react';
import {
  FREE_GEMINI_TEXT_MODELS,
  FREE_LIVE_MODELS,
  testGeminiApiKey,
} from '../services/providers';
import { OpenStudyState, ProviderConfig } from '../types';

export interface OnboardingWizardProps {
  open: boolean;
  state: OpenStudyState;
  onUpdateProvider: (patch: Partial<ProviderConfig>) => void;
  onComplete: () => void;
  onOpenSettings: () => void;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  open,
  state,
  onUpdateProvider,
  onComplete,
  onOpenSettings,
}) => {
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onComplete();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onComplete]);

  if (!open) return null;

  const trimmedKey = state.provider.geminiApiKey.trim();
  const hasKey = trimmedKey.length > 0;

  const handleTestKey = async () => {
    if (!hasKey || testing) return;
    onUpdateProvider({
      activeTextProvider: 'gemini-free',
      freeOnlyLock: true,
      geminiTextModel: state.provider.geminiTextModel || FREE_GEMINI_TEXT_MODELS[0],
      geminiLiveModel: state.provider.geminiLiveModel || FREE_LIVE_MODELS[0],
    });
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testGeminiApiKey(trimmedKey));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      style={{ backgroundColor: 'rgba(18, 22, 20, 0.48)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onComplete();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-sheet-title"
    >
      <div
        className="surface-card animate-enter w-full max-w-[500px] overflow-hidden"
        style={{ borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow-md)' }}
      >
        <div className="px-7 pb-6 pt-7">
          <div className="flex items-start justify-between gap-4">
            <h2
              id="onboarding-sheet-title"
              className="font-display text-[26px] font-normal leading-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              Sprachtutor verbinden
            </h2>
            <button
              type="button"
              onClick={onComplete}
              aria-label="Schliessen"
              className="btn-ghost -mr-2 -mt-1 h-8 w-8 p-0"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>

          <p className="mt-2.5 text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Notizen, Fokus-Timer und Karteikarten funktionieren sofort ohne Konto. Für den
            Live-Sprachtutor brauchst du nur einen kostenlosen Google-Key.
          </p>

          <ol className="mt-6 space-y-2.5 p-0 text-[13.5px] leading-relaxed">
            <li className="flex items-baseline gap-3">
              <span className="font-mono-num w-4 shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                1.
              </span>
              <span style={{ color: 'var(--text-primary)' }}>
                Öffne{' '}
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-4 transition-opacity hover:opacity-80"
                  style={{ color: 'var(--accent)' }}
                >
                  <span>Google AI Studio</span>
                  <ExternalLink size={12} strokeWidth={1.5} />
                </a>{' '}
                <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  (aistudio.google.com/apikey)
                </span>
              </span>
            </li>

            <li className="flex items-baseline gap-3">
              <span className="font-mono-num w-4 shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                2.
              </span>
              <span style={{ color: 'var(--text-primary)' }}>
                Klicke auf «Create API key» und kopiere den Schlüssel
              </span>
            </li>

            <li className="flex items-baseline gap-3">
              <span className="font-mono-num w-4 shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                3.
              </span>
              <span style={{ color: 'var(--text-primary)' }}>
                Füge ihn unten ein — er bleibt ausschliesslich auf deinem Gerät
              </span>
            </li>
          </ol>

          <div className="mt-6">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={state.provider.geminiApiKey}
                  onChange={(e) => {
                    setTestResult(null);
                    onUpdateProvider({
                      activeTextProvider: 'gemini-free',
                      freeOnlyLock: true,
                      geminiApiKey: e.target.value,
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && hasKey) void handleTestKey();
                  }}
                  placeholder="Google API-Key einfügen"
                  aria-label="Google AI Studio API-Key"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono-num h-9 w-full rounded-[10px] pl-3 pr-9 text-[13px]"
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
                  style={{ color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  {showKey ? <EyeOff size={15} strokeWidth={1.5} /> : <Eye size={15} strokeWidth={1.5} />}
                </button>
              </div>

              <button
                type="button"
                onClick={() => void handleTestKey()}
                disabled={!hasKey || testing}
                className="btn-accent shrink-0"
                style={{ opacity: !hasKey || testing ? 0.5 : 1 }}
              >
                {testing && <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />}
                <span>Prüfen</span>
              </button>
            </div>

            {testResult && (
              <p
                role="status"
                className="mt-2.5 flex items-start gap-1.5 text-[12.5px] leading-snug"
                style={{ color: testResult.ok ? 'var(--positive)' : 'var(--negative)' }}
              >
                {testResult.ok ? (
                  <Check size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                )}
                <span>{testResult.message}</span>
              </p>
            )}
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-4 px-7 py-4"
          style={{ borderTop: '1px solid var(--border-hairline)' }}
        >
          <button
            type="button"
            onClick={onOpenSettings}
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
            Eigene Modelle &amp; Bridge
          </button>

          <button
            type="button"
            onClick={onComplete}
            className={hasKey ? 'btn-primary' : 'btn-secondary'}
          >
            {hasKey ? 'Fertig' : 'Ohne Key weiter'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OnboardingWizard;
