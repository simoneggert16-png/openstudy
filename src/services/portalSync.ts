import { GoogleGenAI } from '@google/genai';
import { ScheduleItemCategory, SchoolScheduleItem } from '../types';
import { FREE_GEMINI_TEXT_MODELS } from './providers';

export interface PortalSessionStartResult {
  ok: boolean;
  sessionId?: string;
  browserName?: string;
  portalUrl?: string;
  currentUrl?: string;
  pageTitle?: string;
  looksLikeLogin?: boolean;
  error?: string;
}

export interface PortalSessionStatusResult {
  ok: boolean;
  active: boolean;
  currentUrl: string;
  pageTitle: string;
  looksLikeLogin: boolean;
  error?: string;
}

export interface PortalExtractResult {
  ok: boolean;
  items: SchoolScheduleItem[];
  visitedPages: Array<{ url: string; title: string }>;
  cleanedTextBundle: string;
  horizonDays: number;
  usedAiStructuring: boolean;
  error?: string;
}

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4319';
const START_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;
const EXTRACT_TIMEOUT_MS = 45_000;
const DEFAULT_HORIZON_DAYS = 90;
const MAX_RETURNED_ITEMS = 200;

const VALID_CATEGORIES: ReadonlySet<ScheduleItemCategory> = new Set([
  'exam',
  'homework',
  'lesson',
  'event',
]);

function normalizeBridgeUrl(bridgeUrl: string): string {
  return (bridgeUrl?.trim() || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
}

function clampHorizonDays(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_HORIZON_DAYS;
  }
  return Math.min(180, Math.max(7, Math.round(raw)));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function formatLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getHorizonBounds(horizonDays: number): { startIso: string; endIso: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + horizonDays);
  return {
    startIso: formatLocalIsoDate(start),
    endIso: formatLocalIsoDate(end),
  };
}

function isValidIsoDate(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

function normalizeTime(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = raw.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return undefined;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function normalizeCategory(raw: unknown): ScheduleItemCategory {
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase() as ScheduleItemCategory;
    if (VALID_CATEGORIES.has(lower)) {
      return lower;
    }
  }
  return 'event';
}

function stableShortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function sanitizeScheduleItem(
  raw: unknown,
  bounds: { startIso: string; endIso: string }
): SchoolScheduleItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;

  const rawDate = typeof candidate.date === 'string' ? candidate.date.trim() : '';
  if (!isValidIsoDate(rawDate)) return null;
  if (rawDate < bounds.startIso || rawDate > bounds.endIso) return null;

  const title =
    typeof candidate.title === 'string'
      ? candidate.title.replace(/\s+/g, ' ').trim().slice(0, 120)
      : '';
  if (!title || title.length < 2) return null;

  const courseTitle =
    typeof candidate.courseTitle === 'string' && candidate.courseTitle.trim()
      ? candidate.courseTitle.replace(/\s+/g, ' ').trim().slice(0, 80)
      : 'Allgemein';

  const startTime = normalizeTime(candidate.startTime);
  const endTime = normalizeTime(candidate.endTime);
  const category = normalizeCategory(candidate.category);
  const room =
    typeof candidate.room === 'string' && candidate.room.trim()
      ? candidate.room.replace(/\s+/g, ' ').trim().slice(0, 48)
      : undefined;
  const notes =
    typeof candidate.notes === 'string' && candidate.notes.trim()
      ? candidate.notes.replace(/\s+/g, ' ').trim().slice(0, 220)
      : undefined;

  const idSeed = `${rawDate}|${startTime ?? ''}|${title.toLowerCase()}`;
  const id =
    typeof candidate.id === 'string' && candidate.id.trim().startsWith('portal-')
      ? candidate.id.trim().slice(0, 64)
      : `portal-${rawDate}-${stableShortHash(idSeed)}`;

  const item: SchoolScheduleItem = {
    id,
    title,
    date: rawDate,
    courseTitle,
    source: 'portal-sync',
    category,
  };
  if (startTime) item.startTime = startTime;
  if (endTime) item.endTime = endTime;
  if (room) item.room = room;
  if (notes) item.notes = notes;

  return item;
}

