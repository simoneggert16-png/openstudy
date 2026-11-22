import {
  Content,
  FunctionDeclaration,
  GenerateContentResponse,
  GoogleGenAI,
  MediaResolution,
  Part,
  Schema,
  Type,
} from '@google/genai';
import {
  DailyPlanTask,
  HermesMemoryEntry,
  HermesSkill,
  HermesToolExecution,
  MainView,
  NoteBlock,
  OpenStudyState,
  ScheduleItemCategory,
  SchoolScheduleItem,
  ScreenSpotlight,
  StudyCard,
  StudyNotePage,
} from '../types';
import { FREE_GEMINI_TEXT_MODELS, generateStudyReply } from './providers';
import { LANGUAGE_META } from './voiceEngine';

export interface HermesToolHandlers {
  onHighlightScreen: (spotlight: ScreenSpotlight) => void;
  onClearSpotlights: () => void;
  onCreateNote: (page: StudyNotePage) => void;
  onCreateCards: (cards: StudyCard[]) => void;
  onAddPlanTasks: (tasks: DailyPlanTask[]) => void;
  onAddSchoolScheduleItems?: (items: SchoolScheduleItem[]) => void;
  onNavigate: (view: MainView, courseId?: string) => void;
  onSaveMemory: (entry: HermesMemoryEntry) => void;
  onSaveSkill: (skill: HermesSkill) => void;
  onLogAction: (entry: HermesToolExecution) => void;
  captureFreshFullResFrame?: (crop?: {
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
  }) => Promise<{
    base64: string;
    width: number;
    height: number;
    source: 'windows-bridge' | 'screen-share';
  } | null>;
  bridgeUrl?: string;
  desktopOverlayEnabled?: boolean;
}

const VALID_VIEWS: ReadonlySet<MainView> = new Set<MainView>([
  'home',
  'calendar',
  'teacher',
  'notes',
  'trainer',
  'languages',
  'focus',
  'import',
]);

const VALID_SCHEDULE_CATEGORIES: ReadonlySet<ScheduleItemCategory> = new Set<ScheduleItemCategory>([
  'exam',
  'homework',
  'lesson',
  'event',
]);

const VALID_MEMORY_CATEGORIES: ReadonlySet<HermesMemoryEntry['category']> = new Set([
  'preference',
  'strength',
  'weakness',
  'goal',
  'workflow',
]);

export const HERMES_LIVE_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'inspect_screen_detail',
    description:
      'PFLICHT-TOOL vor jeder Aussage über konkrete Details auf dem Bildschirm! Macht sofort einen brandneuen, hochauflösenden HD-Screenshot (optional mit Zoom-Ausschnitt) und liest kleine UI-Elemente pixelgenau ab (z. B. aktive Steps im FL Studio Channel Rack, Excel-Zellen, Menüpunkte, Code-Zeilen, Mausposition). Rufe dieses Tool IMMER auf, wenn der Lernende fragt, was er gerade gemacht, geklickt oder gesetzt hat, oder ob etwas stimmt.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        question: {
          type: Type.STRING,
          description:
            'Exakte visuelle Prüffrage, z. B. "Welche Steps (1 bis 16) sind in der Hi-Hat-, Kick-, Clap- und Snare-Zeile im FL Studio Channel Rack aktuell beleuchtet?"',
        },
        xMin: {
          type: Type.NUMBER,
          description: 'Optionaler Zoom-Ausschnitt links in Prozent (0–95).',
        },
        yMin: {
          type: Type.NUMBER,
          description: 'Optionaler Zoom-Ausschnitt oben in Prozent (0–95).',
        },
        xMax: {
          type: Type.NUMBER,
          description: 'Optionaler Zoom-Ausschnitt rechts in Prozent (5–100).',
        },
        yMax: {
          type: Type.NUMBER,
          description: 'Optionaler Zoom-Ausschnitt unten in Prozent (5–100).',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'highlight_screen_region',
    description:
      'Markiert eine exakte Stelle auf dem geteilten Bildschirm mit einem nummerierten Lehrer-Ring und einer kurzen deutschen Beschriftung, damit die Lernperson sofort sieht, wo sie hinschauen oder klicken soll.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        xPercent: {
          type: Type.NUMBER,
          description: 'Horizontale Position in Prozent vom linken Rand (0 bis 100).',
          minimum: 0,
          maximum: 100,
        },
        yPercent: {
          type: Type.NUMBER,
          description: 'Vertikale Position in Prozent vom oberen Rand (0 bis 100).',
          minimum: 0,
          maximum: 100,
        },
        label: {
          type: Type.STRING,
          description: 'Kurze deutsche Beschriftung für den Marker (maximal 40 Zeichen).',
        },
        stepNumber: {
          type: Type.NUMBER,
          description: 'Optionale Schrittnummer (1, 2, 3 ...) für geführte Erklärungen.',
        },
      },
      required: ['xPercent', 'yPercent', 'label'],
    },
  },
  {
    name: 'clear_screen_highlights',
    description:
      'Entfernt alle aktuellen Lehrer-Markierungen vom Bildschirm, zum Beispiel beim Wechsel zu einem neuen Schritt oder Fenster.',
  },
  {
    name: 'create_study_note',
    description:
      'Erstellt eine strukturierte Lernnotiz im Notion-Stil für den aktiven Kurs in OpenStudy.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: {
          type: Type.STRING,
          description: 'Klarer, prägnanter Titel der Lernnotiz.',
        },
        summary: {
          type: Type.STRING,
          description: 'Kompakte Zusammenfassung oder Erklärung des Konzepts.',
        },
        keyTakeaway: {
          type: Type.STRING,
          description: 'Optionaler zentraler Merksatz für den Callout-Block.',
        },
        bullets: {
          type: Type.ARRAY,
          description: 'Optionale Liste wichtiger Stichpunkte oder Schritte.',
          items: {
            type: Type.STRING,
          },
        },
      },
      required: ['title', 'summary'],
    },
  },
  {
    name: 'create_flashcards',
    description:
      'Erstellt neue Spaced-Repetition-Karteikarten für den aktiven Kurs in OpenStudy.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        cards: {
          type: Type.ARRAY,
          description: 'Liste der Karteikarten (empfohlen 2 bis 6 Karten).',
          items: {
            type: Type.OBJECT,
            properties: {
              front: {
                type: Type.STRING,
                description: 'Frage oder Impuls auf der Vorderseite.',
              },
              back: {
                type: Type.STRING,
                description: 'Präzise Musterantwort auf der Rückseite.',
              },
              hint: {
                type: Type.STRING,
                description: 'Optionaler kurzer Hinweis.',
              },
            },
            required: ['front', 'back'],
          },
        },
      },
      required: ['cards'],
    },
  },
  {
    name: 'add_daily_plan_tasks',
    description:
      'Fügt realistische Lern- oder Wiederholungsblöcke zum Tagesplan in OpenStudy hinzu.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        tasks: {
          type: Type.ARRAY,
          description: 'Liste konkreter Aufgaben für den Tagesplan.',
          items: {
            type: Type.OBJECT,
            properties: {
              title: {
                type: Type.STRING,
                description: 'Konkreter Titel der Aufgabe.',
              },
              minutes: {
                type: Type.NUMBER,
                description: 'Realistische Dauer in Minuten (5 bis 120).',
              },
              scheduledFor: {
                type: Type.STRING,
                description: 'Optionaler Zeitpunkt, z. B. "Heute" oder "Morgen".',
              },
            },
            required: ['title', 'minutes'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'navigate_app',
    description:
      'Wechselt in OpenStudy zu einer bestimmten Ansicht und aktiviert bei Bedarf einen passenden Kurs.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        view: {
          type: Type.STRING,
          description: 'Zielansicht in OpenStudy.',
          enum: ['home', 'calendar', 'teacher', 'notes', 'trainer', 'languages', 'focus', 'import'],
        },
        courseTitle: {
          type: Type.STRING,
          description: 'Optionaler Kursname oder Fachstichwort, das ausgewählt werden soll.',
        },
      },
      required: ['view'],
    },
  },
  {
    name: 'save_learning_memory',
    description:
      'Speichert einen dauerhaften Lernfakt über Präferenzen, Stärken, Schwächen, Ziele oder Arbeitsweisen im Hermes-Gedächtnis über Sitzungen hinweg.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        fact: {
          type: Type.STRING,
          description: 'Knapper, nützlicher Fakt über die Lernperson oder den Lernstand.',
        },
        category: {
          type: Type.STRING,
          description: 'Kategorie des gespeicherten Lernfakts.',
          enum: ['preference', 'strength', 'weakness', 'goal', 'workflow'],
        },
      },
      required: ['fact', 'category'],
    },
  },
  {
    name: 'save_custom_skill',
    description:
      'Hermes-Selbstverbesserung: Erstellt oder verfeinert eine wiederverwendbare SKILL.md-Lehranleitung für wiederkehrende Lernsituationen oder Apps.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          description: 'Kurzer Skill-Name in Kleinbuchstaben mit Bindestrichen, z. B. "excel-formel-coach".',
        },
        description: {
          type: Type.STRING,
          description: 'Knappe Beschreibung, wofür dieser Skill gedacht ist.',
        },
        trigger: {
          type: Type.STRING,
          description: 'Auslösebedingung, wann dieser Skill angewendet werden soll.',
        },
        instructions: {
          type: Type.STRING,
          description: 'Klare schrittweise Lehranweisungen für künftige Sitzungen.',
        },
      },
      required: ['name', 'description', 'trigger', 'instructions'],
    },
  },
  {
    name: 'add_school_schedule',
    description:
      'Trägt erkannte Prüfungen, Tests, Hausaufgaben, Lektionen oder Termine der nächsten 3 Monate (90 Tage, z. B. aus einem geöffneten Schulportal oder Stundenplan) direkt in den OpenStudy-Kalender ein.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          description: 'Liste erkannter Termine, Prüfungen, Hausaufgaben oder Lektionen.',
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: 'Titel der Prüfung, Aufgabe oder Lektion.' },
              date: { type: Type.STRING, description: 'Datum im Format YYYY-MM-DD.' },
              courseTitle: {
                type: Type.STRING,
                description: 'Fachname, z. B. Mathematik, BWL, Englisch.',
              },
              startTime: {
                type: Type.STRING,
                description: 'Optionale Startzeit im Format HH:MM, z. B. "08:15".',
              },
              endTime: {
                type: Type.STRING,
                description: 'Optionale Endzeit im Format HH:MM, z. B. "09:00".',
              },
              category: {
                type: Type.STRING,
                description: 'Optionale Kategorie des Termins.',
                enum: ['exam', 'homework', 'lesson', 'event'],
              },
              room: {
                type: Type.STRING,
                description: 'Optionaler Raum oder Ort, z. B. "B204" oder "Lab 2".',
              },
            },
            required: ['title', 'date', 'courseTitle'],
          },
        },
      },
      required: ['items'],
    },
  },
];

