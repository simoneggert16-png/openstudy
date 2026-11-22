import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookMarked,
  Bot,
  CalendarPlus,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Eye,
  GraduationCap,
  Layers,
  Loader2,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  AgentStance,
  DailyPlanTask,
  OpenStudyState,
  StudyCard,
  VoicePreferences,
} from '../types';
import { generateStudyText } from '../services/providers';

export interface StudyTrainerViewProps {
  state: OpenStudyState;
  onSelectCourse: (courseId: string) => void;
  onRateCard: (cardId: string, rating: 1 | 2 | 3 | 4) => void;
  onAddCards: (cards: StudyCard[]) => void;
  onAddPlanTasks: (tasks: DailyPlanTask[]) => void;
  onUpdateVoice: (patch: Partial<VoicePreferences>) => void;
  onOpenSettings: () => void;
}

type TrainerTab = 'cards' | 'quiz' | 'agent';

interface ParsedFlashcard {
  front: string;
  back: string;
}

interface ParsedPlanBlock {
  title: string;
  minutes: number;
  scheduledFor: string;
}

interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  usedProvider?: string;
  stance?: AgentStance;
  savedCards?: boolean;
  savedPlan?: boolean;
}

const OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;

function extractFlashcardsFromText(raw: string): ParsedFlashcard[] {
  const results: ParsedFlashcard[] = [];
  const cleaned = raw.replace(/\r\n/g, '\n');

  // Pattern 1: Frage:/Vorderseite:/Q: ... Antwort:/Rückseite:/A: ...
  const pairRegex =
    /(?:^|\n)\s*(?:[-*•]|\d+[.)])?\s*(?:\*{0,2})(?:Frage|Vorderseite|Front|Q)(?:\s*\d+)?(?:\*{0,2})\s*[:\-–]\s*(.+?)\n+\s*(?:[-*•])?\s*(?:\*{0,2})(?:Antwort|Rückseite|Back|A)(?:\s*\d+)?(?:\*{0,2})\s*[:\-–]\s*([\s\S]+?)(?=\n\s*(?:[-*•]|\d+[.)])?\s*(?:\*{0,2})(?:Frage|Vorderseite|Front|Q)(?:\s*\d+)?(?:\*{0,2})\s*[:\-–]|\n\n\s*(?:#|---|$)|$)/gi;

  let match: RegExpExecArray | null;
  while ((match = pairRegex.exec(cleaned)) !== null) {
    const front = match[1].replace(/^\*{1,2}|\*{1,2}$/g, '').trim();
    const back = match[2].replace(/^\*{1,2}|\*{1,2}$/g, '').trim();
    if (front.length >= 4 && back.length >= 3) {
      results.push({ front, back });
    }
  }

  return results.slice(0, 12);
}