function normalizeTitleForComparison(title: string): string {
  return title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleTokens(normalized: string): string[] {
  return normalized.split(' ').filter((token) => token.length >= 2);
}

function areSimilarPortalItems(a: SchoolScheduleItem, b: SchoolScheduleItem): boolean {
  if (a.date !== b.date) return false;

  const normA = normalizeTitleForComparison(a.title);
  const normB = normalizeTitleForComparison(b.title);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (normA.length >= 6 && normB.length >= 6 && (normA.includes(normB) || normB.includes(normA))) {
    return true;
  }

  const tokensA = new Set(titleTokens(normA));
  const tokensB = new Set(titleTokens(normB));
  if (tokensA.size === 0 || tokensB.size === 0) return false;

  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap += 1;
  }
  const minSize = Math.min(tokensA.size, tokensB.size);
  const overlapRatio = overlap / minSize;
  if (overlapRatio >= 0.6) return true;

  if (a.startTime && b.startTime && a.startTime === b.startTime) {
    const courseA = normalizeTitleForComparison(a.courseTitle);
    const courseB = normalizeTitleForComparison(b.courseTitle);
    if (courseA && courseA !== 'allgemein' && courseA === courseB) {
      return true;
    }
    if (overlap >= 1) {
      return true;
    }
  }

  return false;
}

function mergePortalItems(
  aiItems: SchoolScheduleItem[],
  deterministicItems: SchoolScheduleItem[]
): SchoolScheduleItem[] {
  const merged: SchoolScheduleItem[] = [];

  // Prefer AI-structured entries first (richer titles, categories, notes)
  for (const item of aiItems) {
    if (!merged.some((existing) => areSimilarPortalItems(existing, item))) {
      merged.push({ ...item, source: 'portal-sync' });
    }
  }

  // Merge deterministic entries: enrich matching AI entries or add missed entries
  for (const det of deterministicItems) {
    const matchIdx = merged.findIndex((existing) => areSimilarPortalItems(existing, det));
    if (matchIdx >= 0) {
      const existing = merged[matchIdx];
      merged[matchIdx] = {
        ...existing,
        source: 'portal-sync',
        startTime: existing.startTime || det.startTime,
        endTime: existing.endTime || det.endTime,
        room: existing.room || det.room,
        courseTitle:
          existing.courseTitle && existing.courseTitle !== 'Allgemein'
            ? existing.courseTitle
            : det.courseTitle || 'Allgemein',
      };
    } else {
      merged.push({ ...det, source: 'portal-sync' });
    }
  }

  merged.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const ta = a.startTime || '99:99';
    const tb = b.startTime || '99:99';
    if (ta !== tb) return ta.localeCompare(tb);
    return a.title.localeCompare(b.title);
  });

  return merged.slice(0, MAX_RETURNED_ITEMS);
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

function extractJsonArrayFromModelText(rawText: string): unknown[] | null {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!cleaned) return null;

  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.items)) return record.items;
      if (Array.isArray(record.events)) return record.events;
      if (Array.isArray(record.schedule)) return record.schedule;
    }
    return null;
  } catch {
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    if (firstBracket >= 0 && lastBracket > firstBracket) {
      try {
        const sliced: unknown = JSON.parse(cleaned.slice(firstBracket, lastBracket + 1));
        if (Array.isArray(sliced)) return sliced;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function structureAgendaWithGemini(params: {
  geminiApiKey: string;
  cleanedTextBundle: string;
  horizonDays: number;
  bounds: { startIso: string; endIso: string };
}): Promise<{ ok: boolean; items: SchoolScheduleItem[] }> {
  const { geminiApiKey, cleanedTextBundle, horizonDays, bounds } = params;
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const systemInstruction = [
    'Du bist Hermes, der präzise Agenda-Extraktor von OpenStudy.',
    `Extrahiere aus dem folgenden ausgelesenen Portal-Text ALLE realen Prüfungen, Tests, Hausaufgaben, Abgaben, Lektionen und Termine im Zeitraum ${bounds.startIso} bis ${bounds.endIso} (${horizonDays} Tage).`,
    'Strikte Regeln:',
    '- Erfinde niemals Einträge, Daten, Zeiten oder Räume. Übernimm nur, was eindeutig im Text steht.',
    '- Ignoriere allgemeine Fusszeilen, Stand-/Druckdaten, Login-Zeitstempel und Navigationsmenüs.',
    '- Gib ausschliesslich gültiges JSON im Format {"items":[...]} zurück.',
    '- Jedes Element in "items" hat: {"title": string, "date": "YYYY-MM-DD", "courseTitle": string, "category": "exam"|"homework"|"lesson"|"event", "startTime"?: "HH:MM", "endTime"?: "HH:MM", "room"?: string, "notes"?: string}.',
    '- Nutze "exam" für Prüfungen, Klausuren, Tests, Lernkontrollen und Vorträge; "homework" für Aufgaben, Abgaben und Deadlines; "lesson" für reguläre Lektionen/Vorlesungen; "event" für sonstige Termine.',
    '- Wenn kein Fach erkennbar ist, setze "courseTitle" auf "Allgemein".',
    '- Wenn im Text keine Termine im Zeitraum vorkommen, antworte mit {"items":[]}.',
  ].join('\n');

  const userPrompt = [
    `Heutiges Datum: ${bounds.startIso}`,
    `Zeitraum-Ende: ${bounds.endIso}`,
    '',
    'Ausgelesener Portal-Inhalt:',
    cleanedTextBundle.slice(0, 28_000),
  ].join('\n');

  for (const model of FREE_GEMINI_TEXT_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });
      const text = response.text?.trim() ?? '';
      if (!text) continue;

      const rawList = extractJsonArrayFromModelText(text);
      if (!rawList) continue;

      const validated: SchoolScheduleItem[] = [];
      for (const entry of rawList) {
        const sanitized = sanitizeScheduleItem(entry, bounds);
        if (sanitized) {
          validated.push(sanitized);
        }
      }
      return { ok: true, items: validated };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isModelUnavailableError(msg)) {
        continue;
      }
      return { ok: false, items: [] };
    }
  }

  return { ok: false, items: [] };
}

