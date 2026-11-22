import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Calendar,
  CalendarDays,
  Check,
  ChevronDown,
  CopyPlus,
  ExternalLink,
  Eye,
  EyeOff,
  FileDown,
  FileText,
  FileUp,
  FolderOpen,
  Globe,
  GraduationCap,
  KeyRound,
  Layers,
  Link2,
  Loader2,
  MonitorPlay,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  MainView,
  NoteBlock,
  ObsidianNote,
  OpenStudyState,
  ProviderConfig,
  SchoolScheduleItem,
  StudyCard,
  StudyNotePage,
  SubjectCourse,
} from '../types';
import {
  closePortalSession,
  extractPortalAgenda,
  getPortalSessionStatus,
  startPortalSession,
} from '../services/portalSync';

interface FsFileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

interface FsDirectoryHandleLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FsFileHandleLike | FsDirectoryHandleLike>;
}

interface DetectedObsidianVault {
  id: string;
  name: string;
  path: string;
  isOpen: boolean;
  exists: boolean;
}

interface OneNoteNotebookSummary {
  id: string;
  name: string;
  sectionCount: number;
  pageCount: number;
}

interface OneNoteRecentPage {
  id: string;
  name: string;
  notebook: string;
  section: string;
  lastModified: string;
}

interface BridgeSyncSummary {
  obsidianNotesCount: number;
  oneNotePagesCount: number;
  upcoming30Days: Array<{
    title: string;
    date: string;
    courseTitle: string;
    source: 'smart-import';
  }>;
  recentOneNotePages: OneNoteRecentPage[];
  sampleObsidianNotes: ObsidianNote[];
}

interface BridgeFetchResult<T> {
  reachable: boolean;
  ok: boolean;
  data: T | null;
}

async function fetchBridgeJson<T>(
  url: string,
  options?: RequestInit,
  timeoutMs = 5000
): Promise<BridgeFetchResult<T>> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return { reachable: true, ok: res.ok, data };
  } catch {
    return { reachable: false, ok: false, data: null };
  } finally {
    window.clearTimeout(timer);
  }
}

async function collectMarkdownFromDirectory(
  dirHandle: FsDirectoryHandleLike,
  prefix = ''
): Promise<Array<{ file: File; relPath: string }>> {
  const results: Array<{ file: File; relPath: string }> = [];
  for await (const entry of dirHandle.values()) {
    if (entry.name.startsWith('.')) continue;
    const nextPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      const nested = await collectMarkdownFromDirectory(entry, nextPath);
      results.push(...nested);
    } else if (entry.kind === 'file' && /\.(md|markdown)$/i.test(entry.name)) {
      const file = await entry.getFile();
      results.push({ file, relPath: nextPath });
    }
  }
  return results;
}

export interface ObsidianAndImportHubProps {
  state: OpenStudyState;
  onSetObsidianNotes: (notes: ObsidianNote[]) => void;
  onToggleObsidianContext: (path: string) => void;
  onAddCourse: (course: SubjectCourse) => void;
  onUpsertNote: (page: StudyNotePage) => void;
  onAddCards: (cards: StudyCard[]) => void;
  onAddSchoolScheduleItems: (items: SchoolScheduleItem[]) => void;
  onUpdateProvider: (patch: Partial<ProviderConfig>) => void;
  onLaunchPortalSync?: (portalUrl: string) => void;
  onNavigate?: (view: MainView) => void;
}

interface ActivePortalSession {
  sessionId: string;
  browserName: string;
  portalUrl: string;
  currentUrl: string;
  pageTitle: string;
  looksLikeLogin: boolean;
}

type HubTab = 'obsidian' | 'school' | 'notion';

const COURSE_COLORS = ['#0e4d48', '#d96b27', '#2a6e66', '#1f6d4c', '#7c634a'];

const AUTO_SYNC_INTERVALS: Array<{ minutes: number; label: string }> = [
  { minutes: 60, label: 'Stündlich' },
  { minutes: 1440, label: '1× täglich' },
  { minutes: 2880, label: 'Alle 2 Tage' },
];

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//OpenStudy//Academic Schedule//DE
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261208
SUMMARY:Mathematik Klausur: Differentialrechnung
CATEGORIES:Mathematik
END:VEVENT
BEGIN:VEVENT
DTSTART:20261214T093000Z
SUMMARY:Physik: Praktikum Mechanik & Energie
CATEGORIES:Physik
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261219
SUMMARY:Englisch: Mündliche Präsentation
CATEGORIES:Englisch
END:VEVENT
END:VCALENDAR`;

const SAMPLE_SYLLABUS = `# Mechanik & Energieerhaltung
- Gleichförmige und gleichmässig beschleunigte Bewegung beschreiben
- Newtonsche Gesetze auf Alltagsbeispiele anwenden
- Kinetische und potenzielle Energie berechnen