function extractPlanTasksFromText(raw: string): ParsedPlanBlock[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const tasks: ParsedPlanBlock[] = [];
  let currentDay = 'Heute';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const dayHeader = trimmed.match(/^(?:#{1,3}\s*|\*{1,2})?(Tag\s*\d+|Heute|Morgen|Übermorgen)/i);
    if (dayHeader) {
      const label = dayHeader[1];
      if (/tag\s*1/i.test(label) || /heute/i.test(label)) {
        currentDay = 'Heute';
      } else if (/tag\s*2/i.test(label) || /morgen/i.test(label)) {
        currentDay = 'Morgen';
      } else {
        currentDay = label;
      }
    }

    const minMatch = trimmed.match(/(\d{1,2})\s*(?:Min|Minuten|min)\b/i);
    if (minMatch && /^[-*•\d]/.test(trimmed)) {
      const minutes = Math.max(5, Math.min(90, Number(minMatch[1])));
      const title = trimmed
        .replace(/^[-*•]\s*/, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/\*{1,2}/g, '')
        .replace(/\[?\(?\d{1,2}\s*(?:Min|Minuten|min)\.?\)?\]?\s*[:\-–]?/gi, '')
        .replace(/^(Tag\s*\d+|Heute|Morgen)\s*[:\-–]\s*/i, '')
        .trim();

      if (title.length >= 5) {
        tasks.push({
          title: title.slice(0, 120),
          minutes,
          scheduledFor: currentDay,
        });
      }
    }
  }

  return tasks.slice(0, 9);
}

function formatTimer(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const StudyTrainerView: React.FC<StudyTrainerViewProps> = ({
  state,
  onSelectCourse,
  onRateCard,
  onAddCards,
  onAddPlanTasks,
  onUpdateVoice,
  onOpenSettings,
}) => {
  const [activeTab, setActiveTab] = useState<TrainerTab>('cards');
  const [scopeAll, setScopeAll] = useState<boolean>(false);

  // --- Flashcards State ---
  const [practiceAllCards, setPracticeAllCards] = useState<boolean>(false);
  const [cardIndex, setCardIndex] = useState<number>(0);
  const [isFlipped, setIsFlipped] = useState<boolean>(false);
  const [showHint, setShowHint] = useState<boolean>(false);
  const [showCardCreator, setShowCardCreator] = useState<boolean>(false);
  const [newCardFront, setNewCardFront] = useState<string>('');
  const [newCardBack, setNewCardBack] = useState<string>('');
  const [newCardHint, setNewCardHint] = useState<string>('');
  const [newCardCourseId, setNewCardCourseId] = useState<string>(
    state.activeCourseId || state.courses[0]?.id || ''
  );

  // --- Quiz State ---
  const [examMode, setExamMode] = useState<boolean>(false);
  const [quizIndex, setQuizIndex] = useState<number>(0);
  const [quizAnswers, setQuizAnswers] = useState<Record<string, number>>({});
  const [quizFinished, setQuizFinished] = useState<boolean>(false);
  const [examSecondsLeft, setExamSecondsLeft] = useState<number>(0);

  // --- Agent Chat State ---
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [agentInput, setAgentInput] = useState<string>('');
  const [isAgentBusy, setIsAgentBusy] = useState<boolean>(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const activeCourse = useMemo(
    () => state.courses.find((c) => c.id === state.activeCourseId) ?? state.courses[0],
    [state.courses, state.activeCourseId]
  );

  const courseMap = useMemo(() => {
    const map = new Map<string, { title: string; accentColor: string }>();
    for (const c of state.courses) {
      map.set(c.id, { title: c.title, accentColor: c.accentColor });
    }
    return map;
  }, [state.courses]);

  // Scoped cards
  const scopedCards = useMemo(() => {
    if (scopeAll || !activeCourse) return state.cards;
    return state.cards.filter((c) => c.courseId === activeCourse.id);
  }, [state.cards, scopeAll, activeCourse]);

  const dueCards = useMemo(() => {
    const now = Date.now();
    return scopedCards.filter((c) => c.due <= now);
  }, [scopedCards]);

  const activeDeck = practiceAllCards ? scopedCards : dueCards;
  const safeCardIndex = activeDeck.length > 0 ? Math.min(cardIndex, activeDeck.length - 1) : 0;
  const currentCard = activeDeck[safeCardIndex];

  // Scoped quizzes
  const scopedQuizzes = useMemo(() => {
    if (scopeAll || !activeCourse) return state.quizzes;
    return state.quizzes.filter((q) => q.courseId === activeCourse.id);
  }, [state.quizzes, scopeAll, activeCourse]);

  const safeQuizIndex =
    scopedQuizzes.length > 0 ? Math.min(quizIndex, scopedQuizzes.length - 1) : 0;
  const currentQuiz = scopedQuizzes[safeQuizIndex];

  const selectedObsidianNotes = useMemo(
    () => state.obsidianNotes.filter((n) => n.selectedForContext),
    [state.obsidianNotes]
  );

  useEffect(() => {
    setNewCardCourseId(state.activeCourseId || state.courses[0]?.id || '');
  }, [state.activeCourseId, state.courses]);

  // Reset card flip when scope/course changes
  useEffect(() => {
    setCardIndex(0);
    setIsFlipped(false);
    setShowHint(false);
  }, [scopeAll, state.activeCourseId, practiceAllCards]);

  // Reset quiz when scope changes
  useEffect(() => {
    setQuizIndex(0);
    setQuizAnswers({});
    setQuizFinished(false);
    if (examMode && scopedQuizzes.length > 0) {
      setExamSecondsLeft(scopedQuizzes.length * 45);
    }
  }, [scopeAll, state.activeCourseId, examMode, scopedQuizzes.length]);

  // Timed mini-exam countdown
  useEffect(() => {
    if (activeTab !== 'quiz' || !examMode || quizFinished || scopedQuizzes.length === 0) return;
    if (examSecondsLeft <= 0) {
      setQuizFinished(true);
      return;
    }
    const id = window.setInterval(() => {
      setExamSecondsLeft((prev) => {
        if (prev <= 1) {
          window.clearInterval(id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [activeTab, examMode, quizFinished, examSecondsLeft, scopedQuizzes.length]);

  const handleRateCurrentCard = useCallback(
    (rating: 1 | 2 | 3 | 4) => {
      if (!currentCard) return;
      onRateCard(currentCard.id, rating);
      setIsFlipped(false);
      setShowHint(false);
      if (practiceAllCards) {
        setCardIndex((prev) => (prev + 1 < activeDeck.length ? prev + 1 : 0));
      } else {
        setCardIndex(0);
      }
    },
    [currentCard, onRateCard, practiceAllCards, activeDeck.length]
  );

  // Keyboard shortcuts for Tab 1 (Space flip, 1-4 rate)
  useEffect(() => {
    if (activeTab !== 'cards' || !currentCard) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        setIsFlipped((prev) => !prev);
      } else if (isFlipped && (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4')) {
        e.preventDefault();
        handleRateCurrentCard(Number(e.key) as 1 | 2 | 3 | 4);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTab, currentCard, isFlipped, handleRateCurrentCard]);

  const handleCreateCard = (e: React.FormEvent) => {
    e.preventDefault();
    const front = newCardFront.trim();
    const back = newCardBack.trim();
    if (!front || !back) return;

    const card: StudyCard = {
      id: `c-${Date.now()}`,
      courseId: newCardCourseId || activeCourse?.id || state.courses[0]?.id || 'general',
      front,
      back,
      hint: newCardHint.trim() || undefined,
      interval: 0,
      ease: 2.5,
      reps: 0,
      due: Date.now(),
    };
    onAddCards([card]);
    setNewCardFront('');
    setNewCardBack('');
    setNewCardHint('');
    setShowCardCreator(false);
  };

  // Quiz helpers
  const quizScore = useMemo(() => {
    let correct = 0;
    let answered = 0;
    for (const q of scopedQuizzes) {
      if (quizAnswers[q.id] !== undefined) {
        answered += 1;
        if (quizAnswers[q.id] === q.correctIndex) correct += 1;
      }
    }
    return { correct, answered, total: scopedQuizzes.length };
  }, [scopedQuizzes, quizAnswers]);

  const handleRestartQuiz = () => {
    setQuizAnswers({});
    setQuizIndex(0);
    setQuizFinished(false);
    if (examMode && scopedQuizzes.length > 0) {
      setExamSecondsLeft(scopedQuizzes.length * 45);
    }
  };

  // Agent Chat
  const buildAgentSystemPrompt = useCallback(
    (stance: AgentStance) => {
      const courseNotes = activeCourse
        ? state.notes.filter((n) => n.courseId === activeCourse.id).slice(0, 3)
        : [];

      const courseBlock = activeCourse
        ? [
            `Aktives Fach: ${activeCourse.title}`,
            `Beschreibung: ${activeCourse.description}`,
            activeCourse.examDate ? `Prüfungsdatum: ${activeCourse.examDate}` : '',
            'Lernziele:',
            ...activeCourse.objectives.map(
              (o) => `- ${o.title} [Status: ${o.mastery}] — ${o.summary}`
            ),
          ]
            .filter(Boolean)
            .join('\n')
        : 'Kein spezifisches Fach ausgewählt.';

      const localNotesText =
        courseNotes.length > 0
          ? [
              'Relevante lokale Lernnotizen:',
              ...courseNotes.map(
                (n) =>
                  `### ${n.title}\n${n.blocks
                    .slice(0, 8)
                    .map((b) => b.text)
                    .join('\n')}`
              ),
            ].join('\n')
          : '';

      const obsidianContext =
        selectedObsidianNotes.length > 0
          ? [
              'Ausgewählte Obsidian-Notizen als Kontext:',
              ...selectedObsidianNotes
                .slice(0, 4)
                .map((n) => `### ${n.title}\n${n.content.slice(0, 900)}`),
            ].join('\n')
          : '';

      const stanceInstruction =
        stance === 'coach'
          ? [
              'HALTUNG: COACH-MODUS (Standard).',
              'Hilf der lernenden Person mit gezielten Rückfragen, Denkanstössen, Analogien und klaren Schritt-für-Schritt-Erklärungen, damit sie den Stoff wirklich selbst versteht.',
              'Gib nicht einfach unreflektierte fertige Hausaufgabenlösungen aus, sondern leite aktiv zum Mitdenken an.',
              'Wenn ausdrücklich Karteikarten angefordert werden, nutze das Format "Frage: ..." gefolgt von "Antwort: ...".',
            ].join(' ')
          : [
              'HALTUNG: ASSISTENZ-MODUS.',
              'Erstelle auf Wunsch direkt strukturierte Lernpläne, prüfungsreife Zusammenfassungen oder fertige Karteikarten.',
              'Für Karteikarten verwende immer das klare Format:\nFrage: ...\nAntwort: ...',
              'Für Lernpläne verwende pro Block eine Zeile mit Minutenangabe, z.B.:\nTag 1:\n- [15 Min] Thema wiederholen',
            ].join(' ');

      return [
        'Du bist der OpenStudy Lern-Agent. Antworte klar, ruhig, strukturiert und auf Deutsch (sofern keine Fremdsprache geübt wird).',
        stanceInstruction,
        '',
        courseBlock,
        localNotesText,
        obsidianContext,
      ]
        .filter(Boolean)
        .join('\n\n');
    },
    [activeCourse, state.notes, selectedObsidianNotes]
  );

  const sendAgentPrompt = async (promptText: string, overrideStance?: AgentStance) => {
    const trimmed = promptText.trim();
    if (!trimmed || isAgentBusy) return;

    const stanceToUse = overrideStance ?? state.voice.stance;
    if (overrideStance && overrideStance !== state.voice.stance) {
      onUpdateVoice({ stance: overrideStance });
    }

    const userMsg: AgentMessage = {
      id: `msg-u-${Date.now()}`,
      role: 'user',
      content: trimmed,
      stance: stanceToUse,
    };

    const recentHistory = messages
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'Lernende Person' : 'Lern-Agent'}: ${m.content}`)
      .join('\n\n');

    const fullUserPrompt = recentHistory
      ? `Bisheriger Gesprächsverlauf:\n${recentHistory}\n\nNeue Anfrage:\n${trimmed}`
      : trimmed;

    setMessages((prev) => [...prev, userMsg]);
    setAgentInput('');
    setAgentError(null);
    setIsAgentBusy(true);

    try {
      const res = await generateStudyText({
        provider: state.provider,
        systemPrompt: buildAgentSystemPrompt(stanceToUse),
        userPrompt: fullUserPrompt,
      });

      const assistantMsg: AgentMessage = {
        id: `msg-a-${Date.now()}`,
        role: 'assistant',
        content: res.text,
        usedProvider: res.usedProvider,
        stance: stanceToUse,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setAgentError(
        err instanceof Error ? err.message : 'Anfrage an den Lern-Agenten fehlgeschlagen.'
      );
    } finally {
      setIsAgentBusy(false);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isAgentBusy]);

  const handleSaveParsedCards = (messageId: string, parsed: ParsedFlashcard[]) => {
    if (parsed.length === 0) return;
    const courseId = activeCourse?.id || state.courses[0]?.id || 'general';
    const base = Date.now();
    const newCards: StudyCard[] = parsed.map((p, idx) => ({
      id: `c-ai-${base}-${idx}`,
      courseId,
      front: p.front,
      back: p.back,
      interval: 0,
      ease: 2.5,
      reps: 0,
      due: base,
    }));
    onAddCards(newCards);
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, savedCards: true } : m))
    );
  };

  const handleSaveParsedPlan = (messageId: string, parsed: ParsedPlanBlock[]) => {
    if (parsed.length === 0) return;
    const courseId = activeCourse?.id || state.courses[0]?.id || 'general';
    const base = Date.now();
    const tasks: DailyPlanTask[] = parsed.map((p, idx) => ({
      id: `dp-ai-${base}-${idx}`,
      courseId,
      title: p.title,
      minutes: p.minutes,
      done: false,
      scheduledFor: p.scheduledFor,
    }));
    onAddPlanTasks(tasks);
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, savedPlan: true } : m))
    );
  };

  const hardestObjective = useMemo(() => {
    if (!activeCourse) return null;
    return (
      activeCourse.objectives.find((o) => o.mastery === 'open') ??
      activeCourse.objectives.find((o) => o.mastery === 'practicing') ??
      activeCourse.objectives[0] ??
      null
    );
  }, [activeCourse]);

  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-10 animate-enter">
      {/* Header */}
      <header
        className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-end sm:justify-between"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div>
          <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            Spaced Repetition, Übungs-Quiz und persönlicher Lern-Agent
          </p>
          <h1
            className="mt-1 text-[26px] font-semibold tracking-tight sm:text-[28px]"
            style={{ color: 'var(--text-primary)', lineHeight: 1.2 }}
          >
            Lern-Trainer
          </h1>
        </div>

        {/* 3-Tab Switcher */}
        <div
          className="inline-flex rounded-xl border p-1"
          style={{
            backgroundColor: 'var(--bg-raised)',
            borderColor: 'var(--border-hairline)',
          }}
          role="tablist"
          aria-label="Lernmodi"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'cards'}
            onClick={() => setActiveTab('cards')}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: activeTab === 'cards' ? 'var(--bg-card)' : 'transparent',
              color: activeTab === 'cards' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <Layers size={14} strokeWidth={1.5} />
            <span>Karteikarten</span>
            <span className="font-mono-num text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {dueCards.length}
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'quiz'}
            onClick={() => setActiveTab('quiz')}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: activeTab === 'quiz' ? 'var(--bg-card)' : 'transparent',
              color: activeTab === 'quiz' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <ClipboardCheck size={14} strokeWidth={1.5} />
            <span>Übungs-Quiz</span>
            <span className="font-mono-num text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {scopedQuizzes.length}
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'agent'}
            onClick={() => setActiveTab('agent')}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors cursor-pointer"
            style={{
              backgroundColor: activeTab === 'agent' ? 'var(--bg-card)' : 'transparent',
              color: activeTab === 'agent' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <Bot size={14} strokeWidth={1.5} />
            <span>Lern-Agent</span>
          </button>
        </div>
      </header>

      {/* Course Scope Pills */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setScopeAll(true)}
          className="rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors cursor-pointer"
          style={{
            backgroundColor: scopeAll ? 'var(--text-primary)' : 'var(--bg-card)',
            color: scopeAll ? 'var(--bg-card)' : 'var(--text-secondary)',
            borderColor: scopeAll ? 'transparent' : 'var(--border-hairline)',
          }}
        >
          Alle Fächer
        </button>
        {state.courses.map((course) => {
          const active = !scopeAll && course.id === activeCourse?.id;
          return (
            <button
              key={course.id}
              type="button"
              onClick={() => {
                setScopeAll(false);
                onSelectCourse(course.id);
              }}
              className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors cursor-pointer"
              style={{
                backgroundColor: active ? 'var(--bg-card)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                borderColor: active ? 'var(--accent-border)' : 'var(--border-hairline)',
              }}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: course.accentColor }}
              />
              <span>{course.title}</span>
            </button>
          );
        })}
      </div>

      {/* ================= TAB 1: FLASHCARDS (SM-2) ================= */}
      {activeTab === 'cards' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              <span>
                <span className="font-mono-num font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {dueCards.length}
                </span>{' '}
                fällig von{' '}
                <span className="font-mono-num">{scopedCards.length}</span> Karten
              </span>
              {scopedCards.length > 0 && (
                <>
                  <span>·</span>
                  <button
                    type="button"
                    onClick={() => setPracticeAllCards((prev) => !prev)}
                    className="text-[13px] font-medium cursor-pointer"
                    style={{ color: 'var(--accent)' }}
                  >
                    {practiceAllCards ? 'Nur fällige Karten zeigen' : 'Alle Karten frei üben'}
                  </button>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowCardCreator((prev) => !prev)}
              className="btn-secondary h-8 px-3 text-[13px]"
            >
              <Plus size={14} strokeWidth={1.5} />
              <span>Neue Karte</span>
            </button>
          </div>

          {/* Inline Flashcard Creator */}
          {showCardCreator && (
            <form onSubmit={handleCreateCard} className="surface-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Neue Karteikarte erstellen
                </h2>
                <button
                  type="button"
                  onClick={() => setShowCardCreator(false)}
                  className="btn-ghost h-7 px-2 text-[12px]"
                >
                  Schliessen
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Vorderseite (Frage / Begriff)
                  </label>
                  <textarea
                    rows={3}
                    required
                    value={newCardFront}
                    onChange={(e) => setNewCardFront(e.target.value)}
                    placeholder="Was unterscheidet Present Perfect von Past Simple?"
                    className="w-full rounded-lg border p-2.5 text-[14px]"
                    style={{
                      backgroundColor: 'var(--bg-page)',
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Rückseite (Antwort)
                  </label>
                  <textarea
                    rows={3}
                    required
                    value={newCardBack}
                    onChange={(e) => setNewCardBack(e.target.value)}
                    placeholder="Present Perfect verbindet Vergangenheit mit Gegenwart..."
                    className="w-full rounded-lg border p-2.5 text-[14px]"
                    style={{
                      backgroundColor: 'var(--bg-page)',
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                <div className="sm:col-span-5">
                  <label className="mb-1 block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Hinweis (optional)
                  </label>
                  <input
                    type="text"
                    value={newCardHint}
                    onChange={(e) => setNewCardHint(e.target.value)}
                    placeholder="Kleiner Denkanstoss..."
                    className="w-full rounded-lg border px-3 py-1.5 text-[13px]"
                    style={{
                      backgroundColor: 'var(--bg-page)',
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
                <div className="sm:col-span-4">
                  <label className="mb-1 block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Fach
                  </label>
                  <select
                    value={newCardCourseId}
                    onChange={(e) => setNewCardCourseId(e.target.value)}
                    className="w-full rounded-lg border px-3 py-1.5 text-[13px]"
                    style={{
                      backgroundColor: 'var(--bg-page)',
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {state.courses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end sm:col-span-3">
                  <button type="submit" className="btn-accent w-full">
                    <Plus size={15} strokeWidth={1.5} />
                    <span>Karte speichern</span>
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Active Card Stage */}
          {!currentCard ? (
            <div className="surface-card mx-auto max-w-2xl p-8 text-center">
              <CheckCircle2
                size={28}
                strokeWidth={1.5}
                className="mx-auto"
                style={{ color: 'var(--positive)' }}
              />
              <h2 className="mt-3 text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {scopedCards.length === 0
                  ? 'Noch keine Karteikarten in diesem Bereich'
                  : 'Alle fälligen Karten für heute erledigt'}
              </h2>
              <p className="mt-1.5 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
                {scopedCards.length === 0
                  ? 'Erstelle oben eine neue Karte oder lasse den Lern-Agenten passende Karten generieren.'
                  : 'SM-2 hat deine nächsten Wiederholungsintervalle gespeichert. Du kannst jederzeit alle Karten frei wiederholen.'}
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                {scopedCards.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setPracticeAllCards(true)}
                    className="btn-secondary"
                  >
                    <RotateCcw size={15} strokeWidth={1.5} />
                    <span>Alle {scopedCards.length} Karten frei üben</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setActiveTab('agent')}
                  className="btn-accent"
                >
                  <Bot size={15} strokeWidth={1.5} />
                  <span>Karten mit Lern-Agent erstellen</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="surface-card mx-auto max-w-3xl p-6 sm:p-8">
              {/* Meta bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                <div className="flex items-center gap-2">
                  {courseMap.get(currentCard.courseId) && (
                    <>
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: courseMap.get(currentCard.courseId)?.accentColor }}
                      />
                      <span>{courseMap.get(currentCard.courseId)?.title}</span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-3 font-mono-num">
                  <span>
                    Karte {safeCardIndex + 1} / {activeDeck.length}
                  </span>
                  <span>·</span>
                  <span>
                    Wdh. {currentCard.reps} · Intervall {currentCard.interval} T
                  </span>
                </div>
              </div>

              {/* Front */}
              <div className="my-7 min-h-[110px]">
                <p className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
                  Frage
                </p>
                <p
                  className="mt-2 whitespace-pre-line text-[20px] font-medium leading-snug sm:text-[22px]"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {currentCard.front}
                </p>

                {currentCard.hint && !isFlipped && (
                  <div className="mt-4">
                    {showHint ? (
                      <p
                        className="rounded-lg border px-3 py-2 text-[13px]"
                        style={{
                          backgroundColor: 'var(--bg-page)',
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Hinweis: {currentCard.hint}
                      </p>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowHint(true)}
                        className="btn-ghost h-7 px-2 text-[12px]"
                      >
                        <Eye size={13} strokeWidth={1.5} />
                        <span>Hinweis einblenden</span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Back or Flip Trigger */}
              {!isFlipped ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5" style={{ borderColor: 'var(--border-hairline)' }}>
                  <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    Tastatur: <span className="keycap">Space</span> zum Aufdecken
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsFlipped(true)}
                    className="btn-primary"
                  >
                    <span>Antwort zeigen</span>
                    <span className="keycap">Space</span>
                  </button>
                </div>
              ) : (
                <div className="border-t pt-5 space-y-6" style={{ borderColor: 'var(--border-hairline)' }}>
                  <div>
                    <p className="text-[12px] font-medium" style={{ color: 'var(--accent)' }}>
                      Antwort
                    </p>
                    <p
                      className="mt-2 whitespace-pre-line text-[15px] leading-relaxed"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {currentCard.back}
                    </p>
                  </div>

                  {/* SM-2 Rating Controls */}
                  <div>
                    <p className="mb-2.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      Wie sicher war deine Antwort? (Tasten <span className="keycap">1</span> bis{' '}
                      <span className="keycap">4</span>)
                    </p>
                    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                      <button
                        type="button"
                        onClick={() => handleRateCurrentCard(1)}
                        className="flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-[13px] font-medium transition-colors cursor-pointer"
                        style={{
                          backgroundColor: 'var(--negative-soft)',
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--negative)',
                        }}
                      >
                        <span>Nochmal</span>
                        <span className="keycap">1</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleRateCurrentCard(2)}
                        className="flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-[13px] font-medium transition-colors cursor-pointer"
                        style={{
                          backgroundColor: 'var(--warning-soft)',
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--warning)',
                        }}
                      >
                        <span>Schwer</span>
                        <span className="keycap">2</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleRateCurrentCard(3)}
                        className="flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-[13px] font-medium transition-colors cursor-pointer"
                        style={{
                          backgroundColor: 'var(--accent-soft)',
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--accent)',
                        }}
                      >
                        <span>Gut</span>
                        <span className="keycap">3</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleRateCurrentCard(4)}
                        className="flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-[13px] font-medium transition-colors cursor-pointer"
                        style={{
                          backgroundColor: 'var(--positive-soft)',
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--positive)',
                        }}
                      >
                        <span>Leicht</span>
                        <span className="keycap">4</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ================= TAB 2: QUIZ & EXAM MODE ================= */}
      {activeTab === 'quiz' && (
        <div className="space-y-4">
          {/* Quiz Top Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              <span>
                <span className="font-mono-num font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {scopedQuizzes.length}
                </span>{' '}
                Fragen verfügbar
              </span>
              {examMode && !quizFinished && scopedQuizzes.length > 0 && (
                <span
                  className="font-mono-num inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium"
                  style={{
                    backgroundColor: examSecondsLeft <= 30 ? 'var(--negative-soft)' : 'var(--warning-soft)',
                    color: examSecondsLeft <= 30 ? 'var(--negative)' : 'var(--warning)',
                  }}
                >
                  <Clock size={13} strokeWidth={1.5} />
                  <span>{formatTimer(examSecondsLeft)}</span>
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <label
                className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] cursor-pointer"
                style={{
                  backgroundColor: examMode ? 'var(--accent-soft)' : 'var(--bg-card)',
                  borderColor: examMode ? 'var(--accent-border)' : 'var(--border-hairline)',
                  color: examMode ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                <input
                  type="checkbox"
                  checked={examMode}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setExamMode(next);
                    setQuizAnswers({});
                    setQuizIndex(0);
                    setQuizFinished(false);
                    if (next && scopedQuizzes.length > 0) {
                      setExamSecondsLeft(scopedQuizzes.length * 45);
                    }
                  }}
                  className="h-3.5 w-3.5 accent-[var(--accent)] cursor-pointer"
                />
                <span>Prüfungsmodus (Zeitlimit)</span>
              </label>

              <button type="button" onClick={handleRestartQuiz} className="btn-ghost">
                <RotateCcw size={14} strokeWidth={1.5} />
                <span>Neu starten</span>
              </button>
            </div>
          </div>

          {scopedQuizzes.length === 0 ? (
            <div className="surface-card mx-auto max-w-2xl p-8 text-center">
              <GraduationCap size={26} strokeWidth={1.5} className="mx-auto" style={{ color: 'var(--text-muted)' }} />
              <h2 className="mt-3 text-[17px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                Keine Quizfragen für dieses Fach gefunden
              </h2>
              <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                Wähle oben «Alle Fächer» oder lass den Lern-Agenten neue Übungsfragen erstellen.
              </p>
            </div>
          ) : quizFinished ? (
            <div className="surface-card mx-auto max-w-3xl p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-hairline)' }}>
                <div>
                  <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                    {examMode ? 'Prüfungs-Auswertung' : 'Quiz-Auswertung'}
                  </p>
                  <h2 className="mt-1 text-[22px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    <span className="font-mono-num">
                      {quizScore.correct} / {quizScore.total}
                    </span>{' '}
                    richtig beantwortet
                  </h2>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className="font-mono-num rounded-xl px-3.5 py-2 text-[18px] font-semibold"
                    style={{
                      backgroundColor: 'var(--accent-soft)',
                      color: 'var(--accent)',
                    }}
                  >
                    {quizScore.total > 0 ? Math.round((quizScore.correct / quizScore.total) * 100) : 0}%
                  </span>
                  <button type="button" onClick={handleRestartQuiz} className="btn-primary">
                    <RotateCcw size={15} strokeWidth={1.5} />
                    <span>Wiederholen</span>
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                {scopedQuizzes.map((q, idx) => {
                  const chosen = quizAnswers[q.id];
                  const correct = chosen === q.correctIndex;
                  return (
                    <div
                      key={q.id}
                      className="rounded-xl border p-4"
                      style={{
                        backgroundColor: 'var(--bg-page)',
                        borderColor: 'var(--border-hairline)',
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
                          <span className="font-mono-num mr-1.5" style={{ color: 'var(--text-muted)' }}>
                            {idx + 1}.
                          </span>
                          {q.prompt}
                        </p>
                        {correct ? (
                          <CheckCircle2 size={16} strokeWidth={1.5} className="shrink-0" style={{ color: 'var(--positive)' }} />
                        ) : (
                          <XCircle size={16} strokeWidth={1.5} className="shrink-0" style={{ color: 'var(--negative)' }} />
                        )}
                      </div>
                      <p className="mt-2 text-[13px]" style={{ color: 'var(--positive)' }}>
                        Richtige Antwort: {q.options[q.correctIndex]}
                      </p>
                      {!correct && chosen !== undefined && (
                        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--negative)' }}>
                          Deine Wahl: {q.options[chosen]}
                        </p>
                      )}
                      <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        {q.explanation}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            currentQuiz && (
              <div className="surface-card mx-auto max-w-3xl p-6 space-y-5">
                {/* Progress */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    <span>
                      Frage <span className="font-mono-num">{safeQuizIndex + 1}</span> von{' '}
                      <span className="font-mono-num">{scopedQuizzes.length}</span>
                    </span>
                    <span className="font-mono-num">
                      {quizScore.answered} beantwortet
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: 'var(--bg-raised)' }}>
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.round(((safeQuizIndex + 1) / scopedQuizzes.length) * 100)}%`,
                        backgroundColor: 'var(--accent)',
                      }}
                    />
                  </div>
                </div>

                {/* Question prompt */}
                <h2 className="text-[18px] font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>
                  {currentQuiz.prompt}
                </h2>

                {/* Options */}
                <div className="space-y-2.5">
                  {currentQuiz.options.map((opt, idx) => {
                    const chosen = quizAnswers[currentQuiz.id];
                    const hasAnswered = chosen !== undefined;
                    const isSelected = chosen === idx;
                    const isRight = idx === currentQuiz.correctIndex;

                    let bg = 'var(--bg-card)';
                    let border = 'var(--border-hairline)';

                    if (examMode) {
                      if (isSelected) {
                        bg = 'var(--accent-soft)';
                        border = 'var(--accent-border)';
                      }
                    } else if (hasAnswered) {
                      if (isRight) {
                        bg = 'var(--positive-soft)';
                        border = 'var(--positive)';
                      } else if (isSelected) {
                        bg = 'var(--negative-soft)';
                        border = 'var(--negative)';
                      }
                    }

                    return (
                      <button
                        key={opt}
                        type="button"
                        disabled={!examMode && hasAnswered}
                        onClick={() =>
                          setQuizAnswers((prev) => ({ ...prev, [currentQuiz.id]: idx }))
                        }
                        className="flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors cursor-pointer disabled:cursor-default"
                        style={{
                          backgroundColor: bg,
                          borderColor: border,
                          color: 'var(--text-primary)',
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <span className="keycap shrink-0">{OPTION_KEYS[idx] ?? idx + 1}</span>
                          <span className="text-[14px]">{opt}</span>
                        </div>
                        {!examMode && hasAnswered && isRight && (
                          <CheckCircle2 size={16} strokeWidth={1.5} style={{ color: 'var(--positive)' }} />
                        )}
                        {!examMode && hasAnswered && isSelected && !isRight && (
                          <XCircle size={16} strokeWidth={1.5} style={{ color: 'var(--negative)' }} />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Instant explanation in practice mode */}
                {!examMode && quizAnswers[currentQuiz.id] !== undefined && (
                  <div
                    className="rounded-xl border p-3.5 text-[13px] leading-relaxed"
                    style={{
                      backgroundColor:
                        quizAnswers[currentQuiz.id] === currentQuiz.correctIndex
                          ? 'var(--positive-soft)'
                          : 'var(--warning-soft)',
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <p
                      className="font-semibold"
                      style={{
                        color:
                          quizAnswers[currentQuiz.id] === currentQuiz.correctIndex
                            ? 'var(--positive)'
                            : 'var(--warning)',
                      }}
                    >
                      {quizAnswers[currentQuiz.id] === currentQuiz.correctIndex
                        ? 'Korrekt'
                        : 'Erklärung'}
                    </p>
                    <p className="mt-1">{currentQuiz.explanation}</p>
                  </div>
                )}

                {/* Navigation footer */}
                <div
                  className="flex items-center justify-between border-t pt-4"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  <button
                    type="button"
                    disabled={safeQuizIndex === 0}
                    onClick={() => setQuizIndex((i) => Math.max(0, i - 1))}
                    className="btn-secondary h-8 px-3 text-[13px] disabled:opacity-45"
                  >
                    Zurück
                  </button>

                  {safeQuizIndex < scopedQuizzes.length - 1 ? (
                    <button
                      type="button"
                      onClick={() => setQuizIndex((i) => Math.min(scopedQuizzes.length - 1, i + 1))}
                      className="btn-primary h-8 px-4 text-[13px]"
                    >
                      Nächste Frage
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setQuizFinished(true)}
                      className="btn-accent h-8 px-4 text-[13px]"
                    >
                      Auswertung anzeigen
                    </button>
                  )}
                </div>
              </div>
            )
          )}
        </div>
      )}

      {/* ================= TAB 3: LERN-AGENT (HERMES-STYLE) ================= */}
      {activeTab === 'agent' && (
        <div className="space-y-4">
          {/* Explicit 2-Way Stance Selector */}
          <section className="surface-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                <BookMarked size={14} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                <span>Kontext: {activeCourse?.title ?? 'Alle Fächer'}</span>
                <span>·</span>
                <span>
                  <span className="font-mono-num">{selectedObsidianNotes.length}</span> Obsidian-Notizen aktiv
                </span>
              </div>
              <div className="flex items-center gap-2">
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setMessages([]);
                      setAgentError(null);
                    }}
                    className="btn-ghost h-7 px-2 text-[12px]"
                  >
                    <Trash2 size={13} strokeWidth={1.5} />
                    <span>Verlauf leeren</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="btn-ghost h-7 px-2 text-[12px]"
                >
                  <Settings2 size={13} strokeWidth={1.5} />
                  <span>KI-Einstellungen</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <button
                type="button"
                onClick={() => onUpdateVoice({ stance: 'coach' })}
                className="rounded-xl border p-3.5 text-left transition-colors cursor-pointer"
                style={{
                  backgroundColor:
                    state.voice.stance === 'coach' ? 'var(--accent-soft)' : 'var(--bg-page)',
                  borderColor:
                    state.voice.stance === 'coach' ? 'var(--accent-border)' : 'var(--border-hairline)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Coach-Modus (Standard)
                  </span>
                  {state.voice.stance === 'coach' && (
                    <span
                      className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                      style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-ink)' }}
                    >
                      Aktiv
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  Hilft dir mit Fragen, Tipps & Erklärungen, damit du es selbst verstehst.
                </p>
              </button>

              <button
                type="button"
                onClick={() => onUpdateVoice({ stance: 'assistant' })}
                className="rounded-xl border p-3.5 text-left transition-colors cursor-pointer"
                style={{
                  backgroundColor:
                    state.voice.stance === 'assistant' ? 'var(--accent-soft)' : 'var(--bg-page)',
                  borderColor:
                    state.voice.stance === 'assistant'
                      ? 'var(--accent-border)'
                      : 'var(--border-hairline)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Assistenz-Modus
                  </span>
                  {state.voice.stance === 'assistant' && (
                    <span
                      className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                      style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-ink)' }}
                    >
                      Aktiv
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  Erstellt auf Wunsch direkt Lernpläne, Karteikarten oder strukturierte Zusammenfassungen.
                </p>
              </button>
            </div>

            {/* Quick Action Chips */}
            <div className="mt-3.5 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={isAgentBusy}
                onClick={() =>
                  sendAgentPrompt(
                    `Erstelle 3 präzise Karteikarten zum Fach «${activeCourse?.title ?? 'aktuelles Fach'}». Verwende pro Karte genau das Format:\nFrage: ...\nAntwort: ...`,
                    'assistant'
                  )
                }
                className="btn-secondary h-8 px-3 text-[12px]"
              >
                <Layers size={13} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                <span>Erstelle 3 Karteikarten zum aktuellen Fach</span>
              </button>

              <button
                type="button"
                disabled={isAgentBusy}
                onClick={() =>
                  sendAgentPrompt(
                    hardestObjective
                      ? `Erkläre das Lernziel «${hardestObjective.title}» Schritt für Schritt in Depth mit einem klaren Beispiel und einer kurzen Verständnisfrage am Ende.`
                      : `Erkläre das schwierigste Lernziel im Fach «${activeCourse?.title ?? 'aktuelles Fach'}» in Depth mit einem klaren Beispiel.`,
                    'coach'
                  )
                }
                className="btn-secondary h-8 px-3 text-[12px]"
              >
                <GraduationCap size={13} strokeWidth={1.5} style={{ color: 'var(--warning)' }} />
                <span>Erkläre das schwierigste Lernziel in Depth</span>
              </button>

              <button
                type="button"
                disabled={isAgentBusy}
                onClick={() =>
                  sendAgentPrompt(
                    `Erstelle einen realistischen 3-Tage-Lernplan für «${activeCourse?.title ?? 'aktuelles Fach'}» mit kurzen Blöcken von 10–20 Min. Format pro Zeile: - [15 Min] Aufgabe.`,
                    'assistant'
                  )
                }
                className="btn-secondary h-8 px-3 text-[12px]"
              >
                <CalendarPlus size={13} strokeWidth={1.5} style={{ color: 'var(--positive)' }} />
                <span>Erstelle einen 3-Tage-Lernplan</span>
              </button>
            </div>
          </section>

          {/* Chat Thread & Composer */}
          <section className="surface-card flex flex-col overflow-hidden">
            <div className="min-h-[300px] max-h-[480px] overflow-y-auto p-5 space-y-4">
              {messages.length === 0 ? (
                <div className="flex h-full min-h-[240px] flex-col items-center justify-center text-center">
                  <Bot size={26} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                  <h2 className="mt-3 text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Stelle eine Frage oder wähle eine Schnellaktion
                  </h2>
                  <p className="mt-1 max-w-md text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    Der Lern-Agent kennt deine Lernziele im aktiven Fach sowie alle gewählten Obsidian-Notizen. Generierte Karteikarten und Lernblöcke lassen sich mit einem Klick übernehmen.
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isUser = msg.role === 'user';
                  const parsedCards = !isUser ? extractFlashcardsFromText(msg.content) : [];
                  const parsedPlan = !isUser ? extractPlanTasksFromText(msg.content) : [];

                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                    >
                      <div
                        className="max-w-[88%] rounded-2xl border px-4 py-3 text-[14px] leading-relaxed"
                        style={{
                          backgroundColor: isUser ? 'var(--bg-raised)' : 'var(--bg-page)',
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          <span className="font-medium">
                            {isUser
                              ? 'Du'
                              : msg.stance === 'assistant'
                              ? 'Lern-Agent · Assistenz'
                              : 'Lern-Agent · Coach'}
                          </span>
                          {msg.usedProvider && <span>{msg.usedProvider}</span>}
                        </div>
                        <div className="whitespace-pre-wrap">{msg.content}</div>

                        {/* 1-Click Save Actions for Generated Cards / Study Plan */}
                        {!isUser && (parsedCards.length > 0 || parsedPlan.length > 0) && (
                          <div
                            className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3"
                            style={{ borderColor: 'var(--border-hairline)' }}
                          >
                            {parsedCards.length > 0 && (
                              <button
                                type="button"
                                disabled={msg.savedCards}
                                onClick={() => handleSaveParsedCards(msg.id, parsedCards)}
                                className={msg.savedCards ? 'btn-secondary h-8 px-3 text-[12px]' : 'btn-accent h-8 px-3 text-[12px]'}
                              >
                                {msg.savedCards ? (
                                  <>
                                    <Check size={13} strokeWidth={1.5} />
                                    <span>{parsedCards.length} Karten gespeichert</span>
                                  </>
                                ) : (
                                  <>
                                    <Layers size={13} strokeWidth={1.5} />
                                    <span>{parsedCards.length} Karteikarten direkt speichern</span>
                                  </>
                                )}
                              </button>
                            )}

                            {parsedPlan.length > 0 && (
                              <button
                                type="button"
                                disabled={msg.savedPlan}
                                onClick={() => handleSaveParsedPlan(msg.id, parsedPlan)}
                                className="btn-secondary h-8 px-3 text-[12px]"
                              >
                                {msg.savedPlan ? (
                                  <>
                                    <Check size={13} strokeWidth={1.5} />
                                    <span>Im Tagesplan übernommen</span>
                                  </>
                                ) : (
                                  <>
                                    <CalendarPlus size={13} strokeWidth={1.5} />
                                    <span>{parsedPlan.length} Blöcke in den Tagesplan übernehmen</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}

              {isAgentBusy && (
                <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
                  <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                  <span>Lern-Agent denkt nach...</span>
                </div>
              )}

              {agentError && (
                <div
                  className="rounded-xl border p-3.5 text-[13px]"
                  style={{
                    backgroundColor: 'var(--warning-soft)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-2">
                      <AlertCircle size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} />
                      <span>{agentError}</span>
                    </div>
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="btn-secondary h-7 px-2.5 text-[12px]"
                    >
                      Provider einrichten
                    </button>
                  </div>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            {/* Composer */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendAgentPrompt(agentInput);
              }}
              className="border-t p-3.5"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-page)',
              }}
            >
              <div className="flex items-end gap-2.5">
                <textarea
                  rows={2}
                  value={agentInput}
                  onChange={(e) => setAgentInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendAgentPrompt(agentInput);
                    }
                  }}
                  placeholder={
                    state.voice.stance === 'coach'
                      ? 'Stelle eine Verständnisfrage oder beschreibe, wo du hängst... (Enter zum Senden)'
                      : 'Zum Beispiel: Erstelle 4 Karteikarten zu den wichtigsten Begriffen...'
                  }
                  className="flex-1 resize-none rounded-xl border px-3.5 py-2.5 text-[14px] leading-relaxed"
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
                <button
                  type="submit"
                  disabled={!agentInput.trim() || isAgentBusy}
                  className="btn-accent h-[42px] px-4 disabled:opacity-45"
                >
                  <Send size={15} strokeWidth={1.5} />
                  <span>Senden</span>
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
};
