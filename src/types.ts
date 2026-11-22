export type MainView =
  | 'home'
  | 'notes'
  | 'trainer'
  | 'languages'
  | 'focus'
  | 'import';

export type ColorSchemeId =
  | 'focus-cream'
  | 'midnight-teal'
  | 'terracotta-paper'
  | 'botanical-sage'
  | 'espresso-ember';

export type TutorMode = 'explain' | 'exam' | 'language';
export type AgentStance = 'coach' | 'assistant';
export type ResponseDepth = 'concise' | 'indepth';
export type SpeechPace = 'slow' | 'calm' | 'normal';
export type StudyLanguage = 'de' | 'en' | 'fr' | 'es' | 'it';

export type ProviderKind =
  | 'gemini-free'
  | 'ollama'
  | 'cli-bridge'
  | 'openai-compatible'
  | 'anthropic';

export type MasteryState = 'open' | 'practicing' | 'mastered';

export interface SubjectCourse {
  id: string;
  title: string;
  category: 'language' | 'science' | 'humanities' | 'custom';
  accentColor: string;
  examDate?: string; // YYYY-MM-DD
  description: string;
  objectives: {
    id: string;
    title: string;
    summary: string;
    mastery: MasteryState;
  }[];
}

export type BlockType = 'h1' | 'h2' | 'text' | 'todo' | 'callout' | 'code';

export interface NoteBlock {
  id: string;
  type: BlockType;
  text: string;
  checked?: boolean;
}

export interface StudyNotePage {
  id: string;
  courseId: string;
  title: string;
  tags: string[];
  updatedAt: string;
  blocks: NoteBlock[];
  source: 'local' | 'obsidian' | 'notion' | 'school-import';
}

export interface ObsidianNote {
  path: string;
  title: string;
  excerpt: string;
  content: string;
  wikilinks: string[];
  selectedForContext: boolean;
}

export interface StudyCard {
  id: string;
  courseId: string;
  front: string;
  back: string;
  hint?: string;
  interval: number;
  ease: number;
  reps: number;
  due: number;
}

export interface QuizItem {
  id: string;
  courseId: string;
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface DailyPlanTask {
  id: string;
  courseId: string;
  title: string;
  minutes: number;
  done: boolean;
  scheduledFor: string; // e.g. "Heute"
}

export interface FocusSessionLog {
  id: string;
  courseId: string;
  minutes: number;
  completedAt: string;
  label: string;
}

export interface ProviderConfig {
  activeTextProvider: ProviderKind;
  freeOnlyLock: boolean;
  geminiApiKey: string;
  geminiTextModel: string;
  geminiLiveModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  bridgeUrl: string;
  bridgeTool: 'antigravity' | 'claude' | 'codex';
  customEndpoint: string;
  customApiKey: string;
  customModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  notionToken: string;
}

export interface VoicePreferences {
  voiceName: 'Kore' | 'Zephyr' | 'Puck' | 'Charon' | 'Fenrir' | 'Aoede';
  pace: SpeechPace;
  languageLock: StudyLanguage;
  bilingualCoach: boolean;
  explainLanguage: StudyLanguage;
  depth: ResponseDepth;
  mode: TutorMode;
  stance: AgentStance;
}

export interface SchoolScheduleItem {
  id: string;
  title: string;
  date: string;
  courseTitle: string;
  source: 'ics' | 'manual' | 'smart-import';
}

export interface OpenStudyState {
  onboardingDone: boolean;
  theme: 'light' | 'dark';
  colorScheme: ColorSchemeId;
  dailyGoalMinutes: number;
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
  provider: ProviderConfig;
  voice: VoicePreferences;
}