// ---------- Helpers ----------

let spotlightSequenceCounter = 0;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidIsoDate(raw: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
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

function normalizeTimeHhMm(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^(\d{1,2})[:.](\d{2})$/.exec(raw.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function nowIsoTimestamp(): string {
  return new Date().toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw.replace(',', '.').trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toTrimmedString(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen).trimEnd() : trimmed;
}

function slugifySkillName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || `custom-skill-${Date.now().toString(36)}`;
}

function stripDataUrlPrefix(raw?: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const commaIdx = trimmed.indexOf(',');
  if (trimmed.startsWith('data:') && commaIdx !== -1) {
    return trimmed.slice(commaIdx + 1).trim();
  }
  return trimmed;
}

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

function isModelUnavailableMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('not supported') ||
    lower.includes('is not available') ||
    lower.includes('invalid model')
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unbekannter Fehler bei der Hermes-Anfrage.';
}

function fireAndForgetBridgePost(
  bridgeUrl: string | undefined,
  endpointPath: string,
  payload: Record<string, unknown>
): void {
  const trimmed = bridgeUrl?.trim();
  if (!trimmed) return;
  const base = trimmed.replace(/\/+$/, '');
  try {
    void fetch(`${base}${endpointPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  } catch {
    // Non-blocking best-effort sync to local companion bridge
  }
}

function formatNoteExcerpt(note: StudyNotePage, maxChars: number): string {
  const joined = note.blocks
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join(' | ');
  const clipped = joined.length > maxChars ? `${joined.slice(0, maxChars)}...` : joined;
  return `- ${note.title}: ${clipped}`;
}

function formatSkillAsMarkdown(skill: HermesSkill): string {
  return [
    '```markdown',
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `trigger: ${skill.trigger}`,
    '---',
    skill.instructions,
    '```',
  ].join('\n');
}

function convertGeminiSchemaToJsonSchema(schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (schema.type) {
    out.type = String(schema.type).toLowerCase();
  }
  if (schema.description) {
    out.description = schema.description;
  }
  if (schema.enum && schema.enum.length > 0) {
    out.enum = schema.enum;
  }
  if (typeof schema.minimum === 'number') {
    out.minimum = schema.minimum;
  }
  if (typeof schema.maximum === 'number') {
    out.maximum = schema.maximum;
  }
  if (schema.items) {
    out.items = convertGeminiSchemaToJsonSchema(schema.items);
  }
  if (schema.properties) {
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      props[key] = convertGeminiSchemaToJsonSchema(val);
    }
    out.properties = props;
  }
  if (schema.required && schema.required.length > 0) {
    out.required = schema.required;
  }
  return out;
}

const HERMES_OPENAI_TOOLS = HERMES_LIVE_FUNCTION_DECLARATIONS.map((decl) => ({
  type: 'function' as const,
  function: {
    name: decl.name ?? '',
    description: decl.description ?? '',
    parameters: decl.parameters
      ? convertGeminiSchemaToJsonSchema(decl.parameters)
      : { type: 'object', properties: {} },
  },
}));

// ---------- Tiered Hermes System Prompt Builder ----------

export function buildHermesTeacherSystemPrompt(params: {
  state: OpenStudyState;
  activeWindowTitle?: string;
  screenShared: boolean;
}): string {
  const { state, activeWindowTitle, screenShared } = params;
  const { voice } = state;
  const targetLang = LANGUAGE_META[voice.languageLock] ?? LANGUAGE_META.de;
  const explainLang = LANGUAGE_META[voice.explainLanguage] ?? LANGUAGE_META.de;

  const activeCourse =
    state.courses.find((c) => c.id === state.activeCourseId) ?? state.courses[0];

  // TIER 1 — Stable Teacher Identity, Language Lock & Screen Vision Protocol
  const languageDirective = voice.bilingualCoach
    ? [
        `STRIKTE ZWEISPRACHIGE SPERRUNG:`,
        `- Führe Gespräche, Übungen und Beispiele strikt auf ${targetLang.nativeName} (${targetLang.bcp47}).`,
        `- Nutze ${explainLang.nativeName} (${explainLang.bcp47}) nur kurz für präzise Grammatik- oder Begriffserklärungen und kehre sofort zu ${targetLang.nativeName} zurück.`,
      ].join('\n')
    : [
        `STRIKTE SPRACHSPERRUNG:`,
        `- Antworte ausschliesslich auf ${targetLang.nativeName} (${targetLang.bcp47}).`,
        `- Wechsle niemals eigenständig die Sprache, ausser die Lernperson verlangt es ausdrücklich.`,
        voice.languageLock === 'de'
          ? '- Nutze klares, ruhiges Schweizer Hochdeutsch (ss statt ß, keine Ausrufezeichen, keine Emojis).'
          : '- Maintain a calm, natural, encouraging teacher tone without emojis or exclamation spam.',
      ].join('\n');

  const stanceDirective =
    voice.stance === 'coach'
      ? 'HALTUNG (SOKRATISCHER COACH): Leite die Lernperson mit gezielten Hinweisen, Beispielen und kurzen Zwischenfragen zum eigenen Verstehen an, statt Aufgaben sofort komplett vorzulösen.'
      : 'HALTUNG (DIREKTER ASSISTENT): Liefere klare, vollständige Erklärungen, Musterlösungen, Formeln und Lernpläne direkt und ohne Umwege.';

  const depthDirective =
    voice.depth === 'concise'
      ? 'ANTWORTTIEFE (KOMPAKT): Halte Antworten standardmässig knapp und gut lesbar (2 bis 4 klare Sätze oder Schritte). Wenn die Lernperson "ausführlich", "in depth" oder "genauer erklären" sagt, wechsle sofort zu einer vertieften Schritt-für-Schritt-Erklärung.'
      : 'ANTWORTTIEFE (VERTIEFT): Erkläre Zusammenhänge immer gründlich Schritt für Schritt mit Intuition, klaren Beispielen und typischen Fehlerquellen.';

  const modeDirective =
    voice.mode === 'exam'
      ? 'MODUS (PRÜFUNGSSIMULATION): Stelle jeweils genau eine realistische Prüfungsfrage zum aktiven Fach, warte die Antwort ab und gib konstruktives Punkte-Feedback.'
      : voice.mode === 'language'
        ? `MODUS (SPRACHCOACH): Fördere flüssiges Sprechen und sauberen Ausdruck auf ${targetLang.nativeName}, mit freundlichen, konkreten Formulierungsvorschlägen.`
        : 'MODUS (ERKLÄREN & BEGLEITEN): Erkläre Fachstoff und Programme anschaulich, logisch aufgebaut und alltagsnah.';

  const tier1 = [
    '=== TIER 1: STABILE IDENTITÄT (OPENSTUDY HERMES TEACHER) ===',
    'Du bist der OpenStudy Hermes Teacher — ein ruhiger, kompetenter, menschlicher Lernbegleiter nach der Hermes-Agent-Architektur.',
    'Du verbindest Fachwissen mit direkter Hilfe auf dem Bildschirm und realen OpenStudy-Werkzeugen.',
    '',
    languageDirective,
    stanceDirective,
    depthDirective,
    modeDirective,
    '',
    'STRIKTE ANTI-HALLUZINATIONS-REGEL (OBERSTE PFLICHT):',
    '1. Behaupte NIEMALS, etwas auf dem Bildschirm zu sehen, das du nicht glasklar ablesen kannst. Rate niemals und extrapoliere niemals typische Standardmuster (z. B. niemals behaupten "Hi-Hat auf 1, 3, 5, 7..." oder "Kick auf 1 und Snare auf 3", nur weil du es vorher vorgeschlagen hast!).',
    '2. Sobald der Lernende fragt, wo er etwas platziert hat, welche Buttons/Steps/Zellen/Werte aktiv sind, ob etwas stimmt oder was gerade im Detail passiert: Rufe ZUERST ZWINGEND das Tool inspect_screen_detail auf (mit einer präzisen Prüffrage und bei kleinen UI-Bereichen gerne zusätzlich einem Zoom-Ausschnitt xMin/yMin/xMax/yMax), bevor du antwortest!',
    '3. Antworte danach AUSSCHLIESSLICH auf Basis des zurückgegebenen Prüfberichts. Meldet inspect_screen_detail "NICHT SICHER LESBAR", sage ehrlich und direkt auf Deutsch, dass die Stelle zu klein oder unklar ist und bitte kurz ums Vergrössern oder Zoomen — erfinde NIEMALS eine Antwort!',
    '',
    'BILDSCHIRM-SEHEN & ZEIGE-PROTOKOLL:',
    '- Sobald die Lernperson ihren Bildschirm teilt oder nach einer anderen App fragt (z. B. Excel, Word, OneNote, PowerPoint, FL Studio, VS Code, Obsidian, PDF-Reader oder Browser), beschreibe zuerst in einem Satz, was du eindeutig siehst (bei feinen UI-Details erst nach inspect_screen_detail).',
    '- Erkläre danach ruhig Schritt für Schritt und rufe PROAKTIV das Werkzeug highlight_screen_region(xPercent, yPercent, label, stepNumber) mit präzisen Prozent-Koordinaten (0–100 von links/oben) auf, um Menüs, Schaltflächen, Zellen, Formeln, Codezeilen oder Diagrammstellen direkt auf dem Bildschirm zu markieren.',
    '- Halte Marker-Labels kurz (max. 40 Zeichen, z. B. "Formelleiste anklicken" oder "Zelle B2 auswählen") und nummeriere aufeinanderfolgende Schritte (1, 2, 3).',
    '- Wenn sich der Kontext ändert oder alte Marker stören, entferne sie zuerst mit clear_screen_highlights.',
    '',
    'WERKZEUG-PRINZIPIEN:',
    '- Erstelle Lernnotizen (create_study_note), Karteikarten (create_flashcards) oder Tagesplan-Aufgaben (add_daily_plan_tasks), sobald sie dem Lernfortschritt konkret helfen oder gewünscht werden.',
    '- Trage erkannte Prüfungen, Tests, Abgaben oder Termine der nächsten 3 Monate (90 Tage, z. B. aus einem geöffneten Schulportal oder Stundenplan) mit add_school_schedule direkt in den OpenStudy-Prüfungskalender ein.',
    '- Nutze save_learning_memory für wichtige dauerhafte Beobachtungen über Lernstil, Stärken, Schwächen oder Ziele.',
    '- Nutze save_custom_skill nur dann, wenn du ein wiederverwendbares Lehrverfahren (SKILL.md) für wiederkehrende Aufgaben festhalten oder verbessern kannst.',
  ].join('\n');

  // TIER 2 — Active SKILL.md Skills & Workspace Context
  const enabledSkills = state.hermesSkills.filter((sk) => sk.enabled);
  const skillsSection =
    enabledSkills.length > 0
      ? [
          'AKTIVE HERMES SKILLS (SKILL.md):',
          ...enabledSkills.map((sk) => formatSkillAsMarkdown(sk)),
        ].join('\n\n')
      : 'AKTIVE HERMES SKILLS: Keine zusätzlichen Skills aktiviert.';

  const contextLines: string[] = [];

  if (activeWindowTitle?.trim()) {
    contextLines.push(`AKTIVES PC-FENSTER: ${activeWindowTitle.trim()}`);
  }

  if (activeCourse) {
    const objectives = activeCourse.objectives
      .map((obj) => `  - [${obj.mastery}] ${obj.title}: ${obj.summary}`)
      .join('\n');
    contextLines.push(
      [
        `AKTIVER KURS: ${activeCourse.title} (${activeCourse.category})`,
        activeCourse.examDate ? `Prüfungstermin: ${activeCourse.examDate}` : '',
        activeCourse.description ? `Schwerpunkt: ${activeCourse.description}` : '',
        objectives ? `Lernziele:\n${objectives}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  if (state.courses.length > 1) {
    const otherCourses = state.courses
      .filter((c) => c.id !== activeCourse?.id)
      .map((c) => c.title)
      .join(', ');
    if (otherCourses) {
      contextLines.push(`WEITERE VERFÜGBARE KURSE: ${otherCourses}`);
    }
  }

  const relevantNotes = activeCourse
    ? state.notes.filter((n) => n.courseId === activeCourse.id).slice(0, 4)
    : state.notes.slice(0, 3);
  if (relevantNotes.length > 0) {
    contextLines.push(
      `LOKALE LERNNOTIZEN:\n${relevantNotes.map((n) => formatNoteExcerpt(n, 420)).join('\n')}`
    );
  }

  const selectedObsidian = state.obsidianNotes.filter((n) => n.selectedForContext).slice(0, 4);
  if (selectedObsidian.length > 0) {
    const obsLines = selectedObsidian.map((n) => {
      const body = (n.content || n.excerpt || '').replace(/\s+/g, ' ').trim();
      const clipped = body.length > 440 ? `${body.slice(0, 440)}...` : body;
      return `- ${n.title}: ${clipped}`;
    });
    contextLines.push(`AUSGEWÄHLTER OBSIDIAN-KONTEXT:\n${obsLines.join('\n')}`);
  }

  const openTasks = state.dailyPlan.filter((t) => !t.done).slice(0, 5);
  if (openTasks.length > 0) {
    contextLines.push(
      `OFFENE TAGESPLAN-AUFGABEN:\n${openTasks
        .map((t) => `- ${t.title} (${t.minutes} Min., ${t.scheduledFor})`)
        .join('\n')}`
    );
  }

  const tier2 = [
    '=== TIER 2: SKILLS & LERNKONTEXT ===',
    skillsSection,
    '',
    'ARBEITSBEREICH-KONTEXT:',
    ...contextLines,
  ].join('\n');

  // TIER 3 — Volatile Learner Memory & Live Screen State
  const memoryLines =
    state.hermesMemory.length > 0
      ? state.hermesMemory
          .slice(0, 25)
          .map((m) => `- [${m.category}] ${m.fact}`)
          .join('\n')
      : '- Noch keine gespeicherten Lernfakten vorhanden.';

  const screenStateLine = screenShared
    ? 'LIVE-BILDSCHIRMSTATUS: AKTIV — Ein aktuelles Bildschirmbild ist sichtbar. Nutze vor jeder Aussage über kleine UI-Details zwingend inspect_screen_detail und setze bei Bedarf mit highlight_screen_region präzise Marker.'
    : 'LIVE-BILDSCHIRMSTATUS: INAKTIV — Derzeit ist kein Bildschirm geteilt. Falls die Lernperson Hilfe zu einer externen App braucht, weise ruhig auf die Bildschirmfreigabe hin.';

  const activeSpotlightsLine =
    state.screenSpotlights.length > 0
      ? `AKTUELLE BILDSCHIRM-MARKER:\n${state.screenSpotlights
          .map(
            (s) =>
              `- Schritt ${s.stepNumber}: "${s.label}" bei (${Math.round(s.xPercent)}%, ${Math.round(s.yPercent)}%)`
          )
          .join('\n')}`
      : 'AKTUELLE BILDSCHIRM-MARKER: Keine aktiv.';

  const tier3 = [
    '=== TIER 3: LERNGEDÄCHTNIS & LIVE-ZUSTAND ===',
    `HERMES LERNGEDÄCHTNIS:\n${memoryLines}`,
    '',
    screenStateLine,
    activeSpotlightsLine,
  ].join('\n');

  return [tier1, '', tier2, '', tier3].join('\n');
}

// ---------- Forensic High-Resolution Screen Inspector ----------

const FORENSIC_SCREEN_INSPECTOR_PROMPT = [
  'Du bist ein forensischer, streng faktenbasierter Bildschirm-Prüfer. Deine einzige Aufgabe ist das präzise, wörtliche Ablesen sichtbarer Pixel im beigefügten Screenshot (und optionalen Zoom-Ausschnitt).',
  'Schreibe auf klarem Schweizer Hochdeutsch (ss statt ß), kompakt, strukturiert und ohne Spekulation.',
  '',
  'STRENGE PRÜFREGELN:',
  '1. Prüfe AUSSCHLIESSLICH buchstäblich sichtbare Pixel. Rate niemals, vervollständige niemals fehlende Informationen und nimm niemals typische Standardmuster an (z. B. niemals 1, 3, 5, 7, 9, 11, 13, 15 oder Kick auf 1 / Snare auf 3 unterstellen).',
  '2. Bei Step-Sequencern, Rastern oder DAWs (z. B. FL Studio Channel Rack):',
  '   - Liste jede sichtbare Spur bzw. jeden Kanal strikt von oben nach unten exakt mit dem angezeigten Namen auf.',
  '   - Bestimme visuell die exakte Anzahl der Step-Buttons pro Zeile (häufig 16 Schritte in Vierergruppen: 1–4, 5–8, 9–12, 13–16).',
  '   - Vergleiche Helligkeit, Füllfarbe und Kontrast JEDES einzelnen Buttons von links nach rechts (Step 1 bis Ende) direkt mit seinen dunklen/inaktiven Nachbarn innerhalb derselben Vierergruppe.',
  '   - Liste pro Spur AUSSCHLIESSLICH die Step-Nummern auf, die unzweifelhaft hell/beleuchtet/aktiv sind. Sind alle Buttons einer Spur dunkel/inaktiv, schreibe exakt "keine aktiv".',
  '3. Bei Formularen, Tabellen (Excel), Code-Editoren, Menüs, Browsern oder Dialogen:',
  '   - Zitiere ausschliesslich buchstäblich lesbaren Text, Zahlen, Zellbezüge, Formeln, geöffnete Menüs, aktive Tabs oder sichtbare Markierungen.',
  '4. Wenn IRGENDEIN kleiner Button, Step, Wert oder Text zu unscharf, zu klein, abgeschnitten, kontrastarm oder verdeckt ist, um ihn mit 100 % Sicherheit abzulesen, schreibe explizit "NICHT SICHER LESBAR" und nenne kurz den Grund und die betroffene Stelle.',
  '5. Erfinde niemals Elemente, die nicht eindeutig im Bild erkennbar sind.',
].join('\n');

interface CapturedScreenFrame {
  base64: string;
  width: number;
  height: number;
  source: 'windows-bridge' | 'screen-share';
}

async function runForensicScreenInspection(params: {
  apiKey: string;
  question: string;
  fullFrame: CapturedScreenFrame | null;
  zoomedFrame: CapturedScreenFrame | null;
  crop?: { xMin: number; yMin: number; xMax: number; yMax: number };
}): Promise<string> {
  const { apiKey, question, fullFrame, zoomedFrame, crop } = params;
  const ai = new GoogleGenAI({ apiKey });

  const fullB64 = fullFrame ? stripDataUrlPrefix(fullFrame.base64) : '';
  const zoomedB64 = zoomedFrame ? stripDataUrlPrefix(zoomedFrame.base64) : '';

  const headerLines = [`VISUELLE PRÜFFRAGE: ${question}`];
  if (fullB64 && fullFrame && zoomedB64 && zoomedFrame && crop) {
    headerLines.push(
      `Bild 1 zeigt den vollständigen Bildschirm (${fullFrame.width}×${fullFrame.height} px).`,
      `Bild 2 zeigt den vergrösserten Zoom-Ausschnitt x=${Math.round(crop.xMin)}%–${Math.round(crop.xMax)}%, y=${Math.round(crop.yMin)}%–${Math.round(crop.yMax)}% (${zoomedFrame.width}×${zoomedFrame.height} px). Nutze Bild 2 vorrangig für feine UI-Elemente und Bild 1 für den Gesamtkontext.`
    );
  } else if (fullB64 && fullFrame) {
    headerLines.push(
      `Das beigefügte Bild zeigt den vollständigen Bildschirm (${fullFrame.width}×${fullFrame.height} px).`
    );
  } else if (zoomedB64 && zoomedFrame) {
    headerLines.push(
      `Das beigefügte Bild zeigt den vergrösserten Bildschirmausschnitt (${zoomedFrame.width}×${zoomedFrame.height} px).`
    );
  }

  const parts: Part[] = [{ text: headerLines.join('\n') }];
  if (fullB64) {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: fullB64,
      },
    });
  }
  if (zoomedB64) {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: zoomedB64,
      },
    });
  }

  let lastError: unknown = null;
  for (const model of FREE_GEMINI_TEXT_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: FORENSIC_SCREEN_INSPECTOR_PROMPT,
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
          temperature: 0.1,
        },
      });
      const text = response.text?.trim() ?? '';
      return text || 'NICHT SICHER LESBAR — Die Detailprüfung lieferte keinen eindeutigen Befund.';
    } catch (err) {
      lastError = err;
      const msg = formatError(err);
      if (isModelUnavailableMessage(msg)) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Forensische Bildschirmprüfung fehlgeschlagen: ${formatError(lastError)}`);
}

// ---------- Tool Executor ----------

export async function executeHermesToolCall(
  call: { id?: string; name: string; args?: Record<string, unknown> },
  state: OpenStudyState,
  handlers: HermesToolHandlers
): Promise<{
  id?: string;
  name: string;
  response: Record<string, unknown>;
  execution: HermesToolExecution;
}> {
  const args = call.args ?? {};
  const activeCourseId = state.activeCourseId || state.courses[0]?.id || 'course-default';

  const finish = (
    status: 'ok' | 'error',
    summary: string,
    response: Record<string, unknown>
  ) => {
    const execution: HermesToolExecution = {
      id: makeId('act'),
      toolName: call.name,
      summary,
      timestamp: nowIsoTimestamp(),
      status,
    };
    try {
      handlers.onLogAction(execution);
    } catch {
      // keep tool execution resilient even if UI logger fails
    }
    return {
      id: call.id,
      name: call.name,
      response,
      execution,
    };
  };

  try {
    switch (call.name) {
      case 'inspect_screen_detail': {
        const question =
          toTrimmedString(args.question, 600) ||
          'Beschreibe präzise alle aktuell sichtbaren UI-Details und aktiven Zustände auf dem Bildschirm.';

        const hasCropParam =
          args.xMin !== undefined ||
          args.yMin !== undefined ||
          args.xMax !== undefined ||
          args.yMax !== undefined;

        let crop: { xMin: number; yMin: number; xMax: number; yMax: number } | undefined;
        if (hasCropParam) {
          const xMin = clamp(toFiniteNumber(args.xMin, 0), 0, 95);
          const yMin = clamp(toFiniteNumber(args.yMin, 0), 0, 95);
          const xMax = clamp(toFiniteNumber(args.xMax, 100), Math.min(100, xMin + 5), 100);
          const yMax = clamp(toFiniteNumber(args.yMax, 100), Math.min(100, yMin + 5), 100);
          const isFullFrame = xMin <= 0.5 && yMin <= 0.5 && xMax >= 99.5 && yMax >= 99.5;
          if (!isFullFrame) {
            crop = { xMin, yMin, xMax, yMax };
          }
        }

        const apiKey = state.provider.geminiApiKey.trim();
        const fullFrame = handlers.captureFreshFullResFrame
          ? await handlers.captureFreshFullResFrame()
          : null;
        const zoomedFrame =
          crop && handlers.captureFreshFullResFrame
            ? await handlers.captureFreshFullResFrame(crop)
            : null;

        const validFull =
          fullFrame && stripDataUrlPrefix(fullFrame.base64).length > 0 ? fullFrame : null;
        const validZoomed =
          zoomedFrame && stripDataUrlPrefix(zoomedFrame.base64).length > 0 ? zoomedFrame : null;
        const primaryFrame = validFull ?? validZoomed;

        if (!primaryFrame || !apiKey) {
          return finish('error', 'HD-Prüfung nicht verfügbar', {
            ok: false,
            verified: false,
            report:
              'Kein aktuelles HD-Bildschirmbild verfügbar. Sage dem Lernenden ehrlich, dass du das Detail gerade nicht sicher sehen kannst.',
          });
        }

        try {
          const report = await runForensicScreenInspection({
            apiKey,
            question,
            fullFrame: validFull,
            zoomedFrame: validZoomed,
            crop,
          });
          const sourceLabel =
            primaryFrame.source === 'windows-bridge' ? 'Windows HD' : 'Stream';
          const summary = `HD-Prüfung (${primaryFrame.width}×${primaryFrame.height}, ${sourceLabel}${validZoomed ? ' + Zoom' : ''})`;
          return finish('ok', summary, {
            ok: true,
            verified: true,
            resolution: `${primaryFrame.width}x${primaryFrame.height}`,
            source: primaryFrame.source,
            ...(validZoomed
              ? { zoomedResolution: `${validZoomed.width}x${validZoomed.height}` }
              : {}),
            report,
          });
        } catch (err) {
          const errMsg = formatError(err);
          return finish('error', `HD-Prüfung fehlgeschlagen: ${errMsg.slice(0, 72)}`, {
            ok: false,
            verified: false,
            report:
              'Die HD-Detailprüfung konnte technisch nicht abgeschlossen werden. Sage dem Lernenden ehrlich, dass du das Detail gerade nicht sicher ablesen kannst.',
            error: errMsg,
          });
        }
      }

      case 'highlight_screen_region': {
        const rawX = toFiniteNumber(args.xPercent, 50);
        const rawY = toFiniteNumber(args.yPercent, 50);
        const xPercent = Math.round(clamp(rawX, 4, 96) * 10) / 10;
        const yPercent = Math.round(clamp(rawY, 4, 96) * 10) / 10;
        const label = toTrimmedString(args.label, 40) || 'Hier schauen';

        let stepNumber: number;
        if (args.stepNumber !== undefined && args.stepNumber !== null) {
          stepNumber = Math.max(1, Math.min(99, Math.round(toFiniteNumber(args.stepNumber, 1))));
          spotlightSequenceCounter = stepNumber;
        } else {
          spotlightSequenceCounter = (spotlightSequenceCounter % 9) + 1;
          stepNumber = Math.max(spotlightSequenceCounter, state.screenSpotlights.length + 1);
        }

        const spotlight: ScreenSpotlight = {
          id: makeId('spot'),
          xPercent,
          yPercent,
          label,
          stepNumber,
          createdAt: Date.now(),
        };

        handlers.onHighlightScreen(spotlight);

        if (handlers.desktopOverlayEnabled && handlers.bridgeUrl) {
          fireAndForgetBridgePost(handlers.bridgeUrl, '/api/desktop/highlight', {
            id: spotlight.id,
            xPercent: spotlight.xPercent,
            yPercent: spotlight.yPercent,
            label: spotlight.label,
            stepNumber: spotlight.stepNumber,
          });
        }

        return finish(
          'ok',
          `Marker ${stepNumber}: "${label}" (${Math.round(xPercent)} %, ${Math.round(yPercent)} %)`,
          {
            ok: true,
            spotlight,
          }
        );
      }

      case 'clear_screen_highlights': {
        spotlightSequenceCounter = 0;
        handlers.onClearSpotlights();

        if (handlers.desktopOverlayEnabled && handlers.bridgeUrl) {
          fireAndForgetBridgePost(handlers.bridgeUrl, '/api/desktop/highlight', {
            clear: true,
          });
        }

        return finish('ok', 'Bildschirm-Marker entfernt', {
          ok: true,
          cleared: true,
        });
      }

      case 'create_study_note': {
        const title = toTrimmedString(args.title, 120) || 'Neue Lernnotiz';
        const summary = toTrimmedString(args.summary, 2400);
        const keyTakeaway = toTrimmedString(args.keyTakeaway, 400);
        const rawBullets = Array.isArray(args.bullets) ? args.bullets : [];
        const bullets = rawBullets
          .map((item) => toTrimmedString(item, 320))
          .filter(Boolean)
          .slice(0, 14);

        const blocks: NoteBlock[] = [{ id: makeId('blk'), type: 'h1', text: title }];
        if (keyTakeaway) {
          blocks.push({
            id: makeId('blk'),
            type: 'callout',
            text: `Merksatz: ${keyTakeaway}`,
          });
        }
        if (summary) {
          blocks.push({
            id: makeId('blk'),
            type: 'text',
            text: summary,
          });
        }
        if (bullets.length > 0) {
          blocks.push({
            id: makeId('blk'),
            type: 'h2',
            text: 'Wichtige Punkte',
          });
          for (const bullet of bullets) {
            blocks.push({
              id: makeId('blk'),
              type: 'text',
              text: `• ${bullet}`,
            });
          }
        }

        const page: StudyNotePage = {
          id: makeId('note'),
          courseId: activeCourseId,
          title,
          tags: ['hermes', 'lernnotiz'],
          updatedAt: todayIsoDate(),
          blocks,
          source: 'local',
        };

        handlers.onCreateNote(page);

        return finish('ok', `Notiz erstellt: "${title}"`, {
          ok: true,
          noteId: page.id,
          title: page.title,
          blocksCount: blocks.length,
        });
      }

      case 'create_flashcards': {
        const rawCards = Array.isArray(args.cards) ? args.cards : [];
        const now = Date.now();
        const cards: StudyCard[] = [];

        for (const item of rawCards.slice(0, 12)) {
          if (!item || typeof item !== 'object') continue;
          const record = item as Record<string, unknown>;
          const front = toTrimmedString(record.front, 320);
          const back = toTrimmedString(record.back, 640);
          const hint = toTrimmedString(record.hint, 180);
          if (!front || !back) continue;
          cards.push({
            id: makeId('card'),
            courseId: activeCourseId,
            front,
            back,
            ...(hint ? { hint } : {}),
            interval: 0,
            ease: 2.5,
            reps: 0,
            due: now,
          });
        }

        if (cards.length === 0) {
          return finish('error', 'Karteikarten-Erstellung ohne gültige Karten', {
            ok: false,
            error: 'Mindestens eine Karte mit Vorder- und Rückseite ist erforderlich.',
          });
        }

        handlers.onCreateCards(cards);

        return finish('ok', `${cards.length} Karteikarten erstellt`, {
          ok: true,
          count: cards.length,
          cardIds: cards.map((c) => c.id),
        });
      }

      case 'add_daily_plan_tasks': {
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        const tasks: DailyPlanTask[] = [];

        for (const item of rawTasks.slice(0, 10)) {
          if (!item || typeof item !== 'object') continue;
          const record = item as Record<string, unknown>;
          const title = toTrimmedString(record.title, 140);
          if (!title) continue;
          const minutes = Math.round(clamp(toFiniteNumber(record.minutes, 15), 5, 180));
          const scheduledFor = toTrimmedString(record.scheduledFor, 40) || 'Heute';
          tasks.push({
            id: makeId('dp'),
            courseId: activeCourseId,
            title,
            minutes,
            done: false,
            scheduledFor,
          });
        }

        if (tasks.length === 0) {
          return finish('error', 'Keine gültigen Tagesplan-Aufgaben übergeben', {
            ok: false,
            error: 'Mindestens eine Aufgabe mit Titel ist erforderlich.',
          });
        }

        handlers.onAddPlanTasks(tasks);

        return finish('ok', `${tasks.length} Aufgaben im Tagesplan ergänzt`, {
          ok: true,
          count: tasks.length,
          taskIds: tasks.map((t) => t.id),
        });
      }

      case 'navigate_app': {
        const rawView = toTrimmedString(args.view, 32).toLowerCase() as MainView;
        if (!VALID_VIEWS.has(rawView)) {
          return finish('error', `Ungültige Zielansicht: "${String(args.view ?? '')}"`, {
            ok: false,
            error:
              'Erlaubte Ansichten sind: home, calendar, teacher, notes, trainer, languages, focus, import.',
          });
        }

        const requestedCourse = toTrimmedString(args.courseTitle, 100).toLowerCase();
        const matchedCourse = requestedCourse
          ? state.courses.find(
              (c) =>
                c.title.toLowerCase().includes(requestedCourse) ||
                requestedCourse.includes(c.title.toLowerCase()) ||
                c.id.toLowerCase() === requestedCourse
            )
          : undefined;

        handlers.onNavigate(rawView, matchedCourse?.id);

        return finish(
          'ok',
          `Ansicht geöffnet: ${rawView}${matchedCourse ? ` (${matchedCourse.title})` : ''}`,
          {
            ok: true,
            view: rawView,
            courseId: matchedCourse?.id ?? null,
          }
        );
      }

      case 'save_learning_memory': {
        const fact = toTrimmedString(args.fact, 280);
        if (!fact) {
          return finish('error', 'Leerer Lernfakt wurde nicht gespeichert', {
            ok: false,
            error: 'Feld "fact" darf nicht leer sein.',
          });
        }

        const rawCategory = toTrimmedString(args.category, 32).toLowerCase() as
          | HermesMemoryEntry['category']
          | '';
        const category: HermesMemoryEntry['category'] =
          rawCategory && VALID_MEMORY_CATEGORIES.has(rawCategory) ? rawCategory : 'preference';

        const entry: HermesMemoryEntry = {
          id: makeId('mem'),
          fact,
          category,
          createdAt: todayIsoDate(),
          source: 'agent',
        };

        handlers.onSaveMemory(entry);

        if (handlers.bridgeUrl) {
          fireAndForgetBridgePost(handlers.bridgeUrl, '/api/hermes/memory', {
            id: entry.id,
            fact: entry.fact,
            category: entry.category,
            createdAt: entry.createdAt,
            source: entry.source,
            entry,
          });
        }

        return finish('ok', `Lerngedächtnis (${category}): ${fact.slice(0, 68)}`, {
          ok: true,
          memoryId: entry.id,
          category: entry.category,
        });
      }

      case 'save_custom_skill': {
        const rawName = toTrimmedString(args.name, 64);
        const description = toTrimmedString(args.description, 220);
        const trigger = toTrimmedString(args.trigger, 240);
        const instructions = toTrimmedString(args.instructions, 2000);

        if (!rawName || !instructions) {
          return finish('error', 'SKILL.md unvollständig (Name oder Anleitung fehlt)', {
            ok: false,
            error: 'Für save_custom_skill sind "name" und "instructions" erforderlich.',
          });
        }

        const slugName = slugifySkillName(rawName);
        const existing = state.hermesSkills.find(
          (sk) => sk.name.toLowerCase() === slugName.toLowerCase()
        );

        const skill: HermesSkill = {
          id: existing?.id ?? makeId('skill'),
          name: slugName,
          description: description || `Benutzerdefinierter Skill (${slugName})`,
          trigger: trigger || 'Wenn die passende Lernsituation auftritt.',
          instructions,
          enabled: true,
          builtIn: existing?.builtIn ?? false,
          updatedAt: todayIsoDate(),
        };

        handlers.onSaveSkill(skill);

        if (handlers.bridgeUrl) {
          fireAndForgetBridgePost(handlers.bridgeUrl, '/api/hermes/skills', {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            trigger: skill.trigger,
            instructions: skill.instructions,
            enabled: skill.enabled,
            updatedAt: skill.updatedAt,
            skill,
          });
        }

        return finish('ok', `SKILL.md gespeichert: ${skill.name}`, {
          ok: true,
          skillId: skill.id,
          name: skill.name,
        });
      }

      case 'add_school_schedule': {
        const rawItems = Array.isArray(args.items) ? args.items : [];
        const items: SchoolScheduleItem[] = [];
        const seenKeys = new Set<string>();

        for (const raw of rawItems.slice(0, 60)) {
          if (!raw || typeof raw !== 'object') continue;
          const record = raw as Record<string, unknown>;
          const title = toTrimmedString(record.title, 140);
          const date = toTrimmedString(record.date, 20);
          const courseTitle = toTrimmedString(record.courseTitle, 80) || 'Allgemein';
          const startTime = normalizeTimeHhMm(record.startTime);
          const endTime = normalizeTimeHhMm(record.endTime);
          const rawCategory = toTrimmedString(record.category, 24).toLowerCase() as
            | ScheduleItemCategory
            | '';
          const category =
            rawCategory && VALID_SCHEDULE_CATEGORIES.has(rawCategory)
              ? rawCategory
              : undefined;
          const room = toTrimmedString(record.room, 48) || undefined;

          if (!title || !isValidIsoDate(date)) continue;

          const dedupeKey = `${date}|${startTime ?? ''}|${title.toLowerCase()}`;
          if (seenKeys.has(dedupeKey)) continue;
          seenKeys.add(dedupeKey);

          items.push({
            id: makeId('sched'),
            title,
            date,
            courseTitle,
            source: 'smart-import',
            ...(startTime ? { startTime } : {}),
            ...(endTime ? { endTime } : {}),
            ...(category ? { category } : {}),
            ...(room ? { room } : {}),
          });
        }

        if (items.length === 0) {
          return finish('error', 'Keine gültigen Termine (YYYY-MM-DD) übergeben', {
            ok: false,
            error:
              'Mindestens ein Termin mit Titel, Fachname und gültigem Datum im Format YYYY-MM-DD ist erforderlich.',
          });
        }

        handlers.onAddSchoolScheduleItems?.(items);

        const summary =
          items.length === 1
            ? `Termin eingetragen: "${items[0].title}" (${items[0].date}${items[0].startTime ? ` ${items[0].startTime}` : ''}, ${items[0].courseTitle})`
            : `${items.length} Termine im Kalender eingetragen`;

        return finish('ok', summary, {
          ok: true,
          count: items.length,
          itemIds: items.map((item) => item.id),
          items,
        });
      }

      default: {
        return finish('error', `Unbekanntes Werkzeug: ${call.name}`, {
          ok: false,
          error: `Werkzeug "${call.name}" ist nicht registriert.`,
        });
      }
    }
  } catch (err) {
    const message = formatError(err);
    return finish('error', `Fehler bei ${call.name}: ${message}`, {
      ok: false,
      error: message,
    });
  }
}

// ---------- Fallback Inline <hermes_action> Parser ----------

async function parseAndExecuteInlineActions(
  rawReply: string,
  state: OpenStudyState,
  handlers: HermesToolHandlers,
  executedTools: HermesToolExecution[]
): Promise<string> {
  const actionRegex = /<hermes_action>\s*([\s\S]*?)\s*<\/hermes_action>/gi;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = actionRegex.exec(rawReply)) !== null) {
    if (match[1]?.trim()) {
      matches.push(match[1].trim());
    }
  }

  for (const jsonChunk of matches) {
    try {
      const parsed = JSON.parse(jsonChunk) as {
        tool?: string;
        name?: string;
        args?: Record<string, unknown>;
        arguments?: Record<string, unknown>;
      };
      const toolName = (parsed.tool ?? parsed.name ?? '').trim();
      const toolArgs = parsed.args ?? parsed.arguments ?? {};
      if (!toolName) continue;
      const result = await executeHermesToolCall(
        { name: toolName, args: typeof toolArgs === 'object' && toolArgs ? toolArgs : {} },
        state,
        handlers
      );
      executedTools.push(result.execution);
    } catch {
      // Ignore malformed inline action JSON cleanly
    }
  }

  return rawReply.replace(actionRegex, '').trim();
}

function summarizeExecutedTools(executedTools: HermesToolExecution[]): string {
  if (executedTools.length === 0) {
    return 'Ich habe deine Anfrage verarbeitet.';
  }
  const items = executedTools.map((t) => `- ${t.summary}`).join('\n');
  return `Folgende Aktionen wurden direkt in OpenStudy ausgeführt:\n${items}`;
}

// ---------- Gemini Free Agentic Loop (up to 4 tool rounds) ----------

async function generateGeminiWithFallback(
  ai: GoogleGenAI,
  candidateModels: string[],
  contents: Content[],
  systemInstruction: string,
  includeTools: boolean,
  hasImage: boolean
): Promise<{ response: GenerateContentResponse; model: string }> {
  let lastError: unknown = null;

  for (const model of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          ...(hasImage
            ? {
                mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
                temperature: 0.2,
              }
            : {}),
          ...(includeTools
            ? { tools: [{ functionDeclarations: HERMES_LIVE_FUNCTION_DECLARATIONS }] }
            : {}),
        },
      });
      return { response, model };
    } catch (err) {
      lastError = err;
      const msg = formatError(err);
      if (isModelUnavailableMessage(msg)) {
        continue;
      }
      if (msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('api key')) {
        throw new Error(
          'Der Gemini API-Key wurde abgelehnt. Prüfe deinen Schlüssel in den Einstellungen oder erstelle einen neuen Free-Tier Key in Google AI Studio.'
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

  throw new Error(`Keines der Gemini Free-Tier Modelle war erreichbar: ${formatError(lastError)}`);
}

async function runGeminiHermesLoop(params: {
  prompt: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  cleanImage: string;
  systemInstruction: string;
  state: OpenStudyState;
  handlers: HermesToolHandlers;
  executedTools: HermesToolExecution[];
}): Promise<{ reply: string; providerLabel: string; executedTools: HermesToolExecution[] }> {
  const { prompt, history, cleanImage, systemInstruction, state, handlers, executedTools } = params;
  const apiKey = state.provider.geminiApiKey.trim();

  const requestedModel = state.provider.geminiTextModel.trim();
  const isRequestedFree = (FREE_GEMINI_TEXT_MODELS as readonly string[]).includes(requestedModel);
  const primaryModel = state.provider.freeOnlyLock
    ? isRequestedFree
      ? requestedModel
      : FREE_GEMINI_TEXT_MODELS[0]
    : requestedModel || FREE_GEMINI_TEXT_MODELS[0];

  let activeCandidates = [
    primaryModel,
    ...FREE_GEMINI_TEXT_MODELS.filter((m) => m !== primaryModel),
  ];

  const contents: Content[] = history
    .slice(-10)
    .filter((entry) => entry.text.trim().length > 0)
    .map((entry) => ({
      role: entry.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: entry.text }],
    }));

  const currentParts: Part[] = [{ text: prompt }];
  if (cleanImage) {
    currentParts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: cleanImage,
      },
    });
  }
  contents.push({ role: 'user', parts: currentParts });

  const ai = new GoogleGenAI({ apiKey });
  const MAX_TOOL_ROUNDS = 4;
  let usedModel = primaryModel;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const allowTools = round < MAX_TOOL_ROUNDS;
    const { response, model } = await generateGeminiWithFallback(
      ai,
      activeCandidates,
      contents,
      systemInstruction,
      allowTools,
      Boolean(cleanImage)
    );
    usedModel = model;
    activeCandidates = [model];

    const calls = (response.functionCalls ?? []).filter(
      (fc): fc is typeof fc & { name: string } => typeof fc.name === 'string' && fc.name.length > 0
    );

    if (calls.length > 0 && allowTools) {
      const candidateContent = response.candidates?.[0]?.content;
      if (candidateContent?.parts && candidateContent.parts.length > 0) {
        contents.push({
          role: 'model',
          parts: candidateContent.parts,
        });
      } else {
        contents.push({
          role: 'model',
          parts: calls.map((fc) => ({ functionCall: fc })),
        });
      }

      const responseParts: Part[] = [];
      for (const fc of calls) {
        const res = await executeHermesToolCall(
          {
            id: fc.id,
            name: fc.name,
            args:
              fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args)
                ? (fc.args as Record<string, unknown>)
                : {},
          },
          state,
          handlers
        );
        executedTools.push(res.execution);
        responseParts.push({
          functionResponse: {
            id: res.id,
            name: res.name,
            response: res.response,
          },
        });
      }

      contents.push({
        role: 'user',
        parts: responseParts,
      });
      continue;
    }

    const rawReply = response.text?.trim() ?? '';
    const reply = rawReply
      ? await parseAndExecuteInlineActions(rawReply, state, handlers, executedTools)
      : summarizeExecutedTools(executedTools);

    return {
      reply: reply || summarizeExecutedTools(executedTools),
      providerLabel: `Hermes · Gemini Free (${usedModel})`,
      executedTools,
    };
  }

  return {
    reply: summarizeExecutedTools(executedTools),
    providerLabel: `Hermes · Gemini Free (${usedModel})`,
    executedTools,
  };
}

