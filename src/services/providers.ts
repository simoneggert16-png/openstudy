import { GoogleGenAI } from '@google/genai';
import { ProviderConfig, StudyLanguage, VoicePreferences } from '../types';

export const FREE_GEMINI_TEXT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash',
] as const;

export const FREE_LIVE_MODELS = [
  'gemini-3.8-live',
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
] as const;

export type FreeGeminiTextModel = (typeof FREE_GEMINI_TEXT_MODELS)[number];
export type FreeLiveModel = (typeof FREE_LIVE_MODELS)[number];

export interface VoiceCatalogEntry {
  id: VoicePreferences['voiceName'];
  label: string;
  tone: string;
  sampleDe: string;
  sampleEn: string;
  sampleFr: string;
  sampleEs: string;
  sampleIt: string;
  pitchHint: number;
}

export const VOICE_CATALOG: VoiceCatalogEntry[] = [
  {
    id: 'Kore',
    label: 'Kore',
    tone: 'Klar, ruhig und strukturiert',
    sampleDe: 'Hallo, ich bin Kore. Wir gehen den Stoff Schritt für Schritt in Ruhe durch.',
    sampleEn: 'Hello, I am Kore. Let us walk through today’s study topic calmly step by step.',
    sampleFr: 'Bonjour, je suis Kore. Nous allons revoir ce sujet calmement, étape par étape.',
    sampleEs: 'Hola, soy Kore. Vamos a repasar este tema con calma, paso a paso.',
    sampleIt: 'Ciao, sono Kore. Ripassiamo questo argomento con calma, passo dopo passo.',
    pitchHint: 1.04,
  },
  {
    id: 'Zephyr',
    label: 'Zephyr',
    tone: 'Leicht, freundlich und motivierend',
    sampleDe: 'Hi, ich bin Zephyr. Sag mir einfach, welches Thema wir heute gemeinsam festigen.',
    sampleEn: 'Hi, I am Zephyr. Tell me which concept you would like to practice together today.',
    sampleFr: 'Salut, je suis Zephyr. Dis-moi quel point du cours tu souhaites travailler aujourd’hui.',
    sampleEs: 'Hola, soy Zephyr. Dime qué concepto quieres practicar hoy conmigo.',
    sampleIt: 'Ciao, sono Zephyr. Dimmi quale argomento vuoi esercitare oggi insieme.',
    pitchHint: 1.12,
  },
  {
    id: 'Puck',
    label: 'Puck',
    tone: 'Lebendig, direkt und gesprächig',
    sampleDe: 'Hallo, ich bin Puck. Bereit für ein paar schnelle Prüfungsfragen im Gespräch?',
    sampleEn: 'Hello, I am Puck. Ready to warm up with a few quick oral practice questions?',
    sampleFr: 'Bonjour, je suis Puck. Prêt pour quelques questions rapides à l’oral?',
    sampleEs: 'Hola, soy Puck. ¿Listo para practicar con unas preguntas rápidas en voz alta?',
    sampleIt: 'Ciao, sono Puck. Pronto a fare qualche domanda veloce di allenamento orale?',
    pitchHint: 1.08,
  },
  {
    id: 'Charon',
    label: 'Charon',
    tone: 'Tief, gelassen und analytisch',
    sampleDe: 'Guten Tag, ich bin Charon. Wir zerlegen komplexe Zusammenhänge in klare Bausteine.',
    sampleEn: 'Good day, I am Charon. We will break complex concepts into clear building blocks.',
    sampleFr: 'Bonjour, je suis Charon. Nous allons décomposer les notions complexes avec méthode.',
    sampleEs: 'Hola, soy Charon. Vamos a dividir los conceptos complejos en pasos claros.',
    sampleIt: 'Buongiorno, sono Charon. Analizzeremo i concetti complessi in passaggi chiari.',
    pitchHint: 0.86,
  },
  {
    id: 'Fenrir',
    label: 'Fenrir',
    tone: 'Warm, bestimmt und fokussiert',
    sampleDe: 'Hallo, ich bin Fenrir. Wir bleiben fokussiert und bringen deine Antworten auf den Punkt.',
    sampleEn: 'Hello, I am Fenrir. Let us stay focused and sharpen your answers clearly.',
    sampleFr: 'Bonjour, je suis Fenrir. Restons concentrés pour rendre tes réponses précises.',
    sampleEs: 'Hola, soy Fenrir. Mantengamos el enfoque para mejorar tus respuestas.',
    sampleIt: 'Ciao, sono Fenrir. Restiamo concentrati per rendere le tue risposte precise.',
    pitchHint: 0.9,
  },
  {
    id: 'Aoede',
    label: 'Aoede',
    tone: 'Sanft, geduldig und sprachbetont',
    sampleDe: 'Hallo, ich bin Aoede. Nimm dir beim Sprechen Zeit, ich achte auf Ausdruck und Klang.',
    sampleEn: 'Hello, I am Aoede. Take your time speaking, and I will help refine phrasing and flow.',
    sampleFr: 'Bonjour, je suis Aoede. Prends ton temps pour parler, j’écoute ta prononciation.',
    sampleEs: 'Hola, soy Aoede. Tómate tu tiempo al hablar, te ayudaré con la fluidez y la gramática.',
    sampleIt: 'Ciao, sono Aoede. Prenditi il tuo tempo nel parlare, ti aiuterò con fluidità e tono.',
    pitchHint: 1.0,
  },
];