export async function startPortalSession(
  bridgeUrl: string,
  portalUrl: string
): Promise<PortalSessionStartResult> {
  const baseUrl = normalizeBridgeUrl(bridgeUrl);
  const trimmedPortal = portalUrl.trim();
  if (!trimmedPortal) {
    return {
      ok: false,
      error: 'Bitte gib zuerst die Webadresse deines Schul- oder Uni-Portals ein.',
    };
  }

  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/portal/session/start`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portalUrl: trimmedPortal }),
      },
      START_TIMEOUT_MS
    );

    const data = (await res.json().catch(() => ({}))) as Partial<PortalSessionStartResult>;
    if (!res.ok || data.ok !== true) {
      return {
        ok: false,
        error:
          typeof data.error === 'string' && data.error.trim()
            ? data.error.trim()
            : `Portal-Fenster konnte nicht gestartet werden (Status ${res.status}).`,
      };
    }

    return {
      ok: true,
      sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
      browserName: typeof data.browserName === 'string' ? data.browserName : undefined,
      portalUrl: typeof data.portalUrl === 'string' ? data.portalUrl : trimmedPortal,
      currentUrl: typeof data.currentUrl === 'string' ? data.currentUrl : undefined,
      pageTitle: typeof data.pageTitle === 'string' ? data.pageTitle : undefined,
      looksLikeLogin: Boolean(data.looksLikeLogin),
    };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? 'Der Portal-Browser hat nicht rechtzeitig geantwortet. Versuche es kurz erneut.'
        : 'Die lokale OpenStudy-Bridge ist nicht erreichbar. Starte sie lokal und versuche es erneut.',
    };
  }
}

export async function getPortalSessionStatus(
  bridgeUrl: string,
  sessionId: string
): Promise<PortalSessionStatusResult> {
  const baseUrl = normalizeBridgeUrl(bridgeUrl);
  const query = sessionId.trim() ? `?sessionId=${encodeURIComponent(sessionId.trim())}` : '';

  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/portal/session/status${query}`,
      { method: 'GET' },
      STATUS_TIMEOUT_MS
    );

    const data = (await res.json().catch(() => ({}))) as Partial<PortalSessionStatusResult>;
    if (!res.ok || data.ok !== true) {
      return {
        ok: false,
        active: false,
        currentUrl: '',
        pageTitle: '',
        looksLikeLogin: false,
        error:
          typeof data.error === 'string' && data.error.trim()
            ? data.error.trim()
            : `Portal-Status nicht verfügbar (Status ${res.status}).`,
      };
    }

    return {
      ok: true,
      active: Boolean(data.active),
      currentUrl: typeof data.currentUrl === 'string' ? data.currentUrl : '',
      pageTitle: typeof data.pageTitle === 'string' ? data.pageTitle : '',
      looksLikeLogin: Boolean(data.looksLikeLogin),
    };
  } catch {
    return {
      ok: false,
      active: false,
      currentUrl: '',
      pageTitle: '',
      looksLikeLogin: false,
      error: 'Die lokale Bridge ist momentan nicht erreichbar.',
    };
  }
}