// ---------- Nous Research Hermes Gateway Loop (up to 3 tool rounds) ----------

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAiGatewayMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface HermesGatewayChatResponse {
  model?: string;
  text?: string;
  reply?: string;
  output?: string;
  tool_calls?: OpenAiToolCall[];
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: OpenAiToolCall[];
    };
  }>;
  error?: { message?: string } | string;
}

async function postHermesGatewayMessages(params: {
  state: OpenStudyState;
  messages: OpenAiGatewayMessage[];
  includeTools: boolean;
}): Promise<{ data: HermesGatewayChatResponse; model: string }> {
  const { state, messages, includeTools } = params;
  const provider = state.provider;
  const bridgeBase = (provider.bridgeUrl?.trim() || 'http://127.0.0.1:4319').replace(/\/+$/, '');
  const gatewayBase = (provider.hermesGatewayUrl?.trim() || 'http://127.0.0.1:9119').replace(
    /\/+$/,
    ''
  );
  const model = provider.hermesModel?.trim() || 'hermes-default';
  const apiKey = provider.hermesApiKey?.trim() || '';

  const bridgeIsLocal = isLocalhostUrl(bridgeBase);
  const gatewayIsLocal = isLocalhostUrl(gatewayBase);

  if (provider.freeOnlyLock && !bridgeIsLocal && !gatewayIsLocal) {
    throw new Error(
      'Kostenlos-Sperre aktiv: Im Modus "Nur Kostenlos" ist Hermes Gateway nur lokal (127.0.0.1 / localhost) erlaubt.'
    );
  }

  const toolsPayload = includeTools ? HERMES_OPENAI_TOOLS : undefined;

  let bridgeError: string | null = null;
  if (!provider.freeOnlyLock || bridgeIsLocal) {
    try {
      const res = await fetch(`${bridgeBase}/api/hermes/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gatewayUrl: gatewayBase,
          model,
          apiKey: apiKey || undefined,
          messages,
          ...(toolsPayload ? { tools: toolsPayload, tool_choice: 'auto' } : {}),
        }),
      });

      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as HermesGatewayChatResponse;
        if (!data.error) {
          return { data, model: data.model || model };
        }
        bridgeError = typeof data.error === 'string' ? data.error : data.error.message || null;
      } else if (res.status !== 404) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        bridgeError = errBody.error || `Bridge Status ${res.status}`;
      }
    } catch {
      // Bridge offline — try direct gateway
    }
  }

  if (provider.freeOnlyLock && !gatewayIsLocal) {
    throw new Error(
      bridgeError ||
        'Kostenlos-Sperre aktiv: Direkter Zugriff auf ein externes Hermes Gateway ist gesperrt.'
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
        messages,
        ...(toolsPayload ? { tools: toolsPayload, tool_choice: 'auto' } : {}),
      }),
    });
  } catch {
    throw new Error(
      bridgeError ||
        `Hermes Gateway ist weder über die Bridge (${bridgeBase}) noch direkt unter ${gatewayBase} erreichbar.`
    );
  }

  const data = (await directRes.json().catch(() => ({}))) as HermesGatewayChatResponse;
  if (!directRes.ok) {
    const detail =
      typeof data.error === 'string'
        ? data.error
        : data.error?.message || `HTTP ${directRes.status}`;
    throw new Error(`Hermes Gateway Fehler: ${detail}`);
  }

  return { data, model: data.model || model };
}

function extractGatewayContentText(data: HermesGatewayChatResponse): string {
  const msgContent = data.choices?.[0]?.message?.content;
  if (typeof msgContent === 'string' && msgContent.trim()) return msgContent.trim();
  if (Array.isArray(msgContent)) {
    const joined = msgContent
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (joined) return joined;
  }
  if (typeof data.text === 'string' && data.text.trim()) return data.text.trim();
  if (typeof data.reply === 'string' && data.reply.trim()) return data.reply.trim();
  if (typeof data.output === 'string' && data.output.trim()) return data.output.trim();
  return '';
}

async function runHermesGatewayLoop(params: {
  prompt: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  cleanImage: string;
  systemInstruction: string;
  state: OpenStudyState;
  handlers: HermesToolHandlers;
  executedTools: HermesToolExecution[];
}): Promise<{ reply: string; providerLabel: string; executedTools: HermesToolExecution[] }> {
  const { prompt, history, cleanImage, systemInstruction, state, handlers, executedTools } = params;

  const messages: OpenAiGatewayMessage[] = [{ role: 'system', content: systemInstruction }];

  for (const entry of history.slice(-10)) {
    if (!entry.text.trim()) continue;
    messages.push({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content: entry.text,
    });
  }

  if (cleanImage) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${cleanImage}` },
        },
      ],
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  const MAX_TOOL_ROUNDS = 3;
  let usedModel = state.provider.hermesModel?.trim() || 'hermes-default';

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const allowTools = round < MAX_TOOL_ROUNDS;
    const { data, model } = await postHermesGatewayMessages({
      state,
      messages,
      includeTools: allowTools,
    });
    usedModel = model;

    const toolCalls = data.choices?.[0]?.message?.tool_calls ?? data.tool_calls ?? [];

    if (toolCalls.length > 0 && allowTools) {
      messages.push({
        role: 'assistant',
        content: extractGatewayContentText(data) || null,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const fnName = tc.function?.name?.trim() ?? '';
        if (!fnName) continue;

        let parsedArgs: Record<string, unknown> = {};
        if (tc.function?.arguments) {
          try {
            const parsed = JSON.parse(tc.function.arguments);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              parsedArgs = parsed as Record<string, unknown>;
            }
          } catch {
            parsedArgs = {};
          }
        }

        const res = await executeHermesToolCall(
          { id: tc.id, name: fnName, args: parsedArgs },
          state,
          handlers
        );
        executedTools.push(res.execution);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id || makeId('call'),
          name: fnName,
          content: JSON.stringify(res.response),
        });
      }
      continue;
    }

    const rawText = extractGatewayContentText(data);
    const reply = rawText
      ? await parseAndExecuteInlineActions(rawText, state, handlers, executedTools)
      : summarizeExecutedTools(executedTools);

    return {
      reply: reply || summarizeExecutedTools(executedTools),
      providerLabel: `Hermes Gateway (${usedModel})`,
      executedTools,
    };
  }

  return {
    reply: summarizeExecutedTools(executedTools),
    providerLabel: `Hermes Gateway (${usedModel})`,
    executedTools,
  };
}

