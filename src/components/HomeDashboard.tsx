import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Flame,
  GraduationCap,
  Languages,
  Layers,
  Mic,
  Settings2,
  Target,
  Timer,
} from 'lucide-react';
import {
  MainView,
  MasteryState,
  OpenStudyState,
  StudyLanguage,
  TutorMode,
} from '../types';

export interface HomeDashboardProps {
  state: OpenStudyState;
  demoMode: boolean;
  onNavigate: (view: MainView) => void;
  onSelectCourse: (courseId: string) => void;
  onTogglePlanTask: (taskId: string) => void;
  onSetObjectiveMastery: (courseId: string, objectiveId: string, mastery: MasteryState) => void;
  onOpenVoiceTutor: (opts?: { mode?: TutorMode; language?: StudyLanguage }) => void;
  onOpenOnboarding: () => void;
}

const MASTERY_CYCLE: Record<MasteryState, MasteryState> = {
  open: 'practicing',
  practicing: 'mastered',
  mastered: 'open',
};

const MASTERY_META: Record<
  MasteryState,
  { label: string; color: string; bg: string }
> = {
  open: {
    label: 'Offen',
    color: 'var(--text-muted)',
    bg: 'var(--bg-raised)',
  },
  practicing: {
    label: 'In Übung',
    color: 'var(--warning)',
    bg: 'var(--warning-soft)',
  },
  mastered: {
    label: 'Sicher',
    color: 'var(--positive)',
    bg: 'var(--positive-soft)',
  },
};

const QUICK_LANGUAGES: { code: StudyLanguage; short: string; label: string }[] = [
  { code: 'de', short: 'DE', label: 'Deutsch' },
  { code: 'en', short: 'EN', label: 'English' },
  { code: 'fr', short: 'FR', label: 'Français' },
  { code: 'es', short: 'ES', label: 'Español' },
  { code: 'it', short: 'IT', label: 'Italiano' },
];

function getLocalTodayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatShortDate(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function getDaysUntilLabel(dateStr: string): { label: string; urgent: boolean } {
  const target = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) {
    return { label: dateStr, urgent: false };
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return { label: 'Vorbei', urgent: false };
  if (diffDays === 0) return { label: 'Heute', urgent: true };
  if (diffDays === 1) return { label: 'Morgen', urgent: true };
  return { label: `In ${diffDays} Tagen`, urgent: diffDays <= 7 };
}

function getSourceLabel(source: 'ics' | 'manual' | 'smart-import'): string {
  if (source === 'ics') return 'ICS';
  if (source === 'smart-import') return 'Import';
  return 'Manuell';
}

export const HomeDashboard: React.FC<HomeDashboardProps> = ({
  state,
  demoMode,
  onNavigate,
  onSelectCourse,
  onTogglePlanTask,
  onSetObjectiveMastery,
  onOpenVoiceTutor,
  onOpenOnboarding,
}) => {
  const [expandAllCourses, setExpandAllCourses] = useState(false);

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

  const metrics = useMemo(() => {
    const todayIso = getLocalTodayIso();
    const now = Date.now();

    const todayFocusMinutes = state.focusLogs
      .filter((log) => log.completedAt.slice(0, 10) === todayIso)
      .reduce((sum, log) => sum + log.minutes, 0);

    const todayPlanTasks = state.dailyPlan.filter((t) => t.scheduledFor === 'Heute');
    const doneTodayPlanMinutes = todayPlanTasks
      .filter((t) => t.done)
      .reduce((sum, t) => sum + t.minutes, 0);

    const completedMinutesToday = todayFocusMinutes + doneTodayPlanMinutes;
    const goalPercent =
      state.dailyGoalMinutes > 0
        ? Math.min(100, Math.round((completedMinutesToday / state.dailyGoalMinutes) * 100))
        : 0;

    const dueCardsCount = state.cards.filter((c) => c.due <= now).length;

    let totalObjectives = 0;
    let masteredObjectives = 0;
    for (const course of state.courses) {
      totalObjectives += course.objectives.length;
      masteredObjectives += course.objectives.filter((o) => o.mastery === 'mastered').length;
    }

    const doneTodayTasks = todayPlanTasks.filter((t) => t.done).length;
    const todayPlanPercent =
      todayPlanTasks.length > 0
        ? Math.round((doneTodayTasks / todayPlanTasks.length) * 100)
        : 0;

    return {
      completedMinutesToday,
      goalPercent,
      dueCardsCount,
      totalObjectives,
      masteredObjectives,
      todayPlanTasks,
      doneTodayTasks,
      todayPlanPercent,
    };
  }, [state.focusLogs, state.dailyPlan, state.dailyGoalMinutes, state.cards, state.courses]);

  const upcomingPlanTasks = useMemo(
    () => state.dailyPlan.filter((t) => t.scheduledFor !== 'Heute'),
    [state.dailyPlan]
  );

  const sortedSchedule = useMemo(
    () =>
      [...state.schoolSchedule].sort((a, b) => a.date.localeCompare(b.date)),
    [state.schoolSchedule]
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10 animate-enter">
      {/* Header */}
      <header className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between" style={{ borderColor: 'var(--border-hairline)' }}>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {activeCourse ? (
              <span className="inline-flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: activeCourse.accentColor }}
                />
                <span>Aktives Fach: {activeCourse.title}</span>
              </span>
            ) : (
              <span>Persönlicher Lernbereich</span>
            )}
            {demoMode && (
              <>
                <span style={{ color: 'var(--border-strong)' }}>·</span>
                <span
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium"
                  style={{
                    backgroundColor: 'var(--bg-raised)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  Demo-Daten aktiv
                </span>
                <button
                  type="button"
                  onClick={onOpenOnboarding}
                  className="inline-flex items-center gap-1 text-[12px] font-medium transition-opacity hover:opacity-80 cursor-pointer"
                  style={{ color: 'var(--accent)' }}
                >
                  <Settings2 size={13} strokeWidth={1.5} />
                  <span>Einrichten</span>
                </button>
              </>
            )}
          </div>
          <h1
            className="text-[26px] font-semibold tracking-tight sm:text-[28px]"
            style={{ color: 'var(--text-primary)', lineHeight: 1.2 }}
          >
            Lernübersicht
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => onOpenVoiceTutor({ mode: 'explain' })}
            className="btn-accent"
          >
            <Mic size={16} strokeWidth={1.5} />
            <span>Sprachtutor öffnen</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('focus')}
            className="btn-secondary"
          >
            <Timer size={16} strokeWidth={1.5} />
            <span>Fokus-Session starten</span>
          </button>
        </div>
      </header>

      {/* 4 Numeric Stat Cards */}
      <section className="grid grid-cols-2 gap-3.5 lg:grid-cols-4" aria-label="Lernkennzahlen">
        <div className="surface-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              Tagesziel
            </span>
            <Target size={16} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="font-mono-num text-[22px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {metrics.completedMinutesToday} / {state.dailyGoalMinutes}
            </span>
            <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
              Min
            </span>
          </div>
          <div
            className="mt-3 h-1.5 w-full overflow-hidden rounded-full"
            style={{ backgroundColor: 'var(--bg-raised)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${metrics.goalPercent}%`,
                backgroundColor: 'var(--accent)',
              }}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('trainer')}
          className="surface-card p-4 text-left transition-colors cursor-pointer"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div className="flex items-center justify-between">
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              Fällige Karten
            </span>
            <Layers size={16} strokeWidth={1.5} style={{ color: 'var(--text-secondary)' }} />
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="font-mono-num text-[22px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {metrics.dueCardsCount}
            </span>
            <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
              von {state.cards.length}
            </span>
          </div>
          <p className="mt-2.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {metrics.dueCardsCount > 0 ? 'Bereit zur Wiederholung' : 'Alle Karten aktuell'}
          </p>
        </button>

        <div className="surface-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              Lernziele sicher
            </span>
            <CheckCircle2 size={16} strokeWidth={1.5} style={{ color: 'var(--positive)' }} />
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="font-mono-num text-[22px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {metrics.masteredObjectives} / {metrics.totalObjectives}
            </span>
          </div>
          <p className="mt-2.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Über {state.courses.length} Fächer verteilt
          </p>
        </div>

        <div className="surface-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              Lern-Streak
            </span>
            <Flame size={16} strokeWidth={1.5} style={{ color: 'var(--warning)' }} />
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="font-mono-num text-[22px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {state.streakDays}
            </span>
            <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
              Tage
            </span>
          </div>
          <p className="mt-2.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            <span className="font-mono-num">{state.focusLogs.length}</span> Fokus-Sessions erfasst
          </p>
        </div>
      </section>

      {/* Main Split Layout */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* Left Column */}
        <div className="space-y-5 xl:col-span-7">
          {/* Heutiger Lernplan */}
          <section className="surface-card p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Heutiger Lernplan
                </h2>
                <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  <span className="font-mono-num">
                    {metrics.doneTodayTasks} von {metrics.todayPlanTasks.length}
                  </span>{' '}
                  Aufgaben heute erledigt
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('focus')}
                className="btn-ghost"
              >
                <span>Planer öffnen</span>
                <ArrowRight size={14} strokeWidth={1.5} />
              </button>
            </div>

            {/* Progress bar */}
            <div className="mt-3.5 flex items-center gap-3">
              <div
                className="h-1.5 flex-1 overflow-hidden rounded-full"
                style={{ backgroundColor: 'var(--bg-raised)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${metrics.todayPlanPercent}%`,
                    backgroundColor: 'var(--positive)',
                  }}
                />
              </div>
              <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {metrics.todayPlanPercent}%
              </span>
            </div>

            {/* Task rows */}
            {state.dailyPlan.length === 0 ? (
              <div
                className="mt-4 rounded-xl border border-dashed p-5 text-center"
                style={{ borderColor: 'var(--border-strong)' }}
              >
                <p className="text-[14px]" style={{ color: 'var(--text-secondary)' }}>
                  Noch keine Lernblöcke für heute geplant.
                </p>
                <button
                  type="button"
                  onClick={() => onNavigate('focus')}
                  className="btn-secondary mt-3"
                >
                  <span>Tagesplan erstellen</span>
                </button>
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                {metrics.todayPlanTasks.map((task) => {
                  const course = courseMap.get(task.courseId);
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => onTogglePlanTask(task.id)}
                      className="flex w-full items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors cursor-pointer"
                      style={{
                        backgroundColor: task.done ? 'var(--bg-raised)' : 'var(--bg-card)',
                        borderColor: 'var(--border-hairline)',
                      }}
                    >
                      <span
                        className="mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-[5px] border transition-colors"
                        style={{
                          backgroundColor: task.done ? 'var(--positive)' : 'transparent',
                          borderColor: task.done ? 'var(--positive)' : 'var(--border-strong)',
                          color: '#ffffff',
                        }}
                      >
                        {task.done && <Check size={12} strokeWidth={2} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p
                          className={`text-[14px] font-medium leading-snug ${task.done ? 'line-through' : ''}`}
                          style={{
                            color: task.done ? 'var(--text-muted)' : 'var(--text-primary)',
                          }}
                        >
                          {task.title}
                        </p>
                        {course && (
                          <div className="mt-1 flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                            <span
                              className="inline-block h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: course.accentColor }}
                            />
                            <span className="truncate">{course.title}</span>
                          </div>
                        )}
                      </div>
                      <span
                        className="font-mono-num shrink-0 rounded-md px-2 py-0.5 text-[12px]"
                        style={{
                          backgroundColor: 'var(--bg-raised)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {task.minutes} Min
                      </span>
                    </button>
                  );
                })}

                {upcomingPlanTasks.length > 0 && (
                  <div className="pt-2">
                    <p className="mb-2 text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
                      Ausblick
                    </p>
                    <div className="space-y-1.5">
                      {upcomingPlanTasks.slice(0, 3).map((task) => {
                        const course = courseMap.get(task.courseId);
                        return (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => onTogglePlanTask(task.id)}
                            className="flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer"
                            style={{
                              backgroundColor: 'transparent',
                              borderColor: 'var(--border-hairline)',
                            }}
                          >
                            <span
                              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border"
                              style={{
                                backgroundColor: task.done ? 'var(--positive)' : 'transparent',
                                borderColor: task.done ? 'var(--positive)' : 'var(--border-strong)',
                                color: '#ffffff',
                              }}
                            >
                              {task.done && <Check size={11} strokeWidth={2} />}
                            </span>
                            <span
                              className={`min-w-0 flex-1 truncate text-[13px] ${task.done ? 'line-through' : ''}`}
                              style={{ color: task.done ? 'var(--text-muted)' : 'var(--text-secondary)' }}
                            >
                              {task.title}
                            </span>
                            {course && (
                              <span
                                className="hidden h-1.5 w-1.5 rounded-full sm:inline-block"
                                style={{ backgroundColor: course.accentColor }}
                              />
                            )}
                            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                              {task.scheduledFor}
                            </span>
                            <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
                              {task.minutes} Min
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Fächer & Lernziele */}
          <section className="surface-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Fächer & Lernziele
                </h2>
                <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  Fach antippen zum Wechseln, Statuskreis antippen zum Aktualisieren
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setExpandAllCourses((prev) => !prev)}
                  className="btn-ghost"
                >
                  <span>{expandAllCourses ? 'Kompakt' : 'Alle aufklappen'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('notes')}
                  className="btn-ghost"
                >
                  <BookOpen size={14} strokeWidth={1.5} />
                  <span>Notizen</span>
                </button>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {state.courses.map((course) => {
                const isActive = course.id === activeCourse?.id;
                const isExpanded = isActive || expandAllCourses;
                const masteredCount = course.objectives.filter((o) => o.mastery === 'mastered').length;
                const totalCount = course.objectives.length;

                return (
                  <div
                    key={course.id}
                    className="rounded-xl border transition-colors"
                    style={{
                      borderColor: isActive ? 'var(--accent-border)' : 'var(--border-hairline)',
                      backgroundColor: isActive ? 'var(--bg-card)' : 'var(--bg-page)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectCourse(course.id)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left cursor-pointer"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        {isExpanded ? (
                          <ChevronDown size={15} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
                        ) : (
                          <ChevronRight size={15} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
                        )}
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: course.accentColor }}
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className="truncate text-[14px] font-semibold"
                              style={{ color: 'var(--text-primary)' }}
                            >
                              {course.title}
                            </span>
                            {isActive && (
                              <span
                                className="rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                                style={{
                                  backgroundColor: 'var(--accent-soft)',
                                  color: 'var(--accent)',
                                }}
                              >
                                Aktiv
                              </span>
                            )}
                          </div>
                          {!isExpanded && (
                            <p className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--text-muted)' }}>
                              {course.description}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-3">
                        {course.examDate && (
                          <span
                            className="hidden text-[12px] sm:inline-block"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {formatShortDate(course.examDate)}
                          </span>
                        )}
                        <span
                          className="font-mono-num rounded-md px-2 py-0.5 text-[12px]"
                          style={{
                            backgroundColor: 'var(--bg-raised)',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {masteredCount} / {totalCount}
                        </span>
                      </div>
                    </button>

                    {isExpanded && (
                      <div
                        className="border-t px-4 py-3 space-y-2"
                        style={{ borderColor: 'var(--border-hairline)' }}
                      >
                        <p className="text-[13px] mb-2.5" style={{ color: 'var(--text-secondary)' }}>
                          {course.description}
                        </p>
                        {course.objectives.map((obj) => {
                          const meta = MASTERY_META[obj.mastery];
                          const nextState = MASTERY_CYCLE[obj.mastery];
                          return (
                            <div
                              key={obj.id}
                              className="flex items-start gap-3 rounded-lg px-2.5 py-2 transition-colors"
                              style={{ backgroundColor: 'var(--bg-page)' }}
                            >
                              <button
                                type="button"
                                onClick={() => onSetObjectiveMastery(course.id, obj.id, nextState)}
                                title={`Status ändern zu: ${MASTERY_META[nextState].label}`}
                                aria-label={`Lernziel ${obj.title}: aktuell ${meta.label}, klicken für ${MASTERY_META[nextState].label}`}
                                className="mt-0.5 flex shrink-0 items-center justify-center rounded-full p-0.5 transition-transform active:scale-95 cursor-pointer"
                                style={{ color: meta.color }}
                              >
                                {obj.mastery === 'mastered' && (
                                  <CheckCircle2 size={18} strokeWidth={1.5} />
                                )}
                                {obj.mastery === 'practicing' && (
                                  <CircleDot size={18} strokeWidth={1.5} />
                                )}
                                {obj.mastery === 'open' && (
                                  <Circle size={18} strokeWidth={1.5} />
                                )}
                              </button>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span
                                    className="text-[14px] font-medium"
                                    style={{ color: 'var(--text-primary)' }}
                                  >
                                    {obj.title}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => onSetObjectiveMastery(course.id, obj.id, nextState)}
                                    className="rounded-md px-2 py-0.5 text-[11px] font-medium cursor-pointer"
                                    style={{
                                      backgroundColor: meta.bg,
                                      color: meta.color,
                                    }}
                                  >
                                    {meta.label}
                                  </button>
                                </div>
                                <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                                  {obj.summary}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        {/* Right Column */}
        <div className="space-y-5 xl:col-span-5">
          {/* Nächste Prüfungen */}
          <section className="surface-card p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Calendar size={16} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Nächste Prüfungen
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('import')}
                className="btn-ghost"
              >
                <span>Termine importieren</span>
              </button>
            </div>

            {sortedSchedule.length === 0 ? (
              <div
                className="mt-4 rounded-xl border border-dashed p-4 text-center"
                style={{ borderColor: 'var(--border-strong)' }}
              >
                <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  Noch keine Prüfungstermine hinterlegt.
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-2.5">
                {sortedSchedule.map((item) => {
                  const countdown = getDaysUntilLabel(item.date);
                  return (
                    <div
                      key={item.id}
                      className="rounded-xl border p-3.5"
                      style={{
                        borderColor: 'var(--border-hairline)',
                        backgroundColor: 'var(--bg-page)',
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>
                            {item.title}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                            <span>{item.courseTitle}</span>
                            <span>·</span>
                            <span className="font-mono-num">{formatShortDate(item.date)}</span>
                            <span>·</span>
                            <span>{getSourceLabel(item.source)}</span>
                          </div>
                        </div>
                        <span
                          className="font-mono-num shrink-0 rounded-md px-2 py-0.5 text-[12px] font-medium"
                          style={{
                            backgroundColor: countdown.urgent ? 'var(--warning-soft)' : 'var(--bg-raised)',
                            color: countdown.urgent ? 'var(--warning)' : 'var(--text-secondary)',
                          }}
                        >
                          {countdown.label}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Voice Tutor Quick-Launch */}
          <section className="surface-card p-5">
            <div className="flex items-center gap-2">
              <Mic size={16} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
              <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                Voice Tutor Direktstart
              </h2>
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Echtzeit-Gespräch zum aktiven Fach. Wähle direkt zwischen Erklärung, Prüfungs-Simulation oder freiem Sprachtraining.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3 xl:grid-cols-1">
              <button
                type="button"
                onClick={() => onOpenVoiceTutor({ mode: 'explain' })}
                className="btn-secondary justify-between w-full"
              >
                <span className="inline-flex items-center gap-2">
                  <BookOpen size={15} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                  <span>Konzepte erklären</span>
                </span>
                <ArrowRight size={14} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
              </button>
              <button
                type="button"
                onClick={() => onOpenVoiceTutor({ mode: 'exam' })}
                className="btn-secondary justify-between w-full"
              >
                <span className="inline-flex items-center gap-2">
                  <GraduationCap size={15} strokeWidth={1.5} style={{ color: 'var(--warning)' }} />
                  <span>Mündliche Prüfung üben</span>
                </span>
                <ArrowRight size={14} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
              </button>
              <button
                type="button"
                onClick={() => onOpenVoiceTutor({ mode: 'language', language: 'en' })}
                className="btn-secondary justify-between w-full"
              >
                <span className="inline-flex items-center gap-2">
                  <Languages size={15} strokeWidth={1.5} style={{ color: 'var(--positive)' }} />
                  <span>Sprach-Coach starten</span>
                </span>
                <ArrowRight size={14} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>
          </section>

          {/* Language Coach Quick-Launch */}
          <section className="surface-card p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Languages size={16} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Sprachen & Grammatik-Labor
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('languages')}
                className="btn-ghost"
              >
                <span>Öffnen</span>
                <ArrowRight size={14} strokeWidth={1.5} />
              </button>
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Gezielte Grammatik-Drills, KI-Textprüfung und mündliches Training mit striktem Language-Lock.
            </p>
            <div className="mt-3.5 flex flex-wrap gap-2">
              {QUICK_LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => onOpenVoiceTutor({ mode: 'language', language: lang.code })}
                  className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium transition-colors cursor-pointer"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <span className="font-mono-num text-[11px]" style={{ color: 'var(--accent)' }}>
                    {lang.short}
                  </span>
                  <span>{lang.label}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