export async function closePortalSession(bridgeUrl: string, sessionId: string): Promise<void> {
  const baseUrl = normalizeBridgeUrl(bridgeUrl);
  try {
    await fetchWithTimeout(
      `${baseUrl}/api/portal/session/close`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId.trim() }),
      },
      CLOSE_TIMEOUT_MS
    );
  } catch {
    // Ignore close errors if bridge or browser window is already gone
  }
}

export async function extractPortalAgenda(params: {
  bridgeUrl: string;
  sessionId: string;
  geminiApiKey?: string;
  horizonDays?: number;
  closeAfter?: boolean;
}): Promise<PortalExtractResult> {
  const baseUrl = normalizeBridgeUrl(params.bridgeUrl);
  const horizonDays = clampHorizonDays(params.horizonDays);
  const closeAfter = params.closeAfter !== false;
  const bounds = getHorizonBounds(horizonDays);

  let bridgePayload: {
    ok?: boolean;
    items?: unknown[];
    visitedPages?: Array<{ url?: unknown; title?: unknown }>;
    cleanedTextBundle?: unknown;
    horizonDays?: unknown;
    error?: unknown;
  };

  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/portal/session/extract`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: params.sessionId.trim(),
          horizonDays,
          closeAfter,
        }),
      },
      EXTRACT_TIMEOUT_MS
    );

    bridgePayload = (await res.json().catch(() => ({}))) as typeof bridgePayload;
    if (!res.ok || bridgePayload.ok !== true) {
      return {
        ok: false,
        items: [],
        visitedPages: [],
        cleanedTextBundle: '',
        horizonDays,
        usedAiStructuring: false,
        error:
          typeof bridgePayload.error === 'string' && bridgePayload.error.trim()
            ? bridgePayload.error.trim()
            : `Die Portal-Agenda konnte nicht eingelesen werden (Status ${res.status}).`,
      };
    }
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return {
      ok: false,
      items: [],
      visitedPages: [],
      cleanedTextBundle: '',
      horizonDays,
      usedAiStructuring: false,
      error: aborted
        ? 'Das Einlesen der Portal-Agenda hat länger als 45 Sekunden gedauert. Öffne direkt deine Agenda-Seite im Portal-Fenster und versuche es erneut.'
        : 'Verbindung zur lokalen OpenStudy-Bridge während des Einlesens unterbrochen.',
    };
  }

  const effectiveHorizonDays =
    typeof bridgePayload.horizonDays === 'number' && Number.isFinite(bridgePayload.horizonDays)
      ? clampHorizonDays(bridgePayload.horizonDays)
      : horizonDays;
  const effectiveBounds = getHorizonBounds(effectiveHorizonDays);

  const deterministicItems: SchoolScheduleItem[] = [];
  if (Array.isArray(bridgePayload.items)) {
    for (const rawItem of bridgePayload.items) {
      const sanitized = sanitizeScheduleItem(rawItem, effectiveBounds);
      if (sanitized) {
        deterministicItems.push(sanitized);
      }
    }
  }

  const visitedPages: Array<{ url: string; title: string }> = [];
  if (Array.isArray(bridgePayload.visitedPages)) {
    for (const entry of bridgePayload.visitedPages) {
      if (!entry || typeof entry !== 'object') continue;
      const url = typeof entry.url === 'string' ? entry.url.trim() : '';
      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      if (url || title) {
        visitedPages.push({ url, title: title || url });
      }
    }
  }

  const cleanedTextBundle =
    typeof bridgePayload.cleanedTextBundle === 'string'
      ? bridgePayload.cleanedTextBundle.slice(0, 28_000)
      : '';

  let aiItems: SchoolScheduleItem[] = [];
  let usedAiStructuring = false;

  const trimmedGeminiKey = params.geminiApiKey?.trim() || '';
  if (trimmedGeminiKey && cleanedTextBundle.trim().length > 40) {
    const aiResult = await structureAgendaWithGemini({
      geminiApiKey: trimmedGeminiKey,
      cleanedTextBundle,
      horizonDays: effectiveHorizonDays,
      bounds: effectiveBounds,
    });
    if (aiResult.ok) {
      aiItems = aiResult.items;
      usedAiStructuring = true;
    }
  }

  const mergedItems = mergePortalItems(aiItems, deterministicItems);

  return {
    ok: true,
    items: mergedItems,
    visitedPages,
    cleanedTextBundle,
    horizonDays: effectiveHorizonDays,
    usedAiStructuring,
  };
}
