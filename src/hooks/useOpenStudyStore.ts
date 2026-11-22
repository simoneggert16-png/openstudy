import { useCallback, useEffect, useRef, useState } from 'react';
import { COLOR_SCHEMES, getColorSchemeById } from '../data/colorSchemes';
import { createDemoState } from '../data/demoData';
import {
  ColorSchemeId,
  DailyPlanTask,
  FocusSessionLog,
  HermesMemoryEntry,
  HermesSkill,
  HermesToolExecution,
  MasteryState,
  NoteBlock,
  ObsidianNote,
  OpenStudyState,
  ProviderConfig,
  QuizItem,
  SchoolScheduleItem,
  ScreenSpotlight,
  StudyCard,
  StudyNotePage,
  SubjectCourse,
  VoicePreferences,
} from '../types';

const SETTINGS_STORAGE_KEY = 'openstudy-settings-v1';
const STORAGE_KEY = 'openstudy-local-state-v1';
const MAX_PERSISTED_OBSIDIAN_METADATA = 40;

interface PersistedSettings {
  provider: ProviderConfig;
  voice: VoicePreferences;
  colorScheme: ColorSchemeId;
  theme: 'light' | 'dark';
  dailyGoalMinutes: number;
  onboardingDone: boolean;
}

interface PersistedWorkspaceState {
  streakDays: number;
  activeCourseId: string;
  courses: SubjectCourse[];
  notes: StudyNotePage[];
  cards: StudyCard[];
  quizzes: QuizItem[];
  dailyPlan: DailyPlanTask[];
  focusLogs: FocusSessionLog[];
  obsidianNotes: ObsidianNote[];
  schoolSchedule: SchoolScheduleItem[];
  hermesMemory: HermesMemoryEntry[];
  hermesSkills: HermesSkill[];
  hermesActionLog: HermesToolExecution[];
}

export function isDemoQueryActive(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('mode') === 'demo';
  } catch {
    return false;
  }
}

function getValidSchemeFromQuery(): ColorSchemeId | undefined {
  try {
    const schemeParam = new URLSearchParams(window.location.search).get('scheme');
    if (schemeParam && COLOR_SCHEMES.some((s) => s.id === schemeParam)) {
      return schemeParam as ColorSchemeId;
    }
  } catch {
    // ignore malformed location
  }
  return undefined;
}

function extractSettingsPayload(state: OpenStudyState): PersistedSettings {
  return {
    provider: state.provider,
    voice: state.voice,
    colorScheme: state.colorScheme,
    theme: state.theme,
    dailyGoalMinutes: state.dailyGoalMinutes,
    onboardingDone: state.onboardingDone,
  };
}

function stripObsidianNotesForStorage(notes: ObsidianNote[]): ObsidianNote[] {
  if (!Array.isArray(notes) || notes.length === 0) return [];
  // Keep context-selected notes first so selections survive reloads without storing bulky markdown bodies
  const prioritized = [
    ...notes.filter((n) => n.selectedForContext),
    ...notes.filter((n) => !n.selectedForContext),
  ];
  return prioritized.slice(0, MAX_PERSISTED_OBSIDIAN_METADATA).map((note) => ({
    path: note.path,
    title: note.title,
    excerpt: typeof note.excerpt === 'string' ? note.excerpt.slice(0, 180) : '',
    content: '',
    wikilinks: Array.isArray(note.wikilinks) ? note.wikilinks.slice(0, 12) : [],
    selectedForContext: Boolean(note.selectedForContext),
  }));
}

function buildWorkspacePayload(state: OpenStudyState): PersistedWorkspaceState {
  return {
    streakDays: state.streakDays,
    activeCourseId: state.activeCourseId,
    courses: state.courses,
    notes: state.notes,
    cards: state.cards,
    quizzes: state.quizzes,
    dailyPlan: state.dailyPlan,
    focusLogs: state.focusLogs,
    obsidianNotes: stripObsidianNotesForStorage(state.obsidianNotes),
    schoolSchedule: state.schoolSchedule,
    hermesMemory: state.hermesMemory.slice(0, 40),
    hermesSkills: state.hermesSkills,
    hermesActionLog: state.hermesActionLog.slice(0, 50),
  };
}

