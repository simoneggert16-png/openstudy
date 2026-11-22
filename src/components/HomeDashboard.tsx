import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  GraduationCap,
  MessageCircle,
  Mic,
  MonitorPlay,
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
  onOpenSettings: () => void;
}

const MASTERY_CYCLE: Record<MasteryState, MasteryState> = {
  open: 'practicing',
  practicing: 'mastered',
  mastered: 'open',
};

const MASTERY_META: Record<MasteryState, { label: string; color: string }> = {
  open: {
    label: 'Offen',
    color: 'var(--text-muted)',
  },
  practicing: {
    label: 'In Übung',
    color: 'var(--accent-warm)',
  },
  mastered: {
    label: 'Sicher',
    color: 'var(--positive)',
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

function formatGermanDate(): string {
  try {
    return new Intl.DateTimeFormat('de-CH', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date());
  } catch {
    return getLocalTodayIso();
  }
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

export const HomeDashboard: React.FC<HomeDashboardProps> = ({
  state,
  onNavigate,
  onSelectCourse,
  onTogglePlanTask,
  onSetObjectiveMastery,
  onOpenVoiceTutor,
  onOpenOnboarding,
  onOpenSettings,
}) => {
  const [expandAllCourses, setExpandAllCourses] = useState(false);

  const formattedToday = useMemo(() => formatGermanDate(), []);

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

  const sortedSchedule = useMemo(() => {
    const todayIso = getLocalTodayIso();
    const sorted = [...state.schoolSchedule].sort((a, b) => {
      const dateCmp = a.date.localeCompare(b.date);
      if (dateCmp !== 0) return dateCmp;
      return (a.startTime ?? '').localeCompare(b.startTime ?? '');
    });
    const upcoming = sorted.filter((item) => item.date >= todayIso);
    return upcoming.length > 0 ? upcoming : sorted;
  }, [state.schoolSchedule]);

  const hasVoiceKey = Boolean(state.provider.geminiApiKey.trim());

  return (
    <div className="mx-auto max-w-[1120px] pb-14 animate-enter">
      {/* Top Editorial Header */}
      <header
        className="flex flex-col gap-5 border-b pb-7 sm:flex-row sm:items-end sm:justify-between"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div className="space-y-2">
          <div
            className="flex flex-wrap items-center gap-2 text-[13px]"
            style={{ color: 'var(--text-secondary)' }}
          >
            <span>{formattedToday}</span>
            {activeCourse && (
              <>
                <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                  ·
                </span>
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: activeCourse.accentColor }}
                  />
                  <span>{activeCourse.title}</span>
                </span>
              </>
            )}
          </div>
          <h1
            className="font-display text-[32px] sm:text-[38px] font-normal leading-[1.12]"
            style={{ color: 'var(--text-primary)' }}
          >
            Heute im Fokus
          </h1>
        </div>

        <div className="flex flex-col items-start sm:items-end gap-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => onNavigate('focus')}
              className="btn-accent"
            >
              <Timer size={15} strokeWidth={1.5} />
              <span>Fokus starten</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenVoiceTutor({ mode: 'explain' })}
              className="btn-secondary"
            >
              <Mic size={15} strokeWidth={1.5} />
              <span>Sprachtutor</span>
            </button>
          </div>
          {!hasVoiceKey && (
            <button
              type="button"
              onClick={onOpenOnboarding}
              className="text-[12.5px] font-medium cursor-pointer transition-colors hover:underline"
              style={{ color: 'var(--text-secondary)' }}
            >
              Sprachtutor einrichten
            </button>
          )}
        </div>
      </header>

      {/* Open Hairline Metric Strip (Zero SaaS Stat Cards) */}
      <section
        aria-label="Lernstand heute"
        className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-5 border-b py-5"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        {/* 1. Tagesziel */}
        <button
          type="button"
          onClick={onOpenSettings}
          title="Tagesziel in den Einstellungen anpassen"
          className="text-left group cursor-pointer"
        >
          <div
            className="text-[12.5px] transition-colors group-hover:text-[var(--text-primary)]"
            style={{ color: 'var(--text-muted)' }}
          >
            Tagesziel
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span
              className="font-mono-num text-[23px] font-medium tracking-[-0.02em]"
              style={{ color: 'var(--text-primary)' }}
            >
              {metrics.completedMinutesToday}
            </span>
            <span
              className="font-mono-num text-[13.5px]"
              style={{ color: 'var(--text-muted)' }}
            >
              / {state.dailyGoalMinutes} Min
            </span>
          </div>
          <div
            className="mt-2.5 h-[3px] w-full max-w-[168px] overflow-hidden rounded-full"
            style={{ backgroundColor: 'var(--bg-raised)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${metrics.goalPercent}%`,
                backgroundColor: 'var(--accent-warm)',
              }}
            />
          </div>
        </button>

        {/* 2. Fällige Karten */}
        <button
          type="button"
          onClick={() => onNavigate('trainer')}
          className="text-left group cursor-pointer"
        >
          <div
            className="inline-flex items-center gap-1 text-[12.5px] transition-colors group-hover:text-[var(--accent)]"
            style={{ color: 'var(--text-muted)' }}
          >
            <span>Fällige Karten</span>
            <ArrowUpRight
              size={13}
              strokeWidth={1.5}
              className="opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
            />
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span
              className="font-mono-num text-[23px] font-medium tracking-[-0.02em]"
              style={{ color: 'var(--text-primary)' }}
            >
              {metrics.dueCardsCount}
            </span>
          </div>
          <div
            className="mt-1 text-[12.5px] transition-colors group-hover:text-[var(--accent)]"
            style={{ color: 'var(--text-secondary)' }}
          >
            {metrics.dueCardsCount > 0 ? 'bereit zur Wiederholung' : 'alle aktuell'}
          </div>
        </button>

        {/* 3. Lernziele sicher */}
        <div>
          <div className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Lernziele sicher
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span
              className="font-mono-num text-[23px] font-medium tracking-[-0.02em]"
              style={{ color: 'var(--text-primary)' }}
            >
              {metrics.masteredObjectives}
            </span>
            <span
              className="font-mono-num text-[13.5px]"
              style={{ color: 'var(--text-muted)' }}
            >
              / {metrics.totalObjectives}
            </span>
          </div>
          <div className="mt-1 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
            über {state.courses.length} {state.courses.length === 1 ? 'Fach' : 'Fächer'}
          </div>
        </div>

        {/* 4. Lernserie */}
        <div>
          <div className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Lernserie
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: 'var(--accent-warm)' }}
              aria-hidden="true"
            />
            <div className="flex items-baseline gap-1.5">
              <span
                className="font-mono-num text-[23px] font-medium tracking-[-0.02em]"
                style={{ color: 'var(--text-primary)' }}
              >
                {state.streakDays}
              </span>
              <span className="text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>
                {state.streakDays === 1 ? 'Tag' : 'Tage'}
              </span>
            </div>
          </div>
          <div className="mt-1 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-mono-num">{state.focusLogs.length}</span>{' '}
            {state.focusLogs.length === 1 ? 'Fokus-Einheit' : 'Fokus-Einheiten'}
          </div>
        </div>
      </section>

      {/* Main Editorial Two-Column Canvas */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-10 xl:gap-12 pt-8">
        {/* Left Editorial Column (7 cols — open canvas, zero nested boxes) */}
        <div className="xl:col-span-7 space-y-11">
          {/* Heutiger Lernplan */}
          <section aria-labelledby="heading-daily-plan">
            <div className="flex items-baseline justify-between gap-4">
              <h2
                id="heading-daily-plan"
                className="font-display text-[22px] font-normal leading-snug"
                style={{ color: 'var(--text-primary)' }}
              >
                Heutiger Lernplan
              </h2>
              <div className="flex items-center gap-3.5">
                <span
                  className="font-mono-num text-[12px]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {metrics.doneTodayTasks} / {metrics.todayPlanTasks.length}
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate('focus')}
                  className="inline-flex items-center gap-1 text-[13px] font-medium cursor-pointer transition-colors hover:text-[var(--accent)]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <span>Planer</span>
                  <ArrowRight size={13} strokeWidth={1.5} />
                </button>
              </div>
            </div>

            {/* Subtle Warm-Orange Progress Line */}
            <div
              className="mt-3 h-[2px] w-full overflow-hidden rounded-full"
              style={{ backgroundColor: 'var(--border-hairline)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${metrics.todayPlanPercent}%`,
                  backgroundColor: 'var(--accent-warm)',
                }}
              />
            </div>

            {state.dailyPlan.length === 0 ? (
              <div
                className="py-7 border-b text-left space-y-3"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <p className="text-[14px]" style={{ color: 'var(--text-secondary)' }}>
                  Noch keine Lernblöcke für heute geplant.
                </p>
                <button
                  type="button"
                  onClick={() => onNavigate('focus')}
                  className="btn-secondary"
                >
                  <span>Tagesplan erstellen</span>
                </button>
              </div>
            ) : (
              <div>
                {metrics.todayPlanTasks.map((task) => {
                  const course = courseMap.get(task.courseId);
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => onTogglePlanTask(task.id)}
                      className="w-full flex items-start gap-3.5 border-b py-3.5 px-1.5 text-left cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/35"
                      style={{ borderColor: 'var(--border-hairline)' }}
                    >
                      <span
                        className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors"
                        style={{
                          backgroundColor: task.done ? 'var(--accent)' : 'transparent',
                          borderColor: task.done ? 'var(--accent)' : 'var(--border-strong)',
                          color: 'var(--accent-ink)',
                        }}
                      >
                        {task.done && <Check size={11} strokeWidth={2.2} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p
                          className={`text-[14.5px] font-medium leading-snug ${
                            task.done ? 'line-through' : ''
                          }`}
                          style={{
                            color: task.done ? 'var(--text-muted)' : 'var(--text-primary)',
                          }}
                        >
                          {task.title}
                        </p>
                        {course && (
                          <div
                            className="mt-1 flex items-center gap-1.5 text-[12.5px]"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <span
                              className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: course.accentColor }}
                            />
                            <span className="truncate">{course.title}</span>
                          </div>
                        )}
                      </div>
                      <span
                        className="font-mono-num shrink-0 pt-0.5 text-[12.5px]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {task.minutes} Min
                      </span>
                    </button>
                  );
                })}

                {upcomingPlanTasks.length > 0 && (
                  <div className="pt-6">
                    <div
                      className="pb-1.5 text-[12px] font-medium"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Ausblick
                    </div>
                    <div>
                      {upcomingPlanTasks.slice(0, 3).map((task) => {
                        const course = courseMap.get(task.courseId);
                        return (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => onTogglePlanTask(task.id)}
                            className="w-full flex items-center gap-3 border-b py-2.5 px-1.5 text-left cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/30"
                            style={{ borderColor: 'var(--border-hairline)' }}
                          >
                            <span
                              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors"
                              style={{
                                backgroundColor: task.done ? 'var(--accent)' : 'transparent',
                                borderColor: task.done
                                  ? 'var(--accent)'
                                  : 'var(--border-strong)',
                                color: 'var(--accent-ink)',
                              }}
                            >
                              {task.done && <Check size={10} strokeWidth={2.2} />}
                            </span>
                            <span
                              className={`min-w-0 flex-1 truncate text-[13.5px] ${
                                task.done ? 'line-through' : ''
                              }`}
                              style={{
                                color: task.done
                                  ? 'var(--text-muted)'
                                  : 'var(--text-secondary)',
                              }}
                            >
                              {task.title}
                            </span>
                            {course && (
                              <span
                                className="hidden h-1.5 w-1.5 rounded-full shrink-0 sm:inline-block"
                                style={{ backgroundColor: course.accentColor }}
                              />
                            )}
                            <span
                              className="text-[12px] shrink-0"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {task.scheduledFor}
                            </span>
                            <span
                              className="font-mono-num text-[12px] shrink-0"
                              style={{ color: 'var(--text-muted)' }}
                            >
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
          <section aria-labelledby="heading-courses">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2
                id="heading-courses"
                className="font-display text-[22px] font-normal leading-snug"
                style={{ color: 'var(--text-primary)' }}
              >
                Fächer & Lernziele
              </h2>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setExpandAllCourses((prev) => !prev)}
                  className="text-[12.5px] font-medium cursor-pointer transition-colors hover:text-[var(--text-primary)]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {expandAllCourses ? 'Kompakt' : 'Alle öffnen'}
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('notes')}
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium cursor-pointer transition-colors hover:text-[var(--accent)]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <BookOpen size={13} strokeWidth={1.5} />
                  <span>Notizen</span>
                </button>
              </div>
            </div>

            <div
              className="mt-3 border-t"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              {state.courses.map((course) => {
                const isActive = course.id === activeCourse?.id;
                const isExpanded = isActive || expandAllCourses;
                const masteredCount = course.objectives.filter(
                  (o) => o.mastery === 'mastered'
                ).length;
                const totalCount = course.objectives.length;

                return (
                  <div
                    key={course.id}
                    className="border-b"
                    style={{ borderColor: 'var(--border-hairline)' }}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectCourse(course.id)}
                      aria-expanded={isExpanded}
                      className="w-full flex items-center justify-between gap-4 py-4 px-1.5 text-left cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/30"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span
                          className="shrink-0 flex items-center"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {isExpanded ? (
                            <ChevronDown size={15} strokeWidth={1.5} />
                          ) : (
                            <ChevronRight size={15} strokeWidth={1.5} />
                          )}
                        </span>
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: course.accentColor }}
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span
                              className="truncate text-[15px] font-medium"
                              style={{
                                color: isActive
                                  ? 'var(--text-primary)'
                                  : 'var(--text-secondary)',
                              }}
                            >
                              {course.title}
                            </span>
                            {isActive && (
                              <span
                                className="text-[12px] font-medium"
                                style={{ color: 'var(--accent)' }}
                              >
                                Aktiv
                              </span>
                            )}
                          </div>
                          {!isExpanded && (
                            <p
                              className="mt-0.5 truncate text-[12.5px]"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {course.description}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-4">
                        {course.examDate && (
                          <span
                            className="hidden font-mono-num text-[12px] sm:inline-block"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {formatShortDate(course.examDate)}
                          </span>
                        )}
                        <span
                          className="font-mono-num text-[12.5px]"
                          style={{
                            color:
                              masteredCount === totalCount && totalCount > 0
                                ? 'var(--positive)'
                                : 'var(--text-secondary)',
                          }}
                        >
                          {masteredCount} / {totalCount}
                        </span>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="pb-4 pl-7 pr-1">
                        <p
                          className="text-[13px] leading-relaxed mb-3"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {course.description}
                        </p>
                        <div>
                          {course.objectives.map((obj) => {
                            const meta = MASTERY_META[obj.mastery];
                            const nextState = MASTERY_CYCLE[obj.mastery];
                            return (
                              <div
                                key={obj.id}
                                className="flex items-start gap-3 border-t py-3 first:border-t-0"
                                style={{ borderColor: 'var(--border-hairline)' }}
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    onSetObjectiveMastery(course.id, obj.id, nextState)
                                  }
                                  title={`Status ändern zu: ${MASTERY_META[nextState].label}`}
                                  aria-label={`Lernziel ${obj.title}: aktuell ${meta.label}, klicken für ${MASTERY_META[nextState].label}`}
                                  className="mt-0.5 flex shrink-0 items-center justify-center rounded-full transition-transform active:scale-95 cursor-pointer"
                                  style={{ color: meta.color }}
                                >
                                  {obj.mastery === 'mastered' && (
                                    <CheckCircle2 size={17} strokeWidth={1.5} />
                                  )}
                                  {obj.mastery === 'practicing' && (
                                    <CircleDot size={17} strokeWidth={1.5} />
                                  )}
                                  {obj.mastery === 'open' && (
                                    <Circle size={17} strokeWidth={1.5} />
                                  )}
                                </button>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-baseline justify-between gap-3">
                                    <span
                                      className="text-[14px] font-medium leading-snug"
                                      style={{ color: 'var(--text-primary)' }}
                                    >
                                      {obj.title}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onSetObjectiveMastery(course.id, obj.id, nextState)
                                      }
                                      className="shrink-0 text-[12px] font-medium cursor-pointer transition-opacity hover:underline"
                                      style={{ color: meta.color }}
                                    >
                                      {meta.label}
                                    </button>
                                  </div>
                                  <p
                                    className="mt-1 text-[12.5px] leading-relaxed"
                                    style={{ color: 'var(--text-secondary)' }}
                                  >
                                    {obj.summary}
                                  </p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        {/* Right Calm Paper Column (5 cols) */}
        <div className="xl:col-span-5 space-y-9">
          {/* Nächste Prüfungen — Single Quiet Surface Card */}
          <section className="surface-card p-6" aria-labelledby="heading-exams">
            <div className="flex items-baseline justify-between gap-3">
              <h2
                id="heading-exams"
                className="font-display text-[21px] font-normal leading-snug"
                style={{ color: 'var(--text-primary)' }}
              >
                Nächste Prüfungen
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('calendar')}
                className="inline-flex items-center gap-1 text-[12.5px] font-medium cursor-pointer transition-colors hover:text-[var(--accent)]"
                style={{ color: 'var(--text-secondary)' }}
              >
                <span>Kalender</span>
                <ArrowRight size={13} strokeWidth={1.5} />
              </button>
            </div>

            {sortedSchedule.length === 0 ? (
              <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-hairline)' }}>
                <p className="text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>
                  Noch keine Prüfungstermine eingetragen.
                </p>
                <button
                  type="button"
                  onClick={() => onNavigate('import')}
                  className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium cursor-pointer hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  <span>Termine importieren</span>
                  <ArrowRight size={13} strokeWidth={1.5} />
                </button>
              </div>
            ) : (
              <div className="mt-4">
                {sortedSchedule.slice(0, 5).map((item) => {
                  const countdown = getDaysUntilLabel(item.date);
                  return (
                    <div
                      key={item.id}
                      className="border-t py-3.5 first:pt-3.5 last:pb-0 flex items-start justify-between gap-4"
                      style={{ borderColor: 'var(--border-hairline)' }}
                    >
                      <div className="min-w-0">
                        <p
                          className="text-[14px] font-medium leading-snug"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {item.title}
                        </p>
                        <div
                          className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          <span>{item.courseTitle}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono-num">
                            {formatShortDate(item.date)}
                          </span>
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
                        </div>
                      </div>
                      <span
                        className="shrink-0 inline-flex items-center gap-1.5 font-mono-num text-[12px] pt-0.5"
                        style={{
                          color: countdown.urgent
                            ? 'var(--accent-warm)'
                            : 'var(--text-secondary)',
                          fontWeight: countdown.urgent ? 500 : 400,
                        }}
                      >
                        {countdown.urgent && (
                          <span
                            className="h-1.5 w-1.5 rounded-full shrink-0"
                            style={{ backgroundColor: 'var(--accent-warm)' }}
                            aria-hidden="true"
                          />
                        )}
                        <span>{countdown.label}</span>
                      </span>
                    </div>
                  );
                })}
                {sortedSchedule.length > 5 && (
                  <div
                    className="border-t mt-3 pt-3"
                    style={{ borderColor: 'var(--border-hairline)' }}
                  >
                    <button
                      type="button"
                      onClick={() => onNavigate('calendar')}
                      className="inline-flex items-center gap-1 text-[12.5px] font-medium cursor-pointer transition-colors hover:underline"
                      style={{ color: 'var(--accent)' }}
                    >
                      <span>Alle {sortedSchedule.length} Termine im Kalender</span>
                      <ArrowRight size={13} strokeWidth={1.5} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Sprechen & Vertiefen — Open Hairline Section */}
          <section className="px-1" aria-labelledby="heading-voice-quick">
            <div className="flex items-baseline justify-between gap-3">
              <h2
                id="heading-voice-quick"
                className="font-display text-[21px] font-normal leading-snug"
                style={{ color: 'var(--text-primary)' }}
              >
                Sprechen & Vertiefen
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('languages')}
                className="inline-flex items-center gap-1 text-[12.5px] font-medium cursor-pointer transition-colors hover:text-[var(--accent)]"
                style={{ color: 'var(--text-secondary)' }}
              >
                <span>Sprachstudio</span>
                <ArrowRight size={13} strokeWidth={1.5} />
              </button>
            </div>
            <p
              className="mt-1 text-[13px] leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              Direkt im Gespräch zum aktiven Fach oder im geschützten Sprachmodus.
            </p>

            <div
              className="mt-4 border-t"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <button
                type="button"
                onClick={() => onNavigate('teacher')}
                className="w-full flex items-center justify-between gap-3 border-b py-3.5 px-1.5 text-left cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/35 group"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <MonitorPlay
                    size={16}
                    strokeWidth={1.5}
                    className="mt-0.5 shrink-0"
                    style={{ color: 'var(--accent-warm)' }}
                  />
                  <div className="min-w-0">
                    <div
                      className="text-[14px] font-medium"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Bildschirm-Lehrer starten
                    </div>
                    <div
                      className="text-[12.5px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Erklärt dir live Aufgaben in anderen Apps — auch im schwebenden Fenster
                    </div>
                  </div>
                </div>
                <ArrowRight
                  size={14}
                  strokeWidth={1.5}
                  className="shrink-0 transition-transform group-hover:translate-x-0.5"
                  style={{ color: 'var(--text-muted)' }}
                />
              </button>

              <button
                type="button"
                onClick={() => onOpenVoiceTutor({ mode: 'explain' })}
                className="w-full flex items-center justify-between gap-3 border-b py-3.5 px-1.5 text-left cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/35 group"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <BookOpen
                    size={16}
                    strokeWidth={1.5}
                    className="mt-0.5 shrink-0"
                    style={{ color: 'var(--accent)' }}
                  />
                  <div className="min-w-0">
                    <div
                      className="text-[14px] font-medium"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Thema erklären lassen
                    </div>
                    <div
                      className="text-[12.5px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Schrittweise mit Rückfragen verstehen
                    </div>
                  </div>
                </div>
                <ArrowRight
                  size={14}
                  strokeWidth={1.5}
                  className="shrink-0 transition-transform group-hover:translate-x-0.5"
                  style={{ color: 'var(--text-muted)' }}
                />
              </button>

              <button
                type="button"
                onClick={() => onOpenVoiceTutor({ mode: 'exam' })}
                className="w-full flex items-center justify-between gap-3 border-b py-3.5 px-1.5 text-left cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/35 group"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <GraduationCap
                    size={16}
                    strokeWidth={1.5}
                    className="mt-0.5 shrink-0"
                    style={{ color: 'var(--accent-warm)' }}
                  />
                  <div className="min-w-0">
                    <div
                      className="text-[14px] font-medium"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Mündliche Prüfung üben
                    </div>
                    <div
                      className="text-[12.5px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Realistische Fragen mit kurzem Feedback
                    </div>
                  </div>
                </div>
                <ArrowRight
                  size={14}
                  strokeWidth={1.5}
                  className="shrink-0 transition-transform group-hover:translate-x-0.5"
                  style={{ color: 'var(--text-muted)' }}
                />
              </button>

              <button
                type="button"
                onClick={() =>
                  onOpenVoiceTutor({ mode: 'language', language: state.voice.languageLock })
                }
                className="w-full flex items-center justify-between gap-3 border-b py-3.5 px-1.5 text-left cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/35 group"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <MessageCircle
                    size={16}
                    strokeWidth={1.5}
                    className="mt-0.5 shrink-0"
                    style={{ color: 'var(--accent)' }}
                  />
                  <div className="min-w-0">
                    <div
                      className="text-[14px] font-medium"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Freie Konversation
                    </div>
                    <div
                      className="text-[12.5px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Flüssig sprechen im gewählten Sprachmodus
                    </div>
                  </div>
                </div>
                <ArrowRight
                  size={14}
                  strokeWidth={1.5}
                  className="shrink-0 transition-transform group-hover:translate-x-0.5"
                  style={{ color: 'var(--text-muted)' }}
                />
              </button>
            </div>

            {/* Compact 5-Language Row */}
            <div className="mt-5">
              <div
                className="mb-2.5 text-[12px]"
                style={{ color: 'var(--text-muted)' }}
              >
                Sprachmodus direkt öffnen
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {QUICK_LANGUAGES.map((lang) => {
                  const locked = state.voice.languageLock === lang.code;
                  return (
                    <button
                      key={lang.code}
                      type="button"
                      onClick={() =>
                        onOpenVoiceTutor({ mode: 'language', language: lang.code })
                      }
                      title={`${lang.label} im Sprachtutor starten`}
                      aria-label={`${lang.label} im Sprachtutor starten`}
                      className="h-8 px-3 rounded-full border font-mono-num text-[12px] font-medium cursor-pointer transition-colors hover:border-[var(--border-strong)]"
                      style={{
                        backgroundColor: locked ? 'var(--accent-soft)' : 'transparent',
                        borderColor: locked
                          ? 'var(--accent-border)'
                          : 'var(--border-hairline)',
                        color: locked ? 'var(--accent)' : 'var(--text-secondary)',
                      }}
                    >
                      {lang.short}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
