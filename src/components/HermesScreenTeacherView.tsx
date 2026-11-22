import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUpRight,
  BookOpen,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Layers,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  PictureInPicture2,
  Plus,
  Send,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import {
  AgentStance,
  DailyPlanTask,
  HermesMemoryEntry,
  HermesSkill,
  HermesToolExecution,
  MainView,
  OpenStudyState,
  SchoolScheduleItem,
  ScreenSpotlight,
  StudyCard,
  StudyNotePage,
  VoicePreferences,
} from '../types';
import { useFloatingTeacherPip } from '../hooks/useFloatingTeacherPip';
import {
  buildHermesTeacherSystemPrompt,
  executeHermesToolCall,
  HERMES_LIVE_FUNCTION_DECLARATIONS,
  HermesToolHandlers,
  runHermesAgentTurn,
} from '../services/hermesAgent';
import {
  AudioTelemetryLevels,
  LANGUAGE_META,
  LiveConnectionState,
  OpenStudyVoiceSession,
  VoiceTranscriptEntry,
} from '../services/voiceEngine';
import { checkLocalBridge } from '../services/providers';

export interface HermesScreenTeacherViewProps {
  state: OpenStudyState;
  onNavigate: (view: MainView) => void;
  onSelectCourse: (courseId: string) => void;
  onUpsertNote: (page: StudyNotePage) => void;
  onAddCards: (cards: StudyCard[]) => void;
  onAddPlanTasks: (tasks: DailyPlanTask[]) => void;
  onAddSchoolScheduleItems?: (items: SchoolScheduleItem[]) => void;
  onAddHermesMemory: (entry: HermesMemoryEntry) => void;
  onRemoveHermesMemory: (id: string) => void;
  onUpsertHermesSkill: (skill: HermesSkill) => void;
  onToggleHermesSkill: (id: string) => void;
  onLogHermesAction: (entry: HermesToolExecution) => void;
  onAddScreenSpotlight: (spotlight: ScreenSpotlight) => void;
  onClearScreenSpotlights: () => void;
  onUpdateVoice: (patch: Partial<VoicePreferences>) => void;
  onOpenSettings: () => void;
  onOpenOnboarding: () => void;
  initialPrompt?: string | null;
  onConsumeInitialPrompt?: () => void;
}

type StudioTab = 'chat' | 'skills' | 'memory';

interface TeacherChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
  withScreen?: boolean;
  providerLabel?: string;
  source?: 'chat' | 'voice';
  executedTools?: HermesToolExecution[];
}

const QUICK_PROMPTS: string[] = [
  'Erklär mir, was gerade auf meinem Bildschirm ist',
  'Zeig mir Schritt für Schritt, wo ich klicken muss',
  'Erstelle daraus eine strukturierte Notiz',
  'Mach mir 4 Karteikarten zu diesem Thema',
];

const MEMORY_CATEGORY_LABELS: Record<HermesMemoryEntry['category'], string> = {
  preference: 'Präferenz',
  strength: 'Stärke',
  weakness: 'Übungsfeld',
  goal: 'Ziel',
  workflow: 'Workflow',
};

const MEMORY_CATEGORIES: HermesMemoryEntry['category'][] = [
  'preference',
  'strength',
  'weakness',
  'goal',
  'workflow',
];

const IDLE_TELEMETRY: AudioTelemetryLevels = {
  mic: 0,
  speaker: 0,
  bars: Array.from({ length: 12 }, () => 0.08),
};

interface BrowserImageCaptureInstance {
  grabFrame: () => Promise<ImageBitmap>;
}

interface BrowserImageCaptureConstructor {
  new (track: MediaStreamTrack): BrowserImageCaptureInstance;
}

interface ScreenCropBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

interface CapturedFrameResult {
  base64: string;
  width: number;
  height: number;
  source: 'windows-bridge' | 'screen-share';
}

const TOOL_DISPLAY_LABELS: Record<string, string> = {
  inspect_screen_detail: 'HD-Bildschirmprüfung',
  highlight_screen_region: 'Bildschirm-Marker',
  clear_screen_highlights: 'Marker geleert',
  create_study_note: 'Lernnotiz',
  create_flashcards: 'Karteikarten',
  add_daily_plan_tasks: 'Tagesplan',
  add_school_schedule: 'Prüfungskalender ergänzt',
  navigate_app: 'Ansicht gewechselt',
  save_learning_memory: 'Gedächtnis',
  save_custom_skill: 'SKILL.md',
  get_obsidian_overview: 'Obsidian-Übersicht',
  search_obsidian_vault: 'Obsidian-Suche',
  read_obsidian_note: 'Obsidian-Notiz',
};

function getToolDisplayLabel(toolName: string): string {
  return TOOL_DISPLAY_LABELS[toolName] ?? toolName;
}