export function getVoiceCatalogEntry(id: VoicePreferences['voiceName']): VoiceCatalogEntry {
  return VOICE_CATALOG.find((v) => v.id === id) ?? VOICE_CATALOG[0];
}

export function getVoiceSampleText(
  voice: VoiceCatalogEntry,
  language: StudyLanguage
): string {
  switch (language) {
    case 'en':
      return voice.sampleEn;
    case 'fr':
      return voice.sampleFr;
    case 'es':
      return voice.sampleEs;
    case 'it':
      return voice.sampleIt;
    case 'de':
    default:
      return voice.sampleDe;
  }
}

function isLocalhostEndpoint(rawUrl: string): boolean {
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

function isFreeGeminiTextModel(model: string): model is FreeGeminiTextModel {
  return (FREE_GEMINI_TEXT_MODELS as readonly string[]).includes(model);
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unbekannter Fehler bei der KI-Anfrage.';
}

function isModelUnavailableError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('not supported') ||
    lower.includes('is not available') ||
    lower.includes('invalid model')
  );
}

export async function generateStudyText(params: {
  provider: ProviderConfig;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ text: string; usedProvider: string }> {
  const { provider, systemPrompt, userPrompt } = params;

  switch (provider.activeTextProvider) {
    case 'gemini-free': {
      const apiKey = provider.geminiApiKey.trim();
      if (!apiKey) {
        throw new Error(
          'Kein Google AI Studio API-Key hinterlegt. Öffne die Einstellungen und füge deinen kostenlosen Gemini Free-Tier Key ein.'
        );
      }

      const requestedModel = provider.geminiTextModel.trim();
      const primaryModel = provider.freeOnlyLock
        ? isFreeGeminiTextModel(requestedModel)
          ? requestedModel
          : FREE_GEMINI_TEXT_MODELS[0]
        : requestedModel || FREE_GEMINI_TEXT_MODELS[0];

      const candidateModels = [
        primaryModel,
        ...FREE_GEMINI_TEXT_MODELS.filter((m) => m !== primaryModel),
      ];

      const ai = new GoogleGenAI({ apiKey });
      let lastError: unknown = null;

      for (const model of candidateModels) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: userPrompt,
            config: {
              systemInstruction: systemPrompt,
            },
          });
          const text = response.text?.trim() ?? '';
          if (!text) {
            throw new Error('Das Modell hat eine leere Antwort zurückgegeben.');
          }
          return {
            text,
            usedProvider: `Gemini Free (${model})`,
          };
        } catch (err) {
          lastError = err;
          const msg = formatErrorMessage(err);
          if (isModelUnavailableError(msg)) {
            continue;
          }
          if (msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('api key')) {
            throw new Error(
              'Der Gemini API-Key wurde abgelehnt. Prüfe den Schlüssel in den Einstellungen oder erstelle einen neuen Free-Tier Key in Google AI Studio.'
            );
          }
          if (msg.includes('429') || msg.toLowerCase().includes('quota')) {
            throw new Error(
              'Das kostenlose Minutenlimit von Gemini wurde kurzzeitig erreicht. Warte einen Moment und versuche es erneut.'
            );
          }
          throw new Error(`Gemini Fehler: ${msg}`);
        }
      }

      throw new Error(`Gemini Modell nicht erreichbar: ${formatErrorMessage(lastError)}`);
    }

    case 'hermes-gateway': {
      const bridgeBase = (provider.bridgeUrl?.trim() || 'http://127.0.0.1:4319').replace(/\/+$/, '');
      const gatewayBase = (provider.hermesGatewayUrl?.trim() || 'http://127.0.0.1:9119').replace(/\/+$/, '');
      const model = provider.hermesModel?.trim() || 'hermes-default';
      const apiKey = provider.hermesApiKey?.trim() || '';

      const bridgeIsLocal = isLocalhostEndpoint(bridgeBase);
      const gatewayIsLocal = isLocalhostEndpoint(gatewayBase);

      if (provider.freeOnlyLock && !bridgeIsLocal && !gatewayIsLocal) {
        throw new Error(
          'Kostenlos-Sperre aktiv: Im Modus "Nur Kostenlos" ist Hermes Gateway nur lokal (127.0.0.1 / localhost) erlaubt. Du kannst die Sperre in den Einstellungen aufheben.'
        );
      }

      const extractGatewayText = (payload: {
        text?: string;
        reply?: string;
        output?: string;
        message?: { content?: string };
        choices?: Array<{
          message?: {
            content?: string | Array<{ type?: string; text?: string }>;
          };
        }>;
      }): string => {
        if (typeof payload.text === 'string' && payload.text.trim()) return payload.text.trim();
        if (typeof payload.reply === 'string' && payload.reply.trim()) return payload.reply.trim();
        if (typeof payload.output === 'string' && payload.output.trim()) return payload.output.trim();
        if (typeof payload.message?.content === 'string' && payload.message.content.trim()) {
          return payload.message.content.trim();
        }
        const rawContent = payload.choices?.[0]?.message?.content;
        if (Array.isArray(rawContent)) {
          return rawContent
            .map((part) => (typeof part.text === 'string' ? part.text : ''))
            .join('')
            .trim();
        }
        return (rawContent ?? '').trim();
      };

      // 1. Prefer the local OpenStudy Bridge proxy if allowed
      let bridgeError: string | null = null;
      if (!provider.freeOnlyLock || bridgeIsLocal) {
        try {
          const bridgeRes = await fetch(`${bridgeBase}/api/hermes/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              gatewayUrl: gatewayBase,
              model,
              apiKey: apiKey || undefined,
              systemPrompt,
              userPrompt,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
            }),
          });

          if (bridgeRes.ok) {
            const data = (await bridgeRes.json().catch(() => ({}))) as {
              text?: string;
              reply?: string;
              output?: string;
              model?: string;
              message?: { content?: string };
              choices?: Array<{
                message?: {
                  content?: string | Array<{ type?: string; text?: string }>;
                };
              }>;
              error?: string;
            };
            if (!data.error) {
              const text = extractGatewayText(data);
              if (text) {
                return {
                  text,
                  usedProvider: `Hermes Gateway (${data.model || model})`,
                };
              }
            } else {
              bridgeError = data.error;
            }
          } else if (bridgeRes.status !== 404) {
            const errData = (await bridgeRes.json().catch(() => ({}))) as { error?: string };
            bridgeError = errData.error || `Bridge Status ${bridgeRes.status}`;
          }
        } catch {
          // Bridge not running — fall back to direct Hermes Gateway
        }
      }

      // 2. Fallback to direct OpenAI-compatible Hermes Gateway endpoint
      if (provider.freeOnlyLock && !gatewayIsLocal) {
        throw new Error(
          bridgeError ||
            'Kostenlos-Sperre aktiv: Direkter Zugriff auf ein externes Hermes Gateway ist gesperrt. Nutze eine lokale Adresse (127.0.0.1 / localhost) oder deaktiviere die Sperre.'
        );
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Title': 'OpenStudy',
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      let directRes: Response;
      try {
        directRes = await fetch(`${gatewayBase}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
        });
      } catch {
        throw new Error(
          bridgeError ||
            `Hermes Gateway ist weder über die lokale Bridge (${bridgeBase}) noch direkt unter ${gatewayBase} erreichbar. Starte Hermes lokal oder wechsle auf Gemini Free.`
        );
      }

      const directData = (await directRes.json().catch(() => ({}))) as {
        choices?: Array<{
          message?: {
            content?: string | Array<{ type?: string; text?: string }>;
          };
        }>;
        text?: string;
        reply?: string;
        error?: { message?: string } | string;
      };

      if (!directRes.ok) {
        const detail =
          typeof directData.error === 'string'
            ? directData.error
            : directData.error?.message || `HTTP ${directRes.status}`;
        throw new Error(`Hermes Gateway Fehler: ${detail}`);
      }

      const text = extractGatewayText(directData);
      if (!text) {
        throw new Error('Hermes Gateway hat keine verwertbare Antwort zurückgegeben.');
      }

      return {
        text,
        usedProvider: `Hermes Gateway (${model})`,
      };
    }

    case 'ollama': {
      const baseUrl = (provider.ollamaUrl.trim() || 'http://127.0.0.1:11434').replace(/\/+$/, '');
      const model = provider.ollamaModel.trim() || 'gemma3:4b';

      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
        });
      } catch {
        throw new Error(
          `Ollama ist unter ${baseUrl} nicht erreichbar. Starte lokal "ollama serve" und erlaube bei Bedarf CORS (OLLAMA_ORIGINS=*).`
        );
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(
          `Ollama antwortete mit Status ${res.status}${bodyText ? `: ${bodyText.slice(0, 180)}` : '.'}`
        );
      }

      const data = (await res.json()) as {
        message?: { content?: string };
        response?: string;
        error?: string;
      };
      if (data.error) {
        throw new Error(`Ollama Fehler: ${data.error}`);
      }
      const text = (data.message?.content ?? data.response ?? '').trim();
      if (!text) {
        throw new Error('Ollama hat keine Textantwort zurückgegeben.');
      }
      return {
        text,
        usedProvider: `Ollama lokal (${model})`,
      };
    }

    case 'cli-bridge': {
      const baseUrl = (provider.bridgeUrl.trim() || 'http://127.0.0.1:4319').replace(/\/+$/, '');
      const tool = provider.bridgeTool;

      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool,
            systemPrompt,
            userPrompt,
          }),
        });
      } catch {
        throw new Error(
          `Die lokale CLI-Bridge unter ${baseUrl} läuft nicht. Starte sie im Projektordner mit "npm run bridge".`
        );
      }

      const data = (await res.json().catch(() => ({}))) as {
        text?: string;
        output?: string;
        result?: string;
        reply?: string;
        error?: string;
      };

      if (!res.ok || data.error) {
        throw new Error(
          data.error ||
            `CLI-Bridge (${tool}) meldete Fehler ${res.status}. Prüfe, ob das CLI lokal installiert und angemeldet ist.`
        );
      }

      const text = (data.text ?? data.output ?? data.result ?? data.reply ?? '').trim();
      if (!text) {
        throw new Error(`CLI-Bridge (${tool}) lieferte eine leere Antwort.`);
      }

      return {
        text,
        usedProvider: `CLI Bridge (${tool})`,
      };
    }

    case 'openai-compatible': {
      const endpoint = provider.customEndpoint.trim();
      const model = provider.customModel.trim();
      const apiKey = provider.customApiKey.trim();

      if (!endpoint) {
        throw new Error('Bitte trage einen OpenAI-kompatiblen Endpunkt in den Einstellungen ein.');
      }

      const isLocal = isLocalhostEndpoint(endpoint);
      const isExplicitFreeModel = model.toLowerCase().endsWith(':free');

      if (provider.freeOnlyLock && !isLocal && !isExplicitFreeModel) {
        throw new Error(
          'Kostenlos-Sperre aktiv: Bei OpenAI-kompatiblen Endpunkten sind im Modus "Nur Kostenlos" nur lokale Adressen (localhost) oder Modelle mit ":free" erlaubt. Du kannst die Sperre in den Einstellungen aufheben.'
        );
      }

      if (!isLocal && !apiKey) {
        throw new Error(
          'Für diesen externen Endpunkt wird ein API-Key benötigt. Trage ihn in den Einstellungen ein.'
        );
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Title': 'OpenStudy',
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: model || 'google/gemma-3-27b-it:free',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
        });
      } catch {
        throw new Error(`Endpunkt ${endpoint} konnte nicht erreicht werden.`);
      }

      const data = (await res.json().catch(() => ({}))) as {
        choices?: Array<{
          message?: {
            content?: string | Array<{ type?: string; text?: string }>;
          };
        }>;
        error?: { message?: string } | string;
      };

      if (!res.ok) {
        const errDetail =
          typeof data.error === 'string'
            ? data.error
            : data.error?.message || `HTTP ${res.status}`;
        throw new Error(`OpenAI-kompatibler Endpunkt Fehler: ${errDetail}`);
      }

      const rawContent = data.choices?.[0]?.message?.content;
      const text = Array.isArray(rawContent)
        ? rawContent
            .map((part) => (typeof part.text === 'string' ? part.text : ''))
            .join('')
            .trim()
        : (rawContent ?? '').trim();

      if (!text) {
        throw new Error('Der Endpunkt hat keine verwertbare Antwort geliefert.');
      }

      return {
        text,
        usedProvider: `OpenAI-kompatibel (${model || 'Custom'})`,
      };
    }

    case 'anthropic': {
      if (provider.freeOnlyLock) {
        throw new Error(
          'Kostenlos-Sperre aktiv: Die direkte Anthropic-API ist kostenpflichtig. Deaktiviere "Nur Kostenlos" in den Einstellungen, um Anthropic freizuschalten, oder nutze Gemini Free, Ollama bzw. die lokale CLI-Bridge.'
        );
      }

      const apiKey = provider.anthropicApiKey.trim();
      if (!apiKey) {
        throw new Error(
          'Bitte trage zuerst deinen Anthropic API-Key in den Einstellungen ein.'
        );
      }

      const model = provider.anthropicModel.trim() || 'claude-sonnet-4-5';

      let res: Response;
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model,
            max_tokens: 1536,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
        });
      } catch {
        throw new Error('Verbindung zur Anthropic-API fehlgeschlagen.');
      }

      const data = (await res.json().catch(() => ({}))) as {
        content?: Array<{ type?: string; text?: string }>;
        error?: { message?: string };
      };

      if (!res.ok) {
        throw new Error(
          `Anthropic API Fehler (${res.status}): ${data.error?.message || 'Anfrage abgelehnt.'}`
        );
      }

      const text = (data.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text ?? '')
        .join('\n')
        .trim();

      if (!text) {
        throw new Error('Anthropic hat keine Textantwort zurückgegeben.');
      }

      return {
        text,
        usedProvider: `Anthropic (${model})`,
      };
    }

    default: {
      throw new Error('Unbekannter KI-Anbieter ausgewählt.');
    }
  }
}

