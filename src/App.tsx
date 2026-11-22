import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  Clock,
  Download,
  FolderInput,
  Globe,
  GraduationCap,
  LayoutDashboard,
  Menu,
  Mic,
  Settings,
  X,
} from 'lucide-react';
import { COLOR_SCHEMES, getColorSchemeById } from './data/colorSchemes';
import { useOpenStudyStore } from './hooks/useOpenStudyStore';
import { usePwaInstall } from './hooks/usePwaInstall';
import { ColorSchemeId, MainView, StudyLanguage, TutorMode } from './types';
import { HomeDashboard } from './components/HomeDashboard';
import { NotionWorkspace } from './components/NotionWorkspace';
import { StudyTrainerView } from './components/StudyTrainerView';
import { LanguageGrammarLab } from './components/LanguageGrammarLab';
import { FocusPlannerView } from './components/FocusPlannerView';
import { ObsidianAndImportHub } from './components/ObsidianAndImportHub';
import { VoiceTutorDrawer } from './components/VoiceTutorDrawer';
import { OnboardingWizard } from './components/OnboardingWizard';
import { SettingsModal } from './components/SettingsModal';
import { LiveConnectionState } from './services/voiceEngine';

const NAV_ITEMS: {
  id: MainView;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}[] = [
  { id: 'home', label: 'Übersicht', icon: LayoutDashboard },
  { id: 'notes', label: 'Notizen', icon: BookOpen },
  { id: 'trainer', label: 'Karten & Quiz', icon: GraduationCap },
  { id: 'languages', label: 'Sprachen', icon: Globe },
  { id: 'focus', label: 'Fokus', icon: Clock },
  { id: 'import', label: 'Import & Sync', icon: FolderInput },
];

const VIEW_LABELS: Record<MainView, string> = {
  home: 'Übersicht',
  notes: 'Notizen',
  trainer: 'Karten & Quiz',
  languages: 'Sprachen & Grammatik',
  focus: 'Fokus & Planer',
  import: 'Import & Sync',
};

function FocusMark() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle
        cx="10"
        cy="10"
        r="7.5"
        stroke="var(--accent)"
        strokeWidth="1.5"
      />
      <path
        d="M10 2.5A7.5 7.5 0 0 1 17.5 10"
        stroke="var(--accent-warm)"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <circle cx="10" cy="10" r="2.2" fill="var(--accent)" />
    </svg>
  );
}