// ---------- Main Agent Turn Entry Point ----------

export async function runHermesAgentTurn(params: {
  prompt: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  imageBase64?: string;
  activeWindowTitle?: string;
  state: OpenStudyState;
  handlers: HermesToolHandlers;
}): Promise<{
  reply: string;
  providerLabel: string;
  executedTools: HermesToolExecution[];
}> {
  const { prompt, history, imageBase64, activeWindowTitle, state, handlers } = params;
  const cleanImage = stripDataUrlPrefix(imageBase64);
  const screenShared = Boolean(cleanImage);
  const effectivePrompt =
    prompt.trim() ||
    (screenShared
      ? 'Bitte analysiere kurz, was auf meinem Bildschirm zu sehen ist, und erkläre den nächsten Schritt.'
      : '');
  const systemInstruction = buildHermesTeacherSystemPrompt({
    state,
    activeWindowTitle,
    screenShared,
  });
  const executedTools: HermesToolExecution[] = [];

  if (!effectivePrompt) {
    return {
      reply: 'Stelle eine kurze Frage oder teile deinen Bildschirm, damit ich dir helfen kann.',
      providerLabel: 'OpenStudy Hermes',
      executedTools,
    };
  }

  // 1. Gemini Free-Tier multimodal agent loop (up to 4 sequential tool rounds)
  if (state.provider.activeTextProvider === 'gemini-free') {
    if (!state.provider.geminiApiKey.trim()) {
      const visionHint = screenShared
        ? ' Für Live-Bildschirmsehen und automatische Lehrer-Marker brauchst du deinen kostenlosen Google AI Studio Schlüssel (Free Tier, 0 CHF) oder ein lokales Hermes Gateway.'
        : ' Hinterlege deinen kostenlosen Google AI Studio Schlüssel in den Einstellungen (oder wechsle auf Ollama / Hermes Gateway), damit ich direkt antworten und OpenStudy-Aktionen ausführen kann.';
      return {
        reply: `Es ist noch kein Gemini API-Key hinterlegt.${visionHint}`,
        providerLabel: 'Gemini Free (Key benötigt)',
        executedTools,
      };
    }

    return runGeminiHermesLoop({
      prompt: effectivePrompt,
      history,
      cleanImage,
      systemInstruction,
      state,
      handlers,
      executedTools,
    });
  }

  // 2. Nous Research Hermes Gateway multimodal agent loop (up to 3 tool rounds)
  if (state.provider.activeTextProvider === 'hermes-gateway') {
    return runHermesGatewayLoop({
      prompt: effectivePrompt,
      history,
      cleanImage,
      systemInstruction,
      state,
      handlers,
      executedTools,
    });
  }

  // 3. Fallback for Ollama, CLI Bridge, OpenAI-compatible & Anthropic with <hermes_action> support
  const actionProtocolInstruction = [
    '',
    'OPTIONALE OPENSTUDY-AKTIONEN:',
    'Falls du eine OpenStudy-Aktion ausführen willst, füge am Ende deiner Antwort einen oder mehrere Blöcke im Format',
    '<hermes_action>{"tool":"<name>","args":{...}}</hermes_action>',
    'hinzu. Verfügbare Werkzeuge: highlight_screen_region, clear_screen_highlights, create_study_note, create_flashcards, add_daily_plan_tasks, add_school_schedule, navigate_app, save_learning_memory, save_custom_skill.',
  ].join('\n');

  const transcriptHistory = history
    .slice(-8)
    .filter((entry) => entry.text.trim().length > 0)
    .map((entry) => `${entry.role === 'assistant' ? 'Lehrer' : 'Lernperson'}: ${entry.text}`)
    .join('\n');

  const combinedUserPrompt = [
    transcriptHistory ? `Bisheriger Gesprächsverlauf:\n${transcriptHistory}` : '',
    activeWindowTitle?.trim() ? `Aktives PC-Fenster: ${activeWindowTitle.trim()}` : '',
    screenShared
      ? 'Hinweis: Die Lernperson hat einen Bildschirm-Screenshot angehängt, dieser reine Text-Anbieter kann jedoch keine Bilder direkt sehen.'
      : '',
    `Aktuelle Frage der Lernperson:\n${effectivePrompt}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await generateStudyReply({
    provider: state.provider,
    systemPrompt: `${systemInstruction}${actionProtocolInstruction}`,
    userPrompt: combinedUserPrompt,
  });

  let cleanReply = await parseAndExecuteInlineActions(
    result.text,
    state,
    handlers,
    executedTools
  );

  if (!cleanReply) {
    cleanReply = summarizeExecutedTools(executedTools);
  }

  if (screenShared) {
    cleanReply = `${cleanReply}\n\nHinweis: Für direktes Bildschirmsehen mit automatischen Markern wechsle in den Einstellungen auf Gemini Free oder Hermes Gateway.`;
  }

  return {
    reply: cleanReply,
    providerLabel: result.usedProvider,
    executedTools,
  };
}