export const generateStudyReply = generateStudyText;

export async function testGeminiApiKey(
  apiKey: string
): Promise<{ ok: boolean; message: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: 'Bitte gib zuerst einen Google AI Studio API-Key ein.',
    };
  }

  const ai = new GoogleGenAI({ apiKey: trimmed });

  for (const model of FREE_GEMINI_TEXT_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: 'Antworte mit genau einem Wort: OK',
        config: {
          maxOutputTokens: 8,
        },
      });
      if (response.text !== undefined) {
        return {
          ok: true,
          message: `Verbindung bestätigt (${model}, Free Tier aktiv).`,
        };
      }
    } catch (err) {
      const msg = formatErrorMessage(err);
      if (isModelUnavailableError(msg)) {
        continue;
      }
      if (msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('api key')) {
        return {
          ok: false,
          message: 'API-Key ungültig oder ohne Berechtigung. Prüfe den Schlüssel in Google AI Studio.',
        };
      }
      if (msg.includes('429') || msg.toLowerCase().includes('quota')) {
        return {
          ok: false,
          message: 'Schlüssel erkannt, aber das Free-Tier Kontingent ist momentan ausgelastet.',
        };
      }
      return {
        ok: false,
        message: `Verbindung fehlgeschlagen: ${msg}`,
      };
    }
  }

  return {
    ok: false,
    message: 'Keines der Free-Tier Gemini-Modelle konnte erreicht werden.',
  };
}