export default function App() {
  const {
    state,
    demoMode,
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
    resetToDemo,
  } = useOpenStudyStore();

  const { canInstall, isInstalled, promptInstall } = usePwaInstall();

  const [view, setView] = useState<MainView>('home');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [forceOnboarding, setForceOnboarding] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveConnectionState>('idle');
  const [hoveredSchemeId, setHoveredSchemeId] = useState<ColorSchemeId | null>(null);

  const activeCourse = useMemo(
    () => state.courses.find((c) => c.id === state.activeCourseId) ?? state.courses[0],
    [state.courses, state.activeCourseId]
  );

  const dueCardsCount = useMemo(() => {
    const now = Date.now();
    return state.cards.filter((c) => c.due <= now).length;
  }, [state.cards]);

  const activeScheme = useMemo(
    () => getColorSchemeById(hoveredSchemeId ?? state.colorScheme),
    [hoveredSchemeId, state.colorScheme]
  );

  const openVoiceTutor = (opts?: {
    mode?: TutorMode;
    language?: StudyLanguage;
    bilingual?: boolean;
  }) => {
    if (opts) {
      updateVoice({
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.language ? { languageLock: opts.language } : {}),
        ...(opts.bilingual !== undefined ? { bilingualCoach: opts.bilingual } : {}),
      });
    }
    setVoiceOpen(true);
    setMobileMenuOpen(false);
  };

  const navigate = (next: MainView) => {
    setView(next);
    setMobileMenuOpen(false);
  };

  const currentViewLabel = activeCourse
    ? `${VIEW_LABELS[view]} · ${activeCourse.title}`
    : VIEW_LABELS[view];

  const sidebarContent = (
    <div className="flex flex-col h-full px-3.5 py-5 justify-between gap-6">
      <div className="space-y-7">
        {/* Editorial Brand Mark */}
        <button
          type="button"
          onClick={() => navigate('home')}
          className="flex items-center gap-2.5 px-2 pt-0.5 text-left cursor-pointer"
        >
          <FocusMark />
          <span
            className="font-display text-[19px] font-medium tracking-[-0.02em] leading-none"
            style={{ color: 'var(--text-primary)' }}
          >
            OpenStudy
          </span>
        </button>

        {/* Primary Navigation */}
        <nav className="space-y-0.5" aria-label="Hauptnavigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            const count =
              item.id === 'trainer' && dueCardsCount > 0
                ? String(dueCardsCount)
                : item.id === 'notes' && state.notes.length > 0
                ? String(state.notes.length)
                : undefined;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                aria-current={active ? 'page' : undefined}
                className="relative w-full h-9 pl-3 pr-2.5 rounded-lg flex items-center justify-between gap-2 text-[13.5px] cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/55"
                style={{
                  backgroundColor: active ? 'var(--accent-soft)' : undefined,
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: active ? 500 : 400,
                }}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 rounded-full"
                    style={{ backgroundColor: 'var(--accent-warm)' }}
                  />
                )}
                <span className="flex items-center gap-2.5 min-w-0">
                  <span
                    className="shrink-0 flex items-center"
                    style={{ color: active ? 'var(--accent)' : 'var(--text-muted)' }}
                  >
                    <Icon size={15} strokeWidth={1.5} />
                  </span>
                  <span className="truncate">{item.label}</span>
                </span>
                {count && (
                  <span
                    className="font-mono-num text-[11px] shrink-0"
                    style={{
                      color:
                        item.id === 'trainer' && dueCardsCount > 0
                          ? 'var(--accent-warm)'
                          : 'var(--text-muted)',
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Subjects */}
        <div className="space-y-1">
          <div
            className="px-2.5 pb-1 text-[11.5px] font-medium"
            style={{ color: 'var(--text-muted)' }}
          >
            Fächer
          </div>
          <div className="space-y-0.5">
            {state.courses.map((course) => {
              const selected = course.id === activeCourse?.id;
              return (
                <button
                  key={course.id}
                  type="button"
                  onClick={() => {
                    setActiveCourse(course.id);
                    setMobileMenuOpen(false);
                  }}
                  className="w-full h-8 px-2.5 rounded-lg flex items-center gap-2.5 text-[13px] cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/55"
                  style={{
                    backgroundColor: selected ? 'var(--bg-raised)' : undefined,
                    color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: selected ? 500 : 400,
                  }}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: course.accentColor }}
                  />
                  <span className="truncate">{course.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Serene Bottom Controls */}
      <div
        className="pt-4 border-t space-y-3.5"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        {/* 5-Scheme Tactile Swatch Switcher */}
        <div className="px-1 space-y-2">
          <div className="flex items-center justify-between gap-2 text-[11.5px]">
            <span style={{ color: 'var(--text-muted)' }}>Farbschema</span>
            <span
              className="truncate font-medium"
              style={{ color: 'var(--text-secondary)' }}
            >
              {activeScheme.name}
            </span>
          </div>
          <div
            className="flex items-center justify-between gap-1.5"
            role="radiogroup"
            aria-label="Farbschema wählen"
            onMouseLeave={() => setHoveredSchemeId(null)}
          >
            {COLOR_SCHEMES.map((scheme) => {
              const selected = scheme.id === state.colorScheme;
              return (
                <button
                  key={scheme.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`Farbschema ${scheme.name}`}
                  title={`${scheme.name} — ${scheme.tagline}`}
                  onClick={() => setColorScheme(scheme.id)}
                  onMouseEnter={() => setHoveredSchemeId(scheme.id)}
                  onFocus={() => setHoveredSchemeId(scheme.id)}
                  onBlur={() => setHoveredSchemeId(null)}
                  className="w-[26px] h-[26px] rounded-full p-0 overflow-hidden cursor-pointer transition-transform hover:scale-105 shrink-0"
                  style={{
                    outline: selected ? '1.5px solid var(--accent)' : undefined,
                    outlineOffset: selected ? '2px' : undefined,
                    boxShadow: 'inset 0 0 0 1px var(--border-strong)',
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="w-full h-full block"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="12" fill={scheme.swatches[0]} />
                    <path d="M12 0 A12 12 0 0 1 12 24 Z" fill={scheme.swatches[1]} />
                    <path
                      d="M12 12 L24 12 A12 12 0 0 1 12 24 Z"
                      fill={scheme.swatches[2]}
                    />
                  </svg>
                </button>
              );
            })}
          </div>
        </div>

        {/* Primary Voice Tutor Trigger */}
        <button
          type="button"
          onClick={() => openVoiceTutor()}
          className="btn-accent w-full justify-between"
        >
          <span className="flex items-center gap-2">
            <Mic size={15} strokeWidth={1.5} />
            <span>Sprachtutor</span>
          </span>
          {liveStatus === 'connected' ? (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: 'var(--accent-warm)' }}
              aria-label="Verbunden"
              title="Live verbunden"
            />
          ) : (
            <span className="font-mono-num text-[11px] opacity-85">
              {state.voice.languageLock.toUpperCase()}
            </span>
          )}
        </button>

        {/* Quiet Action Row */}
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              setMobileMenuOpen(false);
            }}
            className="w-full h-8 px-2 rounded-lg flex items-center gap-2 text-[13px] cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/55"
            style={{ color: 'var(--text-secondary)' }}
          >
            <Settings size={14} strokeWidth={1.5} />
            <span>Einstellungen</span>
          </button>

          {canInstall && (
            <button
              type="button"
              onClick={() => {
                void promptInstall();
              }}
              className="w-full h-8 px-2 rounded-lg flex items-center gap-2 text-[13px] cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/55"
              style={{ color: 'var(--accent)' }}
            >
              <Download size={14} strokeWidth={1.5} />
              <span>Als App installieren</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: 'var(--bg-page)' }}>
      {/* Desktop Sidebar */}
      <aside
        className="hidden lg:block w-[244px] shrink-0 border-r sticky top-0 h-screen overflow-y-auto"
        style={{
          backgroundColor: 'var(--bg-sidebar)',
          borderColor: 'var(--border-hairline)',
        }}
      >
        {sidebarContent}
      </aside>

      {/* Main Column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile Header */}
        <header
          className="lg:hidden h-14 px-4 border-b flex items-center justify-between sticky top-0 z-20"
          style={{
            backgroundColor: 'var(--bg-sidebar)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((o) => !o)}
              className="btn-ghost p-1.5"
              aria-label="Menü öffnen"
            >
              {mobileMenuOpen ? (
                <X size={18} strokeWidth={1.5} />
              ) : (
                <Menu size={18} strokeWidth={1.5} />
              )}
            </button>
            <button
              type="button"
              onClick={() => navigate('home')}
              className="flex items-center gap-2 cursor-pointer"
            >
              <FocusMark />
              <span
                className="font-display text-[18px] font-medium tracking-[-0.02em]"
                style={{ color: 'var(--text-primary)' }}
              >
                OpenStudy
              </span>
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => openVoiceTutor()}
              className="btn-accent h-8 px-3 text-[12.5px]"
            >
              <Mic size={13} strokeWidth={1.5} />
              <span>Tutor</span>
              {liveStatus === 'connected' && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: 'var(--accent-warm)' }}
                />
              )}
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="btn-ghost p-1.5"
              aria-label="Einstellungen"
            >
              <Settings size={16} strokeWidth={1.5} />
            </button>
          </div>
        </header>

        {mobileMenuOpen && (
          <div className="lg:hidden fixed inset-0 top-14 z-30 flex">
            <div
              className="w-[260px] h-full border-r overflow-y-auto"
              style={{
                backgroundColor: 'var(--bg-sidebar)',
                borderColor: 'var(--border-hairline)',
              }}
            >
              {sidebarContent}
            </div>
            <button
              type="button"
              aria-label="Menü schliessen"
              onClick={() => setMobileMenuOpen(false)}
              className="flex-1 bg-black/30 border-0 cursor-pointer"
            />
          </div>
        )}

        <main className="flex-1 w-full max-w-[1360px] mx-auto px-5 sm:px-8 lg:px-10 py-6 sm:py-9">
          {view === 'home' && (
            <HomeDashboard
              state={state}
              demoMode={demoMode}
              onNavigate={navigate}
              onSelectCourse={setActiveCourse}
              onTogglePlanTask={togglePlanTask}
              onSetObjectiveMastery={setObjectiveMastery}
              onOpenVoiceTutor={openVoiceTutor}
              onOpenOnboarding={() => setForceOnboarding(true)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          )}
          {view === 'notes' && (
            <NotionWorkspace
              state={state}
              onSelectCourse={setActiveCourse}
              onUpsertNote={upsertNote}
              onUpdateNoteBlocks={updateNoteBlocks}
              onDeleteNote={deleteNote}
              onAddCards={addCards}
            />
          )}
          {view === 'trainer' && (
            <StudyTrainerView
              state={state}
              onSelectCourse={setActiveCourse}
              onRateCard={rateCard}
              onAddCards={addCards}
              onAddPlanTasks={addPlanTasks}
              onUpdateVoice={updateVoice}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          )}
          {view === 'languages' && (
            <LanguageGrammarLab
              state={state}
              onOpenVoiceTutor={openVoiceTutor}
            />
          )}
          {view === 'focus' && (
            <FocusPlannerView
              state={state}
              onTogglePlanTask={togglePlanTask}
              onAddPlanTasks={addPlanTasks}
              onSetDailyGoalMinutes={setDailyGoalMinutes}
              onLogFocusSession={logFocusSession}
            />
          )}
          {view === 'import' && (
            <ObsidianAndImportHub
              state={state}
              onSetObsidianNotes={setObsidianNotes}
              onToggleObsidianContext={toggleObsidianContext}
              onAddCourse={addCourse}
              onUpsertNote={upsertNote}
              onAddCards={addCards}
              onAddSchoolScheduleItems={addSchoolScheduleItems}
              onUpdateProvider={updateProvider}
            />
          )}
        </main>
      </div>

      {/* Persistent Voice Tutor Drawer */}
      <VoiceTutorDrawer
        open={voiceOpen}
        onOpenChange={setVoiceOpen}
        state={state}
        currentViewLabel={currentViewLabel}
        onUpdateVoice={updateVoice}
        onUpdateProvider={updateProvider}
        onOpenSettings={() => setSettingsOpen(true)}
        onConnectionStateChange={setLiveStatus}
      />

      {/* Settings Modal */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        state={state}
        onUpdateProvider={updateProvider}
        onSetColorScheme={setColorScheme}
        onSetDailyGoalMinutes={setDailyGoalMinutes}
        onResetToDemo={resetToDemo}
        onReopenOnboarding={() => {
          setSettingsOpen(false);
          setForceOnboarding(true);
        }}
        canInstallPwa={canInstall}
        isPwaInstalled={isInstalled}
        onInstallPwa={promptInstall}
      />

      {/* Optional Setup Guide (never blocks first load) */}
      <OnboardingWizard
        open={forceOnboarding}
        state={state}
        onUpdateProvider={updateProvider}
        onComplete={() => {
          completeOnboarding();
          setForceOnboarding(false);
        }}
        onOpenSettings={() => {
          setForceOnboarding(false);
          setSettingsOpen(true);
        }}
      />
    </div>
  );
}
