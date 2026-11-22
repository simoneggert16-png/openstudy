import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { DailyPlanTask, FocusSessionLog, OpenStudyState } from '../types';
import { checkLocalBridge } from '../services/providers';

export interface FocusPlannerViewProps {
  state: OpenStudyState;
  onTogglePlanTask: (taskId: string) => void;
  onAddPlanTasks: (tasks: DailyPlanTask[]) => void;
  onSetDailyGoalMinutes: (minutes: number) => void;
  onLogFocusSession: (log: FocusSessionLog) => void;
}

type TimerPhase = 'focus' | 'break';

const FOCUS_PRESETS = [
  { minutes: 15, label: '15 Min', detail: 'Sprint' },
  { minutes: 25, label: '25 Min', detail: 'Pomodoro' },
  { minutes: 45, label: '45 Min', detail: 'Deep Work' },
  { minutes: 60, label: '60 Min', detail: 'Fokus' },
];

const BREAK_PRESETS = [
  { minutes: 5, label: '5 Min', detail: 'Kurz' },
  { minutes: 10, label: '10 Min', detail: 'Erholung' },
  { minutes: 15, label: '15 Min', detail: 'Lang' },
];

const GOAL_QUICK_STEPS = [20, 30, 45, 60, 90, 120];

function playGentleChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const notes = [523.25, 659.25]; // C5 -> E5 soft interval
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.22);

      gain.gain.setValueAtTime(0.0001, now + idx * 0.22);
      gain.gain.linearRampToValueAtTime(0.12, now + idx * 0.22 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.22 + 0.9);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.22);
      osc.stop(now + idx * 0.22 + 0.95);
    });

    window.setTimeout(() => {
      ctx.close().catch(() => {});
    }, 1500);
  } catch {
    // Web Audio may be restricted if no interaction occurred
  }
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getLocalTodayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const FocusPlannerView: React.FC<FocusPlannerViewProps> = ({
  state,
  onTogglePlanTask,
  onAddPlanTasks,
  onSetDailyGoalMinutes,
  onLogFocusSession,
}) => {
  const [timerPhase, setTimerPhase] = useState<TimerPhase>('focus');
  const [presetMinutes, setPresetMinutes] = useState<number>(25);
  const [secondsLeft, setSecondsLeft] = useState<number>(25 * 60);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [selectedCourseId, setSelectedCourseId] = useState<string>(
    state.activeCourseId || state.courses[0]?.id || ''
  );
  const [sessionLabel, setSessionLabel] = useState<string>('');
  const [completionNotice, setCompletionNotice] = useState<string | null>(null);

  // New custom plan task state
  const [newTaskTitle, setNewTaskTitle] = useState<string>('');
  const [newTaskCourseId, setNewTaskCourseId] = useState<string>(
    state.activeCourseId || state.courses[0]?.id || ''
  );
  const [newTaskMinutes, setNewTaskMinutes] = useState<number>(15);
  const [newTaskDay, setNewTaskDay] = useState<'Heute' | 'Morgen'>('Heute');
  const [generatorMessage, setGeneratorMessage] = useState<string | null>(null);

  // Local bridge reminder check
  const [reminderTime, setReminderTime] = useState<string>('17:30');
  const [bridgeStatus, setBridgeStatus] = useState<'idle' | 'checking' | 'online' | 'offline'>('idle');
  const [copiedCommand, setCopiedCommand] = useState<boolean>(false);
  const [showBridgeSetup, setShowBridgeSetup] = useState<boolean>(false);

  const completedRef = useRef<boolean>(false);

  const courseMap = useMemo(() => {
    const map = new Map<string, { title: string; accentColor: string }>();
    for (const c of state.courses) {
      map.set(c.id, { title: c.title, accentColor: c.accentColor });
    }
    return map;
  }, [state.courses]);

  const handleTimerComplete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    setIsRunning(false);

    if (soundEnabled) {
      playGentleChime();
    }

    if (timerPhase === 'break') {
      setCompletionNotice(
        `Pause (${presetMinutes} Min) abgeschlossen — bereit für den nächsten Fokus-Block.`
      );
      return;
    }

    const activeCourse = state.courses.find((c) => c.id === selectedCourseId);
    const label =
      sessionLabel.trim() ||
      (activeCourse ? `${activeCourse.title} — Fokus-Einheit` : 'Fokus-Einheit');

    onLogFocusSession({
      id: `fl-${Date.now()}`,
      courseId: selectedCourseId || state.courses[0]?.id || 'general',
      minutes: presetMinutes,
      completedAt: new Date().toISOString(),
      label,
    });

    setCompletionNotice(`${presetMinutes} Minuten für «${label}» protokolliert.`);
    setSessionLabel('');
  }, [
    soundEnabled,
    timerPhase,
    state.courses,
    selectedCourseId,
    sessionLabel,
    presetMinutes,
    onLogFocusSession,
  ]);

  useEffect(() => {
    if (!isRunning) return;
    const intervalId = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          window.clearInterval(intervalId);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isRunning]);

  useEffect(() => {
    if (secondsLeft === 0 && isRunning) {
      handleTimerComplete();
    }
  }, [secondsLeft, isRunning, handleTimerComplete]);

  const selectPhase = (phase: TimerPhase) => {
    if (phase === timerPhase) return;
    const defaultMins = phase === 'focus' ? 25 : 5;
    setIsRunning(false);
    completedRef.current = false;
    setTimerPhase(phase);
    setPresetMinutes(defaultMins);
    setSecondsLeft(defaultMins * 60);
    setCompletionNotice(null);
  };

  const selectPreset = (mins: number) => {
    setIsRunning(false);
    completedRef.current = false;
    setPresetMinutes(mins);
    setSecondsLeft(mins * 60);
    setCompletionNotice(null);
  };

  const handleToggleRun = () => {
    if (secondsLeft === 0) {
      completedRef.current = false;
      setSecondsLeft(presetMinutes * 60);
      setCompletionNotice(null);
      setIsRunning(true);
      return;
    }
    completedRef.current = false;
    setIsRunning((prev) => !prev);
  };

  const handleReset = () => {
    setIsRunning(false);
    completedRef.current = false;
    setSecondsLeft(presetMinutes * 60);
    setCompletionNotice(null);
  };

  const activePresets = timerPhase === 'focus' ? FOCUS_PRESETS : BREAK_PRESETS;
  const totalSeconds = presetMinutes * 60;
  const elapsedFraction = totalSeconds > 0 ? (totalSeconds - secondsLeft) / totalSeconds : 0;
  const ringRadius = 104;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - elapsedFraction);
  const activeRingStroke = timerPhase === 'focus' ? 'var(--accent-warm)' : 'var(--accent)';

  const todayStats = useMemo(() => {
    const todayIso = getLocalTodayIso();
    const loggedMinutes = state.focusLogs
      .filter((l) => l.completedAt.slice(0, 10) === todayIso)
      .reduce((acc, l) => acc + l.minutes, 0);

    const todayTasks = state.dailyPlan.filter((t) => t.scheduledFor === 'Heute');
    const tomorrowTasks = state.dailyPlan.filter((t) => t.scheduledFor !== 'Heute');
    const plannedTodayMinutes = todayTasks.reduce((acc, t) => acc + t.minutes, 0);
    const doneTodayMinutes = todayTasks
      .filter((t) => t.done)
      .reduce((acc, t) => acc + t.minutes, 0);

    const effectiveCompleted = loggedMinutes + doneTodayMinutes;
    const progressPct =
      state.dailyGoalMinutes > 0
        ? Math.min(100, Math.round((effectiveCompleted / state.dailyGoalMinutes) * 100))
        : 0;

    return {
      loggedMinutes,
      todayTasks,
      tomorrowTasks,
      plannedTodayMinutes,
      doneTodayMinutes,
      effectiveCompleted,
      progressPct,
    };
  }, [state.focusLogs, state.dailyPlan, state.dailyGoalMinutes]);

  const handleAddCustomTask = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newTaskTitle.trim();
    if (!trimmed) return;
    const newTask: DailyPlanTask = {
      id: `dp-${Date.now()}`,
      courseId: newTaskCourseId || state.courses[0]?.id || 'general',
      title: trimmed,
      minutes: newTaskMinutes,
      done: false,
      scheduledFor: newTaskDay,
    };
    onAddPlanTasks([newTask]);
    setNewTaskTitle('');
    setGeneratorMessage(null);
  };

  const handleAutoGeneratePlan = () => {
    const existingPendingTitles = new Set(
      state.dailyPlan.filter((t) => !t.done).map((t) => t.title.toLowerCase())
    );

    // Gather non-mastered objectives sorted by exam date and mastery priority (open before practicing)
    const candidates: {
      courseId: string;
      courseTitle: string;
      examDate: string;
      objectiveTitle: string;
      mastery: 'open' | 'practicing';
    }[] = [];

    for (const course of state.courses) {
      for (const obj of course.objectives) {
        if (obj.mastery !== 'mastered') {
          candidates.push({
            courseId: course.id,
            courseTitle: course.title,
            examDate: course.examDate || '9999-12-31',
            objectiveTitle: obj.title,
            mastery: obj.mastery,
          });
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.mastery !== b.mastery) {
        return a.mastery === 'open' ? -1 : 1;
      }
      return a.examDate.localeCompare(b.examDate);
    });

    const generated: DailyPlanTask[] = [];
    const remainingTodayBudget = Math.max(
      15,
      state.dailyGoalMinutes - todayStats.plannedTodayMinutes
    );
    let allocatedToday = 0;
    const baseId = Date.now();

    for (const item of candidates) {
      const duration = item.mastery === 'open' ? 15 : 10;
      const prefix = item.mastery === 'open' ? 'Erarbeiten' : 'Vertiefen';
      const title = `${prefix}: ${item.objectiveTitle}`;

      if (existingPendingTitles.has(title.toLowerCase())) continue;

      if (allocatedToday + duration <= remainingTodayBudget && generated.length < 4) {
        generated.push({
          id: `dp-auto-${baseId}-${generated.length}`,
          courseId: item.courseId,
          title,
          minutes: duration,
          done: false,
          scheduledFor: 'Heute',
        });
        allocatedToday += duration;
      } else if (generated.length < 5) {
        generated.push({
          id: `dp-auto-${baseId}-${generated.length}`,
          courseId: item.courseId,
          title,
          minutes: Math.min(20, duration + 5),
          done: false,
          scheduledFor: 'Morgen',
        });
      }
    }

    // Fallback: if all objectives already scheduled or mastered, create a balanced due-card review block
    if (generated.length === 0) {
      const activeCourseId = state.activeCourseId || state.courses[0]?.id || 'general';
      const activeCourseTitle = courseMap.get(activeCourseId)?.title || 'Aktives Fach';
      generated.push({
        id: `dp-auto-${baseId}-review`,
        courseId: activeCourseId,
        title: `Wiederholung & Karteikarten: ${activeCourseTitle}`,
        minutes: 15,
        done: false,
        scheduledFor: 'Heute',
      });
    }

    onAddPlanTasks(generated);
    setGeneratorMessage(
      `${generated.length} ausgewogene Lernblöcke wurden aus deinen offenen Lernzielen erstellt.`
    );
  };

  const handleCheckBridge = async () => {
    setBridgeStatus('checking');
    const result = await checkLocalBridge(state.provider.bridgeUrl);
    setBridgeStatus(result.online ? 'online' : 'offline');
  };

  const handleCopyBridgeCommand = async () => {
    try {
      await navigator.clipboard.writeText('npm run bridge');
      setCopiedCommand(true);
      window.setTimeout(() => setCopiedCommand(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10 animate-enter">
      {/* Header */}
      <header
        className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-end sm:justify-between"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div>
          <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            Ruhige Zeiteinheiten und realistische Tagesplanung
          </p>
          <h1
            className="font-display font-normal mt-1 text-[30px] sm:text-[34px] leading-[1.15]"
            style={{ color: 'var(--text-primary)' }}
          >
            Fokus & Lernplaner
          </h1>
        </div>
        <div className="flex items-center gap-2.5 text-[13px]">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{
              backgroundColor:
                todayStats.effectiveCompleted > 0 ? 'var(--accent-warm)' : 'var(--border-strong)',
            }}
          />
          <span style={{ color: 'var(--text-secondary)' }}>Heute erreicht</span>
          <span className="font-mono-num font-semibold" style={{ color: 'var(--text-primary)' }}>
            {todayStats.effectiveCompleted} / {state.dailyGoalMinutes} Min
          </span>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Left: Focus Timer */}
        <div className="space-y-6 xl:col-span-5">
          <section className="surface-card p-6">
            <div className="flex items-center justify-between gap-2">
              <h2
                className="font-display font-normal text-[21px] leading-snug"
                style={{ color: 'var(--text-primary)' }}
              >
                Fokus-Timer
              </h2>
              <button
                type="button"
                onClick={() => setSoundEnabled((prev) => !prev)}
                className="btn-ghost"
                title={soundEnabled ? 'Abschlusston ausschalten' : 'Abschlusston einschalten'}
              >
                {soundEnabled ? (
                  <Volume2 size={15} strokeWidth={1.5} />
                ) : (
                  <VolumeX size={15} strokeWidth={1.5} />
                )}
                <span>{soundEnabled ? 'Ton ein' : 'Ton aus'}</span>
              </button>
            </div>

            {/* Phase Switcher: Fokus vs. Pause */}
            <div
              className="mt-4 flex items-center gap-6 border-b"
              style={{ borderColor: 'var(--border-hairline)' }}
              role="tablist"
              aria-label="Timer-Phase"
            >
              <button
                type="button"
                role="tab"
                aria-selected={timerPhase === 'focus'}
                onClick={() => selectPhase('focus')}
                className="relative pb-2.5 text-[13.5px] font-medium transition-colors cursor-pointer"
                style={{
                  color: timerPhase === 'focus' ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                <span className="inline-flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor:
                        timerPhase === 'focus' ? 'var(--accent-warm)' : 'transparent',
                    }}
                  />
                  Fokus
                </span>
                {timerPhase === 'focus' && (
                  <span
                    className="absolute inset-x-0 -bottom-px h-[2px] rounded-full"
                    style={{ backgroundColor: 'var(--accent-warm)' }}
                  />
                )}
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={timerPhase === 'break'}
                onClick={() => selectPhase('break')}
                className="relative pb-2.5 text-[13.5px] font-medium transition-colors cursor-pointer"
                style={{
                  color: timerPhase === 'break' ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                <span className="inline-flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor: timerPhase === 'break' ? 'var(--accent)' : 'transparent',
                    }}
                  />
                  Pause
                </span>
                {timerPhase === 'break' && (
                  <span
                    className="absolute inset-x-0 -bottom-px h-[2px] rounded-full"
                    style={{ backgroundColor: 'var(--accent)' }}
                  />
                )}
              </button>
            </div>

            {/* Presets */}
            <div className="mt-4 flex flex-wrap gap-2">
              {activePresets.map((preset) => {
                const active = presetMinutes === preset.minutes;
                const activeBg =
                  timerPhase === 'focus' ? 'var(--accent-warm-soft)' : 'var(--accent-soft)';
                const activeBorder =
                  timerPhase === 'focus' ? 'var(--accent-warm-border)' : 'var(--accent-border)';
                const activeColor =
                  timerPhase === 'focus' ? 'var(--accent-warm)' : 'var(--accent)';
                return (
                  <button
                    key={preset.minutes}
                    type="button"
                    onClick={() => selectPreset(preset.minutes)}
                    className="rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors cursor-pointer"
                    style={{
                      backgroundColor: active ? activeBg : 'transparent',
                      borderColor: active ? activeBorder : 'var(--border-hairline)',
                      color: active ? activeColor : 'var(--text-secondary)',
                    }}
                  >
                    <span className="font-mono-num">{preset.label}</span>
                    <span className="ml-1 opacity-75">· {preset.detail}</span>
                  </button>
                );
              })}
            </div>

            {/* SVG Progress Ring */}
            <div className="my-8 flex flex-col items-center justify-center">
              <div className="relative flex h-64 w-64 items-center justify-center sm:h-[272px] sm:w-[272px]">
                <svg className="h-full w-full -rotate-90" viewBox="0 0 240 240" aria-hidden="true">
                  <circle
                    cx="120"
                    cy="120"
                    r={ringRadius}
                    fill="none"
                    stroke="var(--bg-raised)"
                    strokeWidth="7"
                  />
                  <circle
                    cx="120"
                    cy="120"
                    r={ringRadius}
                    fill="none"
                    stroke={activeRingStroke}
                    strokeWidth="7"
                    strokeLinecap="round"
                    strokeDasharray={ringCircumference}
                    strokeDashoffset={ringOffset}
                    style={{ transition: 'stroke-dashoffset 400ms var(--ease), stroke 220ms var(--ease)' }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
                  <span
                    className="font-mono-num text-[52px] sm:text-[60px] font-normal tracking-[-0.03em] leading-none"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {formatClock(secondsLeft)}
                  </span>
                  <span
                    className="mt-3 inline-flex items-center gap-1.5 text-[12.5px]"
                    style={{ color: isRunning ? activeRingStroke : 'var(--text-muted)' }}
                  >
                    {isRunning && (
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: activeRingStroke }}
                      />
                    )}
                    {isRunning
                      ? timerPhase === 'focus'
                        ? 'Fokus läuft'
                        : 'Pause läuft'
                      : secondsLeft === 0
                      ? 'Abgeschlossen'
                      : timerPhase === 'focus'
                      ? 'Bereit für Fokus'
                      : 'Bereit für Pause'}
                  </span>
                </div>
              </div>

              {/* Controls */}
              <div className="mt-6 flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleToggleRun}
                  className={timerPhase === 'focus' ? 'btn-primary min-w-[140px]' : 'btn-accent min-w-[140px]'}
                >
                  {isRunning ? (
                    <>
                      <Pause size={16} strokeWidth={1.5} />
                      <span>Pausieren</span>
                    </>
                  ) : (
                    <>
                      <Play size={16} strokeWidth={1.5} />
                      <span>{secondsLeft < totalSeconds && secondsLeft > 0 ? 'Fortsetzen' : 'Starten'}</span>
                    </>
                  )}
                </button>
                <button type="button" onClick={handleReset} className="btn-secondary">
                  <RotateCcw size={15} strokeWidth={1.5} />
                  <span>Zurücksetzen</span>
                </button>
              </div>
            </div>

            {completionNotice && (
              <div
                className="mb-5 flex items-center gap-2.5 border-l-2 py-1 pl-3 text-[13px]"
                style={{
                  borderColor: timerPhase === 'focus' ? 'var(--positive)' : 'var(--accent)',
                  color: timerPhase === 'focus' ? 'var(--positive)' : 'var(--accent)',
                }}
              >
                <CheckCircle2 size={15} strokeWidth={1.5} className="shrink-0" />
                <span>{completionNotice}</span>
              </div>
            )}

            {/* Subject & Label */}
            <div className="space-y-3 border-t pt-5" style={{ borderColor: 'var(--border-hairline)' }}>
              <div>
                <label
                  htmlFor="focus-course-select"
                  className="mb-1.5 block text-[12px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Fach für diese Einheit
                </label>
                <select
                  id="focus-course-select"
                  value={selectedCourseId}
                  onChange={(e) => setSelectedCourseId(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-[14px]"
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
              <div>
                <label
                  htmlFor="focus-session-label"
                  className="mb-1.5 block text-[12px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Fokus-Thema (optional)
                </label>
                <input
                  id="focus-session-label"
                  type="text"
                  value={sessionLabel}
                  onChange={(e) => setSessionLabel(e.target.value)}
                  placeholder="Zum Beispiel: Kapitel 3 zusammenfassen"
                  className="w-full rounded-lg border px-3 py-2 text-[14px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
            </div>
          </section>

          {/* Recent Focus Logs */}
          <section className="surface-card p-6">
            <div className="flex items-baseline justify-between gap-2 pb-3 border-b" style={{ borderColor: 'var(--border-hairline)' }}>
              <h2
                className="font-display font-normal text-[21px] leading-snug"
                style={{ color: 'var(--text-primary)' }}
              >
                Letzte Fokus-Einheiten
              </h2>
              <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {state.focusLogs.reduce((s, l) => s + l.minutes, 0)} Min gesamt
              </span>
            </div>

            {state.focusLogs.length === 0 ? (
              <p className="mt-4 text-[13.5px]" style={{ color: 'var(--text-muted)' }}>
                Sobald ein Fokus-Timer abläuft, wird deine Einheit hier automatisch protokolliert.
              </p>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--border-hairline)' }}>
                {state.focusLogs.slice(0, 5).map((log) => {
                  const course = courseMap.get(log.courseId);
                  return (
                    <div
                      key={log.id}
                      className="flex items-center justify-between gap-3 py-3 first:pt-3.5 last:pb-0"
                      style={{ borderColor: 'var(--border-hairline)' }}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                          {log.label}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                          {course && (
                            <>
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: course.accentColor }}
                              />
                              <span className="truncate">{course.title}</span>
                              <span>·</span>
                            </>
                          )}
                          <span className="font-mono-num">{log.completedAt.slice(0, 10)}</span>
                        </div>
                      </div>
                      <span
                        className="font-mono-num shrink-0 text-[12.5px]"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {log.minutes} Min
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* Right: Daily Study Planner + Auto Generator + Local Reminders */}
        <div className="space-y-6 xl:col-span-7">
          {/* Daily Goal Configurator */}
          <section className="surface-card p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2
                  className="font-display font-normal text-[21px] leading-snug"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Tagesziel & Lernbudget
                </h2>
                <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  Wähle ein realistisches Tagespensum zwischen 15 und 120 Minuten.
                </p>
              </div>
              <span
                className="font-mono-num text-[16px] font-medium"
                style={{ color: 'var(--accent)' }}
              >
                {state.dailyGoalMinutes} Min / Tag
              </span>
            </div>

            <div className="mt-4">
              <input
                type="range"
                min={15}
                max={120}
                step={5}
                value={state.dailyGoalMinutes}
                onChange={(e) => onSetDailyGoalMinutes(Number(e.target.value))}
                aria-label="Tagesziel in Minuten"
                className="w-full cursor-pointer accent-[var(--accent)]"
              />
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {GOAL_QUICK_STEPS.map((step) => {
                  const selected = state.dailyGoalMinutes === step;
                  return (
                    <button
                      key={step}
                      type="button"
                      onClick={() => onSetDailyGoalMinutes(step)}
                      className="font-mono-num rounded-full border px-2.5 py-1 text-[12px] transition-colors cursor-pointer"
                      style={{
                        backgroundColor: selected ? 'var(--text-primary)' : 'transparent',
                        color: selected ? 'var(--bg-card)' : 'var(--text-secondary)',
                        borderColor: selected ? 'transparent' : 'var(--border-hairline)',
                      }}
                    >
                      {step} Min
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-5 flex items-center gap-3">
              <div
                className="h-1.5 flex-1 overflow-hidden rounded-full"
                style={{ backgroundColor: 'var(--bg-raised)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${todayStats.progressPct}%`,
                    backgroundColor:
                      todayStats.progressPct >= 100 ? 'var(--positive)' : 'var(--accent-warm)',
                  }}
                />
              </div>
              <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {todayStats.progressPct}%
              </span>
            </div>
          </section>

          {/* Daily Study Plan & Auto-Generator */}
          <section className="surface-card p-6">
            <div
              className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <div>
                <h2
                  className="font-display font-normal text-[21px] leading-snug"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Täglicher Lernplan
                </h2>
                <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  Geplant für heute: <span className="font-mono-num">{todayStats.plannedTodayMinutes} Min</span>
                </p>
              </div>
              <button
                type="button"
                onClick={handleAutoGeneratePlan}
                className="btn-accent"
              >
                <CalendarPlus size={15} strokeWidth={1.5} />
                <span>Tagesplan vorschlagen</span>
              </button>
            </div>

            {generatorMessage && (
              <div
                className="mt-4 flex items-center gap-2 border-l-2 py-1 pl-3 text-[13px]"
                style={{
                  borderColor: 'var(--accent)',
                  color: 'var(--accent)',
                }}
              >
                <CheckCircle2 size={15} strokeWidth={1.5} className="shrink-0" />
                <span>{generatorMessage}</span>
              </div>
            )}

            {/* Add custom task inline form (flat hairline row) */}
            <form
              onSubmit={handleAddCustomTask}
              className="mt-4 space-y-2 border-b pb-4"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  placeholder="Neuen Lernblock hinzufügen..."
                  className="h-9 flex-1 rounded-lg border px-3 text-[13.5px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
                <button
                  type="submit"
                  className="btn-primary h-9 shrink-0 px-4"
                  aria-label="Aufgabe hinzufügen"
                >
                  <Plus size={15} strokeWidth={1.5} />
                  <span>Hinzufügen</span>
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={newTaskCourseId}
                  onChange={(e) => setNewTaskCourseId(e.target.value)}
                  aria-label="Fach wählen"
                  className="h-8 min-w-0 flex-1 rounded-lg border px-2.5 text-[12.5px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {state.courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
                <select
                  value={newTaskMinutes}
                  onChange={(e) => setNewTaskMinutes(Number(e.target.value))}
                  aria-label="Dauer wählen"
                  className="h-8 w-24 shrink-0 rounded-lg border px-2 font-mono-num text-[12.5px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {[10, 15, 20, 30, 45].map((m) => (
                    <option key={m} value={m}>
                      {m} Min
                    </option>
                  ))}
                </select>
                <select
                  value={newTaskDay}
                  onChange={(e) => setNewTaskDay(e.target.value as 'Heute' | 'Morgen')}
                  aria-label="Tag wählen"
                  className="h-8 w-24 shrink-0 rounded-lg border px-2 text-[12.5px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <option value="Heute">Heute</option>
                  <option value="Morgen">Morgen</option>
                </select>
              </div>
            </form>

            {/* Task List: Today */}
            <div className="mt-4">
              <div
                className="flex items-center justify-between pb-2 text-[12px] font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                <span>Heute</span>
                <span className="font-mono-num">
                  {todayStats.todayTasks.filter((t) => t.done).length} / {todayStats.todayTasks.length}
                </span>
              </div>
              {todayStats.todayTasks.length === 0 ? (
                <p className="py-4 text-[13.5px]" style={{ color: 'var(--text-muted)' }}>
                  Noch keine Blöcke für heute. Erstelle oben einen Vorschlag aus deinen offenen Lernzielen oder füge einen eigenen Block hinzu.
                </p>
              ) : (
                <div className="divide-y" style={{ borderColor: 'var(--border-hairline)' }}>
                  {todayStats.todayTasks.map((task) => {
                    const course = courseMap.get(task.courseId);
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => onTogglePlanTask(task.id)}
                        className="flex w-full items-center gap-3 py-3 text-left transition-colors cursor-pointer hover:bg-[var(--bg-page)]/60 -mx-2 px-2 rounded-lg"
                        style={{ borderColor: 'var(--border-hairline)' }}
                      >
                        <span
                          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors"
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
                            className={`text-[14px] font-medium ${task.done ? 'line-through' : ''}`}
                            style={{ color: task.done ? 'var(--text-muted)' : 'var(--text-primary)' }}
                          >
                            {task.title}
                          </p>
                          {course && (
                            <p className="mt-0.5 flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: course.accentColor }}
                              />
                              <span className="truncate">{course.title}</span>
                            </p>
                          )}
                        </div>
                        <span
                          className="font-mono-num shrink-0 text-[12.5px]"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {task.minutes} Min
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Task List: Upcoming */}
            {todayStats.tomorrowTasks.length > 0 && (
              <div
                className="mt-5 border-t pt-4"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="pb-2 text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
                  Geplant für später
                </div>
                <div className="divide-y" style={{ borderColor: 'var(--border-hairline)' }}>
                  {todayStats.tomorrowTasks.map((task) => {
                    const course = courseMap.get(task.courseId);
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => onTogglePlanTask(task.id)}
                        className="flex w-full items-center gap-3 py-2.5 text-left transition-colors cursor-pointer hover:bg-[var(--bg-page)]/60 -mx-2 px-2 rounded-lg"
                        style={{ borderColor: 'var(--border-hairline)' }}
                      >
                        <span
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors"
                          style={{
                            backgroundColor: task.done ? 'var(--positive)' : 'transparent',
                            borderColor: task.done ? 'var(--positive)' : 'var(--border-strong)',
                            color: '#ffffff',
                          }}
                        >
                          {task.done && <Check size={11} strokeWidth={2} />}
                        </span>
                        <span
                          className={`min-w-0 flex-1 truncate text-[13.5px] ${task.done ? 'line-through' : ''}`}
                          style={{ color: task.done ? 'var(--text-muted)' : 'var(--text-primary)' }}
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
                        <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                          {task.minutes} Min
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          {/* Local Reminder Panel (calm, understated optional bridge) */}
          <section className="surface-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2
                  className="font-display font-normal text-[21px] leading-snug inline-flex items-center gap-2"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <Bell size={17} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                  Lokale Lernerinnerungen
                </h2>
                <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  Tägliche Lernimpulse lassen sich optional über die lokale Desktop-Bridge direkt auf deinem Gerät ausführen — ohne Cloud-Konto.
                </p>
              </div>
              <button
                type="button"
                onClick={handleCheckBridge}
                className="btn-secondary h-8 px-3 text-[13px]"
                disabled={bridgeStatus === 'checking'}
              >
                <RefreshCw
                  size={13}
                  strokeWidth={1.5}
                  className={bridgeStatus === 'checking' ? 'animate-spin' : ''}
                />
                <span>Status prüfen</span>
              </button>
            </div>

            <div
              className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t pt-4"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <div className="flex items-center gap-3">
                <label
                  htmlFor="local-reminder-time"
                  className="inline-flex items-center gap-1.5 text-[13px]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <Clock size={14} strokeWidth={1.5} />
                  <span>Bevorzugte Zeit</span>
                </label>
                <input
                  id="local-reminder-time"
                  type="time"
                  value={reminderTime}
                  onChange={(e) => setReminderTime(e.target.value)}
                  className="font-mono-num rounded-lg border px-2.5 py-1 text-[13px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="flex items-center gap-3">
                {bridgeStatus !== 'idle' && (
                  <span
                    className="inline-flex items-center gap-1.5 text-[12.5px] font-medium"
                    style={{
                      color:
                        bridgeStatus === 'online'
                          ? 'var(--positive)'
                          : bridgeStatus === 'offline'
                          ? 'var(--text-muted)'
                          : 'var(--accent)',
                    }}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        backgroundColor:
                          bridgeStatus === 'online'
                            ? 'var(--positive)'
                            : bridgeStatus === 'offline'
                            ? 'var(--border-strong)'
                            : 'var(--accent)',
                      }}
                    />
                    {bridgeStatus === 'checking' && 'Prüfe Verbindung...'}
                    {bridgeStatus === 'online' && 'Bridge aktiv'}
                    {bridgeStatus === 'offline' && 'Bridge inaktiv'}
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => setShowBridgeSetup((prev) => !prev)}
                  className="btn-ghost h-7 px-2 text-[12.5px]"
                >
                  <span>Optionale Einrichtung</span>
                  {showBridgeSetup ? (
                    <ChevronUp size={14} strokeWidth={1.5} />
                  ) : (
                    <ChevronDown size={14} strokeWidth={1.5} />
                  )}
                </button>
              </div>
            </div>

            {showBridgeSetup && (
              <div
                className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-[12.5px]"
                style={{ borderColor: 'var(--border-hairline)', color: 'var(--text-secondary)' }}
              >
                <div>
                  <span>Lokaler Endpunkt: </span>
                  <span className="font-mono-num" style={{ color: 'var(--text-primary)' }}>
                    {state.provider.bridgeUrl}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <code
                    className="font-mono-num text-[12px]"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    npm run bridge
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyBridgeCommand}
                    className="btn-ghost h-7 px-2 text-[12px]"
                  >
                    {copiedCommand ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />}
                    <span>{copiedCommand ? 'Kopiert' : 'Kopieren'}</span>
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