function clampPercent(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeCropPercent(
  crop?: ScreenCropBox
): { x: number; y: number; w: number; h: number } | null {
  if (!crop) return null;
  if (
    !Number.isFinite(crop.xMin) ||
    !Number.isFinite(crop.yMin) ||
    !Number.isFinite(crop.xMax) ||
    !Number.isFinite(crop.yMax)
  ) {
    return null;
  }
  const x1 = clampPercent(Math.min(crop.xMin, crop.xMax), 0, 99);
  const y1 = clampPercent(Math.min(crop.yMin, crop.yMax), 0, 99);
  const x2 = clampPercent(Math.max(crop.xMin, crop.xMax), x1 + 1, 100);
  const y2 = clampPercent(Math.max(crop.yMin, crop.yMax), y1 + 1, 100);
  return {
    x: x1,
    y: y1,
    w: Math.max(1, x2 - x1),
    h: Math.max(1, y2 - y1),
  };
}

/**
 * Unthrottled interval ticker backed by an inline Web Worker so Chrome/Edge
 * never throttle live frame capture when this tab is occluded behind desktop apps.
 */
function createUnthrottledTicker(intervalMs: number, onTick: () => void): () => void {
  const safeMs = Math.max(100, Math.round(intervalMs));
  let fallbackTimerId: number | null = null;
  let stopped = false;

  const startFallback = () => {
    if (stopped || fallbackTimerId !== null) return;
    fallbackTimerId = window.setInterval(() => {
      if (!stopped) onTick();
    }, safeMs);
  };

  if (
    typeof Worker !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    let worker: Worker | null = null;
    let objectUrl: string | null = null;
    try {
      const workerSource = `
        const id = setInterval(() => { self.postMessage('tick'); }, ${safeMs});
        self.onmessage = (e) => {
          if (e.data === 'stop') {
            clearInterval(id);
            self.close();
          }
        };
      `;
      const blob = new Blob([workerSource], { type: 'application/javascript' });
      objectUrl = URL.createObjectURL(blob);
      worker = new Worker(objectUrl);
      worker.onmessage = () => {
        if (!stopped) onTick();
      };
      worker.onerror = () => {
        if (worker) {
          try {
            worker.terminate();
          } catch {
            // ignore
          }
          worker = null;
        }
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
        startFallback();
      };

      return () => {
        stopped = true;
        if (worker) {
          try {
            worker.postMessage('stop');
          } catch {
            // ignore
          }
          try {
            worker.terminate();
          } catch {
            // ignore
          }
          worker = null;
        }
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
        if (fallbackTimerId !== null) {
          window.clearInterval(fallbackTimerId);
          fallbackTimerId = null;
        }
      };
    } catch {
      if (worker) {
        try {
          worker.terminate();
        } catch {
          // ignore
        }
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }
  }

  startFallback();
  return () => {
    stopped = true;
    if (fallbackTimerId !== null) {
      window.clearInterval(fallbackTimerId);
      fallbackTimerId = null;
    }
  };
}

function formatClockTime(isoOrMs: string | number): string {
  const date = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatClockSeconds(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function makeSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `skill-${Date.now().toString(36)}`;
}

function getToolNavigationTarget(toolName: string): { view: MainView; label: string } | null {
  if (toolName === 'create_study_note') return { view: 'notes', label: 'Notizen öffnen' };
  if (toolName === 'create_flashcards') return { view: 'trainer', label: 'Karten üben' };
  if (toolName === 'add_daily_plan_tasks') return { view: 'focus', label: 'Planer öffnen' };
  if (toolName === 'add_school_schedule') return { view: 'home', label: 'Übersicht öffnen' };
  return null;
}

function extractActiveWindowLabel(payload: Record<string, unknown>): string {
  if (payload.redacted) return '';
  const titleCandidates = [
    payload.title,
    payload.windowTitle,
    payload.activeWindow,
    payload.name,
  ];
  const appCandidates = [payload.appName, payload.processName, payload.app];

  const title = titleCandidates.find((v): v is string => typeof v === 'string' && v.trim().length > 0)?.trim() ?? '';
  const app = appCandidates.find((v): v is string => typeof v === 'string' && v.trim().length > 0)?.trim() ?? '';

  if (title && app && !title.toLowerCase().includes(app.toLowerCase())) {
    return `${app} — ${title}`.slice(0, 90);
  }
  return (title || app).slice(0, 90);
}

export const HermesScreenTeacherView: React.FC<HermesScreenTeacherViewProps> = ({
  state,
  onNavigate,
  onSelectCourse,
  onUpsertNote,
  onAddCards,
  onAddPlanTasks,
  onAddSchoolScheduleItems,
  onAddHermesMemory,
  onRemoveHermesMemory,
  onUpsertHermesSkill,
  onToggleHermesSkill,
  onLogHermesAction,
  onAddScreenSpotlight,
  onClearScreenSpotlights,
  onUpdateVoice,
  onOpenSettings,
  onOpenOnboarding,
  initialPrompt,
  onConsumeInitialPrompt,
}) => {
  const [studioTab, setStudioTab] = useState<StudioTab>('chat');

  // Screen sharing & capture state
  const [isSharingScreen, setIsSharingScreen] = useState<boolean>(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [lastFrameTime, setLastFrameTime] = useState<number | null>(null);
  const [isInspectingHd, setIsInspectingHd] = useState<boolean>(false);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const imageCaptureRef = useRef<{
    track: MediaStreamTrack;
    instance: BrowserImageCaptureInstance;
  } | null>(null);
  const hdInspectionCountRef = useRef<number>(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live voice + vision session state
  const [liveState, setLiveState] = useState<LiveConnectionState>('idle');
  const [liveDetail, setLiveDetail] = useState<string>('');
  const [liveMuted, setLiveMuted] = useState<boolean>(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [audioLevels, setAudioLevels] = useState<AudioTelemetryLevels>(IDLE_TELEMETRY);
  const voiceSessionRef = useRef<OpenStudyVoiceSession | null>(null);

  // Local companion bridge + desktop overlay + active window tracking
  const [bridgeOnline, setBridgeOnline] = useState<boolean>(false);
  const [desktopOverlayEnabled, setDesktopOverlayEnabled] = useState<boolean>(false);
  const [activeWindowTitle, setActiveWindowTitle] = useState<string>('');

  // Chat state (shared between main view and Floating PiP window)
  const [messages, setMessages] = useState<TeacherChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [portalSyncBannerVisible, setPortalSyncBannerVisible] = useState<boolean>(false);
  const [pipInput, setPipInput] = useState<string>('');
  const [isAgentThinking, setIsAgentThinking] = useState<boolean>(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Skills tab UI state
  const [expandedSkillIds, setExpandedSkillIds] = useState<Record<string, boolean>>({});
  const [showNewSkillForm, setShowNewSkillForm] = useState<boolean>(false);
  const [skillNameInput, setSkillNameInput] = useState<string>('');
  const [skillDescInput, setSkillDescInput] = useState<string>('');
  const [skillTriggerInput, setSkillTriggerInput] = useState<string>('');
  const [skillInstructionsInput, setSkillInstructionsInput] = useState<string>('');

  // Memory tab UI state
  const [memoryCategory, setMemoryCategory] = useState<HermesMemoryEntry['category']>('preference');
  const [memoryFactInput, setMemoryFactInput] = useState<string>('');

  // Always-on-top Floating Teacher PiP window
  const pip = useFloatingTeacherPip(state.colorScheme);

  const activeCourse = useMemo(
    () => state.courses.find((c) => c.id === state.activeCourseId) ?? state.courses[0],
    [state.courses, state.activeCourseId]
  );

  const enabledSkillsCount = useMemo(
    () => state.hermesSkills.filter((sk) => sk.enabled).length,
    [state.hermesSkills]
  );

  const hasGeminiKey = state.provider.geminiApiKey.trim().length > 0;
  const normalizedBridgeUrl = useMemo(
    () => (state.provider.bridgeUrl.trim() || 'http://127.0.0.1:4319').replace(/\/+$/, ''),
    [state.provider.bridgeUrl]
  );

  // Keep fresh refs for async callbacks (Gemini Live tool calls & unthrottled frame workers)
  const stateRef = useRef<OpenStudyState>(state);
  stateRef.current = state;

  const activeWindowRef = useRef<string>(activeWindowTitle);
  activeWindowRef.current = activeWindowTitle;

  const isSharingRef = useRef<boolean>(isSharingScreen);
  isSharingRef.current = isSharingScreen;

  const bridgeOnlineRef = useRef<boolean>(bridgeOnline);
  bridgeOnlineRef.current = bridgeOnline;

  const normalizedBridgeUrlRef = useRef<string>(normalizedBridgeUrl);
  normalizedBridgeUrlRef.current = normalizedBridgeUrl;

  const beginHdInspection = useCallback(() => {
    hdInspectionCountRef.current += 1;
    setIsInspectingHd(true);
  }, []);

  const endHdInspection = useCallback(() => {
    hdInspectionCountRef.current = Math.max(0, hdInspectionCountRef.current - 1);
    if (hdInspectionCountRef.current === 0) {
      setIsInspectingHd(false);
    }
  }, []);

  // Hardware MediaStreamTrack frame capture (ImageCapture.grabFrame -> GPU ImageBitmap)
  // with clean fallback to <video> so occluded background tabs never emit frozen frames.
  const captureLiveStreamFrame = useCallback(
    async (options?: {
      maxWidth?: number;
      quality?: number;
      crop?: ScreenCropBox;
    }): Promise<CapturedFrameResult | null> => {
      const stream = screenStreamRef.current;
      const canvas = canvasRef.current;
      if (!stream || !canvas) return null;

      const maxWidth = options?.maxWidth ?? 1440;
      const quality = options?.quality ?? 0.84;
      const normCrop = normalizeCropPercent(options?.crop);

      const encodeSource = (
        source: ImageBitmap | HTMLVideoElement,
        srcW: number,
        srcH: number
      ): CapturedFrameResult | null => {
        if (!srcW || !srcH) return null;

        let sx = 0;
        let sy = 0;
        let sw = srcW;
        let sh = srcH;
        if (normCrop) {
          sx = Math.round((normCrop.x / 100) * srcW);
          sy = Math.round((normCrop.y / 100) * srcH);
          sw = Math.max(1, Math.min(srcW - sx, Math.round((normCrop.w / 100) * srcW)));
          sh = Math.max(1, Math.min(srcH - sy, Math.round((normCrop.h / 100) * srcH)));
        }

        const scale = sw > maxWidth ? maxWidth / sw : 1;
        const targetW = Math.max(1, Math.round(sw * scale));
        const targetH = Math.max(1, Math.round(sh * scale));

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, targetW, targetH);

        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (!dataUrl || !dataUrl.startsWith('data:image/jpeg;base64,')) {
          return null;
        }

        if (!normCrop) {
          setPreviewDataUrl(dataUrl);
        }
        setLastFrameTime(Date.now());

        return {
          base64: dataUrl.slice('data:image/jpeg;base64,'.length),
          width: targetW,
          height: targetH,
          source: 'screen-share',
        };
      };

      // Priority A: Direct hardware track grab via ImageCapture.grabFrame()
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && videoTrack.readyState === 'live') {
        const ImageCaptureCtor = (
          window as unknown as { ImageCapture?: BrowserImageCaptureConstructor }
        ).ImageCapture;

        if (typeof ImageCaptureCtor === 'function') {
          let bitmap: ImageBitmap | null = null;
          try {
            let captureInstance =
              imageCaptureRef.current?.track === videoTrack
                ? imageCaptureRef.current.instance
                : null;
            if (!captureInstance) {
              captureInstance = new ImageCaptureCtor(videoTrack);
              imageCaptureRef.current = { track: videoTrack, instance: captureInstance };
            }
            bitmap = await captureInstance.grabFrame();
            const encoded = encodeSource(bitmap, bitmap.width, bitmap.height);
            if (encoded) return encoded;
          } catch {
            if (imageCaptureRef.current?.track === videoTrack) {
              imageCaptureRef.current = null;
            }
          } finally {
            if (bitmap) {
              try {
                bitmap.close();
              } catch {
                // ignore
              }
            }
          }
        }
      }

      // Priority B: Fallback to mounted <video> element
      const video = videoRef.current;
      if (!video || video.readyState < 2) return null;
      return encodeSource(video, video.videoWidth, video.videoHeight);
    },
    []
  );

  // Full-resolution HD frame grabber for inspect_screen_detail, "Bildschirm prüfen", and chat turns
  const captureFreshFullResFrame = useCallback(
    async (crop?: ScreenCropBox): Promise<CapturedFrameResult | null> => {
      const normCrop = normalizeCropPercent(crop);
      beginHdInspection();
      try {
        // Priority 1: Pixel-perfect native Windows DPI screenshot via Companion Bridge
        if (bridgeOnlineRef.current) {
          const controller = new AbortController();
          const timeoutId = window.setTimeout(() => controller.abort(), 4500);
          try {
            const params = new URLSearchParams({
              maxWidth: '1920',
              quality: '90',
            });
            if (normCrop) {
              params.set('x', String(Math.round(normCrop.x * 10) / 10));
              params.set('y', String(Math.round(normCrop.y * 10) / 10));
              params.set('w', String(Math.round(normCrop.w * 10) / 10));
              params.set('h', String(Math.round(normCrop.h * 10) / 10));
            }

            const res = await fetch(
              `${normalizedBridgeUrlRef.current}/api/desktop/screenshot?${params.toString()}`,
              {
                method: 'GET',
                signal: controller.signal,
              }
            );

            if (res.status === 403) {
              // Respect local bridge privacy guard (password manager / banking / private window)
              return null;
            }

            if (res.ok) {
              const data = (await res.json().catch(() => null)) as {
                ok?: boolean;
                base64?: string;
                width?: number;
                height?: number;
                mimeType?: string;
                activeWindow?: string;
              } | null;

              if (data?.ok && typeof data.base64 === 'string' && data.base64.trim().length > 0) {
                const rawBase64 = data.base64.includes(';base64,')
                  ? data.base64.slice(data.base64.indexOf(';base64,') + ';base64,'.length)
                  : data.base64.trim();
                const mimeType =
                  typeof data.mimeType === 'string' && data.mimeType.startsWith('image/')
                    ? data.mimeType
                    : 'image/jpeg';
                const width =
                  typeof data.width === 'number' && data.width > 0 ? data.width : 1920;
                const height =
                  typeof data.height === 'number' && data.height > 0 ? data.height : 1080;

                if (!normCrop) {
                  setPreviewDataUrl(`data:${mimeType};base64,${rawBase64}`);
                }
                if (typeof data.activeWindow === 'string' && data.activeWindow.trim()) {
                  setActiveWindowTitle(data.activeWindow.trim().slice(0, 90));
                }
                setLastFrameTime(Date.now());

                return {
                  base64: rawBase64,
                  width,
                  height,
                  source: 'windows-bridge',
                };
              }
            }
          } catch {
            // Fall through cleanly to browser screen-share capture
          } finally {
            window.clearTimeout(timeoutId);
          }
        }

        // Priority 2: Hardware MediaStreamTrack HD capture (1920px @ 0.90)
        return await captureLiveStreamFrame({
          maxWidth: 1920,
          quality: 0.9,
          crop,
        });
      } finally {
        endHdInspection();
      }
    },
    [beginHdInspection, endHdInspection, captureLiveStreamFrame]
  );

  const toolHandlers = useMemo<HermesToolHandlers>(
    () => ({
      onHighlightScreen: (spotlight) => {
        onAddScreenSpotlight(spotlight);
      },
      onClearSpotlights: () => {
        onClearScreenSpotlights();
      },
      onCreateNote: (page) => {
        onUpsertNote(page);
      },
      onCreateCards: (cards) => {
        onAddCards(cards);
      },
      onAddPlanTasks: (tasks) => {
        onAddPlanTasks(tasks);
      },
      onAddSchoolScheduleItems: onAddSchoolScheduleItems
        ? (items) => {
            onAddSchoolScheduleItems(items);
          }
        : undefined,
      onNavigate: (view, courseId) => {
        if (courseId) {
          onSelectCourse(courseId);
        }
        onNavigate(view);
      },
      onSaveMemory: (entry) => {
        onAddHermesMemory(entry);
      },
      onSaveSkill: (skill) => {
        onUpsertHermesSkill(skill);
      },
      onLogAction: (entry) => {
        onLogHermesAction(entry);
      },
      captureFreshFullResFrame,
      bridgeUrl: bridgeOnline ? normalizedBridgeUrl : undefined,
      desktopOverlayEnabled: bridgeOnline && desktopOverlayEnabled,
    }),
    [
      onAddScreenSpotlight,
      onClearScreenSpotlights,
      onUpsertNote,
      onAddCards,
      onAddPlanTasks,
      onAddSchoolScheduleItems,
      onSelectCourse,
      onNavigate,
      onAddHermesMemory,
      onUpsertHermesSkill,
      onLogHermesAction,
      captureFreshFullResFrame,
      bridgeOnline,
      normalizedBridgeUrl,
      desktopOverlayEnabled,
    ]
  );

  const toolHandlersRef = useRef<HermesToolHandlers>(toolHandlers);
  toolHandlersRef.current = toolHandlers;

  // Detect local companion bridge once on mount / URL change
  useEffect(() => {
    let cancelled = false;
    void checkLocalBridge(normalizedBridgeUrl).then((res) => {
      if (!cancelled) {
        setBridgeOnline(res.online);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [normalizedBridgeUrl]);

  // Poll active PC window every 3.5s via unthrottled worker while bridge is online AND sharing or PiP is open
  useEffect(() => {
    if (!bridgeOnline || (!isSharingScreen && !pip.isOpen)) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const pollActiveWindow = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 1600);
        try {
          const res = await fetch(`${normalizedBridgeUrl}/api/desktop/active-window`, {
            method: 'GET',
            signal: controller.signal,
          });
          if (!res.ok || cancelled) return;
          const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          if (cancelled) return;
          const label = extractActiveWindowLabel(data);
          setActiveWindowTitle(label);
        } finally {
          window.clearTimeout(timer);
        }
      } catch {
        // Keep last known window silently if bridge poll times out
      } finally {
        inFlight = false;
      }
    };

    void pollActiveWindow();
    const stopTicker = createUnthrottledTicker(3500, () => {
      void pollActiveWindow();
    });

    return () => {
      cancelled = true;
      stopTicker();
    };
  }, [bridgeOnline, isSharingScreen, pip.isOpen, normalizedBridgeUrl]);

  const stopScreenShare = useCallback(() => {
    imageCaptureRef.current = null;
    const stream = screenStreamRef.current;
    screenStreamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.onended = null;
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsSharingScreen(false);
    setPreviewDataUrl(null);
    setLastFrameTime(null);
  }, []);

  const startScreenShare = useCallback(async (): Promise<boolean> => {
    setScreenError(null);
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setScreenError(
        'Dieser Browser unterstützt keine Bildschirmfreigabe. Nutze Chrome, Edge oder Firefox am Desktop.'
      );
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 5, max: 10 },
        },
        audio: false,
      });

      stopScreenShare();
      screenStreamRef.current = stream;

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          stopScreenShare();
        };
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }

      setIsSharingScreen(true);

      // Grab an initial crisp hardware preview snapshot shortly after playback starts
      window.setTimeout(() => {
        void captureLiveStreamFrame({ maxWidth: 1440, quality: 0.84 });
      }, 320);

      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setScreenError('Bildschirmfreigabe wurde abgebrochen.');
      } else {
        setScreenError(
          err instanceof Error
            ? `Bildschirmfreigabe fehlgeschlagen: ${err.message}`
            : 'Bildschirmfreigabe konnte nicht gestartet werden.'
        );
      }
      return false;
    }
  }, [stopScreenShare, captureLiveStreamFrame]);

  // Stream crisp 1440px hardware-captured frames every 1200ms via unthrottled Web Worker ticker
  // when BOTH screen share AND Gemini Live voice are active (also updates PiP previewDataUrl).
  useEffect(() => {
    if (!isSharingScreen || liveState !== 'connected') return;

    let cancelled = false;
    let inFlight = false;

    const pushFrame = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const frame = await captureLiveStreamFrame({
          maxWidth: 1440,
          quality: 0.84,
        });
        if (!cancelled && frame?.base64) {
          voiceSessionRef.current?.sendVideoFrame(frame.base64);
        }
      } finally {
        inFlight = false;
      }
    };

    void pushFrame();
    const stopTicker = createUnthrottledTicker(1200, () => {
      void pushFrame();
    });

    return () => {
      cancelled = true;
      stopTicker();
    };
  }, [isSharingScreen, liveState, captureLiveStreamFrame]);

  // Keep Floating PiP preview mirrored via unthrottled ticker when sharing screen without Live Voice
  useEffect(() => {
    if (!isSharingScreen || !pip.isOpen || liveState === 'connected') return;

    let cancelled = false;
    let inFlight = false;

    const refreshPreview = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await captureLiveStreamFrame({
          maxWidth: 1440,
          quality: 0.84,
        });
      } finally {
        inFlight = false;
      }
    };

    void refreshPreview();
    const stopTicker = createUnthrottledTicker(1200, () => {
      void refreshPreview();
    });

    return () => {
      cancelled = true;
      stopTicker();
    };
  }, [isSharingScreen, pip.isOpen, liveState, captureLiveStreamFrame]);

  // Upsert live voice transcript into unified chat feed
  const upsertVoiceTranscript = useCallback((entry: VoiceTranscriptEntry) => {
    if (!entry.text.trim()) return;
    const mappedRole: TeacherChatMessage['role'] =
      entry.role === 'model' ? 'assistant' : entry.role;

    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === entry.id);
      if (idx === -1) {
        return [
          ...prev,
          {
            id: entry.id,
            role: mappedRole,
            text: entry.text,
            timestamp: entry.timestamp,
            source: 'voice',
            withScreen: mappedRole === 'user' && isSharingRef.current,
          },
        ];
      }
      const next = prev.slice();
      next[idx] = {
        ...next[idx],
        text: entry.text,
        timestamp: entry.timestamp,
      };
      return next;
    });
  }, []);

  const getVoiceSession = useCallback(() => {
    if (!voiceSessionRef.current) {
      voiceSessionRef.current = new OpenStudyVoiceSession({
        onStateChange: (nextState, detail) => {
          setLiveState(nextState);
          setLiveDetail(detail ?? '');
          if (nextState === 'connected') {
            setLiveError(null);
          }
          if (nextState === 'idle') {
            setLiveMuted(false);
            setAudioLevels(IDLE_TELEMETRY);
          }
        },
        onAudioLevels: (levels) => {
          setAudioLevels(levels);
        },
        onTranscript: (entry) => {
          upsertVoiceTranscript(entry);
        },
        onError: (msg) => {
          setLiveError(msg);
        },
        onToolCall: async (calls) => {
          const results: Array<{
            id?: string;
            name: string;
            response: Record<string, unknown>;
          }> = [];
          const executions: HermesToolExecution[] = [];

          for (const call of calls) {
            const isHdInspect = call.name === 'inspect_screen_detail';
            if (isHdInspect) {
              beginHdInspection();
            }
            try {
              const res = await executeHermesToolCall(
                call,
                stateRef.current,
                toolHandlersRef.current
              );
              results.push({
                id: res.id,
                name: res.name,
                response: res.response,
              });
              executions.push(res.execution);
            } finally {
              if (isHdInspect) {
                endHdInspection();
              }
            }
          }

          if (executions.length > 0) {
            setMessages((prev) => [
              ...prev,
              {
                id: `voice-tools-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                role: 'assistant',
                text: executions.map((e) => e.summary).join('\n'),
                timestamp: Date.now(),
                source: 'voice',
                providerLabel: 'Hermes Live-Aktion',
                executedTools: executions,
              },
            ]);
          }

          return results;
        },
      });
    }
    return voiceSessionRef.current;
  }, [upsertVoiceTranscript, beginHdInspection, endHdInspection]);

  const stopLiveVoice = useCallback(() => {
    voiceSessionRef.current?.disconnect();
    setLiveMuted(false);
  }, []);

  const startLiveVoice = useCallback(async () => {
    setLiveError(null);
    if (!state.provider.geminiApiKey.trim()) {
      setLiveError(
        'Für Live-Sprache mit Bildschirmsehen wird ein Google AI Studio Schlüssel in den Einstellungen benötigt.'
      );
      return;
    }

    const systemPrompt = buildHermesTeacherSystemPrompt({
      state: stateRef.current,
      activeWindowTitle: activeWindowRef.current || undefined,
      screenShared: isSharingRef.current,
    });

    const session = getVoiceSession();
    await session.connect({
      apiKey: state.provider.geminiApiKey,
      preferredModel: state.provider.geminiLiveModel,
      freeOnlyLock: state.provider.freeOnlyLock,
      voiceName: state.voice.voiceName,
      languageLock: state.voice.languageLock,
      pace: state.voice.pace,
      systemPrompt,
      tools: [{ functionDeclarations: HERMES_LIVE_FUNCTION_DECLARATIONS }],
      highResVision: true,
    });
  }, [
    state.provider.geminiApiKey,
    state.provider.geminiLiveModel,
    state.provider.freeOnlyLock,
    state.voice.voiceName,
    state.voice.languageLock,
    state.voice.pace,
    getVoiceSession,
  ]);

  const toggleLiveVoice = useCallback(() => {
    if (liveState === 'connected' || liveState === 'connecting') {
      stopLiveVoice();
    } else {
      void startLiveVoice();
    }
  }, [liveState, stopLiveVoice, startLiveVoice]);

  const toggleLiveMute = useCallback(() => {
    if (liveState !== 'connected') return;
    const nextMuted = !liveMuted;
    setLiveMuted(nextMuted);
    voiceSessionRef.current?.setMuted(nextMuted);
  }, [liveState, liveMuted]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      voiceSessionRef.current?.disconnect();
      imageCaptureRef.current = null;
      const stream = screenStreamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          track.onended = null;
          try {
            track.stop();
          } catch {
            // ignore
          }
        }
        screenStreamRef.current = null;
      }
    };
  }, []);

  // Pre-fill chat composer when launched with an initial prompt (e.g. school portal sync)
  useEffect(() => {
    if (!initialPrompt || !initialPrompt.trim()) return;
    setStudioTab('chat');
    setChatInput(initialPrompt);
    setPortalSyncBannerVisible(true);
    onConsumeInitialPrompt?.();
  }, [initialPrompt, onConsumeInitialPrompt]);

  // Auto-scroll chat feed
  useEffect(() => {
    if (studioTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, isAgentThinking, studioTab]);

  // Send a prompt to Hermes (always capturing a crisp full-HD frame when sharing or bridge is online)
  const submitTeacherPrompt = useCallback(
    async (
      rawPrompt: string,
      options?: {
        forceScreenCapture?: boolean;
        prefetchedFrame?: CapturedFrameResult | null;
      }
    ) => {
      const trimmed = rawPrompt.trim();
      if (!trimmed || isAgentThinking) return;

      setAgentError(null);
      const shouldCapture =
        isSharingRef.current || bridgeOnlineRef.current || Boolean(options?.forceScreenCapture);
      const capturedFrame =
        options?.prefetchedFrame ??
        (shouldCapture ? await captureFreshFullResFrame() : null);
      const capturedBase64 = capturedFrame?.base64 ?? null;

      // When Live Voice is active and Gemini key is present, route directly into live audio + vision
      if (liveState === 'connected' && voiceSessionRef.current) {
        if (capturedBase64) {
          voiceSessionRef.current.sendVideoFrame(capturedBase64);
        }
        voiceSessionRef.current.sendText(trimmed);
        return;
      }

      const userMessage: TeacherChatMessage = {
        id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'user',
        text: trimmed,
        timestamp: Date.now(),
        withScreen: Boolean(capturedBase64),
        source: 'chat',
      };

      const historySnapshot = messages
        .filter((m): m is TeacherChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
        .slice(-10)
        .map((m) => ({ role: m.role, text: m.text }));

      setMessages((prev) => [...prev, userMessage]);
      setIsAgentThinking(true);

      try {
        const result = await runHermesAgentTurn({
          prompt: trimmed,
          history: historySnapshot,
          imageBase64: capturedBase64 ?? undefined,
          activeWindowTitle: activeWindowRef.current || undefined,
          state: stateRef.current,
          handlers: toolHandlersRef.current,
        });

        setMessages((prev) => [
          ...prev,
          {
            id: `ast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'assistant',
            text: result.reply,
            timestamp: Date.now(),
            providerLabel: result.providerLabel,
            source: 'chat',
            executedTools: result.executedTools,
          },
        ]);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Anfrage an Hermes konnte nicht verarbeitet werden.';
        setAgentError(msg);
      } finally {
        setIsAgentThinking(false);
      }
    },
    [isAgentThinking, captureFreshFullResFrame, liveState, messages]
  );

  // One-click "Bildschirm prüfen" action (shared by main stage and Floating PiP window)
  const handleInspectScreenNow = useCallback(async () => {
    setScreenError(null);
    let prefetchedFrame: CapturedFrameResult | null = null;

    if (isSharingRef.current || bridgeOnlineRef.current) {
      prefetchedFrame = await captureFreshFullResFrame();
    }

    if (!prefetchedFrame && !isSharingRef.current) {
      const started = await startScreenShare();
      if (!started) return;
      // Allow a brief moment for the first hardware video frame to decode
      await new Promise((resolve) => window.setTimeout(resolve, 420));
      prefetchedFrame = await captureFreshFullResFrame();
    }

    const inspectPrompt =
      'Prüfe meinen aktuellen Bildschirm: Erkläre mir kurz und klar, was du siehst, was der nächste sinnvolle Schritt ist, und markiere mit highlight_screen_region die wichtigsten Stellen zum Hinschauen oder Klicken.';
    await submitTeacherPrompt(inspectPrompt, {
      forceScreenCapture: true,
      prefetchedFrame,
    });
  }, [captureFreshFullResFrame, startScreenShare, submitTeacherPrompt]);

  const handleChatFormSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = chatInput.trim();
      if (!trimmed) return;
      setChatInput('');
      setPortalSyncBannerVisible(false);
      void submitTeacherPrompt(trimmed);
    },
    [chatInput, submitTeacherPrompt]
  );

  const handlePipFormSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = pipInput.trim();
      if (!trimmed) return;
      setPipInput('');
      void submitTeacherPrompt(trimmed);
    },
    [pipInput, submitTeacherPrompt]
  );

  const handleReFlashDesktopSpotlight = useCallback(
    (spot: ScreenSpotlight) => {
      if (!bridgeOnline || !desktopOverlayEnabled) return;
      void fetch(`${normalizedBridgeUrl}/api/desktop/highlight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: spot.id,
          xPercent: spot.xPercent,
          yPercent: spot.yPercent,
          label: spot.label,
          stepNumber: spot.stepNumber,
        }),
      }).catch(() => undefined);
    },
    [bridgeOnline, desktopOverlayEnabled, normalizedBridgeUrl]
  );

  const handleClearSpotlights = useCallback(() => {
    onClearScreenSpotlights();
    if (bridgeOnline && desktopOverlayEnabled) {
      void fetch(`${normalizedBridgeUrl}/api/desktop/highlight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      }).catch(() => undefined);
    }
  }, [onClearScreenSpotlights, bridgeOnline, desktopOverlayEnabled, normalizedBridgeUrl]);

  // Inline "Neuer Skill" submission
  const handleCreateSkill = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const rawName = skillNameInput.trim();
      const instructions = skillInstructionsInput.trim();
      if (!rawName || !instructions) return;

      const slugName = makeSlug(rawName);
      const newSkill: HermesSkill = {
        id: `skill-${Date.now().toString(36)}`,
        name: slugName,
        description: skillDescInput.trim() || `Lehranleitung für ${slugName}`,
        trigger: skillTriggerInput.trim() || 'Wenn die passende Lernsituation auftritt.',
        instructions,
        enabled: true,
        builtIn: false,
        updatedAt: new Date().toISOString().slice(0, 10),
      };

      onUpsertHermesSkill(newSkill);
      onLogHermesAction({
        id: `act-${Date.now().toString(36)}`,
        toolName: 'save_custom_skill',
        summary: `SKILL.md angelegt: ${newSkill.name}`,
        timestamp: new Date().toISOString(),
        status: 'ok',
      });

      setSkillNameInput('');
      setSkillDescInput('');
      setSkillTriggerInput('');
      setSkillInstructionsInput('');
      setShowNewSkillForm(false);
    },
    [
      skillNameInput,
      skillDescInput,
      skillTriggerInput,
      skillInstructionsInput,
      onUpsertHermesSkill,
      onLogHermesAction,
    ]
  );

  // Inline "Gedächtnis hinzufügen" submission
  const handleCreateMemory = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const fact = memoryFactInput.trim();
      if (!fact) return;

      onAddHermesMemory({
        id: `mem-${Date.now().toString(36)}`,
        fact,
        category: memoryCategory,
        createdAt: new Date().toISOString().slice(0, 10),
        source: 'user',
      });
      setMemoryFactInput('');
    },
    [memoryFactInput, memoryCategory, onAddHermesMemory]
  );

  const isLive = liveState === 'connected';
  const isConnecting = liveState === 'connecting';
  const speakerSpeaking = isLive && audioLevels.speaker > 0.04;
  const isActiveWatchOrVoice = isSharingScreen || isLive || isConnecting;

  const recentPipMessages = useMemo(() => messages.slice(-4), [messages]);
  const recentPipActions = useMemo(() => state.hermesActionLog.slice(0, 3), [state.hermesActionLog]);

  // Spotlight marker pins renderer (used identically on main 16:10 stage and inside Floating PiP window)
  const renderSpotlightMarkers = (compact: boolean) =>
    state.screenSpotlights.map((spot) => (
      <div
        key={spot.id}
        className="pointer-events-none absolute z-20 flex flex-col items-center"
        style={{
          left: `${clampPercent(spot.xPercent, 6, 94)}%`,
          top: `${clampPercent(spot.yPercent, 8, 92)}%`,
          transform: 'translate(-50%, -50%)',
        }}
      >
        <div
          className="relative flex items-center justify-center rounded-full"
          style={{
            width: compact ? 30 : 42,
            height: compact ? 30 : 42,
            border: '2px solid var(--accent-warm)',
            backgroundColor: 'rgba(217, 107, 39, 0.2)',
          }}
        >
          <span
            className="font-mono-num flex items-center justify-center rounded-full font-medium"
            style={{
              width: compact ? 18 : 24,
              height: compact ? 18 : 24,
              fontSize: compact ? 10.5 : 12,
              backgroundColor: 'var(--accent-warm)',
              color: '#fffcf8',
            }}
          >
            {spot.stepNumber}
          </span>
        </div>
        <span
          className="mt-1 rounded-full font-medium whitespace-nowrap"
          style={{
            padding: compact ? '2px 7px' : '3px 10px',
            fontSize: compact ? 10.5 : 12,
            backgroundColor: 'rgba(24, 36, 34, 0.92)',
            color: '#fbf8f2',
            border: '1px solid rgba(251, 248, 242, 0.16)',
            maxWidth: compact ? 150 : 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {spot.label}
        </span>
      </div>
    ));

  // Floating Always-on-Top Teacher Portal (Document Picture-in-Picture / Popup)
  const floatingTeacherPortal =
    pip.isOpen && pip.mountNode
      ? createPortal(
          <div
            className="flex flex-col h-screen w-full overflow-hidden"
            style={{
              backgroundColor: 'var(--bg-page)',
              color: 'var(--text-primary)',
            }}
          >
            {/* Compact Header */}
            <header
              className="flex items-center justify-between gap-2 px-3.5 py-2.5 shrink-0 border-b"
              style={{
                backgroundColor: 'var(--bg-card)',
                borderColor: 'var(--border-hairline)',
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="inline-block h-2 w-2 rounded-full shrink-0"
                  style={{
                    backgroundColor: isActiveWatchOrVoice
                      ? 'var(--accent-warm)'
                      : 'var(--accent)',
                  }}
                />
                <span
                  className="font-display text-[17px] font-normal leading-none truncate"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Hermes Lehrer
                </span>
                <span
                  className="text-[11px] truncate"
                  style={{
                    color: isInspectingHd ? 'var(--accent-warm)' : 'var(--text-muted)',
                  }}
                >
                  {isInspectingHd
                    ? 'HD-Prüfung läuft...'
                    : isLive
                      ? speakerSpeaking
                        ? 'Spricht'
                        : isSharingScreen
                          ? 'Live-Sicht aktiv · HD bereit'
                          : 'Live'
                      : isSharingScreen
                        ? 'Live-Sicht aktiv · HD bereit'
                        : bridgeOnline
                          ? 'HD-Prüfung bereit'
                          : 'Bereit'}
                </span>
              </div>

              <button
                type="button"
                onClick={pip.closeFloatingWindow}
                className="btn-ghost shrink-0"
                style={{ height: 28, padding: '0 8px', fontSize: 12 }}
              >
                <X size={13} strokeWidth={1.5} />
                <span>Zurück</span>
              </button>
            </header>

            {/* Compact Live Screen Thumbnail + Spotlight Pins */}
            {isSharingScreen || previewDataUrl ? (
              <div
                className="relative aspect-[16/9] w-full shrink-0 overflow-hidden border-b"
                style={{
                  backgroundColor: '#131d1b',
                  borderColor: 'var(--border-hairline)',
                }}
              >
                {previewDataUrl ? (
                  <img
                    src={previewDataUrl}
                    alt="Geteilter Bildschirm"
                    className="h-full w-full object-contain block"
                  />
                ) : (
                  <div
                    className="flex h-full w-full items-center justify-center text-[12px]"
                    style={{ color: 'rgba(251, 248, 242, 0.72)' }}
                  >
                    Bildschirmvorschau wird geladen...
                  </div>
                )}

                {renderSpotlightMarkers(true)}

                {activeWindowTitle && (
                  <div
                    className={`pointer-events-none absolute bottom-1.5 left-1.5 ${
                      lastFrameTime ? 'max-w-[66%]' : 'max-w-[85%]'
                    } truncate rounded-full px-2 py-0.5 text-[10.5px]`}
                    style={{
                      backgroundColor: 'rgba(24, 36, 34, 0.86)',
                      color: '#fbf8f2',
                    }}
                  >
                    {activeWindowTitle}
                  </div>
                )}

                {lastFrameTime && (
                  <div
                    className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-full px-2 py-0.5 font-mono-num text-[10px]"
                    style={{
                      backgroundColor: 'rgba(24, 36, 34, 0.84)',
                      color: isInspectingHd ? '#f5b88f' : 'rgba(251, 248, 242, 0.88)',
                    }}
                  >
                    {isInspectingHd ? 'HD...' : formatClockSeconds(lastFrameTime)}
                  </div>
                )}

                {state.screenSpotlights.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearSpotlights}
                    className="absolute top-1.5 right-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium cursor-pointer"
                    style={{
                      backgroundColor: 'rgba(24, 36, 34, 0.86)',
                      color: '#fbf8f2',
                      border: '1px solid rgba(251, 248, 242, 0.16)',
                    }}
                  >
                    Marker leeren
                  </button>
                )}
              </div>
            ) : (
              <div
                className="flex items-center justify-between gap-2 px-3.5 py-2 border-b shrink-0 text-[12px]"
                style={{
                  backgroundColor: 'var(--bg-raised)',
                  borderColor: 'var(--border-hairline)',
                  color: 'var(--text-secondary)',
                }}
              >
                <span className="truncate">
                  {activeWindowTitle
                    ? `Fenster: ${activeWindowTitle}`
                    : bridgeOnline
                      ? 'HD-Prüfung über Bridge bereit'
                      : 'Bildschirm noch nicht geteilt'}
                </span>
                <button
                  type="button"
                  onClick={() => void startScreenShare()}
                  className="text-[12px] font-medium cursor-pointer shrink-0 hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  Teilen
                </button>
              </div>
            )}

            {/* Big Accessible 2-Button Bar */}
            <div
              className="grid grid-cols-2 gap-2 px-3 py-2.5 border-b shrink-0"
              style={{
                backgroundColor: 'var(--bg-card)',
                borderColor: 'var(--border-hairline)',
              }}
            >
              <button
                type="button"
                onClick={toggleLiveVoice}
                className={isLive || isConnecting ? 'btn-warm w-full' : 'btn-accent w-full'}
                style={{ height: 34, fontSize: 12.5, padding: '0 10px' }}
              >
                {isConnecting ? (
                  <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                ) : isLive ? (
                  <MicOff size={14} strokeWidth={1.5} />
                ) : (
                  <Mic size={14} strokeWidth={1.5} />
                )}
                <span className="truncate">
                  {isConnecting ? 'Verbindet...' : isLive ? 'Stoppen' : 'Live sprechen'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleInspectScreenNow()}
                disabled={isAgentThinking}
                className="btn-secondary w-full"
                style={{
                  height: 34,
                  fontSize: 12.5,
                  padding: '0 10px',
                  opacity: isAgentThinking ? 0.6 : 1,
                }}
              >
                {isAgentThinking || isInspectingHd ? (
                  <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                ) : (
                  <Camera size={14} strokeWidth={1.5} />
                )}
                <span className="truncate">Bildschirm prüfen</span>
              </button>
            </div>

            {/* Recent Tool Actions & Last 4 Messages */}
            <div className="flex-1 overflow-y-auto px-3.5 py-2.5 space-y-2.5">
              {recentPipActions.length > 0 && (
                <div
                  className="flex flex-wrap gap-1 pb-2 border-b"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  {recentPipActions.map((act) => {
                    const isHdInspectTool = act.toolName === 'inspect_screen_detail';
                    const label = getToolDisplayLabel(act.toolName);
                    return (
                      <span
                        key={act.id}
                        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] max-w-full truncate"
                        style={{
                          backgroundColor:
                            act.status !== 'ok'
                              ? 'var(--negative-soft)'
                              : isHdInspectTool
                                ? 'var(--accent-warm-soft)'
                                : 'var(--accent-soft)',
                          border: `1px solid ${
                            act.status !== 'ok'
                              ? 'var(--negative)'
                              : isHdInspectTool
                                ? 'var(--accent-warm-border)'
                                : 'var(--accent-border)'
                          }`,
                          color:
                            act.status !== 'ok'
                              ? 'var(--negative)'
                              : isHdInspectTool
                                ? 'var(--accent-warm)'
                                : 'var(--accent)',
                        }}
                        title={act.summary}
                      >
                        {isHdInspectTool ? (
                          <Camera size={10} strokeWidth={1.7} className="shrink-0" />
                        ) : (
                          <Check size={10} strokeWidth={2} className="shrink-0" />
                        )}
                        <span className="truncate">
                          {isHdInspectTool ? label : act.summary}
                        </span>
                      </span>
                    );
                  })}
                </div>
              )}

              {(liveError || screenError || agentError) && (
                <div
                  className="border-l-2 pl-2.5 py-0.5 text-[11.5px]"
                  style={{
                    borderColor: 'var(--negative)',
                    color: 'var(--negative)',
                  }}
                >
                  {liveError || screenError || agentError}
                </div>
              )}

              {recentPipMessages.length === 0 ? (
                <div className="py-2 space-y-1.5 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                  <p className="m-0 font-medium" style={{ color: 'var(--text-primary)' }}>
                    Immer im Vordergrund bereit
                  </p>
                  <p className="m-0 leading-relaxed">
                    Wechsle jetzt zu Excel, Word, OneNote, VS Code oder einem PDF. Klicke auf «Bildschirm prüfen» oder stelle unten direkt eine Frage.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {recentPipMessages.map((msg) => {
                    const isUser = msg.role === 'user';
                    return (
                      <div
                        key={msg.id}
                        className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                      >
                        <div
                          className={
                            isUser
                              ? 'max-w-[90%] rounded-2xl px-3 py-1.5 text-[12.5px] leading-snug whitespace-pre-wrap'
                              : 'max-w-[96%] border-l-2 pl-2.5 py-0.5 text-[12.5px] leading-relaxed whitespace-pre-wrap'
                          }
                          style={
                            isUser
                              ? {
                                  backgroundColor: 'var(--bg-raised)',
                                  color: 'var(--text-primary)',
                                }
                              : {
                                  borderColor: 'var(--accent)',
                                  color: 'var(--text-primary)',
                                }
                          }
                        >
                          {msg.text}

                          {!isUser &&
                            msg.executedTools &&
                            msg.executedTools.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                {msg.executedTools.map((tool) => {
                                  const isHdInspectTool =
                                    tool.toolName === 'inspect_screen_detail';
                                  return (
                                    <span
                                      key={tool.id}
                                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                                      style={{
                                        backgroundColor:
                                          tool.status !== 'ok'
                                            ? 'var(--negative-soft)'
                                            : isHdInspectTool
                                              ? 'var(--accent-warm-soft)'
                                              : 'var(--accent-soft)',
                                        border: `1px solid ${
                                          tool.status !== 'ok'
                                            ? 'var(--negative)'
                                            : isHdInspectTool
                                              ? 'var(--accent-warm-border)'
                                              : 'var(--accent-border)'
                                        }`,
                                        color:
                                          tool.status !== 'ok'
                                            ? 'var(--negative)'
                                            : isHdInspectTool
                                              ? 'var(--accent-warm)'
                                              : 'var(--accent)',
                                      }}
                                      title={tool.summary}
                                    >
                                      {isHdInspectTool && (
                                        <Camera
                                          size={10}
                                          strokeWidth={1.7}
                                          className="shrink-0"
                                        />
                                      )}
                                      <span>{getToolDisplayLabel(tool.toolName)}</span>
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                        </div>
                      </div>
                    );
                  })}
                  {(isAgentThinking || isInspectingHd) && (
                    <div
                      className="flex items-center gap-1.5 text-[12px]"
                      style={{
                        color: isInspectingHd
                          ? 'var(--accent-warm)'
                          : 'var(--text-muted)',
                      }}
                    >
                      <Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
                      <span>
                        {isInspectingHd ? 'HD-Prüfung läuft...' : 'Hermes denkt nach...'}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Mini Question Input */}
            <form
              onSubmit={handlePipFormSubmit}
              className="flex items-center gap-1.5 px-3 py-2.5 border-t shrink-0"
              style={{
                backgroundColor: 'var(--bg-card)',
                borderColor: 'var(--border-hairline)',
              }}
            >
              <input
                type="text"
                value={pipInput}
                onChange={(e) => setPipInput(e.target.value)}
                placeholder="Frag zu deiner offenen App..."
                className="flex-1 h-8 px-3 rounded-full text-[12.5px]"
                style={{
                  backgroundColor: 'var(--bg-page)',
                  border: '1px solid var(--border-hairline)',
                  color: 'var(--text-primary)',
                }}
              />
              <button
                type="submit"
                disabled={!pipInput.trim() || isAgentThinking}
                className="btn-primary shrink-0"
                style={{
                  width: 32,
                  height: 32,
                  padding: 0,
                  opacity: pipInput.trim() && !isAgentThinking ? 1 : 0.45,
                }}
                aria-label="Frage senden"
                title="Frage senden"
              >
                <Send size={13} strokeWidth={1.5} />
              </button>
            </form>
          </div>,
          pip.mountNode
        )
      : null;

  return (
    <div className="mx-auto max-w-[1180px] pb-14 animate-enter">
      {/* Editorial Top Header */}
      <header
        className="flex flex-col gap-5 border-b pb-6 lg:flex-row lg:items-end lg:justify-between"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div className="space-y-2 min-w-0">
          <div
            className="flex flex-wrap items-center gap-2 text-[13px]"
            style={{ color: 'var(--text-secondary)' }}
          >
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full shrink-0"
                style={{
                  backgroundColor: isActiveWatchOrVoice
                    ? 'var(--accent-warm)'
                    : 'var(--text-muted)',
                }}
              />
              <span>
                {isLive && isSharingScreen
                  ? 'Live-Sprache & Bildschirm aktiv'
                  : isLive
                    ? 'Live-Sprache aktiv'
                    : isSharingScreen
                      ? 'Bildschirm geteilt'
                      : 'Bereit'}
              </span>
            </span>

            {activeCourse && (
              <>
                <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                  ·
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: activeCourse.accentColor }}
                  />
                  <select
                    value={activeCourse.id}
                    onChange={(e) => onSelectCourse(e.target.value)}
                    aria-label="Aktives Fach wählen"
                    className="bg-transparent border-0 p-0 text-[13px] font-medium cursor-pointer focus:outline-none"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {state.courses.map((course) => (
                      <option
                        key={course.id}
                        value={course.id}
                        style={{
                          backgroundColor: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        {course.title}
                      </option>
                    ))}
                  </select>
                </span>
              </>
            )}

            {bridgeOnline && activeWindowTitle && (
              <>
                <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                  ·
                </span>
                <span
                  className="truncate max-w-[300px]"
                  style={{ color: 'var(--text-muted)' }}
                  title={activeWindowTitle}
                >
                  Aktives Fenster: {activeWindowTitle}
                </span>
              </>
            )}
          </div>

          <h1
            className="font-display text-[32px] sm:text-[38px] font-normal leading-[1.12] m-0"
            style={{ color: 'var(--text-primary)' }}
          >
            Hermes Bildschirm-Lehrer
          </h1>
          <p
            className="text-[14px] leading-relaxed max-w-[660px] m-0"
            style={{ color: 'var(--text-secondary)' }}
          >
            Hermes sieht deinen geteilten Bildschirm auch über andere Programme hinweg, spricht live mit dir, setzt visuelle Marker auf Klickpunkte und erstellt bei Bedarf direkt Notizen oder Karteikarten.
          </p>
        </div>

        <div className="flex flex-col items-start lg:items-end gap-2 shrink-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => {
                if (pip.isOpen) {
                  pip.closeFloatingWindow();
                } else {
                  void pip.openFloatingWindow();
                }
              }}
              className={pip.isOpen ? 'btn-warm' : 'btn-accent'}
              title={
                pip.supportsDocumentPip
                  ? 'Bleibt als schwebendes Fenster über Excel, Word, Code und Browser sichtbar'
                  : 'Öffnet ein kompaktes Begleitfenster neben deinen Apps'
              }
            >
              <PictureInPicture2 size={15} strokeWidth={1.5} />
              <span>{pip.isOpen ? 'Schwebendes Fenster schliessen' : 'Schwebendes Fenster'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (isSharingScreen) {
                  stopScreenShare();
                } else {
                  void startScreenShare();
                }
              }}
              className="btn-secondary"
              style={
                isSharingScreen
                  ? {
                      borderColor: 'var(--accent-warm-border)',
                      color: 'var(--accent-warm)',
                    }
                  : undefined
              }
            >
              <Monitor size={15} strokeWidth={1.5} />
              <span>{isSharingScreen ? 'Freigabe beenden' : 'Bildschirm teilen'}</span>
            </button>
          </div>

          {!hasGeminiKey && state.provider.activeTextProvider === 'gemini-free' && (
            <div className="flex items-center gap-3 text-[12.5px]">
              <button
                type="button"
                onClick={onOpenOnboarding}
                className="font-medium cursor-pointer hover:underline"
                style={{ color: 'var(--accent)' }}
              >
                Einrichtung starten
              </button>
              <span style={{ color: 'var(--border-strong)' }}>·</span>
              <button
                type="button"
                onClick={onOpenSettings}
                className="font-medium cursor-pointer hover:underline"
                style={{ color: 'var(--text-secondary)' }}
              >
                Einstellungen
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Serene Focus 2-Column Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 xl:gap-10 pt-7 items-start">
        {/* LEFT COLUMN (7 cols): Live Screen Stage, Spotlights & Voice Vision Controls */}
        <div className="xl:col-span-7 space-y-6">
          {/* Single Quiet Surface: 16:10 Screen Stage + Bottom Control Strip */}
          <section className="surface-card overflow-hidden" aria-label="Bildschirm-Bühne">
            <div
              className="relative aspect-[16/10] w-full overflow-hidden"
              style={{
                backgroundColor: isSharingScreen ? '#121c1a' : 'var(--bg-card)',
              }}
            >
              {/* Always-mounted video & hidden capture canvas */}
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                onLoadedData={() => {
                  void captureLiveStreamFrame({ maxWidth: 1440, quality: 0.84 });
                }}
                className={`h-full w-full object-contain transition-opacity duration-200 ${
                  isSharingScreen ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
              />
              <canvas ref={canvasRef} className="hidden" />

              {/* Calm Empty State when screen sharing is inactive */}
              {!isSharingScreen && (
                <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
                  <Monitor
                    size={26}
                    strokeWidth={1.4}
                    style={{ color: 'var(--accent)' }}
                  />
                  <h2
                    className="font-display text-[23px] font-normal mt-3.5 mb-1.5"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    Bildschirm oder App freigeben
                  </h2>
                  <p
                    className="text-[13.5px] leading-relaxed max-w-[440px] m-0"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Wähle Excel, Word, OneNote, VS Code, ein PDF oder deinen gesamten Bildschirm. Öffne danach das schwebende Fenster, damit Hermes auch ausserhalb von OpenStudy sichtbar bleibt.
                  </p>
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => void startScreenShare()}
                      className="btn-accent"
                    >
                      <Monitor size={15} strokeWidth={1.5} />
                      <span>Bildschirm auswählen</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void pip.openFloatingWindow()}
                      className="btn-secondary"
                    >
                      <PictureInPicture2 size={15} strokeWidth={1.5} />
                      <span>Schwebendes Fenster</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Live Stage Top Indicators + Numbered Teacher Spotlights */}
              {isSharingScreen && (
                <>
                  <div className="pointer-events-none absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium"
                      style={{
                        backgroundColor: 'rgba(24, 36, 34, 0.84)',
                        color: '#fbf8f2',
                      }}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: 'var(--accent-warm)' }}
                      />
                      <span>
                        {isInspectingHd ? 'HD-Prüfung läuft...' : 'Live-Bildschirm'}
                      </span>
                      {isLive && !isInspectingHd && (
                        <span className="font-mono-num opacity-80">· HD-Stream</span>
                      )}
                      {lastFrameTime && !isInspectingHd && (
                        <span className="font-mono-num opacity-75">
                          · {formatClockSeconds(lastFrameTime)}
                        </span>
                      )}
                    </span>
                  </div>

                  {state.screenSpotlights.length > 0 && (
                    <button
                      type="button"
                      onClick={handleClearSpotlights}
                      className="absolute top-3 right-3 z-20 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium cursor-pointer transition-opacity hover:opacity-90"
                      style={{
                        backgroundColor: 'rgba(24, 36, 34, 0.86)',
                        color: '#fbf8f2',
                        border: '1px solid rgba(251, 248, 242, 0.16)',
                      }}
                    >
                      <X size={13} strokeWidth={1.5} />
                      <span>Marker leeren</span>
                    </button>
                  )}

                  {renderSpotlightMarkers(false)}
                </>
              )}
            </div>

            {/* Clean Hairline Stage Control Strip (not a nested box) */}
            <div
              className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3"
              style={{
                borderColor: 'var(--border-hairline)',
                backgroundColor: 'var(--bg-card)',
              }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={toggleLiveVoice}
                  className={isLive || isConnecting ? 'btn-warm' : 'btn-accent'}
                  style={{ height: 34, fontSize: 13 }}
                >
                  {isConnecting ? (
                    <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                  ) : isLive ? (
                    <MicOff size={14} strokeWidth={1.5} />
                  ) : (
                    <Mic size={14} strokeWidth={1.5} />
                  )}
                  <span>
                    {isConnecting
                      ? 'Verbindet...'
                      : isLive
                        ? 'Live-Sprache stoppen'
                        : 'Live sprechen'}
                  </span>
                </button>

                {isLive && (
                  <button
                    type="button"
                    onClick={toggleLiveMute}
                    className="btn-secondary"
                    style={{
                      height: 34,
                      fontSize: 13,
                      color: liveMuted ? 'var(--accent-warm)' : 'var(--text-primary)',
                      borderColor: liveMuted
                        ? 'var(--accent-warm-border)'
                        : 'var(--border-hairline)',
                    }}
                    title={liveMuted ? 'Mikrofon aktivieren' : 'Mikrofon stummschalten'}
                  >
                    {liveMuted ? (
                      <MicOff size={14} strokeWidth={1.5} />
                    ) : (
                      <Mic size={14} strokeWidth={1.5} />
                    )}
                    <span>{liveMuted ? 'Stumm' : 'Mikrofon an'}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void handleInspectScreenNow()}
                  disabled={isAgentThinking}
                  className="btn-secondary"
                  style={{
                    height: 34,
                    fontSize: 13,
                    opacity: isAgentThinking ? 0.6 : 1,
                  }}
                >
                  {isAgentThinking || isInspectingHd ? (
                    <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                  ) : (
                    <Camera size={14} strokeWidth={1.5} />
                  )}
                  <span>Bildschirm prüfen</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {state.screenSpotlights.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearSpotlights}
                    className="btn-ghost"
                    style={{ height: 30, fontSize: 12.5 }}
                  >
                    <X size={13} strokeWidth={1.5} />
                    <span>Marker leeren</span>
                  </button>
                )}

                {bridgeOnline && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={desktopOverlayEnabled}
                    onClick={() => setDesktopOverlayEnabled((v) => !v)}
                    className="btn-secondary"
                    style={{
                      height: 32,
                      padding: '0 11px',
                      fontSize: 12.5,
                      backgroundColor: desktopOverlayEnabled
                        ? 'var(--accent-warm-soft)'
                        : 'var(--bg-card)',
                      borderColor: desktopOverlayEnabled
                        ? 'var(--accent-warm-border)'
                        : 'var(--border-hairline)',
                      color: desktopOverlayEnabled
                        ? 'var(--accent-warm)'
                        : 'var(--text-secondary)',
                    }}
                    title="Blendet Hermes-Marker zusätzlich direkt über anderen Windows-Programmen ein"
                  >
                    <Crosshair size={13} strokeWidth={1.5} />
                    <span>Desktop-Zeiger (Bridge)</span>
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Errors (if any) as clean editorial left-border notices */}
          {(screenError || liveError) && (
            <div
              className="border-l-2 pl-3.5 py-1 text-[13px] flex items-center justify-between gap-3"
              style={{
                borderColor: 'var(--negative)',
                color: 'var(--negative)',
              }}
              role="alert"
            >
              <span>{screenError || liveError}</span>
              {!hasGeminiKey && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="text-[12.5px] font-medium shrink-0 cursor-pointer hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  Einstellungen
                </button>
              )}
            </div>
          )}

          {/* Open Hairline Live Voice Telemetry & Cross-App Context Strip */}
          <section
            className="border-t pt-4 space-y-4"
            style={{ borderColor: 'var(--border-hairline)' }}
            aria-label="Sitzungsstatus und aktive Marker"
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-2 text-[13.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  <span>
                    {isInspectingHd
                      ? 'HD-Prüfung läuft...'
                      : isConnecting
                        ? liveDetail || 'Verbindet mit Gemini Live...'
                        : isLive
                          ? speakerSpeaking
                            ? `${state.voice.voiceName} erklärt gerade`
                            : liveMuted
                              ? 'Mikrofon stummgeschaltet'
                              : isSharingScreen
                                ? 'Hermes hört zu und sieht deinen Bildschirm live'
                                : 'Hermes hört zu'
                          : 'Sprach- und Bildschirmkontext'}
                  </span>
                </div>
                <div
                  className="flex flex-wrap items-center gap-1.5 text-[12.5px]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <span>Stimme: {state.voice.voiceName}</span>
                  <span>·</span>
                  <span>{LANGUAGE_META[state.voice.languageLock].nameDe}</span>
                  <span>·</span>
                  <span>{state.voice.stance === 'coach' ? 'Coach' : 'Assistenz'}</span>
                  {(isSharingScreen || bridgeOnline || isInspectingHd) && (
                    <>
                      <span>·</span>
                      <span
                        style={{
                          color: isInspectingHd ? 'var(--accent-warm)' : 'var(--accent)',
                        }}
                      >
                        {isInspectingHd
                          ? 'HD-Prüfung läuft...'
                          : isSharingScreen
                            ? 'Live-Sicht aktiv · HD-Prüfung bereit'
                            : 'HD-Prüfung bereit'}
                      </span>
                    </>
                  )}
                  {lastFrameTime && (isSharingScreen || bridgeOnline) && (
                    <>
                      <span>·</span>
                      <span className="font-mono-num" title="Letztes erfasstes Bild">
                        Stand {formatClockSeconds(lastFrameTime)}
                      </span>
                    </>
                  )}
                  {bridgeOnline && (
                    <>
                      <span>·</span>
                      <span>Companion Bridge</span>
                    </>
                  )}
                </div>
              </div>

              {/* 12-Bar Audio Telemetry + Quick Settings link */}
              <div className="flex items-center gap-3 shrink-0">
                {isLive && (
                  <div
                    className="flex items-end gap-[3px] h-6"
                    aria-label="Live-Audiopegel"
                  >
                    {audioLevels.bars.map((level, idx) => (
                      <span
                        key={idx}
                        className="w-[3px] rounded-full transition-all duration-75"
                        style={{
                          height: `${Math.max(14, Math.min(100, Math.round(level * 100)))}%`,
                          backgroundColor: liveMuted
                            ? 'var(--border-strong)'
                            : speakerSpeaking
                              ? 'var(--accent-warm)'
                              : 'var(--accent)',
                        }}
                      />
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="btn-ghost"
                  style={{ height: 30, fontSize: 12.5 }}
                >
                  <SlidersHorizontal size={13} strokeWidth={1.5} />
                  <span>Anbieter</span>
                </button>
              </div>
            </div>

            {/* Active Numbered Teacher Markers List */}
            {state.screenSpotlights.length > 0 && (
              <div
                className="border-t pt-3.5"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span
                    className="text-[12.5px] font-medium"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Gesetzte Lehrer-Marker ({state.screenSpotlights.length})
                  </span>
                  <button
                    type="button"
                    onClick={handleClearSpotlights}
                    className="text-[12px] cursor-pointer hover:underline"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Alle entfernen
                  </button>
                </div>
                <div
                  className="divide-y border-t border-b"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  {state.screenSpotlights.map((spot) => (
                    <div
                      key={spot.id}
                      className="flex items-center justify-between gap-3 py-2 text-[13px]"
                      style={{ borderColor: 'var(--border-hairline)' }}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className="font-mono-num inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium"
                          style={{
                            backgroundColor: 'var(--accent-warm)',
                            color: '#fffcf8',
                          }}
                        >
                          {spot.stepNumber}
                        </span>
                        <span
                          className="truncate font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {spot.label}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <span
                          className="font-mono-num text-[11.5px]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {Math.round(spot.xPercent)}% / {Math.round(spot.yPercent)}%
                        </span>
                        {bridgeOnline && desktopOverlayEnabled && (
                          <button
                            type="button"
                            onClick={() => handleReFlashDesktopSpotlight(spot)}
                            className="text-[12px] font-medium cursor-pointer hover:underline"
                            style={{ color: 'var(--accent-warm)' }}
                          >
                            Erneut zeigen
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>

        {/* RIGHT COLUMN (5 cols): Clean 3-Tab Hermes Studio (Gespräch | Skills | Gedächtnis) */}
        <aside
          className="xl:col-span-5 surface-card flex flex-col xl:h-[710px] min-h-[560px] overflow-hidden"
          aria-label="Hermes Studio"
        >
          {/* Tab Header + Coach/Assistenz Switch */}
          <div
            className="flex items-center justify-between gap-2 border-b px-4 pt-2.5 shrink-0"
            style={{ borderColor: 'var(--border-hairline)' }}
          >
            <div className="flex items-center gap-4" role="tablist" aria-label="Hermes Bereiche">
              {(
                [
                  { id: 'chat', label: 'Gespräch' },
                  { id: 'skills', label: 'Skills', count: enabledSkillsCount },
                  { id: 'memory', label: 'Gedächtnis', count: state.hermesMemory.length },
                ] as Array<{ id: StudioTab; label: string; count?: number }>
              ).map((tab) => {
                const active = studioTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setStudioTab(tab.id)}
                    className="relative pb-2.5 text-[13.5px] font-medium cursor-pointer transition-colors inline-flex items-center gap-1.5"
                    style={{
                      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                  >
                    <span>{tab.label}</span>
                    {tab.count !== undefined && (
                      <span
                        className="font-mono-num text-[11px]"
                        style={{ color: active ? 'var(--accent)' : 'var(--text-muted)' }}
                      >
                        {tab.count}
                      </span>
                    )}
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full"
                        style={{ backgroundColor: 'var(--accent)' }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Coach vs Assistenz Segmented Switch */}
            <div
              className="mb-2 inline-flex p-0.5 rounded-full shrink-0"
              style={{ backgroundColor: 'var(--bg-raised)' }}
              role="group"
              aria-label="Haltung von Hermes"
            >
              {(
                [
                  { id: 'coach', label: 'Coach' },
                  { id: 'assistant', label: 'Assistenz' },
                ] as Array<{ id: AgentStance; label: string }>
              ).map((item) => {
                const active = state.voice.stance === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onUpdateVoice({ stance: item.id })}
                    className="h-6 px-2.5 rounded-full text-[11.5px] font-medium transition-colors cursor-pointer"
                    style={{
                      backgroundColor: active ? 'var(--bg-card)' : 'transparent',
                      color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* TAB 1: GESPRÄCH */}
          {studioTab === 'chat' && (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
                {messages.length === 0 ? (
                  <div className="space-y-5">
                    <div className="space-y-1.5">
                      <h2
                        className="font-display text-[20px] font-normal m-0"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Frag direkt zu deiner aktuellen Aufgabe
                      </h2>
                      <p
                        className="text-[13px] leading-relaxed m-0"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        Bei aktiver Bildschirmfreigabe wird das aktuelle Bild automatisch mitgesendet. Hermes setzt Marker und legt auf Wunsch Notizen oder Karteikarten an.
                      </p>
                    </div>

                    <div
                      className="border-t"
                      style={{ borderColor: 'var(--border-hairline)' }}
                    >
                      {QUICK_PROMPTS.map((promptText) => (
                        <button
                          key={promptText}
                          type="button"
                          onClick={() => void submitTeacherPrompt(promptText)}
                          disabled={isAgentThinking}
                          className="w-full flex items-center justify-between gap-3 border-b py-3 px-1 text-left text-[13.5px] cursor-pointer transition-colors hover:bg-[var(--bg-hover)]/35 group"
                          style={{
                            borderColor: 'var(--border-hairline)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          <span className="leading-snug">{promptText}</span>
                          <ArrowUpRight
                            size={14}
                            strokeWidth={1.5}
                            className="shrink-0 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
                            style={{ color: 'var(--accent)' }}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {messages.map((msg) => {
                      if (msg.role === 'system') {
                        return (
                          <div
                            key={msg.id}
                            className="text-center text-[11.5px] py-1"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {msg.text}
                          </div>
                        );
                      }

                      const isUser = msg.role === 'user';
                      return (
                        <div
                          key={msg.id}
                          className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                        >
                          <div
                            className="mb-1 flex items-center gap-1.5 text-[11px] px-0.5"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <span>{isUser ? 'Du' : 'Hermes'}</span>
                            {msg.withScreen && (
                              <>
                                <span>·</span>
                                <span style={{ color: 'var(--accent-warm)' }}>
                                  mit Bildschirm
                                </span>
                              </>
                            )}
                            {msg.source === 'voice' && (
                              <>
                                <span>·</span>
                                <span>Live</span>
                              </>
                            )}
                            <span>·</span>
                            <span className="font-mono-num">
                              {formatClockTime(msg.timestamp)}
                            </span>
                          </div>

                          <div
                            className={
                              isUser
                                ? 'max-w-[88%] rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap'
                                : 'max-w-[96%] border-l-2 pl-3.5 py-0.5 text-[13.5px] leading-relaxed whitespace-pre-wrap'
                            }
                            style={
                              isUser
                                ? {
                                    backgroundColor: 'var(--bg-raised)',
                                    color: 'var(--text-primary)',
                                  }
                                : {
                                    borderColor: 'var(--accent)',
                                    color: 'var(--text-primary)',
                                  }
                            }
                          >
                            {msg.text}

                            {!isUser &&
                              msg.executedTools &&
                              msg.executedTools.length > 0 && (
                                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                                  {msg.executedTools.map((tool) => {
                                    const nav = getToolNavigationTarget(tool.toolName);
                                    const isHdInspectTool =
                                      tool.toolName === 'inspect_screen_detail';
                                    return (
                                      <span
                                        key={tool.id}
                                        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium"
                                        style={{
                                          backgroundColor:
                                            tool.status !== 'ok'
                                              ? 'var(--negative-soft)'
                                              : isHdInspectTool
                                                ? 'var(--accent-warm-soft)'
                                                : 'var(--accent-soft)',
                                          border: `1px solid ${
                                            tool.status !== 'ok'
                                              ? 'var(--negative)'
                                              : isHdInspectTool
                                                ? 'var(--accent-warm-border)'
                                                : 'var(--accent-border)'
                                          }`,
                                          color:
                                            tool.status !== 'ok'
                                              ? 'var(--negative)'
                                              : isHdInspectTool
                                                ? 'var(--accent-warm)'
                                                : 'var(--accent)',
                                        }}
                                        title={tool.summary}
                                      >
                                        {isHdInspectTool && (
                                          <Camera
                                            size={11}
                                            strokeWidth={1.6}
                                            className="shrink-0"
                                          />
                                        )}
                                        <span>{getToolDisplayLabel(tool.toolName)}</span>
                                        {nav && tool.status === 'ok' && (
                                          <button
                                            type="button"
                                            onClick={() => onNavigate(nav.view)}
                                            className="underline cursor-pointer font-medium"
                                            style={{ color: 'inherit' }}
                                          >
                                            {nav.label}
                                          </button>
                                        )}
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                          </div>
                        </div>
                      );
                    })}

                    {(isAgentThinking || isInspectingHd) && (
                      <div
                        className="flex items-center gap-2 border-l-2 pl-3.5 py-1 text-[13px]"
                        style={{
                          borderColor: 'var(--accent-warm)',
                          color: isInspectingHd
                            ? 'var(--accent-warm)'
                            : 'var(--text-secondary)',
                        }}
                      >
                        <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                        <span>
                          {isInspectingHd
                            ? 'HD-Prüfung läuft...'
                            : isSharingScreen || bridgeOnline
                              ? 'Hermes prüft Bildschirm und Kontext...'
                              : 'Hermes bereitet Antwort vor...'}
                        </span>
                      </div>
                    )}

                    {agentError && (
                      <div
                        className="border-l-2 pl-3.5 py-1 text-[12.5px]"
                        style={{
                          borderColor: 'var(--negative)',
                          color: 'var(--negative)',
                        }}
                        role="alert"
                      >
                        {agentError}
                      </div>
                    )}

                    <div ref={chatEndRef} />
                  </div>
                )}
              </div>

              {/* Compact Quick Prompts Bar once conversation has started */}
              {messages.length > 0 && (
                <div
                  className="border-t px-4 py-2 flex items-center gap-1.5 overflow-x-auto shrink-0"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  {QUICK_PROMPTS.map((promptText) => (
                    <button
                      key={promptText}
                      type="button"
                      disabled={isAgentThinking}
                      onClick={() => void submitTeacherPrompt(promptText)}
                      className="btn-secondary shrink-0"
                      style={{ height: 26, padding: '0 10px', fontSize: 11.5 }}
                    >
                      {promptText}
                    </button>
                  ))}
                </div>
              )}

              {/* Chat Input Footer */}
              <div
                className="border-t px-4 py-3 space-y-2 shrink-0"
                style={{
                  borderColor: 'var(--border-hairline)',
                  backgroundColor: 'var(--bg-page)',
                }}
              >
                <div className="flex items-center justify-between gap-2 text-[12px]">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                      style={{
                        backgroundColor:
                          isInspectingHd || isSharingScreen
                            ? 'var(--accent-warm)'
                            : bridgeOnline
                              ? 'var(--accent)'
                              : 'var(--border-strong)',
                      }}
                    />
                    {isInspectingHd ? (
                      <span
                        className="font-medium truncate"
                        style={{ color: 'var(--accent-warm)' }}
                      >
                        HD-Prüfung läuft...
                      </span>
                    ) : isSharingScreen ? (
                      <span
                        className="font-medium truncate"
                        style={{ color: 'var(--accent-warm)' }}
                      >
                        Live-Sicht aktiv · HD-Prüfung bereit
                      </span>
                    ) : bridgeOnline ? (
                      <span className="inline-flex items-center gap-1.5 min-w-0">
                        <span
                          className="font-medium truncate"
                          style={{ color: 'var(--accent)' }}
                        >
                          HD-Prüfung über Bridge bereit
                        </span>
                        <span style={{ color: 'var(--border-strong)' }}>·</span>
                        <button
                          type="button"
                          onClick={() => void startScreenShare()}
                          className="shrink-0 cursor-pointer hover:underline"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          Live teilen
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void startScreenShare()}
                        className="truncate cursor-pointer hover:underline"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Ohne Bildschirm · jetzt teilen
                      </button>
                    )}
                  </div>

                  {messages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setMessages([]);
                        setAgentError(null);
                      }}
                      className="text-[11.5px] cursor-pointer hover:underline shrink-0"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Verlauf leeren
                    </button>
                  )}
                </div>

                {portalSyncBannerVisible && (
                  <div
                    className="border-l-2 pl-3 py-1 flex items-start justify-between gap-2 text-[12.5px] leading-snug"
                    style={{
                      borderColor: 'var(--accent)',
                      color: 'var(--text-secondary)',
                    }}
                    role="status"
                  >
                    <span>
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                        Portal-Abgleich bereit:
                      </span>{' '}
                      Teile dein geöffnetes Schulportal-Fenster und sende den Auftrag ab.
                    </span>
                    <button
                      type="button"
                      onClick={() => setPortalSyncBannerVisible(false)}
                      aria-label="Hinweis schliessen"
                      className="p-0.5 shrink-0 cursor-pointer"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <X size={13} strokeWidth={1.5} />
                    </button>
                  </div>
                )}

                <form onSubmit={handleChatFormSubmit} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={
                      isSharingScreen
                        ? 'Frag Hermes zu deinem geteilten Bildschirm...'
                        : 'Stelle Hermes eine Frage oder gib eine Aufgabe...'
                    }
                    className="flex-1 h-9 px-3.5 rounded-full text-[13px]"
                    style={{
                      backgroundColor: 'var(--bg-card)',
                      border: '1px solid var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  />
                  <button
                    type="submit"
                    disabled={!chatInput.trim() || isAgentThinking}
                    className="btn-primary shrink-0"
                    style={{
                      width: 36,
                      padding: 0,
                      opacity: chatInput.trim() && !isAgentThinking ? 1 : 0.45,
                    }}
                    aria-label="Nachricht senden"
                    title="Nachricht senden"
                  >
                    <Send size={15} strokeWidth={1.5} />
                  </button>
                </form>
              </div>
            </>
          )}

          {/* TAB 2: SKILLS (SKILL.md Hermes Registry) */}
          {studioTab === 'skills' && (
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div
                    className="flex items-center gap-1.5 text-[13.5px] font-medium"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    <BookOpen size={14} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                    <span>Hermes SKILL.md Registry</span>
                  </div>
                  <p className="text-[12px] m-0 mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Aktive Lehranweisungen werden automatisch in den Hermes-Kontext eingebunden.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNewSkillForm((v) => !v)}
                  className="btn-secondary shrink-0"
                  style={{ height: 30, padding: '0 11px', fontSize: 12 }}
                >
                  {showNewSkillForm ? (
                    <>
                      <X size={13} strokeWidth={1.5} />
                      <span>Schliessen</span>
                    </>
                  ) : (
                    <>
                      <Plus size={13} strokeWidth={1.5} />
                      <span>Neuer Skill</span>
                    </>
                  )}
                </button>
              </div>

              {/* Inline "Neuer Skill" Form */}
              {showNewSkillForm && (
                <form
                  onSubmit={handleCreateSkill}
                  className="border-t border-b py-3.5 space-y-2.5"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={skillNameInput}
                      onChange={(e) => setSkillNameInput(e.target.value)}
                      placeholder="Name, z. B. excel-formel-coach"
                      className="h-8 px-2.5 rounded-lg text-[12.5px]"
                      style={{
                        backgroundColor: 'var(--bg-page)',
                        border: '1px solid var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      required
                    />
                    <input
                      type="text"
                      value={skillDescInput}
                      onChange={(e) => setSkillDescInput(e.target.value)}
                      placeholder="Kurze Beschreibung"
                      className="h-8 px-2.5 rounded-lg text-[12.5px]"
                      style={{
                        backgroundColor: 'var(--bg-page)',
                        border: '1px solid var(--border-hairline)',
                        color: 'var(--text-primary)',
                      }}
                    />
                  </div>

                  <input
                    type="text"
                    value={skillTriggerInput}
                    onChange={(e) => setSkillTriggerInput(e.target.value)}
                    placeholder="Auslöser: Wann soll Hermes diesen Skill anwenden"
                    className="w-full h-8 px-2.5 rounded-lg text-[12.5px]"
                    style={{
                      backgroundColor: 'var(--bg-page)',
                      border: '1px solid var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  />

                  <textarea
                    value={skillInstructionsInput}
                    onChange={(e) => setSkillInstructionsInput(e.target.value)}
                    placeholder="SKILL.md Anweisungen (Schritt-für-Schritt-Verhalten für Hermes)..."
                    rows={3}
                    className="w-full p-2.5 rounded-lg text-[12.5px] leading-relaxed resize-y"
                    style={{
                      backgroundColor: 'var(--bg-page)',
                      border: '1px solid var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    required
                  />

                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowNewSkillForm(false)}
                      className="btn-ghost"
                      style={{ height: 30, fontSize: 12 }}
                    >
                      Abbrechen
                    </button>
                    <button
                      type="submit"
                      disabled={!skillNameInput.trim() || !skillInstructionsInput.trim()}
                      className="btn-accent"
                      style={{
                        height: 30,
                        padding: '0 13px',
                        fontSize: 12,
                        opacity:
                          skillNameInput.trim() && skillInstructionsInput.trim() ? 1 : 0.5,
                      }}
                    >
                      <Check size={13} strokeWidth={1.8} />
                      <span>Skill speichern</span>
                    </button>
                  </div>
                </form>
              )}

              {/* Hairline-divided Skills List */}
              <div
                className="divide-y border-t"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                {state.hermesSkills.map((skill) => {
                  const isExpanded = Boolean(expandedSkillIds[skill.id]);
                  return (
                    <div
                      key={skill.id}
                      className="py-3.5 space-y-1.5"
                      style={{ borderColor: 'var(--border-hairline)' }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className="font-mono-num text-[13px] font-medium truncate"
                              style={{
                                color: skill.enabled
                                  ? 'var(--text-primary)'
                                  : 'var(--text-muted)',
                              }}
                            >
                              {skill.name}
                            </span>
                            <span
                              className="font-mono-num text-[11px]"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {skill.updatedAt}
                            </span>
                          </div>
                          <p
                            className="text-[13px] m-0 mt-0.5 leading-snug"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {skill.description}
                          </p>
                        </div>

                        <button
                          type="button"
                          role="switch"
                          aria-checked={skill.enabled}
                          aria-label={`${skill.name} ${skill.enabled ? 'deaktivieren' : 'aktivieren'}`}
                          onClick={() => onToggleHermesSkill(skill.id)}
                          className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer mt-0.5"
                          style={{
                            backgroundColor: skill.enabled
                              ? 'var(--accent)'
                              : 'var(--bg-raised)',
                            border: '1px solid var(--border-strong)',
                          }}
                        >
                          <span
                            className="inline-block h-3.5 w-3.5 rounded-full transition-transform"
                            style={{
                              backgroundColor: skill.enabled
                                ? 'var(--accent-ink)'
                                : 'var(--text-muted)',
                              transform: skill.enabled
                                ? 'translateX(17px)'
                                : 'translateX(2px)',
                            }}
                          />
                        </button>
                      </div>

                      <p
                        className="text-[12px] m-0 leading-relaxed"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Auslöser: {skill.trigger}
                      </p>

                      <div>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedSkillIds((prev) => ({
                              ...prev,
                              [skill.id]: !prev[skill.id],
                            }))
                          }
                          className="inline-flex items-center gap-1 text-[12px] font-medium cursor-pointer transition-colors hover:underline"
                          style={{ color: 'var(--accent)' }}
                        >
                          <span>
                            {isExpanded ? 'SKILL.md ausblenden' : 'SKILL.md ansehen'}
                          </span>
                          {isExpanded ? (
                            <ChevronUp size={13} strokeWidth={1.5} />
                          ) : (
                            <ChevronDown size={13} strokeWidth={1.5} />
                          )}
                        </button>

                        {isExpanded && (
                          <div
                            className="mt-2 border-l-2 pl-3 py-1 text-[12.5px] leading-relaxed whitespace-pre-wrap"
                            style={{
                              borderColor: 'var(--accent-border)',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {skill.instructions}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: GEDÄCHTNIS (Persistent Memory & Action Audit) */}
          {studioTab === 'memory' && (
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
              {/* Persistent Learner Memory */}
              <section className="space-y-3" aria-label="Hermes Gedächtnis">
                <div className="flex items-center gap-1.5 text-[13.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  <Layers size={14} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                  <span>Dauerhaftes Lerngedächtnis</span>
                </div>

                {/* Inline Add Memory Form */}
                <form onSubmit={handleCreateMemory} className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <select
                      value={memoryCategory}
                      onChange={(e) =>
                        setMemoryCategory(e.target.value as HermesMemoryEntry['category'])
                      }
                      aria-label="Kategorie wählen"
                      className="h-8 px-2 rounded-lg text-[12px] font-medium cursor-pointer shrink-0"
                      style={{
                        backgroundColor: 'var(--bg-page)',
                        border: '1px solid var(--border-hairline)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {MEMORY_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {MEMORY_CATEGORY_LABELS[cat]}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={memoryFactInput}
                      onChange={(e) => setMemoryFactInput(e.target.value)}
                      placeholder="Neue Lernpräferenz oder Hinweis merken..."
                      className="flex-1 min-w-0 h-8 px-2.5 rounded-lg text-[12.5px]"
                      style={{
                        backgroundColor: 'var(--bg-page)',
                        border: '1px solid var(--border-hairline)',
                        color: 'var(--text-primary)',
                      }}
                    />
                    <button
                      type="submit"
                      disabled={!memoryFactInput.trim()}
                      className="btn-accent shrink-0"
                      style={{
                        height: 32,
                        width: 32,
                        padding: 0,
                        opacity: memoryFactInput.trim() ? 1 : 0.45,
                      }}
                      title="Im Gedächtnis speichern"
                      aria-label="Im Gedächtnis speichern"
                    >
                      <Plus size={14} strokeWidth={1.8} />
                    </button>
                  </div>
                </form>

                {state.hermesMemory.length === 0 ? (
                  <p className="text-[13px] py-2 m-0" style={{ color: 'var(--text-muted)' }}>
                    Noch keine Einträge gespeichert. Hermes merkt sich wichtige Lernpräferenzen automatisch oder du ergänzt sie hier direkt.
                  </p>
                ) : (
                  <div
                    className="divide-y border-t"
                    style={{ borderColor: 'var(--border-hairline)' }}
                  >
                    {state.hermesMemory.map((entry) => (
                      <div
                        key={entry.id}
                        className="py-2.5 flex items-start justify-between gap-3"
                        style={{ borderColor: 'var(--border-hairline)' }}
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2 text-[11.5px]">
                            <span
                              className="font-medium"
                              style={{
                                color:
                                  entry.category === 'weakness'
                                    ? 'var(--accent-warm)'
                                    : 'var(--accent)',
                              }}
                            >
                              {MEMORY_CATEGORY_LABELS[entry.category]}
                            </span>
                            <span style={{ color: 'var(--border-strong)' }}>·</span>
                            <span style={{ color: 'var(--text-muted)' }}>
                              {entry.source === 'agent' ? 'Hermes' : 'Manuell'}
                            </span>
                            <span style={{ color: 'var(--border-strong)' }}>·</span>
                            <span
                              className="font-mono-num"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {entry.createdAt}
                            </span>
                          </div>
                          <p
                            className="text-[13px] leading-relaxed m-0"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {entry.fact}
                          </p>
                        </div>

                        <button
                          type="button"
                          onClick={() => onRemoveHermesMemory(entry.id)}
                          className="btn-ghost shrink-0"
                          style={{ height: 26, width: 26, padding: 0 }}
                          title="Eintrag entfernen"
                          aria-label="Gedächtniseintrag entfernen"
                        >
                          <Trash2 size={13} strokeWidth={1.5} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Agent Action Audit Trail */}
              <section
                className="border-t pt-4 space-y-2.5"
                style={{ borderColor: 'var(--border-hairline)' }}
                aria-label="Letzte Agent-Aktionen"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-[13.5px] font-medium"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    Letzte Agent-Aktionen
                  </span>
                  <span
                    className="font-mono-num text-[11.5px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {state.hermesActionLog.length}
                  </span>
                </div>

                {state.hermesActionLog.length === 0 ? (
                  <p className="text-[12.5px] m-0" style={{ color: 'var(--text-muted)' }}>
                    Noch keine Werkzeug-Aktionen protokolliert.
                  </p>
                ) : (
                  <div
                    className="divide-y border-t"
                    style={{ borderColor: 'var(--border-hairline)' }}
                  >
                    {state.hermesActionLog.slice(0, 15).map((entry) => (
                      <div
                        key={entry.id}
                        className="py-2.5 space-y-0.5"
                        style={{ borderColor: 'var(--border-hairline)' }}
                      >
                        <div className="flex items-center justify-between gap-2 text-[11.5px]">
                          <span
                            className="inline-flex items-center gap-1.5 font-medium truncate"
                            style={{
                              color:
                                entry.status !== 'ok'
                                  ? 'var(--negative)'
                                  : entry.toolName === 'inspect_screen_detail'
                                    ? 'var(--accent-warm)'
                                    : 'var(--accent)',
                            }}
                            title={entry.toolName}
                          >
                            {entry.toolName === 'inspect_screen_detail' && (
                              <Camera size={11} strokeWidth={1.6} className="shrink-0" />
                            )}
                            <span className="truncate">
                              {getToolDisplayLabel(entry.toolName)}
                            </span>
                          </span>
                          <span
                            className="font-mono-num shrink-0"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {formatClockTime(entry.timestamp)}
                          </span>
                        </div>
                        <p
                          className="text-[12.5px] leading-snug m-0"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {entry.summary}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </aside>
      </div>

      {/* Portal into Always-on-Top Floating Teacher Window */}
      {floatingTeacherPortal}
    </div>
  );
};

export default HermesScreenTeacherView;
