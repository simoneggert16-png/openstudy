import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  Clock,
  FolderInput,
  Globe,
  GraduationCap,
  LayoutDashboard,
  Menu,
  Mic,
  Moon,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import { useOpenStudyStore } from './hooks/useOpenStudyStore';
import { MainView, StudyLanguage, TutorMode } from './types';
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
  { id: 'home', label: 'Übersicht & Lernplan', icon: LayoutDashboard },
  { id: 'notes', label: 'Notizen (Notion-Hub)', icon: BookOpen },
  { id: 'trainer', label: 'Karten, Quiz & Agent', icon: GraduationCap },
  { id: 'languages', label: 'Sprachen & Grammatik', icon: Globe },
  { id: 'focus', label: 'Fokuszeiten & Planer', icon: Clock },
  { id: 'import', label: 'Obsidian & Schul-Import', icon: FolderInput },
];

const VIEW_LABELS: Record<MainView, string> = {
  home: 'Übersicht & Lernplan',
  notes: 'Notizen-Workspace',
  trainer: 'Karteikarten, Quiz & Lern-Agent',
  languages: 'Sprach- & Grammatik-Studio',
  focus: 'Fokuszeiten & Tagesplan',
  import: 'Obsidian, Notion & Schul-Import',
};

export default function App() {
  const {
    state,
    demoMode,
    toggleTheme,
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

  const [view, setView] = useState<MainView>('home');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [forceOnboarding, setForceOnboarding] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveConnectionState>('idle');

  const activeCourse = useMemo(
    () => state.courses.find((c) => c.id === state.activeCourseId) ?? state.courses[0],
    [state.courses, state.activeCourseId]
  );

  const dueCardsCount = useMemo(() => {
    const now = Date.now();
    return state.cards.filter((c) => c.due <= now).length;
  }, [state.cards]);

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

  const showOnboarding = !demoMode && (!state.onboardingDone || forceOnboarding);

  const sidebarContent = (
    <div className="flex flex-col h-full p-4 justify-between">
      <div className="space-y-6">
        {/* Brand */}
        <div className="flex items-center justify-between px-2 pt-1">
          <div className="flex items-center gap-2.5">
            <span
              className="w-2.5 h-2.5 rounded-[3px] shrink-0"
              style={{ backgroundColor: 'var(--accent)' }}
            />
            <span className="text-[16px] font-semibold tracking-[-0.01em]">OpenStudy</span>
          </div>
          <span className="font-mono-num text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {demoMode ? 'Demo' : 'v1.0'}
          </span>
        </div>

        {/* Navigation */}
        <nav className="space-y-1" aria-label="Hauptnavigation">
          <div className="px-2 pb-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Lernbereiche
          </div>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            const badge =
              item.id === 'trainer'
                ? String(dueCardsCount)
                : item.id === 'notes'
                ? String(state.notes.length)
                : undefined;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                className="w-full h-9 px-2.5 rounded-[8px] flex items-center justify-between gap-2 text-[14px] font-medium cursor-pointer transition-colors"
                style={{
                  backgroundColor: active ? 'var(--bg-card)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  border: active ? '1px solid var(--border-hairline)' : '1px solid transparent',
                  boxShadow: active ? 'var(--shadow-sm)' : 'none',
                }}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon size={16} strokeWidth={1.5} />
                  <span className="truncate">{item.label}</span>
                </span>
                {badge && (
                  <span className="font-mono-num text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Active Courses */}
        <div className="space-y-1">
          <div className="px-2 pb-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Fächer & Themen
          </div>
          {state.courses.map((course) => {
            const selected = course.id === activeCourse?.id;
            return (
              <button
                key={course.id}
                type="button"
                onClick={() => setActiveCourse(course.id)}
                className="w-full h-8 px-2.5 rounded-[7px] flex items-center gap-2 text-[13px] cursor-pointer transition-colors"
                style={{
                  backgroundColor: selected ? 'var(--accent-soft)' : 'transparent',
                  color: selected ? 'var(--accent)' : 'var(--text-secondary)',
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

      {/* Bottom Controls */}
      <div className="pt-4 border-t space-y-2" style={{ borderColor: 'var(--border-hairline)' }}>
        <button
          type="button"
          onClick={() => openVoiceTutor()}
          className="w-full h-9 px-3 rounded-[8px] border flex items-center justify-between text-[13px] font-medium cursor-pointer transition-colors"
          style={{
            backgroundColor: liveStatus === 'connected' ? 'var(--positive-soft)' : 'var(--accent-soft)',
            borderColor: liveStatus === 'connected' ? 'var(--positive)' : 'var(--accent-border)',
            color: liveStatus === 'connected' ? 'var(--positive)' : 'var(--accent)',
          }}
        >
          <span className="flex items-center gap-2">
            <Mic size={15} strokeWidth={1.5} />
            <span>Live Sprachtutor</span>
          </span>
          <span className="font-mono-num text-[11px]">
            {liveStatus === 'connected' ? 'Aktiv' : state.voice.languageLock.toUpperCase()}
          </span>
        </button>

        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              setMobileMenuOpen(false);
            }}
            className="btn-secondary h-8 px-2.5 text-[12px] justify-start"
          >
            <Settings size={14} strokeWidth={1.5} />
            <span>Anbieter</span>
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            className="btn-secondary h-8 px-2.5 text-[12px] justify-start"
          >
            {state.theme === 'light' ? (
              <Moon size={14} strokeWidth={1.5} />
            ) : (
              <Sun size={14} strokeWidth={1.5} />
            )}
            <span>{state.theme === 'light' ? 'Dunkel' : 'Papier'}</span>
          </button>
        </div>

        <div className="px-1 pt-0.5 text-[11px] flex items-center justify-between" style={{ color: 'var(--text-muted)' }}>
          <span>{state.provider.freeOnlyLock ? 'Free-Tier aktiv' : 'Alle Anbieter'}</span>
          <span>100 % lokal</span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: 'var(--bg-page)' }}>
      {/* Desktop Sidebar */}
      <aside
        className="hidden lg:block w-[260px] shrink-0 border-r sticky top-0 h-screen overflow-y-auto"
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
              {mobileMenuOpen ? <X size={18} strokeWidth={1.5} /> : <Menu size={18} strokeWidth={1.5} />}
            </button>
            <span className="text-[15px] font-semibold">OpenStudy</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => openVoiceTutor()}
              className="btn-secondary h-8 px-2.5 text-[12px]"
              style={{
                color: liveStatus === 'connected' ? 'var(--positive)' : 'var(--accent)',
                borderColor: liveStatus === 'connected' ? 'var(--positive)' : 'var(--accent-border)',
              }}
            >
              <Mic size={14} strokeWidth={1.5} />
              <span>{liveStatus === 'connected' ? 'Live' : 'Tutor'}</span>
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
              className="w-[272px] h-full border-r overflow-y-auto"
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
              className="flex-1 bg-black/35 border-0 cursor-pointer"
            />
          </div>
        )}

        <main className="flex-1 w-full max-w-[1440px] mx-auto px-5 sm:px-8 py-6 sm:py-8">
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

      {/* Multi-Provider & Privacy Settings */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        state={state}
        onUpdateProvider={updateProvider}
        onResetToDemo={resetToDemo}
        onReopenOnboarding={() => {
          setSettingsOpen(false);
          setForceOnboarding(true);
        }}
      />

      {/* Friendly 3-Step First-Run Onboarding */}
      <OnboardingWizard
        open={showOnboarding}
        state={state}
        onUpdateProvider={updateProvider}
        onUpdateVoice={updateVoice}
        onSetDailyGoalMinutes={setDailyGoalMinutes}
        onComplete={() => {
          completeOnboarding();
          setForceOnboarding(false);
        }}
        onOpenImport={() => {
          completeOnboarding();
          setForceOnboarding(false);
          navigate('import');
        }}
      />
    </div>
  );
}