export async function checkLocalBridge(
  bridgeUrl: string
): Promise<{ online: boolean; tools: string[] }> {
  const baseUrl = (bridgeUrl.trim() || 'http://127.0.0.1:4319').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2500);

  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      return { online: false, tools: [] };
    }

    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      tools?: string[] | Record<string, boolean>;
      availableTools?: string[];
    };

    let tools: string[] = [];
    if (Array.isArray(data.tools)) {
      tools = data.tools.filter((t): t is string => typeof t === 'string');
    } else if (Array.isArray(data.availableTools)) {
      tools = data.availableTools.filter((t): t is string => typeof t === 'string');
    } else if (data.tools && typeof data.tools === 'object') {
      tools = Object.entries(data.tools)
        .filter(([, available]) => Boolean(available))
        .map(([name]) => name);
    }

    return {
      online: data.ok !== false,
      tools,
    };
  } catch {
    return { online: false, tools: [] };
  } finally {
    window.clearTimeout(timer);
  }
}

async function probeUrlOk(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function checkHermesGateway(
  bridgeUrl: string,
  hermesGatewayUrl: string
): Promise<{
  online: boolean;
  mode: 'gateway' | 'cli' | 'builtin';
  message: string;
  skillsCount: number;
}> {
  const bridgeBase = (bridgeUrl.trim() || 'http://127.0.0.1:4319').replace(/\/+$/, '');
  const gatewayBase = (hermesGatewayUrl.trim() || 'http://127.0.0.1:9119').replace(/\/+$/, '');

  let bridgeSkillsCount = 0;
  let bridgeMessage = '';

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2500);

  try {
    const query = `?gatewayUrl=${encodeURIComponent(gatewayBase)}`;
    const res = await fetch(`${bridgeBase}/api/hermes/status${query}`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        online?: boolean;
        ok?: boolean;
        gatewayOnline?: boolean;
        cliAvailable?: boolean;
        mode?: string;
        message?: string;
        skillsCount?: number;
        skills?: unknown[];
      };

      bridgeSkillsCount =
        typeof data.skillsCount === 'number'
          ? data.skillsCount
          : Array.isArray(data.skills)
            ? data.skills.length
            : 0;

      const resolvedMode: 'gateway' | 'cli' | 'builtin' =
        data.mode === 'gateway' || data.mode === 'cli' || data.mode === 'builtin'
          ? data.mode
          : data.gatewayOnline
            ? 'gateway'
            : data.cliAvailable
              ? 'cli'
              : 'builtin';

      const isOnline =
        typeof data.online === 'boolean'
          ? data.online
          : Boolean(data.gatewayOnline || data.cliAvailable);

      bridgeMessage = typeof data.message === 'string' ? data.message.trim() : '';

      if (isOnline && resolvedMode !== 'builtin') {
        return {
          online: true,
          mode: resolvedMode,
          message:
            bridgeMessage ||
            (resolvedMode === 'gateway'
              ? `Hermes Gateway verbunden (${gatewayBase}).`
              : 'Lokale Hermes CLI über OpenStudy Bridge bereit.'),
          skillsCount: bridgeSkillsCount,
        };
      }
    }
  } catch {
    // Bridge offline or route not available — probe gateway directly
  } finally {
    window.clearTimeout(timer);
  }

  // Direct fallback probe to Hermes Gateway (/health then /v1/models)
  const healthOk = await probeUrlOk(`${gatewayBase}/health`, 2000);
  if (healthOk) {
    return {
      online: true,
      mode: 'gateway',
      message: `Hermes Gateway direkt unter ${gatewayBase} erreichbar.`,
      skillsCount: bridgeSkillsCount,
    };
  }

  const modelsOk = await probeUrlOk(`${gatewayBase}/v1/models`, 2000);
  if (modelsOk) {
    return {
      online: true,
      mode: 'gateway',
      message: `Hermes Gateway direkt unter ${gatewayBase} erreichbar.`,
      skillsCount: bridgeSkillsCount,
    };
  }

  return {
    online: false,
    mode: 'builtin',
    message:
      bridgeMessage ||
      'Kein lokales Hermes Gateway erkannt. Der integrierte Hermes-Agent bleibt mit Gemini Free vollständig nutzbar.',
    skillsCount: bridgeSkillsCount,
  };
}