## Wichtige Begriffe & Formeln
Trägheitsgesetz: Ein Körper verharrt im Zustand der Ruhe oder der gleichförmigen geradlinigen Bewegung, sofern keine resultierende Kraft wirkt.
Aktionsprinzip: F = m * a (Kraft gleich Masse mal Beschleunigung).
Energieerhaltungssatz: In einem abgeschlossenen System bleibt die Gesamtenergie konstant; Energie wird nur umgewandelt.
> Merksatz: Immer zuerst alle wirkenden Kräfte als Vektoren skizzieren und Einheiten in SI-Grundeinheiten umrechnen.`;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function validateHttpsPortalUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    if (parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function formatShortDateTime(iso: string): string {
  if (!iso) return 'Noch nicht synchronisiert';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${year}, ${hh}:${mm}`;
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function extractWikilinks(markdown: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  const regex = /\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|[^[\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const target = match[1].trim();
    if (target && !seen.has(target.toLowerCase())) {
      seen.add(target.toLowerCase());
      links.push(target);
    }
  }
  return links;
}

function cleanNotionFilename(fileName: string): string {
  const withoutExt = fileName.replace(/\.(md|markdown|txt)$/i, '');
  // Notion exports append a 32-character hex UUID suffix after a space
  return withoutExt.replace(/\s+[0-9a-f]{32}$/i, '').trim() || 'Importierte Notiz';
}

function extractTitleFromMarkdown(markdown: string, fallbackName: string): string {
  const body = stripFrontmatter(markdown);
  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  return cleanNotionFilename(fallbackName);
}

function buildExcerpt(markdown: string): string {
  const body = stripFrontmatter(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s*(\[![^\]]+\]\s*)?/gm, '')
    .replace(/\[\[([^[\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^[\]]+)\]\]/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!body) return 'Leere Markdown-Datei';
  return body.length > 170 ? `${body.slice(0, 167).trim()}...` : body;
}

function normalizeBridgeNotes(
  incoming: ObsidianNote[],
  existing: ObsidianNote[]
): ObsidianNote[] {
  const existingSelection = new Map(
    existing.map((n) => [n.path, n.selectedForContext])
  );

  return incoming
    .filter((n) => n && typeof n.path === 'string')
    .map((note, idx) => {
      const content = typeof note.content === 'string' ? note.content : '';
      const title =
        typeof note.title === 'string' && note.title.trim()
          ? note.title.trim()
          : extractTitleFromMarkdown(content, note.path.split('/').pop() || note.path);
      const excerpt =
        typeof note.excerpt === 'string' && note.excerpt.trim()
          ? note.excerpt.trim()
          : buildExcerpt(content);
      const wikilinks = Array.isArray(note.wikilinks)
        ? note.wikilinks.filter((w): w is string => typeof w === 'string')
        : extractWikilinks(content);
      const prevSelected = existingSelection.get(note.path);

      return {
        path: note.path,
        title,
        excerpt,
        content,
        wikilinks,
        selectedForContext:
          prevSelected !== undefined
            ? prevSelected
            : typeof note.selectedForContext === 'boolean'
              ? note.selectedForContext
              : idx < 3,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function markdownToBlocks(markdown: string): NoteBlock[] {
  const body = stripFrontmatter(markdown);
  const lines = body.split(/\r?\n/);
  const blocks: NoteBlock[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      if (inCode) {
        blocks.push({
          id: makeId('blk'),
          type: 'code',
          text: codeLines.join('\n').trim(),
        });
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    if (!trimmed) continue;

    if (trimmed.startsWith('# ')) {
      blocks.push({ id: makeId('blk'), type: 'h1', text: trimmed.slice(2).trim() });
    } else if (/^#{2,6}\s+/.test(trimmed)) {
      blocks.push({
        id: makeId('blk'),
        type: 'h2',
        text: trimmed.replace(/^#{2,6}\s+/, '').trim(),
      });
    } else if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) {
      const checked = /^[-*]\s+\[[xX]\]/.test(trimmed);
      const text = trimmed.replace(/^[-*]\s+\[[ xX]\]\s+/, '').trim();
      blocks.push({ id: makeId('blk'), type: 'todo', text, checked });
    } else if (trimmed.startsWith('>')) {
      const cleaned = trimmed
        .replace(/^>\s*/, '')
        .replace(/^\[![^\]]+\]\s*/, '')
        .trim();
      if (cleaned) {
        blocks.push({ id: makeId('blk'), type: 'callout', text: cleaned });
      }
    } else {
      const cleaned = trimmed.replace(/^[-*•]\s+/, '').trim();
      blocks.push({ id: makeId('blk'), type: 'text', text: cleaned });
    }
  }

  if (inCode && codeLines.length > 0) {
    blocks.push({ id: makeId('blk'), type: 'code', text: codeLines.join('\n').trim() });
  }

  return blocks.length > 0
    ? blocks
    : [{ id: makeId('blk'), type: 'text', text: '' }];
}

function extractStarterCards(
  blocks: NoteBlock[],
  courseId: string,
  pageTitle: string
): StudyCard[] {
  const now = Date.now();
  const seen = new Set<string>();
  const cards: StudyCard[] = [];
  let heading = pageTitle;

  const pushCard = (front: string, back: string, hint?: string) => {
    const key = front.trim().toLowerCase();
    if (!key || seen.has(key) || back.trim().length < 6) return;
    seen.add(key);
    cards.push({
      id: makeId('card'),
      courseId,
      front: front.trim(),
      back: back.trim(),
      hint,
      interval: 0,
      ease: 2.5,
      reps: 0,
      due: now,
    });
  };

  for (const block of blocks) {
    const raw = block.text.trim();
    if (!raw) continue;
    if (block.type === 'h1' || block.type === 'h2') {
      heading = raw;
      continue;
    }
    if (block.type === 'callout') {
      const prefix = raw.match(/^([^:]{3,28}):\s+(.+)$/s);
      if (prefix) {
        pushCard(`${prefix[1].trim()} (${heading})`, prefix[2].trim(), pageTitle);
      } else {
        pushCard(`Wichtigster Merksatz zu «${heading}»`, raw, pageTitle);
      }
      continue;
    }
    if (block.type === 'code') {
      pushCard(`Formel / Beispiel zu «${heading}»`, raw, 'Code / Formel');
      continue;
    }
    if (block.type === 'text') {
      const colon = raw.match(/^([^:]{2,64}):\s+(.{8,})$/s);
      if (colon) {
        const term = colon[1].replace(/^[\d.)\-*•\s]+/, '').trim();
        pushCard(`Erkläre: ${term}`, colon[2].trim(), heading);
        continue;
      }
      const pair = raw.match(/^([^—–\->=]{2,60})\s+(?:->|=>|—|–)\s+(.{8,})$/s);
      if (pair) {
        pushCard(pair[1].trim(), pair[2].trim(), heading);
      }
    }
  }

  return cards.slice(0, 16);
}

interface ParsedIcsEvent {
  uid: string;
  title: string;
  date: string;
  courseTitle: string;
  selected: boolean;
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function parseIcsDate(rawValue: string): string | null {
  const cleaned = rawValue.trim();
  const match = cleaned.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${m}-${d}`;
}

function parseIcsText(rawIcs: string): ParsedIcsEvent[] {
  const unfolded = rawIcs.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const events: ParsedIcsEvent[] = [];
  let inEvent = false;
  let summary = '';
  let dtStart = '';
  let category = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      summary = '';
      dtStart = '';
      category = '';
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      if (inEvent && summary && dtStart) {
        const inferredCourse =
          category ||
          (summary.includes(':') ? summary.split(':')[0].trim() : '') ||
          (summary.includes(' - ') ? summary.split(' - ')[0].trim() : '') ||
          'Allgemein';

        events.push({
          uid: makeId('ics'),
          title: summary,
          date: dtStart,
          courseTitle: inferredCourse.slice(0, 42),
          selected: true,
        });
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const propKey = trimmed.slice(0, colonIdx).split(';')[0].toUpperCase();
    const propVal = trimmed.slice(colonIdx + 1);

    if (propKey === 'SUMMARY') {
      summary = unescapeIcsText(propVal);
    } else if (propKey === 'DTSTART') {
      const parsedDate = parseIcsDate(propVal);
      if (parsedDate) dtStart = parsedDate;
    } else if (propKey === 'CATEGORIES' && !category) {
      category = unescapeIcsText(propVal.split(',')[0] ?? '');
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

function parseSyllabusToObjectives(
  rawText: string,
  courseTitle: string
): SubjectCourse['objectives'] {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const objectives: SubjectCourse['objectives'] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (objectives.length >= 8) break;
    if (line.startsWith('```')) continue;

    const cleaned = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*•]\s+(\[[ xX]\]\s+)?/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^>\s*/, '')
      .trim();

    if (cleaned.length < 5) continue;

    const colonIdx = cleaned.indexOf(':');
    let title = cleaned;
    let summary = `Kernelement aus dem importierten Stoff zu ${courseTitle}.`;

    if (colonIdx > 2 && colonIdx < 68) {
      title = cleaned.slice(0, colonIdx).trim();
      const rest = cleaned.slice(colonIdx + 1).trim();
      if (rest.length >= 8) {
        summary = rest;
      }
    } else if (cleaned.length > 74) {
      title = `${cleaned.slice(0, 68).trim()}...`;
      summary = cleaned;
    }

    const norm = title.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);

    objectives.push({
      id: makeId('obj'),
      title,
      summary,
      mastery: 'open',
    });
  }

  if (objectives.length === 0) {
    objectives.push({
      id: makeId('obj'),
      title: `Grundlagen: ${courseTitle}`,
      summary: 'Strukturierter Einstieg basierend auf den importierten Notizen.',
      mastery: 'open',
    });
  }

  return objectives;
}

function formatCountdown(isoDate: string): {
  label: string;
  tone: 'accent' | 'warning' | 'muted';
} {
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return { label: isoDate, tone: 'muted' };
  }
  const target = new Date(parts[0], parts[1] - 1, parts[2]);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round(
    (target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (diffDays === 0) return { label: 'Heute', tone: 'warning' };
  if (diffDays === 1) return { label: 'Morgen', tone: 'warning' };
  if (diffDays > 1 && diffDays <= 7) {
    return { label: `In ${diffDays} Tagen`, tone: 'warning' };
  }
  if (diffDays > 7) {
    return { label: `In ${diffDays} Tagen`, tone: 'accent' };
  }
  return { label: 'Vergangen', tone: 'muted' };
}

export function ObsidianAndImportHub({
  state,
  onSetObsidianNotes,
  onToggleObsidianContext,
  onAddCourse,
  onUpsertNote,
  onAddCards,
  onAddSchoolScheduleItems,
  onUpdateProvider,
  onLaunchPortalSync,
  onNavigate,
}: ObsidianAndImportHubProps) {
  const [activeTab, setActiveTab] = useState<HubTab>('obsidian');

  const normalizedBridgeUrl = useMemo(
    () => (state.provider.bridgeUrl.trim() || 'http://127.0.0.1:4319').replace(/\/+$/, ''),
    [state.provider.bridgeUrl]
  );

  // --- Tab 1: Obsidian & OneNote state ---
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const singleMdInputRef = useRef<HTMLInputElement | null>(null);
  const [bridgeReachable, setBridgeReachable] = useState<boolean | null>(null);
  const [detectingVaults, setDetectingVaults] = useState(false);
  const [detectedVaults, setDetectedVaults] = useState<DetectedObsidianVault[]>([]);
  const [connectingVaultId, setConnectingVaultId] = useState<string | null>(null);

  const [obsidianSearch, setObsidianSearch] = useState('');
  const [onlySelectedContext, setOnlySelectedContext] = useState(false);
  const [obsidianTargetCourseId, setObsidianTargetCourseId] = useState<string>(
    () => state.activeCourseId || state.courses[0]?.id || ''
  );
  const [expandedObsidianPath, setExpandedObsidianPath] = useState<string | null>(null);
  const [copiedPaths, setCopiedPaths] = useState<Record<string, boolean>>({});
  const [obsidianStatus, setObsidianStatus] = useState<string | null>(null);
  const [loadingVault, setLoadingVault] = useState(false);
  const [vaultFolderName, setVaultFolderName] = useState<string | null>(null);

  // Local OneNote Desktop state
  const [scanningOneNote, setScanningOneNote] = useState(false);
  const [oneNoteScanned, setOneNoteScanned] = useState(false);
  const [oneNoteAvailable, setOneNoteAvailable] = useState<boolean | null>(null);
  const [oneNoteNotebooks, setOneNoteNotebooks] = useState<OneNoteNotebookSummary[]>([]);
  const [oneNoteRecentPages, setOneNoteRecentPages] = useState<OneNoteRecentPage[]>([]);
  const [oneNoteTotalPages, setOneNoteTotalPages] = useState<number>(0);
  const [oneNoteStatus, setOneNoteStatus] = useState<string | null>(null);
  const [importingOneNoteId, setImportingOneNoteId] = useState<string | null>(null);
  const [importedOneNoteIds, setImportedOneNoteIds] = useState<Record<string, boolean>>({});

  // --- Tab 2: School Portal & Auto-Sync state ---
  const [portalMessage, setPortalMessage] = useState<string | null>(null);
  const [portalSession, setPortalSession] = useState<ActivePortalSession | null>(null);
  const [portalStarting, setPortalStarting] = useState(false);
  const [portalExtracting, setPortalExtracting] = useState(false);
  const [portalBridgeFallbackUrl, setPortalBridgeFallbackUrl] = useState<string | null>(null);
  const [portalImportSummary, setPortalImportSummary] = useState<{
    count: number;
    pagesCount: number;
  } | null>(null);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncSavingConfig, setSyncSavingConfig] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncCounts, setSyncCounts] = useState<{
    obsidian: number | null;
    oneNote: number | null;
    upcoming30: number | null;
  }>({ obsidian: null, oneNote: null, upcoming30: null });

  // Collapsed legacy import formats (.ics, syllabus, manual entry)
  const icsFileInputRef = useRef<HTMLInputElement | null>(null);
  const syllabusFileInputRef = useRef<HTMLInputElement | null>(null);
  const [icsRawText, setIcsRawText] = useState('');
  const [parsedIcsEvents, setParsedIcsEvents] = useState<ParsedIcsEvent[]>([]);
  const [icsMessage, setIcsMessage] = useState<string | null>(null);

  const [importCourseTitle, setImportCourseTitle] = useState('');
  const [importCategory, setImportCategory] =
    useState<SubjectCourse['category']>('science');
  const [importExamDate, setImportExamDate] = useState('');
  const [syllabusText, setSyllabusText] = useState('');
  const [syllabusResult, setSyllabusResult] = useState<string | null>(null);

  const [manualTitle, setManualTitle] = useState('');
  const [manualCourse, setManualCourse] = useState('');
  const [manualDate, setManualDate] = useState('');
  const [manualMessage, setManualMessage] = useState<string | null>(null);

  // --- Tab 3: Notion state ---
  const notionFileInputRef = useRef<HTMLInputElement | null>(null);
  const [notionTargetCourseId, setNotionTargetCourseId] = useState<string>(
    () => state.activeCourseId || state.courses[0]?.id || ''
  );
  const [notionAlsoCreateCards, setNotionAlsoCreateCards] = useState(true);
  const [notionDragActive, setNotionDragActive] = useState(false);
  const [notionImportLog, setNotionImportLog] = useState<
    Array<{ title: string; blocks: number; cards: number }>
  >([]);
  const [notionTokenDraft, setNotionTokenDraft] = useState(
    state.provider.notionToken
  );
  const [showNotionToken, setShowNotionToken] = useState(false);
  const [tokenSavedMsg, setTokenSavedMsg] = useState<string | null>(null);

  const resolvedObsidianCourseId =
    obsidianTargetCourseId &&
    state.courses.some((c) => c.id === obsidianTargetCourseId)
      ? obsidianTargetCourseId
      : state.activeCourseId || state.courses[0]?.id || '';

  const resolvedNotionCourseId =
    notionTargetCourseId &&
    state.courses.some((c) => c.id === notionTargetCourseId)
      ? notionTargetCourseId
      : state.activeCourseId || state.courses[0]?.id || '';

  // Derived metrics
  const activeContextCount = useMemo(
    () => state.obsidianNotes.filter((n) => n.selectedForContext).length,
    [state.obsidianNotes]
  );

  const filteredObsidianNotes = useMemo(() => {
    const q = obsidianSearch.trim().toLowerCase();
    return state.obsidianNotes.filter((n) => {
      if (onlySelectedContext && !n.selectedForContext) return false;
      if (!q) return true;
      return (
        n.title.toLowerCase().includes(q) ||
        n.path.toLowerCase().includes(q) ||
        n.excerpt.toLowerCase().includes(q) ||
        n.wikilinks.some((w) => w.toLowerCase().includes(q))
      );
    });
  }, [state.obsidianNotes, obsidianSearch, onlySelectedContext]);

  const sortedSchedule = useMemo(
    () =>
      [...state.schoolSchedule].sort((a, b) => {
        const dateCmp = a.date.localeCompare(b.date);
        if (dateCmp !== 0) return dateCmp;
        return (a.startTime ?? '').localeCompare(b.startTime ?? '');
      }),
    [state.schoolSchedule]
  );

  const upcoming30DaysLocalCount = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const limit = today + 90 * 24 * 60 * 60 * 1000;
    return state.schoolSchedule.filter((item) => {
      const parts = item.date.split('-').map(Number);
      if (parts.length !== 3 || parts.some(Number.isNaN)) return false;
      const t = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
      return t >= today && t <= limit;
    }).length;
  }, [state.schoolSchedule]);

  // --- Auto-detect local Obsidian vaults & bridge sync status on mount ---
  const detectLocalVaults = useCallback(async () => {
    setDetectingVaults(true);
    try {
      const res = await fetchBridgeJson<{
        ok?: boolean;
        vaults?: DetectedObsidianVault[];
      }>(`${normalizedBridgeUrl}/api/obsidian/detect`, { method: 'GET' }, 3500);

      if (!res.reachable) {
        setBridgeReachable(false);
        setDetectedVaults([]);
        return;
      }

      setBridgeReachable(true);
      if (res.ok && res.data?.ok && Array.isArray(res.data.vaults)) {
        setDetectedVaults(
          res.data.vaults.filter(
            (v) => v && typeof v.path === 'string' && v.exists !== false
          )
        );
      } else {
        setDetectedVaults([]);
      }
    } finally {
      setDetectingVaults(false);
    }
  }, [normalizedBridgeUrl]);

  const lastAutoSyncAtRef = useRef(state.provider.lastAutoSyncAt);
  lastAutoSyncAtRef.current = state.provider.lastAutoSyncAt;

  const onUpdateProviderRef = useRef(onUpdateProvider);
  onUpdateProviderRef.current = onUpdateProvider;

  useEffect(() => {
    let cancelled = false;
    void detectLocalVaults();

    void fetchBridgeJson<{
      ok?: boolean;
      lastRunAt?: string;
      summary?: Partial<BridgeSyncSummary>;
      config?: {
        lastRunAt?: string;
        lastSummary?: Partial<BridgeSyncSummary>;
      };
    }>(`${normalizedBridgeUrl}/api/sync/status`, { method: 'GET' }, 3500).then((res) => {
      if (cancelled || !res.reachable || !res.ok || !res.data?.ok) return;
      setBridgeReachable(true);
      const summary = res.data.summary ?? res.data.config?.lastSummary;
      const remoteLastRunAt = res.data.config?.lastRunAt || res.data.lastRunAt;
      const localLastRunAt = lastAutoSyncAtRef.current;
      if (
        remoteLastRunAt &&
        (!localLastRunAt || remoteLastRunAt > localLastRunAt)
      ) {
        onUpdateProviderRef.current({ lastAutoSyncAt: remoteLastRunAt });
      }
      if (summary) {
        setSyncCounts({
          obsidian:
            typeof summary.obsidianNotesCount === 'number'
              ? summary.obsidianNotesCount
              : null,
          oneNote:
            typeof summary.oneNotePagesCount === 'number'
              ? summary.oneNotePagesCount
              : null,
          upcoming30: Array.isArray(summary.upcoming30Days)
            ? summary.upcoming30Days.length
            : null,
        });
        if (
          Array.isArray(summary.recentOneNotePages) &&
          summary.recentOneNotePages.length > 0
        ) {
          setOneNoteRecentPages((prev) =>
            prev.length > 0 ? prev : summary.recentOneNotePages ?? []
          );
          if (typeof summary.oneNotePagesCount === 'number') {
            setOneNoteTotalPages(summary.oneNotePagesCount);
          }
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [detectLocalVaults, normalizedBridgeUrl]);

  // --- Helper: Push auto-sync config to local bridge ---
  const pushSyncConfigToBridge = useCallback(
    async (override?: {
      enabled?: boolean;
      intervalMinutes?: number;
      vaultPath?: string;
      portalUrl?: string;
    }) => {
      const rawPortal = override?.portalUrl ?? state.provider.schoolPortalUrl ?? '';
      const safePortalUrl = validateHttpsPortalUrl(rawPortal) ?? '';
      const payload = {
        enabled: override?.enabled ?? state.provider.autoSyncEnabled,
        intervalMinutes:
          override?.intervalMinutes ?? (state.provider.autoSyncIntervalMinutes || 2880),
        vaultPath: override?.vaultPath ?? state.provider.obsidianVaultPath ?? '',
        portalUrl: safePortalUrl,
        scanOneNote: true,
      };

      const res = await fetchBridgeJson<{ ok?: boolean }>(
        `${normalizedBridgeUrl}/api/sync/config`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        4500
      );
      if (res.reachable) {
        setBridgeReachable(true);
      } else {
        setBridgeReachable(false);
      }
      return res;
    },
    [
      normalizedBridgeUrl,
      state.provider.autoSyncEnabled,
      state.provider.autoSyncIntervalMinutes,
      state.provider.obsidianVaultPath,
      state.provider.schoolPortalUrl,
    ]
  );

  // --- Handlers: Tab 1 (Obsidian & OneNote) ---
  const handleConnectDetectedVault = async (vault: DetectedObsidianVault) => {
    setConnectingVaultId(vault.id);
    setObsidianStatus(null);
    try {
      const res = await fetchBridgeJson<{
        ok?: boolean;
        notes?: ObsidianNote[];
        error?: string;
      }>(
        `${normalizedBridgeUrl}/api/obsidian/notes?vaultPath=${encodeURIComponent(vault.path)}`,
        { method: 'GET' },
        12000
      );

      if (!res.reachable) {
        setBridgeReachable(false);
        setObsidianStatus(
          'Lokale Begleit-Bridge nicht erreichbar. Wähle den Ordner alternativ über «Ordner manuell wählen».'
        );
        return;
      }

      if (!res.ok || !res.data?.ok || !Array.isArray(res.data.notes)) {
        setObsidianStatus(
          res.data?.error || `Notizen aus «${vault.name}» konnten nicht geladen werden.`
        );
        return;
      }

      const normalized = normalizeBridgeNotes(res.data.notes, state.obsidianNotes);
      onSetObsidianNotes(normalized);
      onUpdateProvider({ obsidianVaultPath: vault.path });
      setVaultFolderName(vault.name);
      setSyncCounts((prev) => ({ ...prev, obsidian: normalized.length }));
      setObsidianStatus(
        `${normalized.length} Markdown-Notizen aus «${vault.name}» verbunden.`
      );

      if (state.provider.autoSyncEnabled) {
        void pushSyncConfigToBridge({ vaultPath: vault.path });
      }
    } finally {
      setConnectingVaultId(null);
    }
  };

  const processObsidianEntries = async (
    entries: Array<{ file: File; relPath: string }>,
    sourceLabel?: string
  ) => {
    if (entries.length === 0) {
      setObsidianStatus(
        'Im gewählten Ordner wurden keine Markdown-Dateien (.md) gefunden.'
      );
      return;
    }

    const existingSelection = new Map(
      state.obsidianNotes.map((n) => [n.path, n.selectedForContext])
    );

    const parsedNotes: ObsidianNote[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const { file, relPath } = entries[i];
      const content = await file.text();
      const title = extractTitleFromMarkdown(content, file.name);
      const excerpt = buildExcerpt(content);
      const wikilinks = extractWikilinks(content);
      const previouslySelected = existingSelection.get(relPath);

      parsedNotes.push({
        path: relPath,
        title,
        excerpt,
        content,
        wikilinks,
        selectedForContext:
          previouslySelected !== undefined ? previouslySelected : i < 3,
      });
    }

    parsedNotes.sort((a, b) => a.title.localeCompare(b.title));
    onSetObsidianNotes(parsedNotes);
    setObsidianStatus(
      `${parsedNotes.length} Markdown-Dateien${sourceLabel ? ` aus «${sourceLabel}»` : ''} lokal geladen.`
    );
  };

  const handleObsidianFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setLoadingVault(true);
    setObsidianStatus(null);

    try {
      const entries = Array.from(fileList)
        .filter((file) => {
          const relPath = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
          if (!/\.(md|markdown)$/i.test(file.name)) return false;
          if (relPath.split('/').some((seg) => seg.startsWith('.'))) return false;
          return true;
        })
        .map((file) => ({
          file,
          relPath: (file.webkitRelativePath || file.name).replace(/\\/g, '/'),
        }));

      const firstRoot = entries[0]?.relPath.includes('/')
        ? entries[0].relPath.split('/')[0]
        : undefined;
      if (firstRoot) setVaultFolderName(firstRoot);

      await processObsidianEntries(entries, firstRoot);
    } finally {
      setLoadingVault(false);
    }
  };

  const handlePickObsidianDirectory = async () => {
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (opts?: {
          mode?: 'read' | 'readwrite';
        }) => Promise<FsDirectoryHandleLike>;
      }
    ).showDirectoryPicker;

    if (typeof picker !== 'function') {
      folderInputRef.current?.click();
      return;
    }

    setLoadingVault(true);
    setObsidianStatus(null);
    try {
      const dirHandle = await picker({ mode: 'read' });
      const entries = await collectMarkdownFromDirectory(dirHandle);
      setVaultFolderName(dirHandle.name);
      await processObsidianEntries(entries, dirHandle.name);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      folderInputRef.current?.click();
    } finally {
      setLoadingVault(false);
    }
  };

  const handleSetAllObsidianContext = (selected: boolean) => {
    onSetObsidianNotes(
      state.obsidianNotes.map((n) => ({ ...n, selectedForContext: selected }))
    );
  };

  const handleCopyObsidianNoteToWorkspace = (note: ObsidianNote) => {
    const courseId =
      resolvedObsidianCourseId ||
      state.activeCourseId ||
      state.courses[0]?.id ||
      'course-general';

    const page: StudyNotePage = {
      id: makeId('note'),
      courseId,
      title: note.title,
      tags: ['obsidian'],
      updatedAt: todayIso(),
      source: 'obsidian',
      blocks: markdownToBlocks(note.content),
    };

    onUpsertNote(page);
    setCopiedPaths((prev) => ({ ...prev, [note.path]: true }));
    setObsidianStatus(
      `«${note.title}» wurde in deine lokalen OpenStudy-Notizen kopiert.`
    );
  };

  const handleScanOneNote = async () => {
    setScanningOneNote(true);
    setOneNoteStatus(null);
    try {
      const res = await fetchBridgeJson<{
        ok?: boolean;
        available?: boolean;
        notebooks?: OneNoteNotebookSummary[];
        recentPages?: OneNoteRecentPage[];
        totalPages?: number;
        error?: string;
      }>(`${normalizedBridgeUrl}/api/onenote/scan`, { method: 'GET' }, 14000);

      if (!res.reachable) {
        setBridgeReachable(false);
        setOneNoteStatus(
          'Lokale Begleit-Bridge nicht aktiv. Sobald sie auf diesem PC läuft, liest OpenStudy deine OneNote-Notizbücher direkt lokal aus.'
        );
        return;
      }

      setBridgeReachable(true);
      setOneNoteScanned(true);

      if (!res.ok || !res.data?.ok) {
        setOneNoteStatus(
          res.data?.error || 'OneNote-Scan konnte nicht abgeschlossen werden.'
        );
        return;
      }

      const available = Boolean(res.data.available);
      const notebooks = Array.isArray(res.data.notebooks) ? res.data.notebooks : [];
      const recentPages = Array.isArray(res.data.recentPages)
        ? res.data.recentPages
        : [];
      const totalPages =
        typeof res.data.totalPages === 'number'
          ? res.data.totalPages
          : recentPages.length;

      setOneNoteAvailable(available);
      setOneNoteNotebooks(notebooks);
      setOneNoteRecentPages(recentPages);
      setOneNoteTotalPages(totalPages);
      setSyncCounts((prev) => ({ ...prev, oneNote: totalPages }));

      if (!available) {
        setOneNoteStatus('Auf diesem Gerät wurde kein lokales OneNote Desktop erkannt.');
      } else if (notebooks.length === 0 && recentPages.length === 0) {
        setOneNoteStatus('OneNote erkannt, es wurden jedoch keine lokalen Seiten gefunden.');
      }
    } finally {
      setScanningOneNote(false);
    }
  };

  const handleImportOneNotePage = async (page: OneNoteRecentPage) => {
    setImportingOneNoteId(page.id);
    setOneNoteStatus(null);
    try {
      const res = await fetchBridgeJson<{
        ok?: boolean;
        id?: string;
        title?: string;
        content?: string;
        error?: string;
      }>(
        `${normalizedBridgeUrl}/api/onenote/page?id=${encodeURIComponent(page.id)}`,
        { method: 'GET' },
        12000
      );

      if (!res.reachable) {
        setBridgeReachable(false);
        setOneNoteStatus('Lokale Begleit-Bridge nicht erreichbar.');
        return;
      }

      if (!res.ok || !res.data?.ok) {
        setOneNoteStatus(
          res.data?.error || `Seite «${page.name}» konnte nicht gelesen werden.`
        );
        return;
      }

      const courseId =
        resolvedObsidianCourseId ||
        state.activeCourseId ||
        state.courses[0]?.id ||
        'course-general';

      const notebookSlug = page.notebook
        .toLowerCase()
        .replace(/[^a-z0-9äöü-]+/gi, '-')
        .replace(/^-+|-+$/g, '');

      const notePage: StudyNotePage = {
        id: makeId('note'),
        courseId,
        title: (res.data.title || page.name || 'OneNote-Seite').trim(),
        tags: notebookSlug ? ['onenote', notebookSlug] : ['onenote'],
        updatedAt: todayIso(),
        source: 'school-import',
        blocks: markdownToBlocks(res.data.content || ''),
      };

      onUpsertNote(notePage);
      setImportedOneNoteIds((prev) => ({ ...prev, [page.id]: true }));
      setOneNoteStatus(
        `«${notePage.title}» wurde als OpenStudy-Notiz übernommen.`
      );
    } finally {
      setImportingOneNoteId(null);
    }
  };

  // --- Handlers: Tab 2 (School Portal & Auto-Sync) ---
  const activePortalSessionId = portalSession?.sessionId ?? null;

  useEffect(() => {
    if (!activePortalSessionId || portalExtracting) return;
    let cancelled = false;
    let inFlight = false;

    const pollStatus = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const status = await getPortalSessionStatus(
          normalizedBridgeUrl,
          activePortalSessionId
        );
        if (cancelled) return;
        if (!status.ok) return;
        if (!status.active) {
          setPortalSession((prev) =>
            prev?.sessionId === activePortalSessionId ? null : prev
          );
          setPortalMessage('Das Portal-Fenster wurde geschlossen.');
          return;
        }
        setPortalSession((prev) => {
          if (!prev || prev.sessionId !== activePortalSessionId) return prev;
          return {
            ...prev,
            currentUrl: status.currentUrl || prev.currentUrl,
            pageTitle: status.pageTitle || prev.pageTitle,
            looksLikeLogin: Boolean(status.looksLikeLogin),
          };
        });
      } catch {
        // Keep active session visible on transient poll hiccups
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void pollStatus();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activePortalSessionId, portalExtracting, normalizedBridgeUrl]);

  const handleOpenSchoolPortal = () => {
    const validUrl = validateHttpsPortalUrl(state.provider.schoolPortalUrl);
    if (!validUrl) {
      setPortalMessage(
        'Bitte gib eine gültige Webadresse ein, zum Beispiel portal.schule.example.'
      );
      setPortalBridgeFallbackUrl(null);
      return;
    }
    setPortalMessage(null);
    setPortalBridgeFallbackUrl(null);
    if (validUrl !== state.provider.schoolPortalUrl) {
      onUpdateProvider({ schoolPortalUrl: validUrl });
    }
    window.open(validUrl, '_blank', 'noopener,noreferrer');
  };

  const handleStartHermesPortalReader = async () => {
    const validUrl = validateHttpsPortalUrl(state.provider.schoolPortalUrl);
    if (!validUrl) {
      setPortalMessage(
        'Bitte gib eine gültige Webadresse ein, zum Beispiel portal.schule.example.'
      );
      setPortalBridgeFallbackUrl(null);
      return;
    }
    if (validUrl !== state.provider.schoolPortalUrl) {
      onUpdateProvider({ schoolPortalUrl: validUrl });
    }

    setPortalMessage(null);
    setPortalBridgeFallbackUrl(null);
    setPortalImportSummary(null);

    if (portalSession) {
      const prevId = portalSession.sessionId;
      setPortalSession(null);
      void closePortalSession(normalizedBridgeUrl, prevId).catch(() => undefined);
    }

    setPortalStarting(true);
    try {
      const res = await startPortalSession(normalizedBridgeUrl, validUrl);
      if (res.ok && res.sessionId) {
        setBridgeReachable(true);
        setPortalSession({
          sessionId: res.sessionId,
          browserName: res.browserName || 'Chrome',
          portalUrl: res.portalUrl || validUrl,
          currentUrl: res.currentUrl || res.portalUrl || validUrl,
          pageTitle: res.pageTitle || '',
          looksLikeLogin: res.looksLikeLogin ?? true,
        });
        return;
      }

      const probe = await fetchBridgeJson<{ ok?: boolean }>(
        `${normalizedBridgeUrl}/api/sync/status`,
        { method: 'GET' },
        1800
      );
      if (!probe.reachable) {
        setBridgeReachable(false);
        setPortalBridgeFallbackUrl(validUrl);
        setPortalMessage(
          'Für das automatische Einlesen direkt im PC-Browser wird die lokale Begleit-Bridge benötigt (npm run bridge).'
        );
      } else {
        setBridgeReachable(true);
        setPortalBridgeFallbackUrl(validUrl);
        setPortalMessage(
          res.error || 'Das Portal-Fenster konnte nicht automatisch geöffnet werden.'
        );
      }
    } catch {
      setBridgeReachable(false);
      setPortalBridgeFallbackUrl(validUrl);
      setPortalMessage(
        'Für das automatische Einlesen direkt im PC-Browser wird die lokale Begleit-Bridge benötigt (npm run bridge).'
      );
    } finally {
      setPortalStarting(false);
    }
  };

  const handleExtractPortalAgenda = async () => {
    if (!portalSession || portalExtracting) return;
    setPortalExtracting(true);
    setPortalMessage(null);
    setPortalImportSummary(null);
    try {
      const res = await extractPortalAgenda({
        bridgeUrl: normalizedBridgeUrl,
        sessionId: portalSession.sessionId,
        geminiApiKey: state.provider.geminiApiKey.trim() || undefined,
        horizonDays: 90,
        closeAfter: true,
      });

      if (!res.ok) {
        setPortalMessage(
          res.error || 'Die Portal-Agenda konnte nicht ausgelesen werden.'
        );
        return;
      }

      const extractedItems = Array.isArray(res.items) ? res.items : [];
      const visitedCount = Array.isArray(res.visitedPages)
        ? res.visitedPages.length
        : typeof res.visitedPages === 'number'
          ? res.visitedPages
          : 1;

      if (extractedItems.length > 0) {
        onAddSchoolScheduleItems(extractedItems);
      }

      setPortalSession(null);
      setPortalImportSummary({
        count: extractedItems.length,
        pagesCount: Math.max(1, visitedCount),
      });
    } catch {
      setPortalMessage(
        'Die Verbindung zur lokalen Begleit-Bridge wurde unterbrochen. Bitte versuche es erneut.'
      );
    } finally {
      setPortalExtracting(false);
    }
  };

  const handleClosePortalSession = async () => {
    if (!portalSession) return;
    const sid = portalSession.sessionId;
    setPortalSession(null);
    try {
      await closePortalSession(normalizedBridgeUrl, sid);
    } catch {
      // Ignore cleanup errors if window was already closed
    }
  };

  const handleToggleAutoSync = async () => {
    const nextEnabled = !state.provider.autoSyncEnabled;
    const intervalMinutes = state.provider.autoSyncIntervalMinutes || 2880;
    onUpdateProvider({
      autoSyncEnabled: nextEnabled,
      autoSyncIntervalMinutes: intervalMinutes,
    });
    setSyncSavingConfig(true);
    setSyncMessage(null);
    try {
      const res = await pushSyncConfigToBridge({
        enabled: nextEnabled,
        intervalMinutes,
      });
      if (!res.reachable) {
        setSyncMessage(
          'Einstellung lokal gespeichert. Sobald die lokale Bridge läuft, startet der Hintergrund-Abgleich automatisch.'
        );
      } else if (res.ok) {
        setSyncMessage(
          nextEnabled
            ? 'Hintergrund-Sync aktiviert.'
            : 'Hintergrund-Sync pausiert.'
        );
      }
    } finally {
      setSyncSavingConfig(false);
    }
  };

  const handleSelectAutoSyncInterval = async (minutes: number) => {
    onUpdateProvider({ autoSyncIntervalMinutes: minutes });
    setSyncSavingConfig(true);
    setSyncMessage(null);
    try {
      const res = await pushSyncConfigToBridge({ intervalMinutes: minutes });
      if (!res.reachable) {
        setSyncMessage('Intervall lokal gespeichert.');
      }
    } finally {
      setSyncSavingConfig(false);
    }
  };

  const handleRunSyncNow = async () => {
    setSyncRunning(true);
    setSyncMessage(null);
    try {
      const res = await fetchBridgeJson<{
        ok?: boolean;
        summary?: BridgeSyncSummary;
        error?: string;
      }>(
        `${normalizedBridgeUrl}/api/sync/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vaultPath: state.provider.obsidianVaultPath || '',
            portalUrl: validateHttpsPortalUrl(state.provider.schoolPortalUrl) ?? '',
            scanOneNote: true,
          }),
        },
        20000
      );

      if (!res.reachable) {
        setBridgeReachable(false);
        setSyncMessage(
          'Lokale Begleit-Bridge nicht erreichbar. Du kannst Termine jederzeit über «Mit Hermes 3 Monate einlesen» oder manuell übernehmen.'
        );
        return;
      }

      setBridgeReachable(true);

      if (!res.ok || !res.data?.ok || !res.data.summary) {
        setSyncMessage(
          res.data?.error || 'Synchronisation konnte nicht abgeschlossen werden.'
        );
        return;
      }

      const summary = res.data.summary;
      const nowIso = new Date().toISOString();

      // Deduplicate upcoming 30-day schedule items against state.schoolSchedule
      const existingKeys = new Set(
        state.schoolSchedule.map(
          (item) => `${item.date}::${item.title.trim().toLowerCase()}`
        )
      );
      const freshItems: SchoolScheduleItem[] = [];
      if (Array.isArray(summary.upcoming30Days)) {
        for (const entry of summary.upcoming30Days) {
          if (!entry?.title || !entry?.date) continue;
          const key = `${entry.date}::${entry.title.trim().toLowerCase()}`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          freshItems.push({
            id: makeId('sch'),
            title: entry.title.trim(),
            date: entry.date,
            courseTitle: (entry.courseTitle || 'Allgemein').trim(),
            source: 'smart-import',
          });
        }
      }

      if (freshItems.length > 0) {
        onAddSchoolScheduleItems(freshItems);
      }

      // Merge sampleObsidianNotes cleanly (preserving context toggles)
      if (
        Array.isArray(summary.sampleObsidianNotes) &&
        summary.sampleObsidianNotes.length > 0
      ) {
        const normalizedSamples = normalizeBridgeNotes(
          summary.sampleObsidianNotes,
          state.obsidianNotes
        );
        if (state.obsidianNotes.length === 0) {
          onSetObsidianNotes(normalizedSamples);
        } else {
          const byPath = new Map(state.obsidianNotes.map((n) => [n.path, n]));
          for (const sample of normalizedSamples) {
            byPath.set(sample.path, sample);
          }
          onSetObsidianNotes(
            Array.from(byPath.values()).sort((a, b) =>
              a.title.localeCompare(b.title)
            )
          );
        }
      }

      if (
        Array.isArray(summary.recentOneNotePages) &&
        summary.recentOneNotePages.length > 0
      ) {
        setOneNoteRecentPages(summary.recentOneNotePages);
        setOneNoteTotalPages(summary.oneNotePagesCount);
      }

      onUpdateProvider({ lastAutoSyncAt: nowIso });
      setSyncCounts({
        obsidian: summary.obsidianNotesCount,
        oneNote: summary.oneNotePagesCount,
        upcoming30: Array.isArray(summary.upcoming30Days)
          ? summary.upcoming30Days.length
          : upcoming30DaysLocalCount + freshItems.length,
      });

      setSyncMessage(
        freshItems.length > 0
          ? `Synchronisation abgeschlossen: ${freshItems.length} neue ${freshItems.length === 1 ? 'Termin' : 'Termine'} in den Prüfungsplan übernommen.`
          : 'Synchronisation abgeschlossen — alle Notizen und Termine sind aktuell.'
      );
    } finally {
      setSyncRunning(false);
    }
  };

  // --- Handlers: Collapsed Legacy Formats (.ics, Syllabus, Manual Entry) ---
  const handleParseIcsInput = (content: string) => {
    setIcsRawText(content);
    const events = parseIcsText(content);
    setParsedIcsEvents(events);
    if (events.length === 0) {
      setIcsMessage(
        'Keine gültigen VEVENT-Einträge mit SUMMARY und DTSTART erkannt.'
      );
    } else {
      setIcsMessage(
        `${events.length} ${events.length === 1 ? 'Termin' : 'Termine'} aus der Kalenderdatei erkannt.`
      );
    }
  };

  const handleIcsFileUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    const text = await file.text();
    handleParseIcsInput(text);
  };

  const handleCommitIcsEvents = () => {
    const chosen = parsedIcsEvents.filter((ev) => ev.selected);
    if (chosen.length === 0) {
      setIcsMessage('Bitte wähle mindestens einen Termin zum Übernehmen aus.');
      return;
    }

    const existingKeys = new Set(
      state.schoolSchedule.map(
        (s) => `${s.date}::${s.title.trim().toLowerCase()}`
      )
    );

    const newItems: SchoolScheduleItem[] = [];
    let skipped = 0;

    for (const ev of chosen) {
      const key = `${ev.date}::${ev.title.trim().toLowerCase()}`;
      if (existingKeys.has(key)) {
        skipped += 1;
        continue;
      }
      existingKeys.add(key);
      newItems.push({
        id: makeId('sch'),
        title: ev.title,
        date: ev.date,
        courseTitle: ev.courseTitle,
        source: 'ics',
      });
    }

    if (newItems.length > 0) {
      onAddSchoolScheduleItems(newItems);
      setIcsMessage(
        `${newItems.length} ${newItems.length === 1 ? 'Termin' : 'Termine'} in den Prüfungsplan übernommen${skipped > 0 ? ` (${skipped} bereits vorhanden)` : ''}.`
      );
      setParsedIcsEvents([]);
      setIcsRawText('');
    } else {
      setIcsMessage('Alle gewählten Termine sind bereits im Prüfungsplan vorhanden.');
    }
  };

  const handleSyllabusFileUpload = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    const text = await file.text();
    setSyllabusText(text);
    if (!importCourseTitle.trim()) {
      setImportCourseTitle(cleanNotionFilename(file.name));
    }
  };

  const handleRunSmartSyllabusImport = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = importCourseTitle.trim();
    const trimmedText = syllabusText.trim();
    if (!trimmedTitle || !trimmedText) {
      setSyllabusResult(
        'Bitte gib einen Kursnamen ein und füge Lernziele oder Notizen ein.'
      );
      return;
    }

    const courseId = makeId('course');
    const accentColor =
      COURSE_COLORS[state.courses.length % COURSE_COLORS.length];
    const objectives = parseSyllabusToObjectives(trimmedText, trimmedTitle);

    const newCourse: SubjectCourse = {
      id: courseId,
      title: trimmedTitle,
      category: importCategory,
      accentColor,
      examDate: importExamDate || undefined,
      description: buildExcerpt(trimmedText),
      objectives,
    };

    const blocks = markdownToBlocks(trimmedText);
    const notePage: StudyNotePage = {
      id: makeId('note'),
      courseId,
      title: `${trimmedTitle} — Stoffübersicht`,
      tags: ['schul-import', importCategory],
      updatedAt: todayIso(),
      source: 'school-import',
      blocks,
    };

    const starterCards = extractStarterCards(blocks, courseId, trimmedTitle);

    onAddCourse(newCourse);
    onUpsertNote(notePage);
    if (starterCards.length > 0) {
      onAddCards(starterCards);
    }

    let addedExam = false;
    if (importExamDate) {
      onAddSchoolScheduleItems([
        {
          id: makeId('sch'),
          title: `Prüfung / Leistungsnachweis: ${trimmedTitle}`,
          date: importExamDate,
          courseTitle: trimmedTitle.split('—')[0].trim(),
          source: 'smart-import',
        },
      ]);
      addedExam = true;
    }

    setSyllabusResult(
      `Kurs «${trimmedTitle}» angelegt: ${objectives.length} Lernziele, 1 strukturierte Notizseite (${blocks.length} Blöcke)${starterCards.length > 0 ? `, ${starterCards.length} Starter-Karteikarten` : ''}${addedExam ? ' und 1 Prüfungstermin' : ''}.`
    );
    setImportCourseTitle('');
    setImportExamDate('');
    setSyllabusText('');
  };

  const handleAddManualScheduleItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualTitle.trim() || !manualDate) return;
    onAddSchoolScheduleItems([
      {
        id: makeId('sch'),
        title: manualTitle.trim(),
        date: manualDate,
        courseTitle: manualCourse.trim() || 'Allgemein',
        source: 'manual',
      },
    ]);
    setManualMessage(`«${manualTitle.trim()}» am ${manualDate} hinzugefügt.`);
    setManualTitle('');
    setManualCourse('');
    setManualDate('');
  };

  // --- Handlers: Tab 3 (Notion) ---
  const importNotionMarkdownFiles = async (files: File[]) => {
    const valid = files.filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
    if (valid.length === 0) return;

    const courseId =
      resolvedNotionCourseId ||
      state.activeCourseId ||
      state.courses[0]?.id ||
      'course-general';

    const logEntries: Array<{ title: string; blocks: number; cards: number }> = [];
    const allGeneratedCards: StudyCard[] = [];

    for (const file of valid) {
      const content = await file.text();
      const title = extractTitleFromMarkdown(content, file.name);
      const blocks = markdownToBlocks(content);
      const page: StudyNotePage = {
        id: makeId('note'),
        courseId,
        title,
        tags: ['notion'],
        updatedAt: todayIso(),
        source: 'notion',
        blocks,
      };
      onUpsertNote(page);

      let cardCount = 0;
      if (notionAlsoCreateCards) {
        const cards = extractStarterCards(blocks, courseId, title);
        cardCount = cards.length;
        allGeneratedCards.push(...cards);
      }

      logEntries.push({
        title,
        blocks: blocks.length,
        cards: cardCount,
      });
    }

    if (allGeneratedCards.length > 0) {
      onAddCards(allGeneratedCards);
    }

    setNotionImportLog((prev) => [...logEntries, ...prev].slice(0, 12));
  };

  const handleSaveNotionToken = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateProvider({ notionToken: notionTokenDraft.trim() });
    setTokenSavedMsg(
      notionTokenDraft.trim()
        ? 'Notion Integration Token lokal im Browser gespeichert.'
        : 'Notion Integration Token entfernt.'
    );
  };

  const folderInputAttrs = {
    webkitdirectory: '',
    directory: '',
  } as React.InputHTMLAttributes<HTMLInputElement>;

  const displayedObsidianCount =
    syncCounts.obsidian !== null ? syncCounts.obsidian : state.obsidianNotes.length;
  const displayedOneNoteCount =
    syncCounts.oneNote !== null ? syncCounts.oneNote : oneNoteTotalPages;
  const displayedUpcoming30Count =
    syncCounts.upcoming30 !== null ? syncCounts.upcoming30 : upcoming30DaysLocalCount;

  return (
    <div className="mx-auto max-w-5xl animate-enter space-y-7 pb-12">
      {/* Page Header */}
      <header
        className="flex flex-col md:flex-row md:items-end md:justify-between gap-3 border-b pb-5"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div>
          <p className="text-[13px] text-[var(--text-secondary)]">
            Obsidian, OneNote Desktop, Schulportal und Notion
          </p>
          <h1 className="font-display font-normal mt-1 text-[30px] sm:text-[34px] leading-[1.15] text-[var(--text-primary)]">
            Import &amp; Sync
          </h1>
        </div>

        {/* Summary Counters (flat inline metadata) */}
        <div className="flex flex-wrap items-center gap-2.5 text-[12.5px] font-mono-num text-[var(--text-muted)]">
          <span>
            Obsidian: {state.obsidianNotes.length} ({activeContextCount} aktiv)
          </span>
          <span className="text-[var(--border-strong)]">·</span>
          <span>Termine: {state.schoolSchedule.length}</span>
          {state.provider.autoSyncEnabled && (
            <>
              <span className="text-[var(--border-strong)]">·</span>
              <span className="text-[var(--accent)]">Auto-Sync an</span>
            </>
          )}
        </div>
      </header>

      {/* 3-Tab Editorial Underline Navigation */}
      <div
        role="tablist"
        aria-label="Import- und Synchronisationsbereiche"
        className="flex flex-wrap gap-7 border-b"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        {(
          [
            {
              id: 'obsidian' as const,
              label: 'Obsidian & OneNote',
              icon: FolderOpen,
            },
            {
              id: 'school' as const,
              label: 'Schulportal & Auto-Sync',
              icon: CalendarDays,
            },
            {
              id: 'notion' as const,
              label: 'Notion',
              icon: FileDown,
            },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={`relative inline-flex items-center gap-2 pb-3 text-[14px] font-medium transition-colors cursor-pointer ${
                isActive
                  ? 'text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Icon
                size={15}
                strokeWidth={1.5}
                className={isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}
              />
              {tab.label}
              {isActive && (
                <span
                  className="absolute inset-x-0 -bottom-px h-[2px] rounded-full"
                  style={{ backgroundColor: 'var(--accent)' }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ================================================================= */}
      {/* TAB 1: OBSIDIAN & ONENOTE                                         */}
      {/* ================================================================= */}
      {activeTab === 'obsidian' && (
        <div className="space-y-6">
          {/* Section 1: 1-Klick-Obsidian-Vaults */}
          <section className="surface-card p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="space-y-1">
                <h2 className="font-display font-normal text-[22px] leading-snug text-[var(--text-primary)]">
                  Obsidian-Vaults
                </h2>
                <p className="text-[13.5px] text-[var(--text-secondary)] leading-relaxed">
                  Lokale Vaults erscheinen automatisch zum Verbinden. Alternativ wählst du deinen Ordner direkt im Browser.
                  {vaultFolderName && (
                    <span className="ml-1.5 font-mono-num text-[12px] text-[var(--accent)]">
                      · {vaultFolderName}
                    </span>
                  )}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  {...folderInputAttrs}
                  onChange={(e) => {
                    void handleObsidianFilesSelected(e.target.files);
                    e.target.value = '';
                  }}
                  className="hidden"
                />
                <input
                  ref={singleMdInputRef}
                  type="file"
                  accept=".md,.markdown"
                  multiple
                  onChange={(e) => {
                    void handleObsidianFilesSelected(e.target.files);
                    e.target.value = '';
                  }}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={() => void handlePickObsidianDirectory()}
                  disabled={loadingVault}
                  className={
                    detectedVaults.length > 0 ? 'btn-secondary' : 'btn-accent'
                  }
                >
                  <FolderOpen size={15} strokeWidth={1.5} />
                  {loadingVault ? 'Lese Ordner...' : 'Ordner manuell wählen'}
                </button>
                <button
                  type="button"
                  onClick={() => singleMdInputRef.current?.click()}
                  disabled={loadingVault}
                  className="btn-ghost h-9 px-2.5 text-[13px]"
                >
                  <FileUp size={14} strokeWidth={1.5} />
                  Einzelne .md
                </button>
                <button
                  type="button"
                  onClick={() => void detectLocalVaults()}
                  disabled={detectingVaults}
                  className="btn-ghost h-9 px-2 text-[12.5px]"
                  title="Lokale Obsidian-Vaults erneut suchen"
                  aria-label="Lokale Obsidian-Vaults erneut suchen"
                >
                  <RefreshCw
                    size={14}
                    strokeWidth={1.5}
                    className={detectingVaults ? 'animate-spin' : ''}
                  />
                </button>
              </div>
            </div>

            {/* Detected Local Obsidian Vaults (Hairline Rows) */}
            {detectingVaults && detectedVaults.length === 0 ? (
              <div
                className="border-t pt-4 flex items-center gap-2 text-[13px] text-[var(--text-muted)]"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                <span>Suche nach lokalen Obsidian-Vaults...</span>
              </div>
            ) : detectedVaults.length > 0 ? (
              <div
                className="divide-y border-t"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                {detectedVaults.map((vault) => {
                  const isConnected =
                    state.provider.obsidianVaultPath === vault.path;
                  const isLoadingThis = connectingVaultId === vault.id;

                  return (
                    <div
                      key={vault.id}
                      className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      style={{ borderColor: 'var(--border-hairline)' }}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="inline-block h-2 w-2 rounded-full shrink-0"
                            style={{
                              backgroundColor:
                                isConnected || vault.isOpen
                                  ? 'var(--positive)'
                                  : 'var(--border-strong)',
                            }}
                            aria-hidden="true"
                          />
                          <span className="text-[14.5px] font-medium text-[var(--text-primary)] truncate">
                            {vault.name}
                          </span>
                          {isConnected && (
                            <span className="text-[12px] font-medium text-[var(--accent)]">
                              · Verbunden
                            </span>
                          )}
                          {!isConnected && vault.isOpen && (
                            <span className="text-[12px] text-[var(--text-muted)]">
                              · Geöffnet in Obsidian
                            </span>
                          )}
                        </div>
                        <p className="text-[12px] font-mono-num text-[var(--text-muted)] truncate pl-4">
                          {vault.path}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleConnectDetectedVault(vault)}
                        disabled={connectingVaultId !== null}
                        className="btn-accent h-8 px-3.5 text-[13px] shrink-0 self-start sm:self-center"
                      >
                        {isLoadingThis ? (
                          <>
                            <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                            <span>Lade...</span>
                          </>
                        ) : (
                          <span>{isConnected ? 'Neu laden' : 'Verbinden'}</span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                className="border-t pt-3.5 text-[13px] text-[var(--text-muted)]"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                {bridgeReachable === false
                  ? 'Lokale Begleit-Bridge ist aktuell nicht aktiv — wähle deinen Vault-Ordner einfach direkt über «Ordner manuell wählen».'
                  : 'Keine Obsidian-Vaults automatisch gefunden. Wähle deinen Ordner über «Ordner manuell wählen».'}
              </div>
            )}

            {obsidianStatus && (
              <div className="border-l-2 border-[var(--accent)] pl-3.5 py-0.5 text-[13px] text-[var(--text-primary)] flex items-center justify-between gap-2">
                <span>{obsidianStatus}</span>
                <button
                  type="button"
                  onClick={() => setObsidianStatus(null)}
                  aria-label="Status schliessen"
                  className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </div>
            )}

            {/* Loaded Obsidian Notes Explorer */}
            {state.obsidianNotes.length > 0 && (
              <div
                className="space-y-4 pt-5 border-t"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                {/* Search, Filter & Destination Course Controls */}
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
                  <div className="flex flex-wrap items-center gap-2 flex-1">
                    <div className="relative flex-1 min-w-[200px] max-w-sm">
                      <Search
                        size={15}
                        strokeWidth={1.5}
                        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                      />
                      <input
                        type="text"
                        value={obsidianSearch}
                        onChange={(e) => setObsidianSearch(e.target.value)}
                        placeholder="Nach Titel, Pfad oder [[Wikilink]] filtern..."
                        className="w-full h-9 pl-9 pr-8 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                      />
                      {obsidianSearch && (
                        <button
                          type="button"
                          onClick={() => setObsidianSearch('')}
                          aria-label="Filter zurücksetzen"
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                        >
                          <X size={13} strokeWidth={1.5} />
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => setOnlySelectedContext((v) => !v)}
                      className={`h-9 px-3.5 rounded-full text-[13px] font-medium border transition-colors cursor-pointer ${
                        onlySelectedContext
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)]'
                          : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-hairline)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      Nur Lernkontext ({activeContextCount})
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-muted)]">
                      Zielkurs:
                      <select
                        value={resolvedObsidianCourseId}
                        onChange={(e) => setObsidianTargetCourseId(e.target.value)}
                        className="h-8 px-2 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[12.5px] text-[var(--text-primary)]"
                      >
                        {state.courses.map((c) => (
                          <option
                            key={c.id}
                            value={c.id}
                            style={{
                              backgroundColor: 'var(--bg-card)',
                              color: 'var(--text-primary)',
                            }}
                          >
                            {c.title}
                          </option>
                        ))}
                      </select>
                    </label>

                    <button
                      type="button"
                      onClick={() => handleSetAllObsidianContext(true)}
                      className="btn-ghost h-8 px-2.5 text-[12.5px]"
                    >
                      Alle
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetAllObsidianContext(false)}
                      className="btn-ghost h-8 px-2.5 text-[12.5px]"
                    >
                      Keine
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onSetObsidianNotes([]);
                        setVaultFolderName(null);
                        setObsidianStatus('Lokale Obsidian-Liste geleert.');
                      }}
                      className="btn-ghost h-8 px-2 text-[12.5px] hover:text-[var(--negative)]"
                      title="Geladene Vault-Liste entfernen"
                      aria-label="Geladene Vault-Liste entfernen"
                    >
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>

                {/* Notes List (flat hairline rows) */}
                <div className="divide-y divide-[var(--border-hairline)] max-h-[480px] overflow-y-auto pr-1">
                  {filteredObsidianNotes.length === 0 ? (
                    <p className="text-[13.5px] text-[var(--text-muted)] py-6 text-center">
                      Keine Notizen entsprechen dem aktuellen Filter.
                    </p>
                  ) : (
                    filteredObsidianNotes.map((note) => {
                      const isExpanded = expandedObsidianPath === note.path;
                      const isCopied = Boolean(copiedPaths[note.path]);

                      return (
                        <div
                          key={note.path}
                          className="py-4 first:pt-2 last:pb-1 space-y-2.5"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                            <div className="space-y-1 min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2.5">
                                <button
                                  type="button"
                                  onClick={() => onToggleObsidianContext(note.path)}
                                  className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[12px] font-medium border transition-colors cursor-pointer ${
                                    note.selectedForContext
                                      ? 'bg-[var(--accent)] text-[var(--accent-ink)] border-transparent'
                                      : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-strong)] hover:border-[var(--accent)]'
                                  }`}
                                >
                                  <Check size={11} strokeWidth={2} />
                                  {note.selectedForContext
                                    ? 'Im Lernkontext'
                                    : 'Als Kontext teilen'}
                                </button>
                                <span className="text-[15px] font-medium text-[var(--text-primary)] truncate">
                                  {note.title}
                                </span>
                              </div>
                              <p className="text-[12px] font-mono-num text-[var(--text-muted)] truncate">
                                {note.path}
                              </p>
                              <p className="text-[13.5px] text-[var(--text-secondary)] leading-relaxed">
                                {note.excerpt}
                              </p>
                            </div>

                            <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => handleCopyObsidianNoteToWorkspace(note)}
                                className="btn-secondary h-8 px-3 text-[12.5px]"
                              >
                                {isCopied ? (
                                  <>
                                    <Check
                                      size={14}
                                      strokeWidth={1.5}
                                      className="text-[var(--positive)]"
                                    />
                                    Kopiert
                                  </>
                                ) : (
                                  <>
                                    <CopyPlus size={14} strokeWidth={1.5} />
                                    In Notizen kopieren
                                  </>
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedObsidianPath(isExpanded ? null : note.path)
                                }
                                className="btn-ghost h-8 px-2 text-[12.5px]"
                                aria-label="Inhalt anzeigen"
                              >
                                {isExpanded ? (
                                  <EyeOff size={14} strokeWidth={1.5} />
                                ) : (
                                  <Eye size={14} strokeWidth={1.5} />
                                )}
                              </button>
                            </div>
                          </div>

                          {note.wikilinks.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Link2
                                size={12}
                                strokeWidth={1.5}
                                className="text-[var(--text-muted)]"
                              />
                              {note.wikilinks.slice(0, 6).map((wl) => (
                                <button
                                  key={wl}
                                  type="button"
                                  onClick={() => setObsidianSearch(wl)}
                                  className="px-2 py-0.5 rounded-full text-[11.5px] bg-[var(--bg-page)] text-[var(--text-secondary)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] cursor-pointer transition-colors"
                                >
                                  [[{wl}]]
                                </button>
                              ))}
                              {note.wikilinks.length > 6 && (
                                <span className="text-[11.5px] text-[var(--text-muted)] font-mono-num">
                                  +{note.wikilinks.length - 6} weitere
                                </span>
                              )}
                            </div>
                          )}

                          {isExpanded && (
                            <pre className="border-l-2 border-[var(--border-strong)] pl-3.5 py-1 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-[var(--text-primary)] font-sans max-h-64 overflow-y-auto">
                              {note.content}
                            </pre>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Section 2: Lokaler OneNote-Desktop-Scan */}
          <section className="surface-card p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="space-y-1">
                <h2 className="font-display font-normal text-[22px] leading-snug text-[var(--text-primary)]">
                  Lokales OneNote (Desktop)
                </h2>
                <p className="text-[13.5px] text-[var(--text-secondary)] leading-relaxed">
                  Liest deine lokalen OneNote-Notizbücher direkt auf diesem PC — ohne Microsoft-Cloud-Login oder OAuth.
                </p>
              </div>

              <button
                type="button"
                onClick={() => void handleScanOneNote()}
                disabled={scanningOneNote}
                className="btn-accent shrink-0 self-start"
              >
                {scanningOneNote ? (
                  <>
                    <Loader2 size={15} strokeWidth={1.5} className="animate-spin" />
                    <span>Scanne...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw size={15} strokeWidth={1.5} />
                    <span>OneNote jetzt scannen</span>
                  </>
                )}
              </button>
            </div>

            {oneNoteStatus && (
              <div className="border-l-2 border-[var(--accent)] pl-3.5 py-0.5 text-[13px] text-[var(--text-primary)] flex items-center justify-between gap-2">
                <span>{oneNoteStatus}</span>
                <button
                  type="button"
                  onClick={() => setOneNoteStatus(null)}
                  aria-label="Meldung schliessen"
                  className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </div>
            )}

            {/* Detected OneNote Notebooks */}
            {oneNoteNotebooks.length > 0 && (
              <div
                className="border-t pt-4 space-y-2.5"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-medium text-[var(--text-secondary)]">
                    Erkannte Notizbücher ({oneNoteNotebooks.length})
                  </span>
                  <span className="text-[12px] font-mono-num text-[var(--text-muted)]">
                    {oneNoteTotalPages} Seiten gesamt
                  </span>
                </div>
                <div className="divide-y divide-[var(--border-hairline)]">
                  {oneNoteNotebooks.map((nb) => (
                    <div
                      key={nb.id}
                      className="py-2.5 flex items-center justify-between gap-3 text-[13.5px]"
                    >
                      <span className="font-medium text-[var(--text-primary)] truncate">
                        {nb.name}
                      </span>
                      <span className="font-mono-num text-[12px] text-[var(--text-muted)] shrink-0">
                        {nb.sectionCount} Abschnitte · {nb.pageCount} Seiten
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent OneNote Pages with 1-Click Import */}
            {oneNoteRecentPages.length > 0 && (
              <div
                className="border-t pt-4 space-y-3"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12.5px] font-medium text-[var(--text-secondary)]">
                    Neueste OneNote-Seiten
                  </span>
                  <label className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-muted)]">
                    Zielkurs:
                    <select
                      value={resolvedObsidianCourseId}
                      onChange={(e) => setObsidianTargetCourseId(e.target.value)}
                      className="h-8 px-2 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[12.5px] text-[var(--text-primary)]"
                    >
                      {state.courses.map((c) => (
                        <option
                          key={c.id}
                          value={c.id}
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          {c.title}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="divide-y divide-[var(--border-hairline)] max-h-[360px] overflow-y-auto pr-1">
                  {oneNoteRecentPages.map((page) => {
                    const isImporting = importingOneNoteId === page.id;
                    const isImported = Boolean(importedOneNoteIds[page.id]);

                    return (
                      <div
                        key={page.id}
                        className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="text-[14px] font-medium text-[var(--text-primary)] truncate">
                            {page.name}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
                            <span>{page.notebook}</span>
                            <span>·</span>
                            <span>{page.section}</span>
                            {page.lastModified && (
                              <>
                                <span>·</span>
                                <span className="font-mono-num">
                                  {formatShortDateTime(page.lastModified)}
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => void handleImportOneNotePage(page)}
                          disabled={importingOneNoteId !== null}
                          className="btn-secondary h-8 px-3 text-[12.5px] shrink-0 self-start sm:self-center"
                        >
                          {isImporting ? (
                            <>
                              <Loader2
                                size={13}
                                strokeWidth={1.5}
                                className="animate-spin"
                              />
                              <span>Lade...</span>
                            </>
                          ) : isImported ? (
                            <>
                              <Check
                                size={14}
                                strokeWidth={1.5}
                                className="text-[var(--positive)]"
                              />
                              <span>Übernommen</span>
                            </>
                          ) : (
                            <>
                              <CopyPlus size={14} strokeWidth={1.5} />
                              <span>Als Notiz übernehmen</span>
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {!oneNoteScanned &&
              oneNoteNotebooks.length === 0 &&
              oneNoteRecentPages.length === 0 &&
              oneNoteAvailable === null && (
                <p
                  className="border-t pt-3.5 text-[13px] text-[var(--text-muted)]"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  Klicke auf «OneNote jetzt scannen», um deine zuletzt bearbeiteten Seiten lokal anzuzeigen und einzeln als Lernnotiz zu übernehmen.
                </p>
              )}
          </section>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 2: SCHULPORTAL & AUTO-SYNC                                    */}
      {/* ================================================================= */}
      {activeTab === 'school' && (
        <div className="space-y-6">
          {/* 1. Automatischer Hermes Portal-Reader (1 Feld) */}
          <section className="surface-card p-6 space-y-5">
            <div className="space-y-1">
              <h2 className="font-display font-normal text-[22px] leading-snug text-[var(--text-primary)]">
                Schulportal
              </h2>
              <p className="text-[13.5px] text-[var(--text-secondary)] leading-relaxed">
                Gib den Link zu deinem Schul- oder Uni-Portal ein. Hermes öffnet ein echtes Browser-Fenster auf deinem PC — du meldest dich normal an und liest anschliessend die nächsten 3 Monate (90 Tage) automatisch in deinen Kalender ein.
              </p>
            </div>

            <div className="flex flex-col lg:flex-row lg:items-end gap-3">
              <div className="flex-1 space-y-1.5 min-w-0">
                <label
                  htmlFor="school-portal-url-input"
                  className="block text-[12.5px] font-medium text-[var(--text-secondary)]"
                >
                  Schulportal-Link (nur lokal im Browser gespeichert)
                </label>
                <input
                  id="school-portal-url-input"
                  type="text"
                  inputMode="url"
                  value={state.provider.schoolPortalUrl}
                  onChange={(e) => {
                    onUpdateProvider({ schoolPortalUrl: e.target.value });
                    if (portalMessage) setPortalMessage(null);
                    if (portalBridgeFallbackUrl) setPortalBridgeFallbackUrl(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleStartHermesPortalReader();
                    }
                  }}
                  placeholder="portal.schule.example"
                  className="w-full h-10 px-3.5 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleStartHermesPortalReader()}
                  disabled={portalStarting || portalExtracting}
                  className="btn-accent h-10 px-4 text-[13.5px]"
                >
                  {portalStarting ? (
                    <>
                      <Loader2 size={15} strokeWidth={1.5} className="animate-spin" />
                      <span>Öffne Browser...</span>
                    </>
                  ) : (
                    <>
                      <Globe size={15} strokeWidth={1.5} />
                      <span>Mit Hermes 3 Monate einlesen</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleOpenSchoolPortal}
                  className="btn-secondary h-10 px-4 text-[13.5px]"
                >
                  <ExternalLink size={15} strokeWidth={1.5} />
                  <span>Nur im Browser öffnen</span>
                </button>
              </div>
            </div>

            {/* Live Portal Session Bar (flat hairline + left accent rule, zero nested boxes) */}
            {portalSession && (
              <div
                className="border-t pt-4"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div
                  className="border-l-2 pl-4 space-y-3"
                  style={{
                    borderColor: portalSession.looksLikeLogin
                      ? 'var(--accent-warm)'
                      : 'var(--accent)',
                  }}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{
                          backgroundColor: portalSession.looksLikeLogin
                            ? 'var(--accent-warm)'
                            : 'var(--accent)',
                        }}
                        aria-hidden="true"
                      />
                      <span className="text-[13.5px] font-medium text-[var(--text-primary)]">
                        {portalExtracting
                          ? 'Hermes liest deine Agenda der nächsten 3 Monate ein...'
                          : portalSession.looksLikeLogin
                            ? `${portalSession.browserName}-Fenster geöffnet · Melde dich dort normal mit deinem Konto an.`
                            : 'Angemeldet erkannt — bereit zum Einlesen'}
                      </span>
                    </div>

                    {(portalSession.pageTitle || portalSession.currentUrl) && (
                      <div className="pl-[18px] flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--text-muted)]">
                        {portalSession.pageTitle && (
                          <span className="text-[var(--text-secondary)] truncate max-w-full">
                            {portalSession.pageTitle}
                          </span>
                        )}
                        {portalSession.pageTitle && portalSession.currentUrl && (
                          <span aria-hidden="true">·</span>
                        )}
                        {portalSession.currentUrl && (
                          <span className="font-mono-num truncate max-w-full">
                            {portalSession.currentUrl}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="pl-[18px] flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleExtractPortalAgenda()}
                      disabled={portalExtracting}
                      className="btn-accent h-9 px-4 text-[13px]"
                    >
                      {portalExtracting ? (
                        <>
                          <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                          <span>Lese Agenda ein...</span>
                        </>
                      ) : (
                        <>
                          <CalendarDays size={14} strokeWidth={1.5} />
                          <span>Bin angemeldet — Agenda jetzt einlesen</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleClosePortalSession()}
                      disabled={portalExtracting}
                      className="btn-ghost h-9 px-3 text-[13px]"
                    >
                      <X size={14} strokeWidth={1.5} />
                      <span>Fenster schliessen</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Portal Import Summary */}
            {portalImportSummary && (
              <div
                className="border-t pt-4"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="border-l-2 border-[var(--accent)] pl-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <p className="text-[13.5px] text-[var(--text-primary)] leading-relaxed">
                    {portalImportSummary.count > 0
                      ? `${portalImportSummary.count} ${portalImportSummary.count === 1 ? 'Termin' : 'Termine'} der nächsten 3 Monate aus ${portalImportSummary.pagesCount} ${portalImportSummary.pagesCount === 1 ? 'Portal-Seite' : 'Portal-Seiten'} eingelesen (inkl. Prüfungen & Agenda).`
                      : `Aus ${portalImportSummary.pagesCount} ${portalImportSummary.pagesCount === 1 ? 'Portal-Seite' : 'Portal-Seiten'} wurden noch keine Termine für die nächsten 3 Monate erkannt. Öffne im Portal die Agenda- oder Prüfungsseite und versuche es erneut.`}
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    {portalImportSummary.count > 0 && onNavigate && (
                      <button
                        type="button"
                        onClick={() => onNavigate('calendar')}
                        className="btn-accent h-8 px-3.5 text-[12.5px]"
                      >
                        <span>Im Kalender ansehen</span>
                        <ArrowRight size={13} strokeWidth={1.5} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setPortalImportSummary(null)}
                      aria-label="Zusammenfassung schliessen"
                      className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                    >
                      <X size={14} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Calm Error / Bridge-Offline Fallback */}
            {portalMessage && (
              <div className="border-l-2 border-[var(--accent-warm)] pl-3.5 py-0.5 space-y-2.5">
                <p className="text-[13px] text-[var(--text-primary)] leading-relaxed">
                  {portalMessage}
                </p>
                {portalBridgeFallbackUrl && onLaunchPortalSync && (
                  <button
                    type="button"
                    onClick={() => onLaunchPortalSync(portalBridgeFallbackUrl)}
                    className="btn-secondary h-8 px-3.5 text-[12.5px]"
                  >
                    <MonitorPlay size={14} strokeWidth={1.5} />
                    <span>Stattdessen über Bildschirm-Lehrer einlesen</span>
                  </button>
                )}
              </div>
            )}
          </section>

          {/* 2. Hermes Auto-Sync (Hintergrund-Cron) */}
          <section className="surface-card p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="space-y-1">
                <h2 className="font-display font-normal text-[22px] leading-snug text-[var(--text-primary)]">
                  Hermes Auto-Sync
                </h2>
                <p className="text-[13.5px] text-[var(--text-secondary)] leading-relaxed">
                  Synchronisiert Obsidian-Notizen, OneNote-Seiten und anstehende Termine der nächsten 3 Monate (90 Tage) im Hintergrund — standardmässig alle 2 Tage.
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0 self-start">
                <span className="text-[13px] font-medium text-[var(--text-primary)]">
                  Automatisch im Hintergrund scannen
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={state.provider.autoSyncEnabled}
                  aria-label="Automatisch im Hintergrund scannen"
                  disabled={syncSavingConfig}
                  onClick={() => void handleToggleAutoSync()}
                  className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer"
                  style={{
                    backgroundColor: state.provider.autoSyncEnabled
                      ? 'var(--accent)'
                      : 'var(--bg-raised)',
                    border: '1px solid var(--border-strong)',
                  }}
                >
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full transition-transform"
                    style={{
                      backgroundColor: state.provider.autoSyncEnabled
                        ? 'var(--accent-ink)'
                        : 'var(--text-muted)',
                      transform: state.provider.autoSyncEnabled
                        ? 'translateX(17px)'
                        : 'translateX(2px)',
                    }}
                  />
                </button>
              </div>
            </div>

            {/* Interval Selector Pills & Run Now Button */}
            <div
              className="border-t pt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <div
                className="flex flex-wrap items-center gap-2"
                role="radiogroup"
                aria-label="Synchronisationsintervall"
              >
                {AUTO_SYNC_INTERVALS.map((opt) => {
                  const selected =
                    (state.provider.autoSyncIntervalMinutes || 2880) === opt.minutes;
                  return (
                    <button
                      key={opt.minutes}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => void handleSelectAutoSyncInterval(opt.minutes)}
                      className="h-8 px-3.5 rounded-full text-[13px] font-medium border transition-colors cursor-pointer"
                      style={{
                        backgroundColor: selected
                          ? 'var(--accent-soft)'
                          : 'transparent',
                        borderColor: selected
                          ? 'var(--accent-border)'
                          : 'var(--border-hairline)',
                        color: selected
                          ? 'var(--accent)'
                          : 'var(--text-secondary)',
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => void handleRunSyncNow()}
                disabled={syncRunning}
                className="btn-accent h-9 px-4 text-[13px] shrink-0 self-start sm:self-center"
              >
                <RefreshCw
                  size={14}
                  strokeWidth={1.5}
                  className={syncRunning ? 'animate-spin' : ''}
                />
                <span>
                  {syncRunning ? 'Synchronisiere...' : 'Jetzt synchronisieren'}
                </span>
              </button>
            </div>

            {syncMessage && (
              <div className="border-l-2 border-[var(--accent)] pl-3.5 py-0.5 text-[13px] text-[var(--text-primary)] flex items-center justify-between gap-2">
                <span>{syncMessage}</span>
                <button
                  type="button"
                  onClick={() => setSyncMessage(null)}
                  aria-label="Meldung schliessen"
                  className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </div>
            )}

            {/* Crisp Status Line */}
            <div
              className="border-t pt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[12.5px]"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <span className="text-[var(--text-secondary)]">
                Zuletzt synchronisiert:{' '}
                <span className="font-mono-num text-[var(--text-primary)]">
                  {formatShortDateTime(state.provider.lastAutoSyncAt)}
                </span>
              </span>

              <div className="flex flex-wrap items-center gap-2 font-mono-num text-[var(--text-muted)]">
                <span>Obsidian: {displayedObsidianCount}</span>
                <span className="text-[var(--border-strong)]">·</span>
                <span>OneNote: {displayedOneNoteCount}</span>
                <span className="text-[var(--border-strong)]">·</span>
                <span>Nächste 3 Monate: {displayedUpcoming30Count}</span>
              </div>
            </div>
          </section>

          {/* Upcoming Schedule Timeline */}
          <section className="surface-card p-6 space-y-4">
            <div
              className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3.5"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <h2 className="font-display font-normal text-[21px] leading-snug text-[var(--text-primary)]">
                Anstehende Prüfungen &amp; Termine{' '}
                <span className="font-mono-num text-[14px] text-[var(--text-muted)]">
                  ({sortedSchedule.length})
                </span>
              </h2>
              <div className="flex items-center gap-3.5">
                <span className="hidden sm:inline text-[12.5px] text-[var(--text-muted)]">
                  Übersicht aus Hermes, Auto-Sync und Importen
                </span>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('calendar')}
                    className="inline-flex items-center gap-1 text-[13px] font-medium cursor-pointer text-[var(--accent)] hover:underline"
                  >
                    <span>Kalender öffnen</span>
                    <ArrowRight size={13} strokeWidth={1.5} />
                  </button>
                )}
              </div>
            </div>

            {sortedSchedule.length === 0 ? (
              <p className="text-[13.5px] text-[var(--text-muted)] py-4 text-center">
                Noch keine Termine eingetragen. Lies die nächsten 3 Monate mit Hermes ein oder öffne unten weitere Import-Formate.
              </p>
            ) : (
              <div className="divide-y divide-[var(--border-hairline)]">
                {sortedSchedule.map((item) => {
                  const countdown = formatCountdown(item.date);
                  const sourceLabel =
                    item.source === 'ics'
                      ? 'Kalender .ics'
                      : item.source === 'portal-sync'
                        ? 'Portal-Sync'
                        : item.source === 'smart-import'
                          ? 'Portal / Sync'
                          : 'Manuell';

                  return (
                    <div
                      key={item.id}
                      className="py-3 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                    >
                      <div className="flex items-start sm:items-center gap-3 min-w-0">
                        <span className="font-mono-num text-[13px] font-medium text-[var(--text-secondary)] shrink-0 w-24">
                          {item.date}
                        </span>
                        <div className="min-w-0">
                          <div className="text-[14px] font-medium text-[var(--text-primary)] truncate">
                            {item.title}
                          </div>
                          <div className="text-[12px] text-[var(--text-muted)] flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span>{item.courseTitle}</span>
                            {item.startTime && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono-num">
                                  {item.endTime
                                    ? `${item.startTime}–${item.endTime}`
                                    : item.startTime}
                                </span>
                              </>
                            )}
                            {item.room && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{item.room}</span>
                              </>
                            )}
                            <span aria-hidden="true">·</span>
                            <span>{sourceLabel}</span>
                          </div>
                        </div>
                      </div>

                      <span
                        className="self-start sm:self-center shrink-0 text-[12px] font-medium font-mono-num"
                        style={{
                          color:
                            countdown.tone === 'warning'
                              ? 'var(--accent-warm)'
                              : countdown.tone === 'accent'
                                ? 'var(--accent)'
                                : 'var(--text-muted)',
                        }}
                      >
                        {countdown.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 3. Collapsed <details>: Weitere Import-Formate (.ics, Stoffplan & manueller Termin) */}
          <details className="surface-card overflow-hidden group">
            <summary className="px-6 py-4 cursor-pointer select-none flex items-center justify-between gap-3 text-[14px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] list-none">
              <span>
                Weitere Import-Formate (.ics Kalender, Stoffplan-Text &amp; manueller Termin)
              </span>
              <ChevronDown
                size={16}
                strokeWidth={1.5}
                className="shrink-0 text-[var(--text-muted)] transition-transform group-open:rotate-180"
              />
            </summary>

            <div
              className="px-6 pb-6 pt-5 border-t space-y-8"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              {/* A: Manueller Termin */}
              <div className="space-y-3">
                <div className="space-y-0.5">
                  <h3 className="font-display font-normal text-[19px] text-[var(--text-primary)] inline-flex items-center gap-2">
                    <Plus size={16} strokeWidth={1.5} className="text-[var(--accent)]" />
                    Manueller Termin
                  </h3>
                  <p className="text-[13px] text-[var(--text-secondary)]">
                    Einzelne Prüfung oder Abgabe direkt in den Prüfungsplan aufnehmen.
                  </p>
                </div>

                <form
                  onSubmit={handleAddManualScheduleItem}
                  className="grid grid-cols-1 sm:grid-cols-[1fr_180px_160px_auto] gap-2.5 items-end"
                >
                  <div className="space-y-1">
                    <label
                      htmlFor="manual-event-title"
                      className="text-[12px] text-[var(--text-secondary)]"
                    >
                      Titel
                    </label>
                    <input
                      id="manual-event-title"
                      type="text"
                      required
                      value={manualTitle}
                      onChange={(e) => setManualTitle(e.target.value)}
                      placeholder="z. B. Chemie Klausur: Säuren & Basen"
                      className="w-full h-9 px-3 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[13.5px] text-[var(--text-primary)]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="manual-event-course"
                      className="text-[12px] text-[var(--text-secondary)]"
                    >
                      Fach
                    </label>
                    <input
                      id="manual-event-course"
                      type="text"
                      value={manualCourse}
                      onChange={(e) => setManualCourse(e.target.value)}
                      placeholder="z. B. Chemie"
                      className="w-full h-9 px-3 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[13.5px] text-[var(--text-primary)]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="manual-event-date"
                      className="text-[12px] text-[var(--text-secondary)]"
                    >
                      Datum
                    </label>
                    <input
                      id="manual-event-date"
                      type="date"
                      required
                      value={manualDate}
                      onChange={(e) => setManualDate(e.target.value)}
                      className="w-full h-9 px-3 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[13.5px] font-mono-num text-[var(--text-primary)]"
                    />
                  </div>
                  <button type="submit" className="btn-accent h-9 px-3.5 text-[13px]">
                    Hinzufügen
                  </button>
                </form>

                {manualMessage && (
                  <p className="border-l-2 border-[var(--positive)] pl-3 py-0.5 text-[13px] text-[var(--positive)]">
                    {manualMessage}
                  </p>
                )}
              </div>

              {/* B: .ics Kalender-Import */}
              <div
                className="border-t pt-6 space-y-4"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="space-y-0.5">
                  <h3 className="font-display font-normal text-[19px] text-[var(--text-primary)] inline-flex items-center gap-2">
                    <Calendar
                      size={16}
                      strokeWidth={1.5}
                      className="text-[var(--accent)]"
                    />
                    .ics Kalender-Import
                  </h3>
                  <p className="text-[13px] text-[var(--text-secondary)]">
                    Lade eine .ics-Datei hoch oder füge iCal-Text ein. Alle Termine werden lokal im Browser ausgelesen.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={icsFileInputRef}
                    type="file"
                    accept=".ics,.ical,text/calendar"
                    onChange={(e) => {
                      void handleIcsFileUpload(e.target.files);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => icsFileInputRef.current?.click()}
                    className="btn-secondary h-9 text-[13px]"
                  >
                    <Upload size={15} strokeWidth={1.5} />
                    .ics-Datei wählen
                  </button>
                  <button
                    type="button"
                    onClick={() => handleParseIcsInput(SAMPLE_ICS)}
                    className="btn-ghost h-9 text-[13px]"
                  >
                    Beispiel-Kalender testen
                  </button>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="ics-textarea"
                    className="block text-[12.5px] font-medium text-[var(--text-secondary)]"
                  >
                    Oder iCal-Text direkt einfügen
                  </label>
                  <textarea
                    id="ics-textarea"
                    rows={4}
                    value={icsRawText}
                    onChange={(e) => setIcsRawText(e.target.value)}
                    placeholder="BEGIN:VCALENDAR&#10;BEGIN:VEVENT&#10;DTSTART;VALUE=DATE:20261215&#10;SUMMARY:Biologie Test: Genetik&#10;END:VEVENT&#10;END:VCALENDAR"
                    className="w-full p-3 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] font-mono-num text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                  />
                  {icsRawText.trim() && parsedIcsEvents.length === 0 && (
                    <button
                      type="button"
                      onClick={() => handleParseIcsInput(icsRawText)}
                      className="btn-secondary h-8 text-[12.5px]"
                    >
                      iCal-Text auslesen
                    </button>
                  )}
                </div>

                {icsMessage && (
                  <p className="border-l-2 border-[var(--accent)] pl-3 py-0.5 text-[13px] text-[var(--text-primary)]">
                    {icsMessage}
                  </p>
                )}

                {parsedIcsEvents.length > 0 && (
                  <div
                    className="space-y-2.5 pt-3 border-t"
                    style={{ borderColor: 'var(--border-hairline)' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] font-medium text-[var(--text-primary)]">
                        Erkannte Termine (
                        {parsedIcsEvents.filter((e) => e.selected).length}/
                        {parsedIcsEvents.length})
                      </span>
                      <button
                        type="button"
                        onClick={handleCommitIcsEvents}
                        className="btn-accent h-8 px-3 text-[12.5px]"
                      >
                        <Check size={14} strokeWidth={1.5} />
                        Ausgewählte übernehmen
                      </button>
                    </div>

                    <div className="divide-y divide-[var(--border-hairline)] max-h-56 overflow-y-auto">
                      {parsedIcsEvents.map((ev) => (
                        <label
                          key={ev.uid}
                          className="flex items-start gap-2.5 py-2.5 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={ev.selected}
                            onChange={() =>
                              setParsedIcsEvents((prev) =>
                                prev.map((item) =>
                                  item.uid === ev.uid
                                    ? { ...item, selected: !item.selected }
                                    : item
                                )
                              )
                            }
                            className="mt-1 accent-[var(--accent)]"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-[13.5px] font-medium text-[var(--text-primary)]">
                              {ev.title}
                            </div>
                            <div className="text-[12px] text-[var(--text-muted)] font-mono-num">
                              {ev.date} · {ev.courseTitle}
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* C: Stoffplan- & Lehrplan-Text */}
              <form
                onSubmit={handleRunSmartSyllabusImport}
                className="border-t pt-6 space-y-4"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="space-y-0.5">
                  <h3 className="font-display font-normal text-[19px] text-[var(--text-primary)] inline-flex items-center gap-2">
                    <GraduationCap
                      size={17}
                      strokeWidth={1.5}
                      className="text-[var(--accent)]"
                    />
                    Stoffplan- &amp; Lehrplan-Text
                  </h3>
                  <p className="text-[13px] text-[var(--text-secondary)]">
                    Erzeugt aus Skripten oder PDF-Auszügen direkt einen Kurs mit Lernzielen, strukturierter Notizseite und Starter-Karten.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label
                      htmlFor="smart-course-title"
                      className="block text-[12.5px] font-medium text-[var(--text-secondary)]"
                    >
                      Kurs- oder Fachname
                    </label>
                    <input
                      id="smart-course-title"
                      type="text"
                      value={importCourseTitle}
                      onChange={(e) => setImportCourseTitle(e.target.value)}
                      placeholder="z. B. Physik — Mechanik & Energie"
                      className="w-full h-9 px-3 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                    />
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="smart-course-category"
                      className="block text-[12.5px] font-medium text-[var(--text-secondary)]"
                    >
                      Fachbereich
                    </label>
                    <select
                      id="smart-course-category"
                      value={importCategory}
                      onChange={(e) =>
                        setImportCategory(
                          e.target.value as SubjectCourse['category']
                        )
                      }
                      className="w-full h-9 px-3 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[13.5px] text-[var(--text-primary)]"
                    >
                      <option
                        value="science"
                        style={{
                          backgroundColor: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        Naturwissenschaften &amp; Mathe
                      </option>
                      <option
                        value="language"
                        style={{
                          backgroundColor: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        Sprachen
                      </option>
                      <option
                        value="humanities"
                        style={{
                          backgroundColor: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        Gesellschaft &amp; Geisteswiss.
                      </option>
                      <option
                        value="custom"
                        style={{
                          backgroundColor: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        Eigener Kurs
                      </option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="smart-exam-date"
                      className="block text-[12.5px] font-medium text-[var(--text-secondary)]"
                    >
                      Prüfungsdatum (optional)
                    </label>
                    <input
                      id="smart-exam-date"
                      type="date"
                      value={importExamDate}
                      onChange={(e) => setImportExamDate(e.target.value)}
                      className="w-full h-9 px-3 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[13.5px] font-mono-num text-[var(--text-primary)]"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor="smart-syllabus-text"
                      className="text-[12.5px] font-medium text-[var(--text-secondary)]"
                    >
                      Lernziele, Skript oder kopierter PDF-Text
                    </label>
                    <div className="flex items-center gap-1.5">
                      <input
                        ref={syllabusFileInputRef}
                        type="file"
                        accept=".txt,.md,.markdown"
                        onChange={(e) => {
                          void handleSyllabusFileUpload(e.target.files);
                          e.target.value = '';
                        }}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => syllabusFileInputRef.current?.click()}
                        className="btn-ghost h-7 px-2 text-[12px]"
                      >
                        <FileUp size={13} strokeWidth={1.5} />
                        .txt / .md laden
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setImportCourseTitle('Physik — Mechanik & Energie');
                          setImportCategory('science');
                          setSyllabusText(SAMPLE_SYLLABUS);
                        }}
                        className="btn-ghost h-7 px-2 text-[12px]"
                      >
                        Beispielstoff einfügen
                      </button>
                    </div>
                  </div>

                  <textarea
                    id="smart-syllabus-text"
                    rows={5}
                    value={syllabusText}
                    onChange={(e) => setSyllabusText(e.target.value)}
                    placeholder="Lernziele als Aufzählung, Definitionen im Format «Begriff: Erklärung» oder Text aus einem PDF-Arbeitsblatt einfügen..."
                    className="w-full p-3 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[13.5px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12px] text-[var(--text-muted)]">
                    Hinweis: «Begriff: Erklärung» wird automatisch als Karteikarte erkannt.
                  </span>
                  <button type="submit" className="btn-accent h-9 px-4 text-[13px]">
                    <Layers size={15} strokeWidth={1.5} />
                    Kurs, Notiz &amp; Karten erstellen
                  </button>
                </div>

                {syllabusResult && (
                  <div className="border-l-2 border-[var(--positive)] pl-3 py-1 text-[13px] text-[var(--positive)] flex items-center justify-between gap-2">
                    <span>{syllabusResult}</span>
                    <button
                      type="button"
                      onClick={() => setSyllabusResult(null)}
                      aria-label="Meldung schliessen"
                      className="p-0.5 cursor-pointer"
                    >
                      <X size={14} strokeWidth={1.5} />
                    </button>
                  </div>
                )}
              </form>
            </div>
          </details>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 3: NOTION-VERBINDUNG & MARKDOWN-IMPORT                        */}
      {/* ================================================================= */}
      {activeTab === 'notion' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          {/* Left Card: Notion Markdown Export Dropzone */}
          <div className="surface-card p-6 space-y-4">
            <div className="space-y-1">
              <h2 className="font-display font-normal text-[21px] leading-snug text-[var(--text-primary)] inline-flex items-center gap-2">
                <BookOpen size={17} strokeWidth={1.5} className="text-[var(--accent)]" />
                Notion Markdown-Export importieren
              </h2>
              <p className="text-[13.5px] text-[var(--text-secondary)] leading-relaxed">
                Wähle in Notion «Exportieren → Markdown &amp; CSV» und ziehe die entpackten .md-Dateien hier hinein. Notion-ID-Endungen im Dateinamen werden automatisch bereinigt.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                Zielkurs:
                <select
                  value={resolvedNotionCourseId}
                  onChange={(e) => setNotionTargetCourseId(e.target.value)}
                  className="h-8 px-2.5 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] text-[13px] text-[var(--text-primary)]"
                >
                  {state.courses.map((c) => (
                    <option
                      key={c.id}
                      value={c.id}
                      style={{
                        backgroundColor: 'var(--bg-card)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>

              <label className="inline-flex items-center gap-2 text-[13px] text-[var(--text-secondary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={notionAlsoCreateCards}
                  onChange={(e) => setNotionAlsoCreateCards(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                Karteikarten mit erzeugen
              </label>
            </div>

            <input
              ref={notionFileInputRef}
              type="file"
              accept=".md,.markdown,.txt"
              multiple
              onChange={(e) => {
                if (e.target.files) {
                  void importNotionMarkdownFiles(Array.from(e.target.files));
                }
                e.target.value = '';
              }}
              className="hidden"
            />

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setNotionDragActive(true);
              }}
              onDragLeave={() => setNotionDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setNotionDragActive(false);
                void importNotionMarkdownFiles(Array.from(e.dataTransfer.files));
              }}
              className={`rounded-xl border border-dashed p-7 text-center space-y-2.5 transition-colors ${
                notionDragActive
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--border-strong)] bg-[var(--bg-page)]/60'
              }`}
            >
              <FileDown
                size={22}
                strokeWidth={1.5}
                className="mx-auto text-[var(--accent)]"
              />
              <div className="space-y-0.5">
                <p className="text-[14px] font-medium text-[var(--text-primary)]">
                  Notion .md-Dateien hier ablegen
                </p>
                <p className="text-[12.5px] text-[var(--text-secondary)]">
                  Überschriften, Checklisten, Merksätze und Code-Blöcke werden direkt in den OpenStudy-Editor übernommen.
                </p>
              </div>
              <button
                type="button"
                onClick={() => notionFileInputRef.current?.click()}
                className="btn-accent h-9 text-[13px]"
              >
                <Upload size={15} strokeWidth={1.5} />
                Markdown-Dateien auswählen
              </button>
            </div>

            {notionImportLog.length > 0 && (
              <div className="space-y-2 pt-3 border-t border-[var(--border-hairline)]">
                <div className="text-[12.5px] font-medium text-[var(--text-muted)]">
                  Zuletzt importiert
                </div>
                <div className="divide-y divide-[var(--border-hairline)]">
                  {notionImportLog.map((entry, idx) => (
                    <div
                      key={`${entry.title}-${idx}`}
                      className="flex items-center justify-between gap-2 py-2 text-[13px]"
                    >
                      <span className="inline-flex items-center gap-2 text-[var(--text-primary)] font-medium truncate">
                        <FileText
                          size={14}
                          strokeWidth={1.5}
                          className="text-[var(--positive)] shrink-0"
                        />
                        <span className="truncate">{entry.title}</span>
                      </span>
                      <span className="font-mono-num text-[12px] text-[var(--text-secondary)] shrink-0">
                        {entry.blocks} Blöcke
                        {entry.cards > 0 ? ` · ${entry.cards} Karten` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Card: Optional Official Notion Integration Token */}
          <div className="surface-card p-6 space-y-5">
            <div className="space-y-1">
              <h2 className="font-display font-normal text-[21px] leading-snug text-[var(--text-primary)] inline-flex items-center gap-2">
                <KeyRound size={17} strokeWidth={1.5} className="text-[var(--accent)]" />
                Optionale Notion-API-Verbindung
              </h2>
              <p className="text-[13.5px] text-[var(--text-secondary)] leading-relaxed">
                OpenStudy funktioniert vollständig ohne Notion-Konto. Wenn du eine eigene Notion Internal Integration nutzt, kannst du dein Token hier optional lokal hinterlegen.
              </p>
            </div>

            <form onSubmit={handleSaveNotionToken} className="space-y-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="notion-token-input"
                  className="block text-[12.5px] font-medium text-[var(--text-secondary)]"
                >
                  Notion Integration Token (optional)
                </label>
                <div className="relative">
                  <input
                    id="notion-token-input"
                    type={showNotionToken ? 'text' : 'password'}
                    value={notionTokenDraft}
                    onChange={(e) => setNotionTokenDraft(e.target.value)}
                    placeholder="ntn_... oder secret_..."
                    autoComplete="off"
                    className="w-full h-10 pl-3 pr-10 rounded-lg bg-[var(--bg-page)] border border-[var(--border-hairline)] font-mono-num text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNotionToken((v) => !v)}
                    aria-label={
                      showNotionToken ? 'Token verbergen' : 'Token anzeigen'
                    }
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    {showNotionToken ? (
                      <EyeOff size={15} strokeWidth={1.5} />
                    ) : (
                      <Eye size={15} strokeWidth={1.5} />
                    )}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" className="btn-primary h-9 text-[13px]">
                  <Check size={15} strokeWidth={1.5} />
                  Lokal speichern
                </button>
                {state.provider.notionToken && (
                  <button
                    type="button"
                    onClick={() => {
                      setNotionTokenDraft('');
                      onUpdateProvider({ notionToken: '' });
                      setTokenSavedMsg('Notion Integration Token entfernt.');
                    }}
                    className="btn-secondary h-9 text-[13px]"
                  >
                    Token entfernen
                  </button>
                )}
              </div>

              {tokenSavedMsg && (
                <p className="text-[13px] text-[var(--positive)]">{tokenSavedMsg}</p>
              )}
            </form>

            <div className="border-t border-[var(--border-hairline)] pt-4 space-y-1.5 text-[13px] text-[var(--text-secondary)]">
              <div className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                <ShieldCheck
                  size={15}
                  strokeWidth={1.5}
                  className="text-[var(--positive)]"
                />
                Datenschutz-Hinweis
              </div>
              <p className="leading-relaxed">
                Dein Token wird ausschliesslich lokal im Browser-Speicher dieses Geräts gesichert. Da Browser direkte Notion-API-Anfragen per CORS blockieren, ist der Markdown-Export links der direkteste Weg ohne zusätzliche Server.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ObsidianAndImportHub;
