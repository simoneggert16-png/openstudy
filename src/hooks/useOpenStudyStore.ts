import { useCallback, useEffect, useState } from 'react';
import { getColorSchemeById } from '../data/colorSchemes';
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
  SchoolScheduleItem,
  ScreenSpotlight,
  StudyCard,
  StudyNotePage,
  SubjectCourse,
  VoicePreferences,
} from '../types';

const STORAGE_KEY = 'openstudy-local-state-v1';

export function isDemoQueryActive(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('mode') === 'demo';
  } catch {
    return false;
  }
}

function loadState(): OpenStudyState {
  const demo = createDemoState();
  const envGemini = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? '';
  const envBridge = (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? 'http://127.0.0.1:4319';
  const envOllama = (import.meta.env.VITE_OLLAMA_URL as string | undefined) ?? 'http://127.0.0.1:11434';

  // Isolated demo mode (used for public showcase & automated preview screenshots)
  if (isDemoQueryActive()) {
    const schemeParam = new URLSearchParams(window.location.search).get('scheme') ?? undefined;
    const schemeDef = getColorSchemeById(schemeParam || demo.colorScheme);
    return {
      ...demo,
      colorScheme: schemeDef.id,
      theme: schemeDef.isDark ? 'dark' : 'light',
      onboardingDone: true,
    };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        ...demo,
        provider: {
          ...demo.provider,
          geminiApiKey: envGemini,
          bridgeUrl: envBridge,
          ollamaUrl: envOllama,
        },
      };
    }
    const parsed = JSON.parse(raw) as Partial<OpenStudyState>;
    const resolvedScheme = getColorSchemeById(
      parsed.colorScheme ?? (parsed.theme === 'dark' ? 'midnight-teal' : 'focus-cream')
    );
    return {
      ...demo,
      ...parsed,
      onboardingDone: true,
      colorScheme: resolvedScheme.id,
      theme: resolvedScheme.isDark ? 'dark' : 'light',
      provider: {
        ...demo.provider,
        ...(parsed.provider ?? {}),
        geminiApiKey: parsed.provider?.geminiApiKey || envGemini,
      },
      voice: {
        ...demo.voice,
        ...(parsed.voice ?? {}),
      },
      hermesMemory: Array.isArray(parsed.hermesMemory) ? parsed.hermesMemory : demo.hermesMemory,
      hermesSkills: Array.isArray(parsed.hermesSkills) && parsed.hermesSkills.length > 0
        ? parsed.hermesSkills
        : demo.hermesSkills,
      hermesActionLog: Array.isArray(parsed.hermesActionLog) ? parsed.hermesActionLog : demo.hermesActionLog,
      screenSpotlights: [],
    };
  } catch {
    return demo;
  }
}

export function useOpenStudyStore() {
  const [state, setState] = useState<OpenStudyState>(loadState);
  const demoMode = isDemoQueryActive();

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
    if (demoMode) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore storage quota errors
    }
  }, [state, demoMode]);

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