function persistSettings(state: OpenStudyState): boolean {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(extractSettingsPayload(state)));
    return true;
  } catch {
    return false;
  }
}

function persistWorkspace(state: OpenStudyState): void {
  const payload = buildWorkspacePayload(state);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Fallback if workspace payload still exceeds browser quota: drop cached metadata & trim logs
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...payload,
          obsidianNotes: [],
          hermesActionLog: payload.hermesActionLog.slice(0, 15),
        })
      );
    } catch {
      // ignore storage quota errors; dedicated settings key stays protected
    }
  }
}

function loadState(): OpenStudyState {
  const demo = createDemoState();
  const envGemini = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? '';
  const envBridge = (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? 'http://127.0.0.1:4319';
  const envOllama = (import.meta.env.VITE_OLLAMA_URL as string | undefined) ?? 'http://127.0.0.1:11434';
  const schemeFromQuery = getValidSchemeFromQuery();

  // Isolated demo mode (used for public showcase & automated preview screenshots)
  if (isDemoQueryActive()) {
    const schemeDef = getColorSchemeById(schemeFromQuery ?? demo.colorScheme);
    return {
      ...demo,
      colorScheme: schemeDef.id,
      theme: schemeDef.isDark ? 'dark' : 'light',
      onboardingDone: true,
    };
  }

  let parsedSettings: Partial<PersistedSettings> | null = null;
  let parsedWorkspace: Partial<OpenStudyState> | null = null;

  try {
    const rawSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (rawSettings) {
      parsedSettings = JSON.parse(rawSettings) as Partial<PersistedSettings>;
    }
  } catch {
    parsedSettings = null;
  }

  try {
    const rawWorkspace = localStorage.getItem(STORAGE_KEY);
    if (rawWorkspace) {
      parsedWorkspace = JSON.parse(rawWorkspace) as Partial<OpenStudyState>;
    }
  } catch {
    parsedWorkspace = null;
  }

  if (!parsedSettings && !parsedWorkspace) {
    const resolvedScheme = getColorSchemeById(schemeFromQuery ?? demo.colorScheme);
    return {
      ...demo,
      colorScheme: resolvedScheme.id,
      theme: resolvedScheme.isDark ? 'dark' : 'light',
      provider: {
        ...demo.provider,
        geminiApiKey: envGemini,
        bridgeUrl: envBridge,
        ollamaUrl: envOllama,
      },
    };
  }

  // Prefer dedicated settings key; seamlessly migrate legacy settings stored in STORAGE_KEY
  const savedScheme = parsedSettings?.colorScheme ?? parsedWorkspace?.colorScheme;
  const savedTheme = parsedSettings?.theme ?? parsedWorkspace?.theme;
  const resolvedScheme = getColorSchemeById(
    schemeFromQuery ??
      savedScheme ??
      (savedTheme === 'dark' ? 'midnight-teal' : 'focus-cream')
  );

  const savedProvider: Partial<ProviderConfig> =
    parsedSettings?.provider ?? parsedWorkspace?.provider ?? {};
  const savedVoice: Partial<VoicePreferences> =
    parsedSettings?.voice ?? parsedWorkspace?.voice ?? {};
  const resolvedGoalMinutes =
    typeof parsedSettings?.dailyGoalMinutes === 'number'
      ? parsedSettings.dailyGoalMinutes
      : typeof parsedWorkspace?.dailyGoalMinutes === 'number'
        ? parsedWorkspace.dailyGoalMinutes
        : demo.dailyGoalMinutes;
  const resolvedOnboardingDone =
    typeof parsedSettings?.onboardingDone === 'boolean'
      ? parsedSettings.onboardingDone
      : typeof parsedWorkspace?.onboardingDone === 'boolean'
        ? parsedWorkspace.onboardingDone
        : true;

  return {
    ...demo,
    ...(parsedWorkspace ?? {}),
    onboardingDone: resolvedOnboardingDone,
    colorScheme: resolvedScheme.id,
    theme: resolvedScheme.isDark ? 'dark' : 'light',
    dailyGoalMinutes: resolvedGoalMinutes,
    provider: {
      ...demo.provider,
      bridgeUrl: envBridge,
      ollamaUrl: envOllama,
      ...savedProvider,
      geminiApiKey: savedProvider.geminiApiKey || envGemini,
    },
    voice: {
      ...demo.voice,
      ...savedVoice,
    },
    obsidianNotes: Array.isArray(parsedWorkspace?.obsidianNotes)
      ? parsedWorkspace.obsidianNotes
      : demo.obsidianNotes,
    hermesMemory: Array.isArray(parsedWorkspace?.hermesMemory)
      ? parsedWorkspace.hermesMemory
      : demo.hermesMemory,
    hermesSkills:
      Array.isArray(parsedWorkspace?.hermesSkills) && parsedWorkspace.hermesSkills.length > 0
        ? parsedWorkspace.hermesSkills
        : demo.hermesSkills,
    hermesActionLog: Array.isArray(parsedWorkspace?.hermesActionLog)
      ? parsedWorkspace.hermesActionLog
      : demo.hermesActionLog,
    screenSpotlights: [],
  };
}

export function useOpenStudyStore() {
  const [state, setState] = useState<OpenStudyState>(loadState);
  const demoMode = isDemoQueryActive();
  const reconnectedVaultRef = useRef<string>('');

  // Clean up one-shot ?scheme= query param after initial load in normal mode so later in-app switches stick
  useEffect(() => {
    if (demoMode) return;
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('scheme')) {
        url.searchParams.delete('scheme');
        const nextUrl = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState(null, '', nextUrl);
      }
    } catch {
      // ignore on restricted origins (e.g. file://)
    }
  }, [demoMode]);

  useEffect(() => {
    const scheme = getColorSchemeById(state.colorScheme);
    const root = document.documentElement;
    const prevScheme = root.getAttribute('data-scheme');
    if (prevScheme && prevScheme !== scheme.id) {
      root.classList.add('scheme-switching');
      root.setAttribute('data-scheme', scheme.id);
      root.setAttribute('data-theme', scheme.isDark ? 'dark' : 'light');
      void root.offsetHeight;
      requestAnimationFrame(() => root.classList.remove('scheme-switching'));
    } else {
      root.setAttribute('data-scheme', scheme.id);
      root.setAttribute('data-theme', scheme.isDark ? 'dark' : 'light');
    }
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', scheme.themeColor);
    }

    if (demoMode) {
      // Keep demo screenshots isolated, but persist an explicitly entered Gemini API key
      if (state.provider.geminiApiKey.trim()) {
        try {
          const existingRaw = localStorage.getItem(SETTINGS_STORAGE_KEY);
          const existing = existingRaw
            ? (JSON.parse(existingRaw) as Partial<PersistedSettings>)
            : {};
          const merged: PersistedSettings = {
            ...extractSettingsPayload(state),
            ...existing,
            provider: {
              ...state.provider,
              ...(existing.provider ?? {}),
              geminiApiKey: state.provider.geminiApiKey,
            },
          };
          localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
        } catch {
          // ignore storage quota errors
        }
      }
      return;
    }

    // Save tiny settings key FIRST so API keys & preferences are completely immune to workspace quota issues
    const settingsSaved = persistSettings(state);
    persistWorkspace(state);
    if (!settingsSaved) {
      // Retry tiny settings write after workspace compaction frees legacy bloated space
      persistSettings(state);
    }
  }, [state, demoMode]);

  // Quietly re-hydrate connected Obsidian vault from local companion bridge on startup
  const savedVaultPath = state.provider.obsidianVaultPath.trim();
  const savedBridgeUrl = state.provider.bridgeUrl.trim();
  const obsidianNeedsHydration =
    state.obsidianNotes.length === 0 ||
    state.obsidianNotes.every((note) => !note.content);

  useEffect(() => {
    if (demoMode || !savedVaultPath || !obsidianNeedsHydration) return;
    if (reconnectedVaultRef.current === savedVaultPath) return;

    const normalizedBridgeUrl = (savedBridgeUrl || 'http://127.0.0.1:4319').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(normalizedBridgeUrl)) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 1500);
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(
          `${normalizedBridgeUrl}/api/obsidian/notes?vaultPath=${encodeURIComponent(savedVaultPath)}`,
          { method: 'GET', signal: controller.signal }
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          ok?: boolean;
          notes?: ObsidianNote[];
        };
        if (cancelled || !data?.ok || !Array.isArray(data.notes) || data.notes.length === 0) {
          return;
        }
        const incoming = data.notes.filter(
          (note): note is ObsidianNote => Boolean(note && typeof note.path === 'string')
        );
        if (incoming.length === 0) return;

        setState((prev) => {
          if (prev.obsidianNotes.some((n) => Boolean(n.content))) {
            return prev;
          }
          const prevSelection = new Map(
            prev.obsidianNotes.map((n) => [n.path, Boolean(n.selectedForContext)])
          );
          const hasPrevSelections = prev.obsidianNotes.length > 0;
          const hydrated: ObsidianNote[] = incoming
            .map((note, idx) => ({
              path: note.path,
              title:
                typeof note.title === 'string' && note.title.trim()
                  ? note.title.trim()
                  : note.path.split('/').pop()?.replace(/\.md$/i, '') || note.path,
              excerpt: typeof note.excerpt === 'string' ? note.excerpt : '',
              content: typeof note.content === 'string' ? note.content : '',
              wikilinks: Array.isArray(note.wikilinks)
                ? note.wikilinks.filter((w): w is string => typeof w === 'string')
                : [],
              selectedForContext: prevSelection.has(note.path)
                ? Boolean(prevSelection.get(note.path))
                : hasPrevSelections
                  ? false
                  : typeof note.selectedForContext === 'boolean'
                    ? note.selectedForContext
                    : idx < 3,
            }))
            .sort((a, b) => a.title.localeCompare(b.title));
          return {
            ...prev,
            obsidianNotes: hydrated,
          };
        });
      } catch {
        // Best-effort startup reconnect: silently ignore if bridge is offline or times out
      } finally {
        window.clearTimeout(timeoutId);
        if (!cancelled) {
          reconnectedVaultRef.current = savedVaultPath;
        }
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [demoMode, savedVaultPath, savedBridgeUrl, obsidianNeedsHydration]);

  const setColorScheme = useCallback((schemeId: ColorSchemeId) => {
    const scheme = getColorSchemeById(schemeId);
    setState((s) => ({
      ...s,
      colorScheme: scheme.id,
      theme: scheme.isDark ? 'dark' : 'light',
    }));
  }, []);

  const toggleTheme = useCallback(() => {
    setState((s) => {
      const nextScheme: ColorSchemeId = s.theme === 'light' ? 'midnight-teal' : 'focus-cream';
      return {
        ...s,
        colorScheme: nextScheme,
        theme: nextScheme === 'midnight-teal' ? 'dark' : 'light',
      };
    });
  }, []);

  const setActiveCourse = useCallback((courseId: string) => {
    setState((s) => ({ ...s, activeCourseId: courseId }));
  }, []);

  const completeOnboarding = useCallback(() => {
    setState((s) => ({ ...s, onboardingDone: true }));
  }, []);

  const updateProvider = useCallback((patch: Partial<ProviderConfig>) => {
    setState((s) => ({ ...s, provider: { ...s.provider, ...patch } }));
  }, []);

  const updateVoice = useCallback((patch: Partial<VoicePreferences>) => {
    setState((s) => ({ ...s, voice: { ...s.voice, ...patch } }));
  }, []);

  const setObjectiveMastery = useCallback((courseId: string, objectiveId: string, mastery: MasteryState) => {
    setState((s) => ({
      ...s,
      courses: s.courses.map((c) =>
        c.id !== courseId
          ? c
          : {
              ...c,
              objectives: c.objectives.map((o) =>
                o.id === objectiveId ? { ...o, mastery } : o
              ),
            }
      ),
    }));
  }, []);

  const addCourse = useCallback((course: SubjectCourse) => {
    setState((s) => ({
      ...s,
      activeCourseId: course.id,
      courses: [course, ...s.courses],
    }));
  }, []);

  const upsertNote = useCallback((page: StudyNotePage) => {
    setState((s) => {
      const exists = s.notes.some((n) => n.id === page.id);
      return {
        ...s,
        notes: exists
          ? s.notes.map((n) => (n.id === page.id ? page : n))
          : [page, ...s.notes],
      };
    });
  }, []);

  const updateNoteBlocks = useCallback((noteId: string, blocks: NoteBlock[], title?: string) => {
    setState((s) => ({
      ...s,
      notes: s.notes.map((n) =>
        n.id === noteId
          ? {
              ...n,
              title: title ?? n.title,
              blocks,
              updatedAt: new Date().toISOString().slice(0, 10),
            }
          : n
      ),
    }));
  }, []);

  const deleteNote = useCallback((noteId: string) => {
    setState((s) => ({
      ...s,
      notes: s.notes.filter((n) => n.id !== noteId),
    }));
  }, []);

  const addCards = useCallback((newCards: StudyCard[]) => {
    setState((s) => ({ ...s, cards: [...newCards, ...s.cards] }));
  }, []);

  const rateCard = useCallback((cardId: string, rating: 1 | 2 | 3 | 4) => {
    const now = Date.now();
    setState((s) => ({
      ...s,
      cards: s.cards.map((card) => {
        if (card.id !== cardId) return card;
        let reps = card.reps;
        let ease = card.ease;
        let interval = card.interval;
        if (rating === 1) {
          reps = 0;
          interval = 0.004;
          ease = Math.max(1.3, ease - 0.2);
        } else if (rating === 2) {
          reps += 1;
          interval = interval === 0 ? 0.5 : Math.max(1, interval * 1.2);
          ease = Math.max(1.3, ease - 0.15);
        } else if (rating === 3) {
          reps += 1;
          interval = reps === 1 ? 1 : reps === 2 ? 3 : Math.round(interval * ease);
        } else {
          reps += 1;
          interval = reps === 1 ? 3 : Math.round(interval * ease * 1.3);
          ease = Math.min(3.0, ease + 0.15);
        }
        return {
          ...card,
          reps,
          ease,
          interval,
          due: now + interval * 24 * 60 * 60 * 1000,
        };
      }),
    }));
  }, []);

  const togglePlanTask = useCallback((taskId: string) => {
    setState((s) => ({
      ...s,
      dailyPlan: s.dailyPlan.map((t) => (t.id === taskId ? { ...t, done: !t.done } : t)),
    }));
  }, []);

  const addPlanTasks = useCallback((tasks: DailyPlanTask[]) => {
    setState((s) => ({ ...s, dailyPlan: [...tasks, ...s.dailyPlan] }));
  }, []);

  const setDailyGoalMinutes = useCallback((minutes: number) => {
    setState((s) => ({ ...s, dailyGoalMinutes: Math.max(10, Math.min(240, minutes)) }));
  }, []);

  const logFocusSession = useCallback((log: FocusSessionLog) => {
    setState((s) => ({
      ...s,
      focusLogs: [log, ...s.focusLogs],
    }));
  }, []);

  const setObsidianNotes = useCallback((notes: ObsidianNote[]) => {
    setState((s) => ({ ...s, obsidianNotes: notes }));
  }, []);

  const toggleObsidianContext = useCallback((path: string) => {
    setState((s) => ({
      ...s,
      obsidianNotes: s.obsidianNotes.map((n) =>
        n.path === path ? { ...n, selectedForContext: !n.selectedForContext } : n
      ),
    }));
  }, []);

  const addSchoolScheduleItems = useCallback((items: SchoolScheduleItem[]) => {
    if (!items.length) return;
    setState((s) => {
      const existingKeys = new Set(
        s.schoolSchedule.map(
          (e) =>
            `${e.date}|${(e.startTime || '').trim()}|${e.title.trim().toLowerCase().slice(0, 60)}`
        )
      );
      const uniqueNew: SchoolScheduleItem[] = [];
      for (const item of items) {
        const key = `${item.date}|${(item.startTime || '').trim()}|${item.title.trim().toLowerCase().slice(0, 60)}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        uniqueNew.push(item);
      }
      if (uniqueNew.length === 0) return s;
      return {
        ...s,
        schoolSchedule: [...uniqueNew, ...s.schoolSchedule],
      };
    });
  }, []);

  const removeSchoolScheduleItem = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      schoolSchedule: s.schoolSchedule.filter((item) => item.id !== id),
    }));
  }, []);

  const addHermesMemory = useCallback((entry: HermesMemoryEntry) => {
    setState((s) => ({
      ...s,
      hermesMemory: [entry, ...s.hermesMemory.filter((m) => m.fact !== entry.fact)].slice(0, 40),
    }));
  }, []);

  const removeHermesMemory = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      hermesMemory: s.hermesMemory.filter((m) => m.id !== id),
    }));
  }, []);

  const upsertHermesSkill = useCallback((skill: HermesSkill) => {
    setState((s) => {
      const exists = s.hermesSkills.some((sk) => sk.id === skill.id || sk.name === skill.name);
      return {
        ...s,
        hermesSkills: exists
          ? s.hermesSkills.map((sk) => (sk.id === skill.id || sk.name === skill.name ? skill : sk))
          : [skill, ...s.hermesSkills],
      };
    });
  }, []);

  const toggleHermesSkill = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      hermesSkills: s.hermesSkills.map((sk) =>
        sk.id === id ? { ...sk, enabled: !sk.enabled } : sk
      ),
    }));
  }, []);

  const logHermesAction = useCallback((action: HermesToolExecution) => {
    setState((s) => ({
      ...s,
      hermesActionLog: [action, ...s.hermesActionLog].slice(0, 50),
    }));
  }, []);

  const addScreenSpotlight = useCallback((spotlight: ScreenSpotlight) => {
    setState((s) => ({
      ...s,
      screenSpotlights: [...s.screenSpotlights.slice(-5), spotlight],
    }));
  }, []);

  const clearScreenSpotlights = useCallback(() => {
    setState((s) => ({ ...s, screenSpotlights: [] }));
  }, []);

  const resetToDemo = useCallback(() => {
    const fresh = createDemoState();
    setState((prev) => ({
      ...fresh,
      theme: prev.theme,
      colorScheme: prev.colorScheme,
      onboardingDone: true,
    }));
  }, []);

  return {
    state,
    demoMode,
    toggleTheme,
    setColorScheme,
    setActiveCourse,
    completeOnboarding,
    updateProvider,
    updateVoice,
    setObjectiveMastery,
    addCourse,
    upsertNote,
    updateNoteBlocks,
    deleteNote,
    addCards,
    rateCard,
    togglePlanTask,
    addPlanTasks,
    setDailyGoalMinutes,
    logFocusSession,
    setObsidianNotes,
    toggleObsidianContext,
    addSchoolScheduleItems,
    removeSchoolScheduleItem,
    addHermesMemory,
    removeHermesMemory,
    upsertHermesSkill,
    toggleHermesSkill,
    logHermesAction,
    addScreenSpotlight,
    clearScreenSpotlights,
    resetToDemo,
  };
}
