import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  FolderInput,
  ListChecks,
  MapPin,
  Mic,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  DailyPlanTask,
  MainView,
  OpenStudyState,
  ScheduleItemCategory,
  SchoolScheduleItem,
  StudyLanguage,
  TutorMode,
} from '../types';

export interface CalendarViewProps {
  state: OpenStudyState;
  onAddScheduleItems: (items: SchoolScheduleItem[]) => void;
  onRemoveScheduleItem: (id: string) => void;
  onAddPlanTasks: (tasks: DailyPlanTask[]) => void;
  onNavigate: (view: MainView) => void;
  onOpenVoiceTutor: (opts?: { mode?: TutorMode; language?: StudyLanguage }) => void;
}

type CalendarMode = 'month' | 'week' | 'agenda';
type CategoryFilter = 'all' | ScheduleItemCategory;

interface CategoryMeta {
  label: string;
  filterLabel: string;
  dotColor: string;
  chipBg: string;
  chipBorder: string;
  chipText: string;
  priority: number;
}

const CATEGORY_META: Record<ScheduleItemCategory, CategoryMeta> = {
  exam: {
    label: 'Prüfung',
    filterLabel: 'Prüfungen',
    dotColor: 'var(--accent-warm)',
    chipBg: 'var(--accent-warm-soft)',
    chipBorder: 'var(--accent-warm-border)',
    chipText: 'var(--accent-warm)',
    priority: 0,
  },
  homework: {
    label: 'Aufgabe',
    filterLabel: 'Aufgaben',
    dotColor: 'var(--accent)',
    chipBg: 'var(--accent-soft)',
    chipBorder: 'var(--accent-border)',
    chipText: 'var(--accent)',
    priority: 1,
  },
  lesson: {
    label: 'Stunde',
    filterLabel: 'Stundenplan',
    dotColor: 'var(--text-muted)',
    chipBg: 'var(--bg-raised)',
    chipBorder: 'var(--border-hairline)',
    chipText: 'var(--text-secondary)',
    priority: 2,
  },
  event: {
    label: 'Termin',
    filterLabel: 'Termine',
    dotColor: 'var(--positive)',
    chipBg: 'var(--positive-soft)',
    chipBorder: 'var(--border-hairline)',
    chipText: 'var(--positive)',
    priority: 3,
  },
};

const CATEGORY_ORDER: ScheduleItemCategory[] = ['exam', 'homework', 'lesson', 'event'];

const SOURCE_LABELS: Record<SchoolScheduleItem['source'], string> = {
  'portal-sync': 'Portal-Sync',
  ics: 'Kalender',
  'smart-import': 'Import',
  manual: 'Manuell',
};

const WEEKDAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIsoDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function getLocalToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function getMondayOfWeek(date: Date): Date {
  const dayOfWeek = date.getDay(); // 0 = Sun, 1 = Mon, ...
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return addDays(date, offset);
}

function getIsoWeekNumber(date: Date): number {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function capitalizeFirst(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatMonthYear(date: Date): string {
  try {
    const raw = new Intl.DateTimeFormat('de-CH', {
      month: 'long',
      year: 'numeric',
    }).format(date);
    return capitalizeFirst(raw);
  } catch {
    return `${date.getMonth() + 1}.${date.getFullYear()}`;
  }
}

function formatShortMonth(date: Date): string {
  try {
    return new Intl.DateTimeFormat('de-CH', { month: 'short' })
      .format(date)
      .replace(/\.$/, '');
  } catch {
    return String(date.getMonth() + 1);
  }
}

function formatWeekRangeLabel(weekDays: { date: Date }[]): string {
  if (weekDays.length < 7) return '';
  const first = weekDays[0].date;
  const last = weekDays[6].date;
  const kw = getIsoWeekNumber(first);
  const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  if (sameMonth) {
    return `KW ${kw} · ${first.getDate()}.–${last.getDate()}. ${formatShortMonth(last)}`;
  }
  return `KW ${kw} · ${first.getDate()}. ${formatShortMonth(first)} – ${last.getDate()}. ${formatShortMonth(last)}`;
}

function formatFullGermanDate(iso: string): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) return iso;
  try {
    const raw = new Intl.DateTimeFormat('de-CH', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(parsed);
    return capitalizeFirst(raw);
  } catch {
    return iso;
  }
}

function formatShortWeekday(iso: string): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) return '';
  const idx = parsed.getDay() === 0 ? 6 : parsed.getDay() - 1;
  return WEEKDAY_SHORT[idx] ?? '';
}

function formatDayAndShortMonth(iso: string): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) return iso;
  return `${parsed.getDate()}. ${formatShortMonth(parsed)}`;
}

function formatNumericDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function formatTimeRange(startTime?: string, endTime?: string): string | null {
  const start = startTime?.trim();
  const end = endTime?.trim();
  if (start && end) return `${start} – ${end}`;
  if (start) return start;
  if (end) return `bis ${end}`;
  return null;
}

function getCountdownInfo(
  iso: string,
  todayDate: Date
): { label: string; diffDays: number; urgent: boolean; past: boolean } {
  const parsed = parseIsoDate(iso);
  if (!parsed) {
    return { label: iso, diffDays: 999, urgent: false, past: false };
  }
  const diffDays = Math.round((parsed.getTime() - todayDate.getTime()) / 86400000);
  if (diffDays < 0) {
    return {
      label: diffDays === -1 ? 'Gestern' : `Vor ${Math.abs(diffDays)} Tagen`,
      diffDays,
      urgent: false,
      past: true,
    };
  }
  if (diffDays === 0) return { label: 'Heute', diffDays: 0, urgent: true, past: false };
  if (diffDays === 1) return { label: 'Morgen', diffDays: 1, urgent: true, past: false };
  return {
    label: `In ${diffDays} Tagen`,
    diffDays,
    urgent: diffDays <= 7,
    past: false,
  };
}

function resolveCategory(item: SchoolScheduleItem): ScheduleItemCategory {
  if (item.category && CATEGORY_META[item.category]) {
    return item.category;
  }
  const lower = item.title.toLowerCase();
  if (
    lower.includes('abgabe') ||
    lower.includes('hausaufgabe') ||
    lower.includes('essay') ||
    lower.includes('submission') ||
    lower.includes('aufgabe') ||
    lower.includes('blatt')
  ) {
    return 'homework';
  }
  if (lower.includes('lektion') || lower.includes('stunde') || lower.includes('session')) {
    return 'lesson';
  }
  return 'exam';
}

function compareScheduleItems(a: SchoolScheduleItem, b: SchoolScheduleItem): number {
  const dateDiff = a.date.localeCompare(b.date);
  if (dateDiff !== 0) return dateDiff;

  const timeA = a.startTime?.trim() || '99:99';
  const timeB = b.startTime?.trim() || '99:99';
  const timeDiff = timeA.localeCompare(timeB);
  if (timeDiff !== 0) return timeDiff;

  const catA = CATEGORY_META[resolveCategory(a)].priority;
  const catB = CATEGORY_META[resolveCategory(b)].priority;
  if (catA !== catB) return catA - catB;

  return a.title.localeCompare(b.title);
}

function getMonthGridCells(
  year: number,
  monthIndex: number
): { date: Date; iso: string; dayNumber: number; inCurrentMonth: boolean }[] {
  const firstOfMonth = new Date(year, monthIndex, 1);
  const lastOfMonth = new Date(year, monthIndex + 1, 0);
  const gridStart = getMondayOfWeek(firstOfMonth);

  const lastDayOfWeek = lastOfMonth.getDay(); // 0 = Sun ... 6 = Sat
  const trailingDays = lastDayOfWeek === 0 ? 0 : 7 - lastDayOfWeek;
  const gridEnd = addDays(lastOfMonth, trailingDays);

  const cells: { date: Date; iso: string; dayNumber: number; inCurrentMonth: boolean }[] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    cells.push({
      date: cursor,
      iso: toIsoDate(cursor),
      dayNumber: cursor.getDate(),
      inCurrentMonth: cursor.getMonth() === monthIndex && cursor.getFullYear() === year,
    });
    cursor = addDays(cursor, 1);
  }
  return cells;
}

function formatScheduledForLabel(targetDate: Date, todayDate: Date): string {
  const diffDays = Math.round((targetDate.getTime() - todayDate.getTime()) / 86400000);
  if (diffDays <= 0) return 'Heute';
  if (diffDays === 1) return 'Morgen';
  const dd = String(targetDate.getDate()).padStart(2, '0');
  const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.`;
}

export const CalendarView: React.FC<CalendarViewProps> = ({
  state,
  onAddScheduleItems,
  onRemoveScheduleItem,
  onAddPlanTasks,
  onNavigate,
  onOpenVoiceTutor,
}) => {
  const todayDate = useMemo(() => getLocalToday(), []);
  const todayIso = useMemo(() => toIsoDate(todayDate), [todayDate]);
  const horizon90Date = useMemo(() => addDays(todayDate, 90), [todayDate]);
  const horizon90Iso = useMemo(() => toIsoDate(horizon90Date), [horizon90Date]);

  const [viewMode, setViewMode] = useState<CalendarMode>('month');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [cursorDate, setCursorDate] = useState<Date>(() => getLocalToday());
  const [selectedDateIso, setSelectedDateIso] = useState<string>(() => toIsoDate(getLocalToday()));

  // Inline composer state
  const [composerOpen, setComposerOpen] = useState<boolean>(false);
  const [draftTitle, setDraftTitle] = useState<string>('');
  const [draftDate, setDraftDate] = useState<string>(() => toIsoDate(getLocalToday()));
  const [draftStartTime, setDraftStartTime] = useState<string>('');
  const [draftEndTime, setDraftEndTime] = useState<string>('');
  const [draftCourseTitle, setDraftCourseTitle] = useState<string>('');
  const [draftCategory, setDraftCategory] = useState<ScheduleItemCategory>('exam');
  const [draftRoom, setDraftRoom] = useState<string>('');
  const [draftNotes, setDraftNotes] = useState<string>('');
  const [composerFeedback, setComposerFeedback] = useState<string | null>(null);

  // Per-item generated study plan confirmation
  const [plannedConfirmations, setPlannedConfirmations] = useState<Record<string, string>>({});

  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (composerOpen && titleInputRef.current) {
      titleInputRef.current.focus();
    }
  }, [composerOpen]);

  const courseLookup = useMemo(() => {
    return state.courses.map((course) => ({
      id: course.id,
      title: course.title,
      lower: course.title.toLowerCase(),
      accentColor: course.accentColor,
    }));
  }, [state.courses]);

  const matchCourse = (courseTitle: string) => {
    const query = courseTitle.trim().toLowerCase();
    if (!query) return undefined;
    return courseLookup.find(
      (c) => c.lower === query || c.lower.includes(query) || query.includes(c.lower)
    );
  };

  // All schedule items sorted deterministically
  const allSortedItems = useMemo(
    () => [...state.schoolSchedule].sort(compareScheduleItems),
    [state.schoolSchedule]
  );

  // Count within next 3 months (90 days from today) for header eyebrow
  const next90ItemsAll = useMemo(
    () => allSortedItems.filter((item) => item.date >= todayIso && item.date <= horizon90Iso),
    [allSortedItems, todayIso, horizon90Iso]
  );

  // Filtered items by selected category
  const filteredItems = useMemo(() => {
    if (categoryFilter === 'all') return allSortedItems;
    return allSortedItems.filter((item) => resolveCategory(item) === categoryFilter);
  }, [allSortedItems, categoryFilter]);

  // Category counts across all schedule items
  const categoryCounts = useMemo(() => {
    const counts: Record<ScheduleItemCategory, number> = {
      exam: 0,
      homework: 0,
      lesson: 0,
      event: 0,
    };
    for (const item of allSortedItems) {
      counts[resolveCategory(item)] += 1;
    }
    return counts;
  }, [allSortedItems]);

  // Lookup map by ISO date (filtered)
  const itemsByDate = useMemo(() => {
    const map = new Map<string, SchoolScheduleItem[]>();
    for (const item of filteredItems) {
      const existing = map.get(item.date);
      if (existing) {
        existing.push(item);
      } else {
        map.set(item.date, [item]);
      }
    }
    return map;
  }, [filteredItems]);

  // Unfiltered lookup by date to inform user when a filter hides entries on the selected day
  const allItemsByDate = useMemo(() => {
    const map = new Map<string, SchoolScheduleItem[]>();
    for (const item of allSortedItems) {
      const existing = map.get(item.date);
      if (existing) {
        existing.push(item);
      } else {
        map.set(item.date, [item]);
      }
    }
    return map;
  }, [allSortedItems]);

  const monthCells = useMemo(
    () => getMonthGridCells(cursorDate.getFullYear(), cursorDate.getMonth()),
    [cursorDate]
  );

  const weekDays = useMemo(() => {
    const monday = getMondayOfWeek(cursorDate);
    return Array.from({ length: 7 }, (_, idx) => {
      const date = addDays(monday, idx);
      return {
        date,
        iso: toIsoDate(date),
        dayShort: WEEKDAY_SHORT[idx],
        dayNumber: date.getDate(),
      };
    });
  }, [cursorDate]);

  const selectedDayItems = useMemo(
    () => itemsByDate.get(selectedDateIso) ?? [],
    [itemsByDate, selectedDateIso]
  );

  const hiddenOnSelectedDayCount = useMemo(() => {
    const total = allItemsByDate.get(selectedDateIso)?.length ?? 0;
    return Math.max(0, total - selectedDayItems.length);
  }, [allItemsByDate, selectedDateIso, selectedDayItems.length]);

  const selectedDayCountdown = useMemo(
    () => getCountdownInfo(selectedDateIso, todayDate),
    [selectedDateIso, todayDate]
  );

  // Upcoming 3 exams (fallback to next 3 upcoming items if no exams exist)
  const upcomingExams = useMemo(() => {
    const exams = allSortedItems.filter(
      (item) => item.date >= todayIso && resolveCategory(item) === 'exam'
    );
    if (exams.length > 0) return exams.slice(0, 3);
    return allSortedItems.filter((item) => item.date >= todayIso).slice(0, 3);
  }, [allSortedItems, todayIso]);

  const hasUpcomingExamsOnly = useMemo(
    () => allSortedItems.some((item) => item.date >= todayIso && resolveCategory(item) === 'exam'),
    [allSortedItems, todayIso]
  );

  // 90-day Agenda grouped by month
  const agendaGroups = useMemo(() => {
    const itemsInHorizon = filteredItems.filter(
      (item) => item.date >= todayIso && item.date <= horizon90Iso
    );
    const groups: { monthKey: string; monthLabel: string; items: SchoolScheduleItem[] }[] = [];
    const groupMap = new Map<string, { monthKey: string; monthLabel: string; items: SchoolScheduleItem[] }>();

    for (const item of itemsInHorizon) {
      const parsed = parseIsoDate(item.date);
      const monthKey = parsed
        ? `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`
        : item.date.slice(0, 7);
      const existing = groupMap.get(monthKey);
      if (existing) {
        existing.items.push(item);
      } else {
        const entry = {
          monthKey,
          monthLabel: parsed ? formatMonthYear(parsed) : monthKey,
          items: [item],
        };
        groupMap.set(monthKey, entry);
        groups.push(entry);
      }
    }
    return groups;
  }, [filteredItems, todayIso, horizon90Iso]);

  const agendaTotalCount = useMemo(
    () => agendaGroups.reduce((sum, g) => sum + g.items.length, 0),
    [agendaGroups]
  );

  const openComposerForDate = (isoDate: string) => {
    setDraftDate(isoDate);
    setSelectedDateIso(isoDate);
    const parsed = parseIsoDate(isoDate);
    if (parsed) {
      setCursorDate(parsed);
    }
    setComposerFeedback(null);
    setComposerOpen(true);
  };

  const handleToggleHeaderComposer = () => {
    if (composerOpen) {
      setComposerOpen(false);
      return;
    }
    setDraftDate(selectedDateIso);
    setComposerFeedback(null);
    setComposerOpen(true);
  };

  const handleSelectDate = (iso: string) => {
    setSelectedDateIso(iso);
    const parsed = parseIsoDate(iso);
    if (
      parsed &&
      viewMode === 'month' &&
      (parsed.getMonth() !== cursorDate.getMonth() ||
        parsed.getFullYear() !== cursorDate.getFullYear())
    ) {
      setCursorDate(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
    }
  };

  const handleJumpToDate = (iso: string) => {
    setSelectedDateIso(iso);
    const parsed = parseIsoDate(iso);
    if (parsed) {
      setCursorDate(parsed);
    }
  };

  const handleNavigatePeriod = (direction: -1 | 1) => {
    if (viewMode === 'month') {
      setCursorDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + direction, 1));
    } else if (viewMode === 'week') {
      setCursorDate((prev) => addDays(prev, direction * 7));
    }
  };

  const handleJumpToday = () => {
    const freshToday = getLocalToday();
    setCursorDate(freshToday);
    setSelectedDateIso(toIsoDate(freshToday));
  };

  const handleCreateScheduleItem = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = draftTitle.trim();
    const cleanDate = draftDate.trim();
    if (!cleanTitle || !parseIsoDate(cleanDate)) return;

    const newItem: SchoolScheduleItem = {
      id: `sch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: cleanTitle,
      date: cleanDate,
      courseTitle: draftCourseTitle.trim() || 'Allgemein',
      category: draftCategory,
      startTime: draftStartTime.trim() || undefined,
      endTime: draftEndTime.trim() || undefined,
      room: draftRoom.trim() || undefined,
      notes: draftNotes.trim() || undefined,
      source: 'manual',
    };

    onAddScheduleItems([newItem]);

    // Jump view cleanly to the newly added date
    const parsed = parseIsoDate(cleanDate);
    setSelectedDateIso(cleanDate);
    if (parsed) {
      setCursorDate(parsed);
    }
    if (categoryFilter !== 'all' && categoryFilter !== draftCategory) {
      setCategoryFilter('all');
    }

    setDraftTitle('');
    setDraftStartTime('');
    setDraftEndTime('');
    setDraftRoom('');
    setDraftNotes('');
    setComposerOpen(false);
    setComposerFeedback(`«${cleanTitle}» am ${formatNumericDate(cleanDate)} eingetragen.`);
  };

  const handleGenerateStudyPlan = (item: SchoolScheduleItem) => {
    const category = resolveCategory(item);
    const matched = matchCourse(item.courseTitle);
    const targetCourseId = matched?.id || state.activeCourseId || state.courses[0]?.id || 'general';
    const targetDate = parseIsoDate(item.date) ?? addDays(todayDate, 3);
    const diffDays = Math.max(
      0,
      Math.round((targetDate.getTime() - todayDate.getTime()) / 86400000)
    );
    const baseId = Date.now();

    const tasks: DailyPlanTask[] = [];
    if (category === 'exam') {
      const firstDate =
        diffDays >= 6 ? addDays(targetDate, -5) : todayDate;
      const secondDate =
        diffDays >= 3 ? addDays(targetDate, -2) : diffDays >= 1 ? addDays(todayDate, 1) : todayDate;
      const thirdDate =
        diffDays >= 1 ? addDays(targetDate, -1) : todayDate;

      tasks.push(
        {
          id: `dp-cal-${baseId}-1`,
          courseId: targetCourseId,
          title: `Stoffübersicht & Kernpunkte: ${item.title}`,
          minutes: 20,
          done: false,
          scheduledFor: formatScheduledForLabel(firstDate, todayDate),
        },
        {
          id: `dp-cal-${baseId}-2`,
          courseId: targetCourseId,
          title: `Aktives Üben & Karteikarten: ${item.title}`,
          minutes: 25,
          done: false,
          scheduledFor: formatScheduledForLabel(secondDate, todayDate),
        },
        {
          id: `dp-cal-${baseId}-3`,
          courseId: targetCourseId,
          title: `Probe-Durchgang & letzte Lücken: ${item.title}`,
          minutes: 20,
          done: false,
          scheduledFor: formatScheduledForLabel(thirdDate, todayDate),
        }
      );
    } else {
      const firstDate = diffDays >= 3 ? addDays(targetDate, -2) : todayDate;
      const secondDate = diffDays >= 1 ? addDays(targetDate, -1) : todayDate;

      tasks.push(
        {
          id: `dp-cal-${baseId}-1`,
          courseId: targetCourseId,
          title: `Struktur & erster Entwurf: ${item.title}`,
          minutes: 20,
          done: false,
          scheduledFor: formatScheduledForLabel(firstDate, todayDate),
        },
        {
          id: `dp-cal-${baseId}-2`,
          courseId: targetCourseId,
          title: `Überarbeiten & Abgabe prüfen: ${item.title}`,
          minutes: 15,
          done: false,
          scheduledFor: formatScheduledForLabel(secondDate, todayDate),
        }
      );
    }

    onAddPlanTasks(tasks);
    setPlannedConfirmations((prev) => ({
      ...prev,
      [item.id]: `${tasks.length} Lernblöcke im Planer hinterlegt`,
    }));
  };

  const renderDetailEntry = (item: SchoolScheduleItem, showDateBadge = false) => {
    const category = resolveCategory(item);
    const meta = CATEGORY_META[category];
    const matchedCourse = matchCourse(item.courseTitle);
    const timeRange = formatTimeRange(item.startTime, item.endTime);
    const isPreparable = category === 'exam' || category === 'homework';
    const planConfirmation = plannedConfirmations[item.id];

    return (
      <div
        key={item.id}
        className="border-t py-4 first:pt-4 last:pb-0"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        {/* Top meta row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
            <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: meta.chipText }}>
              <span
                className="h-1.5 w-1.5 rounded-full shrink-0"
                style={{ backgroundColor: meta.dotColor }}
                aria-hidden="true"
              />
              <span>{meta.label}</span>
            </span>
            {showDateBadge && (
              <>
                <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                  ·
                </span>
                <span className="font-mono-num" style={{ color: 'var(--text-secondary)' }}>
                  {formatNumericDate(item.date)}
                </span>
              </>
            )}
            {timeRange && (
              <>
                <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                  ·
                </span>
                <span
                  className="inline-flex items-center gap-1 font-mono-num"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <Clock size={11} strokeWidth={1.5} />
                  <span>{timeRange}</span>
                </span>
              </>
            )}
            <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
              ·
            </span>
            <span style={{ color: 'var(--text-muted)' }}>
              {SOURCE_LABELS[item.source] ?? 'Manuell'}
            </span>
          </div>

          <button
            type="button"
            onClick={() => onRemoveScheduleItem(item.id)}
            title="Termin entfernen"
            aria-label={`Termin «${item.title}» entfernen`}
            className="shrink-0 p-1 rounded-md cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/60 hover:text-[var(--negative)]"
            style={{ color: 'var(--text-muted)' }}
          >
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        </div>

        {/* Title */}
        <h3
          className="mt-1.5 text-[14.5px] font-medium leading-snug"
          style={{ color: 'var(--text-primary)' }}
        >
          {item.title}
        </h3>

        {/* Subject & Room */}
        <div
          className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px]"
          style={{ color: 'var(--text-secondary)' }}
        >
          <span className="inline-flex items-center gap-1.5">
            {matchedCourse && (
              <span
                className="h-1.5 w-1.5 rounded-full shrink-0"
                style={{ backgroundColor: matchedCourse.accentColor }}
                aria-hidden="true"
              />
            )}
            <span>{item.courseTitle}</span>
          </span>
          {item.room && (
            <>
              <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                ·
              </span>
              <span className="inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                <MapPin size={12} strokeWidth={1.5} />
                <span>{item.room}</span>
              </span>
            </>
          )}
        </div>

        {/* Notes */}
        {item.notes && (
          <p
            className="mt-2 text-[12.5px] leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            {item.notes}
          </p>
        )}

        {/* Prep Actions for Exam / Homework */}
        {isPreparable && (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleGenerateStudyPlan(item)}
                className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border text-[12px] font-medium cursor-pointer transition-colors hover:bg-[var(--bg-raised)]"
                style={{
                  borderColor: 'var(--border-hairline)',
                  color: 'var(--text-primary)',
                  backgroundColor: 'transparent',
                }}
              >
                <ListChecks size={13} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                <span>Lernplan erstellen</span>
              </button>

              <button
                type="button"
                onClick={() => onOpenVoiceTutor({ mode: 'exam' })}
                className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border text-[12px] font-medium cursor-pointer transition-colors hover:bg-[var(--accent-warm-soft)]"
                style={{
                  borderColor: 'var(--accent-warm-border)',
                  color: 'var(--accent-warm)',
                  backgroundColor: 'transparent',
                }}
              >
                <Mic size={13} strokeWidth={1.5} />
                <span>Üben</span>
              </button>
            </div>

            {planConfirmation && (
              <div
                className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] border-l-2 pl-2.5 py-0.5"
                style={{
                  borderColor: 'var(--positive)',
                  color: 'var(--positive)',
                }}
              >
                <span className="inline-flex items-center gap-1">
                  <Check size={12} strokeWidth={2} />
                  <span>{planConfirmation}</span>
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate('focus')}
                  className="inline-flex items-center gap-1 font-medium cursor-pointer hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  <span>Zum Planer</span>
                  <ArrowRight size={11} strokeWidth={1.5} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const eyebrowCountText =
    next90ItemsAll.length === 0
      ? 'Keine Einträge in den nächsten 3 Monaten'
      : next90ItemsAll.length === 1
      ? '1 Eintrag in den nächsten 3 Monaten'
      : `${next90ItemsAll.length} Einträge in den nächsten 3 Monaten`;

  const periodLabel =
    viewMode === 'month'
      ? formatMonthYear(cursorDate)
      : viewMode === 'week'
      ? formatWeekRangeLabel(weekDays)
      : `${formatDayAndShortMonth(todayIso)} – ${formatDayAndShortMonth(horizon90Iso)}`;

  return (
    <div className="mx-auto max-w-[1180px] pb-14 animate-enter">
      {/* 1. Serene Editorial Header */}
      <header
        className="flex flex-col gap-5 border-b pb-6 sm:flex-row sm:items-end sm:justify-between"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div className="space-y-1.5">
          <div
            className="flex flex-wrap items-center gap-2 text-[13px]"
            style={{ color: 'var(--text-secondary)' }}
          >
            <span>{formatMonthYear(todayDate)}</span>
            <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
              ·
            </span>
            <span>{eyebrowCountText}</span>
          </div>
          <h1
            className="font-display font-normal text-[32px] sm:text-[36px] leading-[1.12]"
            style={{ color: 'var(--text-primary)' }}
          >
            Kalender &amp; Agenda
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleToggleHeaderComposer}
            className="btn-accent"
            aria-expanded={composerOpen}
          >
            {composerOpen ? (
              <>
                <X size={15} strokeWidth={1.5} />
                <span>Schliessen</span>
              </>
            ) : (
              <>
                <Plus size={15} strokeWidth={1.5} />
                <span>Termin</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => onNavigate('import')}
            className="btn-secondary"
          >
            <FolderInput size={15} strokeWidth={1.5} />
            <span>Portal einlesen</span>
          </button>
        </div>
      </header>

      {/* Quiet Confirmation Banner after adding an entry */}
      {composerFeedback && !composerOpen && (
        <div
          className="mt-4 flex items-center justify-between gap-3 border-l-2 py-1 pl-3 text-[13px]"
          style={{
            borderColor: 'var(--positive)',
            color: 'var(--positive)',
          }}
        >
          <span className="inline-flex items-center gap-2">
            <Check size={14} strokeWidth={1.8} />
            <span>{composerFeedback}</span>
          </span>
          <button
            type="button"
            onClick={() => setComposerFeedback(null)}
            aria-label="Hinweis ausblenden"
            className="p-0.5 cursor-pointer opacity-75 hover:opacity-100"
            style={{ color: 'var(--text-muted)' }}
          >
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
      )}

      {/* 4. Expandable Inline «Neuer Termin» Composer */}
      {composerOpen && (
        <section
          aria-label="Neuen Termin eintragen"
          className="surface-card mt-5 p-5 sm:p-6 animate-enter"
        >
          <div
            className="flex items-center justify-between gap-3 border-b pb-3.5"
            style={{ borderColor: 'var(--border-hairline)' }}
          >
            <div>
              <h2
                className="font-display font-normal text-[21px] leading-snug"
                style={{ color: 'var(--text-primary)' }}
              >
                Neuer Termin
              </h2>
              <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                Prüfung, Aufgabe, Lektion oder Termin direkt in deiner Agenda festhalten.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setComposerOpen(false)}
              aria-label="Formular schliessen"
              className="btn-ghost p-1.5"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>

          <form onSubmit={handleCreateScheduleItem} className="mt-4 space-y-4">
            {/* Category Selector Row */}
            <div>
              <span
                className="mb-1.5 block text-[12px] font-medium"
                style={{ color: 'var(--text-secondary)' }}
              >
                Kategorie
              </span>
              <div className="flex flex-wrap gap-2">
                {CATEGORY_ORDER.map((cat) => {
                  const meta = CATEGORY_META[cat];
                  const selected = draftCategory === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setDraftCategory(cat)}
                      className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12.5px] font-medium cursor-pointer transition-colors"
                      style={{
                        backgroundColor: selected ? meta.chipBg : 'transparent',
                        borderColor: selected ? meta.chipBorder : 'var(--border-hairline)',
                        color: selected ? meta.chipText : 'var(--text-secondary)',
                      }}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: meta.dotColor }}
                        aria-hidden="true"
                      />
                      <span>{meta.filterLabel === 'Stundenplan' ? 'Stundenplan' : meta.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Primary Fields Grid */}
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-12">
              <div className="sm:col-span-6">
                <label
                  htmlFor="cal-draft-title"
                  className="mb-1.5 block text-[12px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Titel
                </label>
                <input
                  ref={titleInputRef}
                  id="cal-draft-title"
                  type="text"
                  required
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="Zum Beispiel: Mathematik Prüfung Funktionen"
                  className="w-full rounded-lg border px-3 py-2 text-[14px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="sm:col-span-3">
                <label
                  htmlFor="cal-draft-date"
                  className="mb-1.5 block text-[12px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Datum
                </label>
                <input
                  id="cal-draft-date"
                  type="date"
                  required
                  value={draftDate}
                  onChange={(e) => setDraftDate(e.target.value)}
                  className="font-mono-num w-full rounded-lg border px-3 py-2 text-[13.5px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="sm:col-span-3">
                <label
                  htmlFor="cal-draft-course"
                  className="mb-1.5 block text-[12px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Fach
                </label>
                <input
                  id="cal-draft-course"
                  type="text"
                  list="calendar-course-suggestions"
                  value={draftCourseTitle}
                  onChange={(e) => setDraftCourseTitle(e.target.value)}
                  placeholder="Fach wählen oder eingeben"
                  className="w-full rounded-lg border px-3 py-2 text-[14px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
                <datalist id="calendar-course-suggestions">
                  {state.courses.map((course) => (
                    <option key={course.id} value={course.title} />
                  ))}
                </datalist>
              </div>
            </div>

            {/* Optional Details Grid */}
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-12">
              <div className="sm:col-span-2">
                <label
                  htmlFor="cal-draft-start"
                  className="mb-1.5 block text-[12px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Startzeit
                </label>
                <input
                  id="cal-draft-start"
                  type="time"
                  value={draftStartTime}
                  onChange={(e) => setDraftStartTime(e.target.value)}
                  className="font-mono-num w-full rounded-lg border px-3 py-2 text-[13.5px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="sm:col-span-2">
                <label
                  htmlFor="cal-draft-end"
                  className="mb-1.5 block text-[12px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Endzeit
                </label>
                <input
                  id="cal-draft-end"
                  type="time"
                  value={draftEndTime}
                  onChange={(e) => setDraftEndTime(e.target.value)}
                  className="font-mono-num w-full rounded-lg border px-3 py-2 text-[13.5px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="sm:col-span-3">
                <label
                  htmlFor="cal-draft-room"
                  className="mb-1.5 block text-[12px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Raum (optional)
                </label>
                <input
                  id="cal-draft-room"
                  type="text"
                  value={draftRoom}
                  onChange={(e) => setDraftRoom(e.target.value)}
                  placeholder="Zum Beispiel: B204"
                  className="w-full rounded-lg border px-3 py-2 text-[14px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="sm:col-span-5">
                <label
                  htmlFor="cal-draft-notes"
                  className="mb-1.5 block text-[12px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Notiz (optional)
                </label>
                <input
                  id="cal-draft-notes"
                  type="text"
                  value={draftNotes}
                  onChange={(e) => setDraftNotes(e.target.value)}
                  placeholder="Kapitel, Hilfsmittel oder kurze Erinnerung"
                  className="w-full rounded-lg border px-3 py-2 text-[14px]"
                  style={{
                    backgroundColor: 'var(--bg-page)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
            </div>

            <div
              className="flex flex-wrap items-center justify-end gap-2.5 border-t pt-4"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <button
                type="button"
                onClick={() => setComposerOpen(false)}
                className="btn-ghost"
              >
                Abbrechen
              </button>
              <button
                type="submit"
                disabled={!draftTitle.trim() || !draftDate}
                className="btn-accent disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <Check size={15} strokeWidth={1.6} />
                <span>Termin speichern</span>
              </button>
            </div>
          </form>
        </section>
      )}

      {/* 2. Clean View & Filter Toolbar (Hairline Bar — Zero Heavy Boxes) */}
      <section
        aria-label="Kalender-Ansicht und Filter"
        className="border-b pt-4 pb-4 space-y-4"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          {/* Left: Segmented Editorial View Switcher */}
          <div
            className="flex items-center gap-6 border-b lg:border-b-0"
            style={{ borderColor: 'var(--border-hairline)' }}
            role="tablist"
            aria-label="Kalenderansicht wählen"
          >
            {(
              [
                { id: 'month', label: 'Monat' },
                { id: 'week', label: 'Woche' },
                { id: 'agenda', label: 'Agenda (3 Monate)' },
              ] as { id: CalendarMode; label: string }[]
            ).map((tab) => {
              const active = viewMode === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setViewMode(tab.id)}
                  className="relative pb-2.5 lg:pb-1.5 text-[14px] font-medium cursor-pointer transition-colors"
                  style={{
                    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                >
                  <span>{tab.label}</span>
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 -bottom-px h-[2px] rounded-full"
                      style={{ backgroundColor: 'var(--accent)' }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Center / Right: Period Navigation + Display Label */}
          <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-start">
            {viewMode !== 'agenda' ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleNavigatePeriod(-1)}
                  aria-label={viewMode === 'month' ? 'Vorheriger Monat' : 'Vorherige Woche'}
                  className="btn-ghost h-8 w-8 p-0"
                >
                  <ChevronLeft size={16} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={handleJumpToday}
                  className="btn-ghost h-8 px-2.5 text-[12.5px]"
                >
                  Heute
                </button>
                <button
                  type="button"
                  onClick={() => handleNavigatePeriod(1)}
                  aria-label={viewMode === 'month' ? 'Nächster Monat' : 'Nächste Woche'}
                  className="btn-ghost h-8 w-8 p-0"
                >
                  <ChevronRight size={16} strokeWidth={1.5} />
                </button>
              </div>
            ) : (
              <span
                className="inline-flex items-center gap-1.5 text-[12.5px]"
                style={{ color: 'var(--text-muted)' }}
              >
                <CalendarDays size={14} strokeWidth={1.5} />
                <span>90-Tage-Horizont</span>
              </span>
            )}

            <h2
              className="font-display font-normal text-[20px] sm:text-[22px] leading-none"
              style={{ color: 'var(--text-primary)' }}
            >
              {periodLabel}
            </h2>
          </div>
        </div>

        {/* Category Filter Row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Nach Kategorie filtern">
            <button
              type="button"
              onClick={() => setCategoryFilter('all')}
              aria-pressed={categoryFilter === 'all'}
              className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium cursor-pointer transition-colors"
              style={{
                backgroundColor:
                  categoryFilter === 'all' ? 'var(--bg-raised)' : 'transparent',
                borderColor:
                  categoryFilter === 'all' ? 'var(--border-strong)' : 'var(--border-hairline)',
                color:
                  categoryFilter === 'all' ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              <span>Alle</span>
              <span className="font-mono-num text-[11px] opacity-70">{allSortedItems.length}</span>
            </button>

            {CATEGORY_ORDER.map((cat) => {
              const meta = CATEGORY_META[cat];
              const active = categoryFilter === cat;
              const count = categoryCounts[cat];
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  aria-pressed={active}
                  className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium cursor-pointer transition-colors"
                  style={{
                    backgroundColor: active ? meta.chipBg : 'transparent',
                    borderColor: active ? meta.chipBorder : 'var(--border-hairline)',
                    color: active ? meta.chipText : 'var(--text-secondary)',
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: meta.dotColor }}
                    aria-hidden="true"
                  />
                  <span>{meta.filterLabel}</span>
                  {count > 0 && (
                    <span className="font-mono-num text-[11px] opacity-70">{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {viewMode === 'agenda'
              ? `${agendaTotalCount} ${agendaTotalCount === 1 ? 'Eintrag' : 'Einträge'} im Zeitraum`
              : `${filteredItems.length} ${filteredItems.length === 1 ? 'Eintrag' : 'Einträge'} gesamt`}
          </span>
        </div>
      </section>

      {/* 3A. MONAT VIEW (Default — Crisp 7-Column Grid + Right Day Detail Panel) */}
      {viewMode === 'month' && (
        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-12 xl:gap-8 items-start">
          {/* Left: 7-Column European Month Grid */}
          <section
            aria-label={`Monatskalender ${formatMonthYear(cursorDate)}`}
            className="surface-card overflow-hidden xl:col-span-8"
          >
            {/* Weekday Header Row */}
            <div
              className="grid grid-cols-7 border-b"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              {WEEKDAY_SHORT.map((day, idx) => (
                <div
                  key={day}
                  className="py-2.5 px-2 text-center text-[11.5px] font-medium"
                  style={{
                    color: idx >= 5 ? 'var(--text-muted)' : 'var(--text-secondary)',
                  }}
                >
                  {day}
                </div>
              ))}
            </div>

            {/* Day Grid */}
            <div className="grid grid-cols-7">
              {monthCells.map((cell, idx) => {
                const isToday = cell.iso === todayIso;
                const isSelected = cell.iso === selectedDateIso;
                const isWeekend = idx % 7 >= 5;
                const isLastCol = idx % 7 === 6;
                const isLastRow = idx >= monthCells.length - 7;
                const dayItems = itemsByDate.get(cell.iso) ?? [];
                const visibleChips = dayItems.slice(0, 3);
                const overflowCount = Math.max(0, dayItems.length - 3);

                return (
                  <button
                    key={cell.iso}
                    type="button"
                    onClick={() => handleSelectDate(cell.iso)}
                    aria-label={`${formatFullGermanDate(cell.iso)}, ${dayItems.length} ${dayItems.length === 1 ? 'Eintrag' : 'Einträge'}`}
                    aria-pressed={isSelected}
                    className="group relative flex min-h-[86px] sm:min-h-[96px] flex-col items-stretch justify-start gap-1 p-1.5 sm:p-2 text-left cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/35"
                    style={{
                      borderRight: isLastCol ? 'none' : '1px solid var(--border-hairline)',
                      borderBottom: isLastRow ? 'none' : '1px solid var(--border-hairline)',
                      backgroundColor: isSelected
                        ? 'var(--accent-soft)'
                        : !cell.inCurrentMonth
                        ? 'var(--bg-page)'
                        : isWeekend
                        ? 'var(--bg-card)'
                        : 'transparent',
                      boxShadow: isSelected ? 'inset 0 0 0 1.5px var(--accent)' : undefined,
                    }}
                  >
                    {/* Day Number Row */}
                    <div className="flex items-center justify-between gap-1">
                      <span
                        className="font-mono-num inline-flex h-6 w-6 items-center justify-center rounded-full text-[12px]"
                        style={{
                          backgroundColor: isToday ? 'var(--accent)' : 'transparent',
                          color: isToday
                            ? 'var(--accent-ink)'
                            : !cell.inCurrentMonth
                            ? 'var(--text-muted)'
                            : isWeekend
                            ? 'var(--text-secondary)'
                            : 'var(--text-primary)',
                          fontWeight: isToday || isSelected ? 500 : 400,
                          opacity: !cell.inCurrentMonth && !isToday ? 0.55 : 1,
                        }}
                      >
                        {cell.dayNumber}
                      </span>
                    </div>

                    {/* Up to 3 compact single-line event chips */}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {visibleChips.map((item) => {
                        const meta = CATEGORY_META[resolveCategory(item)];
                        return (
                          <div
                            key={item.id}
                            className="flex min-w-0 items-center gap-1 rounded-[5px] px-1 sm:px-1.5 py-[2px] text-[10.5px] sm:text-[11px] font-medium leading-[1.3]"
                            style={{
                              backgroundColor: meta.chipBg,
                              color: meta.chipText,
                            }}
                            title={`${item.title}${item.startTime ? ` (${item.startTime})` : ''}`}
                          >
                            <span
                              className="h-1.5 w-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: meta.dotColor }}
                              aria-hidden="true"
                            />
                            <span className="truncate">{item.title}</span>
                          </div>
                        );
                      })}
                      {overflowCount > 0 && (
                        <span
                          className="font-mono-num px-1 text-[10.5px]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          +{overflowCount} weitere
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Right: Serene Tagesdetails Panel */}
          <aside
            aria-label="Tagesdetails"
            className="surface-card p-5 sm:p-6 xl:col-span-4 xl:sticky xl:top-6"
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span
                  className="font-mono-num"
                  style={{
                    color: selectedDayCountdown.urgent
                      ? 'var(--accent-warm)'
                      : 'var(--text-muted)',
                    fontWeight: selectedDayCountdown.urgent ? 500 : 400,
                  }}
                >
                  {selectedDayCountdown.label}
                </span>
                <span className="font-mono-num" style={{ color: 'var(--text-muted)' }}>
                  {selectedDayItems.length}{' '}
                  {selectedDayItems.length === 1 ? 'Eintrag' : 'Einträge'}
                </span>
              </div>

              <h2
                className="font-display font-normal text-[22px] leading-snug"
                style={{ color: 'var(--text-primary)' }}
              >
                {formatFullGermanDate(selectedDateIso)}
              </h2>

              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => openComposerForDate(selectedDateIso)}
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium cursor-pointer transition-colors hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  <Plus size={14} strokeWidth={1.6} />
                  <span>An diesem Tag hinzufügen</span>
                </button>
              </div>
            </div>

            {selectedDayItems.length > 0 ? (
              <div className="mt-4">
                {selectedDayItems.map((item) => renderDetailEntry(item, false))}
                {hiddenOnSelectedDayCount > 0 && (
                  <div
                    className="mt-4 border-t pt-3 flex items-center justify-between gap-2 text-[12px]"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    <span>
                      {hiddenOnSelectedDayCount}{' '}
                      {hiddenOnSelectedDayCount === 1
                        ? 'weiterer Eintrag ausgeblendet'
                        : 'weitere Einträge ausgeblendet'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCategoryFilter('all')}
                      className="font-medium cursor-pointer hover:underline"
                      style={{ color: 'var(--accent)' }}
                    >
                      Alle zeigen
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-4">
                <div
                  className="border-t py-4 space-y-1.5"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  <p className="text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>
                    Für diesen Tag sind keine Einträge geplant.
                  </p>
                  {hiddenOnSelectedDayCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setCategoryFilter('all')}
                      className="text-[12.5px] font-medium cursor-pointer hover:underline"
                      style={{ color: 'var(--accent)' }}
                    >
                      {hiddenOnSelectedDayCount === 1
                        ? '1 ausgeblendeten Eintrag anzeigen'
                        : `${hiddenOnSelectedDayCount} ausgeblendete Einträge anzeigen`}
                    </button>
                  )}
                </div>

                {/* Calm summary of the next 3 upcoming exams so the panel is always useful */}
                <div
                  className="border-t pt-5"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h3
                      className="font-display font-normal text-[18px] leading-snug"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {hasUpcomingExamsOnly ? 'Nächste Prüfungen' : 'Nächste Termine'}
                    </h3>
                    <button
                      type="button"
                      onClick={() => setViewMode('agenda')}
                      className="text-[12px] font-medium cursor-pointer transition-colors hover:text-[var(--accent)]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Alle 3 Monate
                    </button>
                  </div>

                  {upcomingExams.length === 0 ? (
                    <div className="mt-3 space-y-2.5">
                      <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                        Noch keine kommenden Prüfungen oder Termine hinterlegt.
                      </p>
                      <button
                        type="button"
                        onClick={() => onNavigate('import')}
                        className="inline-flex items-center gap-1.5 text-[12.5px] font-medium cursor-pointer hover:underline"
                        style={{ color: 'var(--accent)' }}
                      >
                        <span>Schulportal einlesen</span>
                        <ArrowRight size={13} strokeWidth={1.5} />
                      </button>
                    </div>
                  ) : (
                    <div className="mt-3">
                      {upcomingExams.map((exam) => {
                        const countdown = getCountdownInfo(exam.date, todayDate);
                        const meta = CATEGORY_META[resolveCategory(exam)];
                        return (
                          <button
                            key={exam.id}
                            type="button"
                            onClick={() => handleJumpToDate(exam.date)}
                            className="w-full border-t py-3 first:pt-3 last:pb-0 flex items-start justify-between gap-3 text-left cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/30"
                            style={{ borderColor: 'var(--border-hairline)' }}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="h-1.5 w-1.5 rounded-full shrink-0"
                                  style={{ backgroundColor: meta.dotColor }}
                                  aria-hidden="true"
                                />
                                <p
                                  className="truncate text-[13.5px] font-medium"
                                  style={{ color: 'var(--text-primary)' }}
                                >
                                  {exam.title}
                                </p>
                              </div>
                              <div
                                className="mt-0.5 pl-3 flex flex-wrap items-center gap-x-1.5 text-[12px]"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                <span>{exam.courseTitle}</span>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono-num">
                                  {formatNumericDate(exam.date)}
                                </span>
                              </div>
                            </div>
                            <span
                              className="font-mono-num shrink-0 pt-0.5 text-[11.5px]"
                              style={{
                                color: countdown.urgent
                                  ? 'var(--accent-warm)'
                                  : 'var(--text-secondary)',
                                fontWeight: countdown.urgent ? 500 : 400,
                              }}
                            >
                              {countdown.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* 3B. WOCHE VIEW (7-Day Structured Weekly Schedule) */}
      {viewMode === 'week' && (
        <div className="mt-6 space-y-6">
          <section
            aria-label={`Wochenplan ${formatWeekRangeLabel(weekDays)}`}
            className="surface-card overflow-hidden"
          >
            <div className="grid grid-cols-1 md:grid-cols-7">
              {weekDays.map((day, idx) => {
                const isToday = day.iso === todayIso;
                const isSelected = day.iso === selectedDateIso;
                const isLast = idx === 6;
                const dayItems = itemsByDate.get(day.iso) ?? [];

                return (
                  <div
                    key={day.iso}
                    className="flex flex-col border-b md:border-b-0 last:border-b-0"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      backgroundColor: isSelected ? 'var(--accent-soft)' : 'transparent',
                    }}
                  >
                    <div
                      className={`flex h-full flex-col ${!isLast ? 'md:border-r' : ''}`}
                      style={{ borderColor: 'var(--border-hairline)' }}
                    >
                      {/* Column Header */}
                      <div
                        className="flex items-center justify-between gap-2 border-b px-3 py-2.5"
                        style={{ borderColor: 'var(--border-hairline)' }}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedDateIso(day.iso)}
                          className="flex items-center gap-2 text-left cursor-pointer"
                        >
                          <span
                            className="text-[12px] font-medium"
                            style={{
                              color: isToday
                                ? 'var(--accent)'
                                : idx >= 5
                                ? 'var(--text-muted)'
                                : 'var(--text-secondary)',
                            }}
                          >
                            {day.dayShort}
                          </span>
                          <span
                            className="font-mono-num inline-flex h-6 w-6 items-center justify-center rounded-full text-[12.5px] font-medium"
                            style={{
                              backgroundColor: isToday ? 'var(--accent)' : 'transparent',
                              color: isToday ? 'var(--accent-ink)' : 'var(--text-primary)',
                            }}
                          >
                            {day.dayNumber}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => openComposerForDate(day.iso)}
                          title={`Termin am ${formatNumericDate(day.iso)} hinzufügen`}
                          aria-label={`Termin am ${formatFullGermanDate(day.iso)} hinzufügen`}
                          className="flex h-6 w-6 items-center justify-center rounded-full cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          <Plus size={13} strokeWidth={1.6} />
                        </button>
                      </div>

                      {/* Day Items */}
                      <div className="flex-1 min-h-[110px] md:min-h-[340px] divide-y" style={{ borderColor: 'var(--border-hairline)' }}>
                        {dayItems.length === 0 ? (
                          <div className="px-3 py-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                            Frei
                          </div>
                        ) : (
                          dayItems.map((item) => {
                            const meta = CATEGORY_META[resolveCategory(item)];
                            const timeRange = formatTimeRange(item.startTime, item.endTime);
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => setSelectedDateIso(day.iso)}
                                className="w-full block px-3 py-2.5 text-left cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/35"
                                style={{
                                  borderColor: 'var(--border-hairline)',
                                }}
                              >
                                <div
                                  className="border-l-2 pl-2 space-y-0.5"
                                  style={{ borderColor: meta.dotColor }}
                                >
                                  {timeRange && (
                                    <div
                                      className="font-mono-num text-[11px]"
                                      style={{ color: 'var(--text-muted)' }}
                                    >
                                      {timeRange}
                                    </div>
                                  )}
                                  <div
                                    className="text-[12.5px] font-medium leading-snug"
                                    style={{ color: 'var(--text-primary)' }}
                                  >
                                    {item.title}
                                  </div>
                                  <div
                                    className="text-[11.5px] truncate"
                                    style={{ color: 'var(--text-secondary)' }}
                                  >
                                    {item.courseTitle}
                                    {item.room ? ` · ${item.room}` : ''}
                                  </div>
                                </div>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Selected Day Editorial Detail Strip under Weekly Grid */}
          <section
            aria-label="Details zum gewählten Wochentag"
            className="surface-card p-5 sm:p-6"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <p className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  {selectedDayCountdown.label}
                </p>
                <h3
                  className="font-display font-normal text-[21px] leading-snug"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {formatFullGermanDate(selectedDateIso)}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => openComposerForDate(selectedDateIso)}
                className="btn-secondary h-8 px-3 text-[12.5px]"
              >
                <Plus size={14} strokeWidth={1.5} />
                <span>Termin an diesem Tag</span>
              </button>
            </div>

            {selectedDayItems.length === 0 ? (
              <p
                className="mt-4 border-t pt-4 text-[13.5px]"
                style={{
                  borderColor: 'var(--border-hairline)',
                  color: 'var(--text-secondary)',
                }}
              >
                Keine Einträge für diesen Tag. Wähle einen anderen Tag in der Woche oder füge direkt einen Termin hinzu.
              </p>
            ) : (
              <div className="mt-4">
                {selectedDayItems.map((item) => renderDetailEntry(item, false))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* 3C. AGENDA (3 MONATE) VIEW — Chronological 90-Day Timeline */}
      {viewMode === 'agenda' && (
        <section
          aria-label="Agenda der nächsten 3 Monate"
          className="mt-6 space-y-9"
        >
          {agendaGroups.length === 0 ? (
            <div
              className="surface-card p-7 space-y-3"
            >
              <h3
                className="font-display font-normal text-[22px] leading-snug"
                style={{ color: 'var(--text-primary)' }}
              >
                {categoryFilter === 'all'
                  ? 'Keine Einträge in den nächsten 3 Monaten'
                  : `Keine Einträge in «${CATEGORY_META[categoryFilter].filterLabel}»`}
              </h3>
              <p className="max-w-lg text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>
                {categoryFilter === 'all'
                  ? 'Füge Prüfungen, Aufgaben oder Lektionen manuell hinzu oder lies deine nächsten 3 Monate direkt über das Schulportal ein.'
                  : 'Für diese Kategorie sind im Zeitraum der nächsten 90 Tage aktuell keine Einträge vorhanden.'}
              </p>
              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                {categoryFilter !== 'all' && (
                  <button
                    type="button"
                    onClick={() => setCategoryFilter('all')}
                    className="btn-secondary"
                  >
                    Alle Kategorien anzeigen
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openComposerForDate(todayIso)}
                  className="btn-accent"
                >
                  <Plus size={15} strokeWidth={1.5} />
                  <span>Termin hinzufügen</span>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('import')}
                  className="btn-secondary"
                >
                  <FolderInput size={15} strokeWidth={1.5} />
                  <span>Portal einlesen</span>
                </button>
              </div>
            </div>
          ) : (
            agendaGroups.map((group) => (
              <div key={group.monthKey}>
                <div className="flex items-baseline justify-between gap-3 pb-3">
                  <h3
                    className="font-display font-normal text-[22px] leading-snug"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {group.monthLabel}
                  </h3>
                  <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    {group.items.length} {group.items.length === 1 ? 'Eintrag' : 'Einträge'}
                  </span>
                </div>

                <div
                  className="border-t"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  {group.items.map((item) => {
                    const category = resolveCategory(item);
                    const meta = CATEGORY_META[category];
                    const countdown = getCountdownInfo(item.date, todayDate);
                    const timeRange = formatTimeRange(item.startTime, item.endTime);
                    const matchedCourse = matchCourse(item.courseTitle);
                    const isPreparable = category === 'exam' || category === 'homework';
                    const planConfirmation = plannedConfirmations[item.id];
                    const isToday = item.date === todayIso;

                    return (
                      <div
                        key={item.id}
                        className="flex flex-col gap-3 border-b py-4 px-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-5 transition-colors hover:bg-[var(--bg-hover)]/25"
                        style={{ borderColor: 'var(--border-hairline)' }}
                      >
                        {/* Left: Date + Weekday */}
                        <div className="flex items-baseline gap-2.5 sm:w-[126px] sm:flex-col sm:gap-0.5 shrink-0">
                          <div className="flex items-center gap-1.5">
                            {isToday && (
                              <span
                                className="h-2 w-2 rounded-full shrink-0"
                                style={{ backgroundColor: 'var(--accent)' }}
                                aria-hidden="true"
                              />
                            )}
                            <span
                              className="font-mono-num text-[14px] font-medium"
                              style={{
                                color: isToday ? 'var(--accent)' : 'var(--text-primary)',
                              }}
                            >
                              {formatDayAndShortMonth(item.date)}
                            </span>
                          </div>
                          <div
                            className="flex items-center gap-1.5 text-[12px]"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <span>{formatShortWeekday(item.date)}</span>
                            {timeRange && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono-num">{timeRange}</span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Center: Title, Subject, Room, Notes */}
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
                            <span
                              className="inline-flex items-center gap-1.5 font-medium"
                              style={{ color: meta.chipText }}
                            >
                              <span
                                className="h-1.5 w-1.5 rounded-full shrink-0"
                                style={{ backgroundColor: meta.dotColor }}
                                aria-hidden="true"
                              />
                              <span>{meta.label}</span>
                            </span>
                            <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                              ·
                            </span>
                            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                              {matchedCourse && (
                                <span
                                  className="h-1.5 w-1.5 rounded-full shrink-0"
                                  style={{ backgroundColor: matchedCourse.accentColor }}
                                  aria-hidden="true"
                                />
                              )}
                              <span>{item.courseTitle}</span>
                            </span>
                            {item.room && (
                              <>
                                <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                                  ·
                                </span>
                                <span className="inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                                  <MapPin size={11.5} strokeWidth={1.5} />
                                  <span>{item.room}</span>
                                </span>
                              </>
                            )}
                            <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                              ·
                            </span>
                            <span style={{ color: 'var(--text-muted)' }}>
                              {SOURCE_LABELS[item.source] ?? 'Manuell'}
                            </span>
                          </div>

                          <p
                            className="text-[15px] font-medium leading-snug"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {item.title}
                          </p>

                          {item.notes && (
                            <p
                              className="text-[12.5px] leading-relaxed"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              {item.notes}
                            </p>
                          )}

                          {planConfirmation && (
                            <div
                              className="pt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]"
                              style={{ color: 'var(--positive)' }}
                            >
                              <span className="inline-flex items-center gap-1">
                                <Check size={12} strokeWidth={2} />
                                <span>{planConfirmation}</span>
                              </span>
                              <button
                                type="button"
                                onClick={() => onNavigate('focus')}
                                className="inline-flex items-center gap-1 font-medium cursor-pointer hover:underline"
                                style={{ color: 'var(--accent)' }}
                              >
                                <span>Zum Planer</span>
                                <ArrowRight size={11} strokeWidth={1.5} />
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Right: Countdown + Quick Actions */}
                        <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:gap-2 shrink-0">
                          <span
                            className="inline-flex items-center gap-1.5 font-mono-num text-[12px]"
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

                          <div className="flex items-center gap-1.5">
                            {isPreparable && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleGenerateStudyPlan(item)}
                                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[12px] font-medium cursor-pointer transition-colors hover:bg-[var(--bg-raised)]"
                                  style={{
                                    borderColor: 'var(--border-hairline)',
                                    color: 'var(--text-primary)',
                                  }}
                                >
                                  <ListChecks
                                    size={12.5}
                                    strokeWidth={1.5}
                                    style={{ color: 'var(--accent)' }}
                                  />
                                  <span>Lernplan</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onOpenVoiceTutor({ mode: 'exam' })}
                                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[12px] font-medium cursor-pointer transition-colors hover:bg-[var(--accent-warm-soft)]"
                                  style={{
                                    borderColor: 'var(--accent-warm-border)',
                                    color: 'var(--accent-warm)',
                                  }}
                                >
                                  <Mic size={12.5} strokeWidth={1.5} />
                                  <span>Üben</span>
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              onClick={() => onRemoveScheduleItem(item.id)}
                              title="Termin entfernen"
                              aria-label={`Termin «${item.title}» entfernen`}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-full cursor-pointer transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--negative)]"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              <Trash2 size={13.5} strokeWidth={1.5} />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
};
