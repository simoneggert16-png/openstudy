import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  CheckSquare,
  Code2,
  CopyPlus,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  GraduationCap,
  Heading1,
  Heading2,
  Layers,
  Lightbulb,
  Link2,
  Plus,
  Search,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import {
  BlockType,
  NoteBlock,
  ObsidianNote,
  OpenStudyState,
  StudyCard,
  StudyNotePage,
} from '../types';

export interface NotionWorkspaceProps {
  state: OpenStudyState;
  onSelectCourse: (courseId: string) => void;
  onUpsertNote: (page: StudyNotePage) => void;
  onUpdateNoteBlocks: (noteId: string, blocks: NoteBlock[], title?: string) => void;
  onDeleteNote: (noteId: string) => void;
  onAddCards: (cards: StudyCard[]) => void;
}

const BLOCK_META: Record<
  BlockType,
  { label: string; placeholder: string; shortLabel: string }
> = {
  h1: {
    label: 'Überschrift',
    shortLabel: 'H1',
    placeholder: 'Hauptüberschrift...',
  },
  h2: {
    label: 'Abschnitt',
    shortLabel: 'H2',
    placeholder: 'Abschnittstitel...',
  },
  text: {
    label: 'Absatz',
    shortLabel: 'Text',
    placeholder: 'Schreibe einen Absatz, Definition (Begriff: Erklärung) oder [[Wikilink]]...',
  },
  todo: {
    label: 'Checkliste',
    shortLabel: 'Aufgabe',
    placeholder: 'Lernaufgabe oder Wiederholungspunkt...',
  },
  callout: {
    label: 'Merksatz',
    shortLabel: 'Merksatz',
    placeholder: 'Wichtige Regel, Merksatz oder Prüfungshinweis...',
  },
  code: {
    label: 'Formel / Code',
    shortLabel: 'Formel',
    placeholder: 'Formel, Reaktionsgleichung oder Code-Beispiel...',
  },
};

const SOURCE_META: Record<
  StudyNotePage['source'],
  { label: string }
> = {
  local: { label: 'Lokal' },
  obsidian: { label: 'Obsidian' },
  notion: { label: 'Notion' },
  'school-import': { label: 'Schul-Import' },
};

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function extractWikilinksFromBlocks(blocks: NoteBlock[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const regex = /\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|[^[\]]+)?\]\]/g;

  for (const block of blocks) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(block.text)) !== null) {
      const target = match[1].trim();
      if (target && !seen.has(target.toLowerCase())) {
        seen.add(target.toLowerCase());
        ordered.push(target);
      }
    }
  }
  return ordered;
}

function extractWikilinksFromText(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const regex = /\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|[^[\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const target = match[1].trim();
    if (target && !seen.has(target.toLowerCase())) {
      seen.add(target.toLowerCase());
      ordered.push(target);
    }
  }
  return ordered;
}

function markdownToBlocks(markdown: string): NoteBlock[] {
  const stripped = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines = stripped.split(/\r?\n/);
  const blocks: NoteBlock[] = [];
  let inCodeFence = false;
  let codeLines: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      if (inCodeFence) {
        blocks.push({
          id: makeId('blk'),
          type: 'code',
          text: codeLines.join('\n').trim(),
        });
        codeLines = [];
        inCodeFence = false;
      } else {
        inCodeFence = true;
      }
      continue;
    }

    if (inCodeFence) {
      codeLines.push(rawLine);
      continue;
    }

    if (!trimmed) continue;

    if (trimmed.startsWith('# ')) {
      blocks.push({ id: makeId('blk'), type: 'h1', text: trimmed.slice(2).trim() });
    } else if (trimmed.startsWith('## ') || trimmed.startsWith('### ')) {
      blocks.push({
        id: makeId('blk'),
        type: 'h2',
        text: trimmed.replace(/^#{2,6}\s+/, '').trim(),
      });
    } else if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) {
      const checked = /^[-*]\s+\[[xX]\]/.test(trimmed);
      const text = trimmed.replace(/^[-*]\s+\[[ xX]\]\s+/, '').trim();
      blocks.push({ id: makeId('blk'), type: 'todo', text, checked });
    } else if (trimmed.startsWith('>')) {
      const cleaned = trimmed
        .replace(/^>\s*/, '')
        .replace(/^\[![^\]]+\]\s*/, '')
        .trim();
      if (cleaned) {
        blocks.push({ id: makeId('blk'), type: 'callout', text: cleaned });
      }
    } else {
      const cleaned = trimmed.replace(/^[-*•]\s+/, '').trim();
      blocks.push({ id: makeId('blk'), type: 'text', text: cleaned });
    }
  }

  if (inCodeFence && codeLines.length > 0) {
    blocks.push({ id: makeId('blk'), type: 'code', text: codeLines.join('\n').trim() });
  }

  return blocks.length > 0
    ? blocks
    : [{ id: makeId('blk'), type: 'text', text: '' }];
}

function pageToMarkdown(page: StudyNotePage, courseTitle?: string): string {
  const frontmatter = [
    '---',
    `title: "${page.title.replace(/"/g, '\\"')}"`,
    ...(courseTitle ? [`course: "${courseTitle.replace(/"/g, '\\"')}"`] : []),
    `updated: ${page.updatedAt}`,
    `source: ${page.source}`,
    ...(page.tags.length > 0 ? [`tags: [${page.tags.join(', ')}]`] : []),
    '---',
    '',
  ].join('\n');

  const body = page.blocks
    .map((block) => {
      const content = block.text.trim();
      if (!content) return '';
      switch (block.type) {
        case 'h1':
          return `# ${content}`;
        case 'h2':
          return `## ${content}`;
        case 'todo':
          return `- [${block.checked ? 'x' : ' '}] ${content}`;
        case 'callout':
          return `> [!note]\n> ${content.split('\n').join('\n> ')}`;
        case 'code':
          return `\`\`\`\n${content}\n\`\`\``;
        case 'text':
        default:
          return content;
      }
    })
    .filter(Boolean)
    .join('\n\n');

  return `${frontmatter}${body}\n`;
}

function generateCardsFromPage(
  page: StudyNotePage,
  existingCards: StudyCard[]
): { created: StudyCard[]; skippedDuplicates: number } {
  const existingFronts = new Set(
    existingCards
      .filter((c) => c.courseId === page.courseId)
      .map((c) => c.front.trim().toLowerCase())
  );

  const candidates: Array<{ front: string; back: string; hint?: string }> = [];
  let currentHeading = page.title.trim() || 'Notiz';
  let pendingSectionPoints: string[] = [];

  const flushSectionPoints = () => {
    if (pendingSectionPoints.length >= 2) {
      candidates.push({
        front: `Welche Kernpunkte gehören zu «${currentHeading}»?`,
        back: pendingSectionPoints.join('\n'),
        hint: `Aus Notiz: ${page.title}`,
      });
    }
    pendingSectionPoints = [];
  };

  for (const block of page.blocks) {
    const raw = block.text.trim();
    if (!raw) continue;

    if (block.type === 'h1' || block.type === 'h2') {
      flushSectionPoints();
      currentHeading = raw;
      continue;
    }

    if (block.type === 'callout') {
      const prefixMatch = raw.match(/^([^:]{3,28}):\s+(.+)$/s);
      if (prefixMatch) {
        candidates.push({
          front: `${prefixMatch[1].trim()} zu «${currentHeading}»`,
          back: prefixMatch[2].trim(),
          hint: page.title,
        });
      } else {
        candidates.push({
          front: `Was ist der wichtigste Merksatz zu «${currentHeading}»?`,
          back: raw,
          hint: page.title,
        });
      }
      continue;
    }

    if (block.type === 'code') {
      candidates.push({
        front: `Notiere die Formel oder Syntax zu «${currentHeading}»`,
        back: raw,
        hint: 'Formel- / Code-Block',
      });
      continue;
    }

    if (block.type === 'text') {
      // Definition pattern: "Begriff: Erklärung"
      const colonMatch = raw.match(/^([^:]{2,68}):\s+(.{10,})$/s);
      if (colonMatch) {
        const term = colonMatch[1].replace(/^[\d.)\-*•\s]+/, '').trim();
        const explanation = colonMatch[2].trim();
        if (term.length >= 2 && explanation.length >= 10) {
          candidates.push({
            front: `Erkläre: ${term}`,
            back: explanation,
            hint: currentHeading !== term ? currentHeading : undefined,
          });
          continue;
        }
      }

      // Arrow / Dash pair pattern: "Term -> Definition" or "Term — Definition"
      const pairMatch = raw.match(/^([^—–\->=]{2,60})\s+(?:->|=>|—|–)\s+(.{8,})$/s);
      if (pairMatch) {
        const left = pairMatch[1].replace(/^[\d.)\-*•\s]+/, '').trim();
        const right = pairMatch[2].trim();
        if (left.length >= 2 && right.length >= 8) {
          candidates.push({
            front: left,
            back: right,
            hint: currentHeading,
          });
          continue;
        }
      }

      // Collect clean bullet / numbered points under current heading as fallback synthesis card
      if (raw.length >= 14) {
        pendingSectionPoints.push(raw);
      }
    }
  }

  flushSectionPoints();

  const now = Date.now();
  const created: StudyCard[] = [];
  let skippedDuplicates = 0;

  for (const item of candidates) {
    const normalized = item.front.trim().toLowerCase();
    if (existingFronts.has(normalized)) {
      skippedDuplicates += 1;
      continue;
    }
    existingFronts.add(normalized);
    created.push({
      id: makeId('card'),
      courseId: page.courseId,
      front: item.front.trim(),
      back: item.back.trim(),
      hint: item.hint,
      interval: 0,
      ease: 2.5,
      reps: 0,
      due: now,
    });
  }

  return { created, skippedDuplicates };
}

function BlockTypeIcon({ type, size = 15 }: { type: BlockType; size?: number }) {
  switch (type) {
    case 'h1':
      return <Heading1 size={size} strokeWidth={1.5} />;
    case 'h2':
      return <Heading2 size={size} strokeWidth={1.5} />;
    case 'todo':
      return <CheckSquare size={size} strokeWidth={1.5} />;
    case 'callout':
      return <Lightbulb size={size} strokeWidth={1.5} />;
    case 'code':
      return <Code2 size={size} strokeWidth={1.5} />;
    case 'text':
    default:
      return <AlignLeft size={size} strokeWidth={1.5} />;
  }
}

function SourceIcon({ source }: { source: StudyNotePage['source'] }) {
  switch (source) {
    case 'obsidian':
      return <FolderOpen size={13} strokeWidth={1.5} />;
    case 'notion':
      return <BookOpen size={13} strokeWidth={1.5} />;
    case 'school-import':
      return <GraduationCap size={13} strokeWidth={1.5} />;
    case 'local':
    default:
      return <FileText size={13} strokeWidth={1.5} />;
  }
}

export function NotionWorkspace({
  state,
  onSelectCourse,
  onUpsertNote,
  onUpdateNoteBlocks,
  onDeleteNote,
  onAddCards,
}: NotionWorkspaceProps) {
  const [courseFilter, setCourseFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNoteId, setSelectedNoteId] = useState<string>(
    () =>
      state.notes.find((n) => n.courseId === state.activeCourseId)?.id ??
      state.notes[0]?.id ??
      ''
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: 'positive' | 'neutral' | 'warning';
    message: string;
  } | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const [previewObsidianNote, setPreviewObsidianNote] = useState<ObsidianNote | null>(null);
  const [pendingFocusBlockId, setPendingFocusBlockId] = useState<string | null>(null);

  const blockRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const courseMap = useMemo(() => {
    const map = new Map<string, (typeof state.courses)[number]>();
    for (const c of state.courses) {
      map.set(c.id, c);
    }
    return map;
  }, [state.courses]);

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return state.notes.filter((note) => {
      if (courseFilter !== 'all' && note.courseId !== courseFilter) return false;
      if (!q) return true;
      if (note.title.toLowerCase().includes(q)) return true;
      if (note.tags.some((t) => t.toLowerCase().includes(q))) return true;
      return note.blocks.some((b) => b.text.toLowerCase().includes(q));
    });
  }, [state.notes, courseFilter, searchQuery]);

  const activeNote = useMemo(() => {
    const exact = state.notes.find((n) => n.id === selectedNoteId);
    if (exact) return exact;
    return filteredNotes[0] ?? state.notes[0] ?? null;
  }, [state.notes, selectedNoteId, filteredNotes]);

  useEffect(() => {
    if (activeNote && activeNote.id !== selectedNoteId) {
      setSelectedNoteId(activeNote.id);
    }
  }, [activeNote, selectedNoteId]);

  useEffect(() => {
    if (!pendingFocusBlockId) return;
    const el = blockRefs.current[pendingFocusBlockId];
    if (el) {
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
      setPendingFocusBlockId(null);
    }
  }, [pendingFocusBlockId, activeNote?.blocks]);

  // Auto-resize all block textareas cleanly when active note or block content changes
  useEffect(() => {
    if (!activeNote) return;
    for (const block of activeNote.blocks) {
      const el = blockRefs.current[block.id];
      if (el) {
        el.style.height = 'auto';
        el.style.height = `${Math.max(el.scrollHeight, 28)}px`;
      }
    }
  }, [activeNote]);

  const showTransientFeedback = (
    tone: 'positive' | 'neutral' | 'warning',
    message: string
  ) => {
    setFeedback({ tone, message });
  };

  const handleCreatePage = (customTitle?: string) => {
    const targetCourseId =
      courseFilter !== 'all'
        ? courseFilter
        : state.activeCourseId || state.courses[0]?.id || 'course-general';

    const firstBlockId = makeId('blk');
    const secondBlockId = makeId('blk');
    const newPage: StudyNotePage = {
      id: makeId('note'),
      courseId: targetCourseId,
      title: customTitle?.trim() || 'Neue Lernseite',
      tags: [],
      updatedAt: todayIso(),
      source: 'local',
      blocks: [
        {
          id: firstBlockId,
          type: 'h1',
          text: customTitle?.trim() || 'Überblick',
        },
        {
          id: secondBlockId,
          type: 'text',
          text: '',
        },
      ],
    };

    onUpsertNote(newPage);
    setSelectedNoteId(newPage.id);
    setPreviewObsidianNote(null);
    setConfirmDeleteId(null);
    setPendingFocusBlockId(secondBlockId);
  };

  const handleTitleChange = (newTitle: string) => {
    if (!activeNote) return;
    onUpdateNoteBlocks(activeNote.id, activeNote.blocks, newTitle);
  };

  const handleCourseChange = (newCourseId: string) => {
    if (!activeNote) return;
    onUpsertNote({
      ...activeNote,
      courseId: newCourseId,
      updatedAt: todayIso(),
    });
    onSelectCourse(newCourseId);
  };

  const handleUpdateBlock = (blockId: string, patch: Partial<NoteBlock>) => {
    if (!activeNote) return;
    const nextBlocks = activeNote.blocks.map((b) =>
      b.id === blockId ? { ...b, ...patch } : b
    );
    onUpdateNoteBlocks(activeNote.id, nextBlocks);
  };

  const handleInsertBlockAfter = (afterIndex: number, type: BlockType = 'text') => {
    if (!activeNote) return;
    const newBlock: NoteBlock = {
      id: makeId('blk'),
      type,
      text: '',
      ...(type === 'todo' ? { checked: false } : {}),
    };
    const nextBlocks = [...activeNote.blocks];
    nextBlocks.splice(afterIndex + 1, 0, newBlock);
    onUpdateNoteBlocks(activeNote.id, nextBlocks);
    setPendingFocusBlockId(newBlock.id);
  };

  const handleAppendBlock = (type: BlockType) => {
    if (!activeNote) return;
    handleInsertBlockAfter(activeNote.blocks.length - 1, type);
  };

  const handleMoveBlock = (index: number, direction: -1 | 1) => {
    if (!activeNote) return;
    const target = index + direction;
    if (target < 0 || target >= activeNote.blocks.length) return;
    const nextBlocks = [...activeNote.blocks];
    const [moved] = nextBlocks.splice(index, 1);
    nextBlocks.splice(target, 0, moved);
    onUpdateNoteBlocks(activeNote.id, nextBlocks);
  };

  const handleRemoveBlock = (blockId: string, fallbackFocusIndex?: number) => {
    if (!activeNote) return;
    if (activeNote.blocks.length <= 1) {
      handleUpdateBlock(blockId, { text: '', checked: false });
      return;
    }
    const nextBlocks = activeNote.blocks.filter((b) => b.id !== blockId);
    onUpdateNoteBlocks(activeNote.id, nextBlocks);
    if (fallbackFocusIndex !== undefined) {
      const target = nextBlocks[Math.max(0, Math.min(fallbackFocusIndex, nextBlocks.length - 1))];
      if (target) setPendingFocusBlockId(target.id);
    }
  };

  const handleBlockKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    block: NoteBlock,
    index: number
  ) => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      block.type !== 'code' &&
      block.type !== 'callout'
    ) {
      e.preventDefault();
      handleInsertBlockAfter(index, block.type === 'todo' ? 'todo' : 'text');
    } else if (
      e.key === 'Backspace' &&
      block.text === '' &&
      activeNote &&
      activeNote.blocks.length > 1
    ) {
      e.preventDefault();
      handleRemoveBlock(block.id, index - 1);
    }
  };

  const handleAddTag = () => {
    if (!activeNote) return;
    const cleaned = tagInput.trim().toLowerCase().replace(/^#/, '');
    if (!cleaned) {
      setShowTagInput(false);
      return;
    }
    if (!activeNote.tags.includes(cleaned)) {
      onUpsertNote({
        ...activeNote,
        tags: [...activeNote.tags, cleaned],
        updatedAt: todayIso(),
      });
    }
    setTagInput('');
    setShowTagInput(false);
  };

  const handleRemoveTag = (tagToRemove: string) => {
    if (!activeNote) return;
    onUpsertNote({
      ...activeNote,
      tags: activeNote.tags.filter((t) => t !== tagToRemove),
      updatedAt: todayIso(),
    });
  };

  const handleGenerateCards = () => {
    if (!activeNote) return;
    const { created, skippedDuplicates } = generateCardsFromPage(
      activeNote,
      state.cards
    );

    if (created.length > 0) {
      onAddCards(created);
      const suffix =
        skippedDuplicates > 0
          ? ` (${skippedDuplicates} bereits vorhanden)`
          : '';
      showTransientFeedback(
        'positive',
        `${created.length} ${created.length === 1 ? 'Karteikarte' : 'Karteikarten'} aus «${activeNote.title || 'Seite'}» zum Lernstapel hinzugefügt${suffix}.`
      );
    } else if (skippedDuplicates > 0) {
      showTransientFeedback(
        'neutral',
        `Alle ${skippedDuplicates} erkannten Karteikarten dieser Seite sind bereits im Lernstapel.`
      );
    } else {
      showTransientFeedback(
        'warning',
        'Keine eindeutigen Paare gefunden. Nutze z. B. «Begriff: Erklärung», einen Merksatz oder eine Formel.'
      );
    }
  };

  const handleExportMarkdown = () => {
    if (!activeNote) return;
    const course = courseMap.get(activeNote.courseId);
    const md = pageToMarkdown(activeNote, course?.title);
    const slug = (activeNote.title || 'notiz')
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'notiz';

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${slug}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showTransientFeedback(
      'neutral',
      `Markdown-Datei «${slug}.md» heruntergeladen (Obsidian-kompatibel).`
    );
  };

  const handleConfirmDelete = (noteId: string) => {
    const remaining = state.notes.filter((n) => n.id !== noteId);
    onDeleteNote(noteId);
    setConfirmDeleteId(null);
    setSelectedNoteId(remaining[0]?.id ?? '');
    showTransientFeedback('neutral', 'Notizseite wurde gelöscht.');
  };

  const resolveWikilink = (target: string): {
    localMatch?: StudyNotePage;
    obsidianMatch?: ObsidianNote;
  } => {
    const norm = target.trim().toLowerCase();
    const localMatch = state.notes.find(
      (n) => n.title.trim().toLowerCase() === norm
    );
    const obsidianMatch = state.obsidianNotes.find((o) => {
      const baseName = o.path.split('/').pop()?.replace(/\.md$/i, '') ?? '';
      return (
        o.title.trim().toLowerCase() === norm ||
        baseName.trim().toLowerCase() === norm
      );
    });
    return { localMatch, obsidianMatch };
  };

  const handleWikilinkClick = (target: string) => {
    const { localMatch, obsidianMatch } = resolveWikilink(target);
    if (localMatch) {
      setCourseFilter('all');
      setSelectedNoteId(localMatch.id);
      setPreviewObsidianNote(null);
      showTransientFeedback('neutral', `Gewechselt zu «${localMatch.title}».`);
      return;
    }
    if (obsidianMatch) {
      setPreviewObsidianNote(obsidianMatch);
      return;
    }
    handleCreatePage(target);
    showTransientFeedback('positive', `Neue verknüpfte Seite «${target}» erstellt.`);
  };

  const handleCopyObsidianPreviewToNotes = (obsNote: ObsidianNote) => {
    const targetCourseId =
      activeNote?.courseId ||
      state.activeCourseId ||
      state.courses[0]?.id ||
      'course-general';

    const importedPage: StudyNotePage = {
      id: makeId('note'),
      courseId: targetCourseId,
      title: obsNote.title,
      tags: ['obsidian'],
      updatedAt: todayIso(),
      source: 'obsidian',
      blocks: markdownToBlocks(obsNote.content),
    };
    onUpsertNote(importedPage);
    setSelectedNoteId(importedPage.id);
    setPreviewObsidianNote(null);
    showTransientFeedback(
      'positive',
      `Obsidian-Notiz «${obsNote.title}» in eigene Notizen übernommen.`
    );
  };

  const outgoingWikilinks = useMemo(
    () => (activeNote ? extractWikilinksFromBlocks(activeNote.blocks) : []),
    [activeNote]
  );

  const backlinks = useMemo(() => {
    if (!activeNote || !activeNote.title.trim()) return [];
    const targetNorm = activeNote.title.trim().toLowerCase();
    return state.notes.filter((n) => {
      if (n.id === activeNote.id) return false;
      return extractWikilinksFromBlocks(n.blocks).some(
        (link) => link.toLowerCase() === targetNorm
      );
    });
  }, [activeNote, state.notes]);

  const activeCourse = activeNote ? courseMap.get(activeNote.courseId) : undefined;
  const todoStats = useMemo(() => {
    if (!activeNote) return { total: 0, done: 0 };
    const todos = activeNote.blocks.filter((b) => b.type === 'todo');
    return {
      total: todos.length,
      done: todos.filter((b) => b.checked).length,
    };
  }, [activeNote]);

  return (
    <div className="animate-enter space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
            Notizen & Wissensbasis
          </h1>
          <p className="text-[14px] text-[var(--text-secondary)]">
            Lokaler Block-Editor mit [[Wikilinks]], Markdown-Export und direkter Karteikarten-Erzeugung.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-[var(--text-muted)] font-mono-num">
          <span>{state.notes.length} Seiten</span>
          <span>·</span>
          <span>{state.obsidianNotes.length} Obsidian-Dateien</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[296px_minmax(0,1fr)] gap-5 items-start">
        {/* Left Sidebar: Pages & Filters */}
        <aside className="surface-card p-3.5 flex flex-col gap-3 lg:sticky lg:top-6">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[14px] font-medium text-[var(--text-primary)]">
              Seiten ({filteredNotes.length})
            </span>
            <button
              type="button"
              onClick={() => handleCreatePage()}
              className="btn-accent h-8 px-3 text-[13px]"
            >
              <Plus size={15} strokeWidth={1.5} />
              Neue Seite
            </button>
          </div>

          {/* Search input */}
          <div className="relative">
            <Search
              size={15}
              strokeWidth={1.5}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Notizen durchsuchen..."
              aria-label="Notizen durchsuchen"
              className="w-full h-9 pl-9 pr-8 rounded-lg bg-[var(--bg-raised)] border border-[var(--border-hairline)] text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Suche leeren"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            )}
          </div>

          {/* Course Filter Pills */}
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setCourseFilter('all')}
              className={`px-2.5 py-1 rounded-md text-[12.5px] font-medium transition-colors border ${
                courseFilter === 'all'
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)]'
                  : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-hairline)] hover:bg-[var(--bg-raised)]'
              }`}
            >
              Alle Fächer
            </button>
            {state.courses.map((course) => {
              const isActive = courseFilter === course.id;
              return (
                <button
                  key={course.id}
                  type="button"
                  onClick={() => {
                    setCourseFilter(course.id);
                    onSelectCourse(course.id);
                  }}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12.5px] font-medium transition-colors border max-w-full ${
                    isActive
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)]'
                      : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-hairline)] hover:bg-[var(--bg-raised)]'
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: course.accentColor }}
                  />
                  <span className="truncate max-w-[140px]">
                    {course.title.split('—')[0].trim()}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Page list */}
          <div className="space-y-1 max-h-[520px] overflow-y-auto pr-0.5">
            {filteredNotes.length === 0 ? (
              <div className="surface-raised p-4 text-center space-y-2">
                <p className="text-[13px] text-[var(--text-secondary)]">
                  Keine passenden Notizen gefunden.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    handleCreatePage();
                  }}
                  className="btn-secondary h-8 text-[12.5px] px-3"
                >
                  <FilePlus2 size={14} strokeWidth={1.5} />
                  Seite anlegen
                </button>
              </div>
            ) : (
              filteredNotes.map((note) => {
                const course = courseMap.get(note.courseId);
                const isSelected = activeNote?.id === note.id && !previewObsidianNote;
                const todos = note.blocks.filter((b) => b.type === 'todo');
                const doneTodos = todos.filter((b) => b.checked).length;

                return (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => {
                      setSelectedNoteId(note.id);
                      setPreviewObsidianNote(null);
                      setConfirmDeleteId(null);
                    }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                      isSelected
                        ? 'bg-[var(--accent-soft)] border-[var(--accent-border)]'
                        : 'bg-transparent border-transparent hover:bg-[var(--bg-raised)]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[13.5px] font-medium leading-snug line-clamp-2 text-[var(--text-primary)]">
                        {note.title.trim() || 'Unbenannte Seite'}
                      </span>
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-[var(--bg-raised)] text-[var(--text-muted)]">
                        {SOURCE_META[note.source].label}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px] text-[var(--text-muted)]">
                      <span className="inline-flex items-center gap-1.5 truncate">
                        {course && (
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ backgroundColor: course.accentColor }}
                          />
                        )}
                        <span className="truncate">
                          {course ? course.title.split('—')[0].trim() : 'Allgemein'}
                        </span>
                      </span>
                      <span className="font-mono-num shrink-0 text-[11.5px]">
                        {todos.length > 0 ? `${doneTodos}/${todos.length} · ` : ''}
                        {note.updatedAt}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {state.obsidianNotes.length > 0 && (
            <div className="pt-2.5 border-t border-[var(--border-hairline)] space-y-1.5">
              <div className="flex items-center justify-between text-[12px] text-[var(--text-muted)] px-1">
                <span className="inline-flex items-center gap-1.5">
                  <FolderOpen size={13} strokeWidth={1.5} />
                  Obsidian-Vault
                </span>
                <span className="font-mono-num">{state.obsidianNotes.length}</span>
              </div>
              <div className="space-y-0.5 max-h-36 overflow-y-auto">
                {state.obsidianNotes.slice(0, 6).map((obs) => (
                  <button
                    key={obs.path}
                    type="button"
                    onClick={() => setPreviewObsidianNote(obs)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-md text-[12.5px] truncate transition-colors ${
                      previewObsidianNote?.path === obs.path
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {obs.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Right Main Editor / Obsidian Preview */}
        <section className="surface-card p-5 sm:p-7 min-h-[600px] flex flex-col gap-5">
          {previewObsidianNote ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--border-hairline)]">
                <div className="space-y-1">
                  <div className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--accent)] font-medium">
                    <FolderOpen size={14} strokeWidth={1.5} />
                    Obsidian-Vorschau (schreibgeschützt)
                  </div>
                  <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
                    {previewObsidianNote.title}
                  </h2>
                  <p className="text-[12.5px] font-mono-num text-[var(--text-muted)]">
                    {previewObsidianNote.path}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleCopyObsidianPreviewToNotes(previewObsidianNote)}
                    className="btn-accent"
                  >
                    <CopyPlus size={15} strokeWidth={1.5} />
                    In eigene Notizen kopieren
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewObsidianNote(null)}
                    className="btn-secondary"
                  >
                    Zurück zum Editor
                  </button>
                </div>
              </div>

              {previewObsidianNote.wikilinks.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12.5px] text-[var(--text-muted)] mr-1 inline-flex items-center gap-1">
                    <Link2 size={13} strokeWidth={1.5} />
                    Verknüpfungen:
                  </span>
                  {previewObsidianNote.wikilinks.map((wl) => (
                    <button
                      key={wl}
                      type="button"
                      onClick={() => handleWikilinkClick(wl)}
                      className="px-2 py-0.5 rounded-md text-[12.5px] bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent-border)] hover:opacity-90"
                    >
                      [[{wl}]]
                    </button>
                  ))}
                </div>
              )}

              <pre className="surface-raised p-4 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-[var(--text-primary)] font-sans max-h-[520px] overflow-y-auto">
                {previewObsidianNote.content}
              </pre>
            </div>
          ) : !activeNote ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-16 space-y-3">
              <div className="w-11 h-11 rounded-xl bg-[var(--bg-raised)] border border-[var(--border-hairline)] flex items-center justify-center text-[var(--text-muted)]">
                <FileText size={20} strokeWidth={1.5} />
              </div>
              <div className="space-y-1 max-w-sm">
                <h2 className="text-[17px] font-medium text-[var(--text-primary)]">
                  Noch keine Notizseite vorhanden
                </h2>
                <p className="text-[14px] text-[var(--text-secondary)]">
                  Erstelle deine erste lokale Seite mit Überschriften, Merksätzen, Checklisten und [[Wikilinks]].
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleCreatePage()}
                className="btn-accent"
              >
                <Plus size={16} strokeWidth={1.5} />
                Erste Seite erstellen
              </button>
            </div>
          ) : (
            <>
              {/* Editor Top Meta & Action Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--border-hairline)]">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Course Pill Selector */}
                  <div className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-[var(--bg-raised)] border border-[var(--border-hairline)]">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        backgroundColor: activeCourse?.accentColor ?? 'var(--accent)',
                      }}
                    />
                    <select
                      aria-label="Kurs zuordnen"
                      value={activeNote.courseId}
                      onChange={(e) => handleCourseChange(e.target.value)}
                      className="bg-transparent text-[13px] font-medium text-[var(--text-primary)] border-none pr-1 cursor-pointer max-w-[200px]"
                    >
                      {state.courses.map((c) => (
                        <option
                          key={c.id}
                          value={c.id}
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          {c.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Source Badge */}
                  <span className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-[var(--bg-raised)] border border-[var(--border-hairline)] text-[12.5px] font-medium text-[var(--text-secondary)]">
                    <SourceIcon source={activeNote.source} />
                    {SOURCE_META[activeNote.source].label}
                  </span>

                  {/* Updated Date & Todo Progress */}
                  <span className="text-[12.5px] text-[var(--text-muted)] font-mono-num px-1">
                    {activeNote.updatedAt}
                    {todoStats.total > 0 && ` · ${todoStats.done}/${todoStats.total} Aufgaben`}
                  </span>
                </div>

                {/* Primary Actions */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleGenerateCards}
                    className="btn-accent h-8 px-3 text-[13px]"
                  >
                    <Layers size={15} strokeWidth={1.5} />
                    Karteikarten aus dieser Seite erzeugen
                  </button>
                  <button
                    type="button"
                    onClick={handleExportMarkdown}
                    className="btn-secondary h-8 px-3 text-[13px]"
                    title="Als Obsidian-kompatible Markdown-Datei exportieren"
                  >
                    <Download size={15} strokeWidth={1.5} />
                    Markdown
                  </button>

                  {confirmDeleteId === activeNote.id ? (
                    <div className="inline-flex items-center gap-1.5 pl-1">
                      <button
                        type="button"
                        onClick={() => handleConfirmDelete(activeNote.id)}
                        className="h-8 px-2.5 rounded-lg text-[12.5px] font-medium bg-[var(--negative-soft)] text-[var(--negative)] border border-[var(--negative)] cursor-pointer"
                      >
                        Löschen bestätigen
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="btn-ghost h-8 px-2 text-[12.5px]"
                      >
                        Abbrechen
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(activeNote.id)}
                      className="btn-ghost h-8 w-8 p-0 text-[var(--text-muted)] hover:text-[var(--negative)]"
                      aria-label="Seite löschen"
                      title="Seite löschen"
                    >
                      <Trash2 size={15} strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              </div>

              {/* Inline Confirmation Feedback */}
              {feedback && (
                <div
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg text-[13.5px] border"
                  style={{
                    backgroundColor:
                      feedback.tone === 'positive'
                        ? 'var(--positive-soft)'
                        : feedback.tone === 'warning'
                          ? 'var(--warning-soft)'
                          : 'var(--bg-raised)',
                    borderColor:
                      feedback.tone === 'positive'
                        ? 'var(--positive)'
                        : feedback.tone === 'warning'
                          ? 'var(--warning)'
                          : 'var(--border-hairline)',
                    color:
                      feedback.tone === 'positive'
                        ? 'var(--positive)'
                        : feedback.tone === 'warning'
                          ? 'var(--warning)'
                          : 'var(--text-primary)',
                  }}
                >
                  <span className="inline-flex items-center gap-2">
                    <Check size={15} strokeWidth={1.5} className="shrink-0" />
                    {feedback.message}
                  </span>
                  <button
                    type="button"
                    onClick={() => setFeedback(null)}
                    aria-label="Hinweis schließen"
                    className="p-0.5 rounded opacity-80 hover:opacity-100 cursor-pointer"
                  >
                    <X size={14} strokeWidth={1.5} />
                  </button>
                </div>
              )}

              {/* Page Title & Tags */}
              <div className="space-y-2.5">
                <input
                  type="text"
                  value={activeNote.title}
                  onChange={(e) => handleTitleChange(e.target.value)}
                  placeholder="Seitentitel eingeben..."
                  aria-label="Seitentitel"
                  className="w-full bg-transparent border-none text-[24px] sm:text-[26px] font-semibold tracking-[-0.02em] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] px-0 py-0.5"
                />

                <div className="flex flex-wrap items-center gap-1.5">
                  <Tag size={13} strokeWidth={1.5} className="text-[var(--text-muted)] mr-0.5" />
                  {activeNote.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] bg-[var(--bg-raised)] text-[var(--text-secondary)] border border-[var(--border-hairline)]"
                    >
                      #{tag}
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(tag)}
                        aria-label={`Tag ${tag} entfernen`}
                        className="text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                      >
                        <X size={11} strokeWidth={1.5} />
                      </button>
                    </span>
                  ))}
                  {showTagInput ? (
                    <input
                      type="text"
                      value={tagInput}
                      autoFocus
                      onChange={(e) => setTagInput(e.target.value)}
                      onBlur={handleAddTag}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddTag();
                        } else if (e.key === 'Escape') {
                          setTagInput('');
                          setShowTagInput(false);
                        }
                      }}
                      placeholder="Tag eingeben..."
                      className="h-6 px-2 rounded-md text-[12px] bg-[var(--bg-raised)] border border-[var(--accent-border)] text-[var(--text-primary)] w-32"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowTagInput(true)}
                      className="px-2 py-0.5 rounded-md text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-raised)] transition-colors cursor-pointer"
                    >
                      + Tag
                    </button>
                  )}
                </div>
              </div>

              {/* Block Editor Stream */}
              <div className="space-y-2.5 flex-1">
                {activeNote.blocks.map((block, index) => {
                  const inlineLinks = extractWikilinksFromText(block.text);

                  const blockInputStyle =
                    block.type === 'h1'
                      ? 'text-[20px] font-semibold tracking-[-0.015em] leading-snug text-[var(--text-primary)]'
                      : block.type === 'h2'
                        ? 'text-[17px] font-medium tracking-[-0.01em] leading-snug text-[var(--text-primary)]'
                        : block.type === 'code'
                          ? 'font-mono-num text-[13.5px] leading-relaxed text-[var(--text-primary)]'
                          : block.type === 'todo' && block.checked
                            ? 'text-[15px] leading-relaxed line-through text-[var(--text-muted)]'
                            : 'text-[15px] leading-relaxed text-[var(--text-primary)]';

                  const blockWrapperStyle =
                    block.type === 'callout'
                      ? 'border-l-[3px] border-[var(--accent)] bg-[var(--accent-soft)] rounded-r-lg px-4 py-3'
                      : block.type === 'code'
                        ? 'bg-[var(--bg-raised)] border border-[var(--border-hairline)] rounded-lg px-3.5 py-2.5'
                        : 'px-1 py-1 rounded-lg hover:bg-[var(--bg-page)]/60 transition-colors';

                  return (
                    <div
                      key={block.id}
                      className="group relative flex flex-col gap-1.5"
                    >
                      <div className="flex items-start gap-2">
                        {/* Block Content Area */}
                        <div className={`flex-1 min-w-0 ${blockWrapperStyle}`}>
                          <div className="flex items-start gap-2.5">
                            {block.type === 'todo' && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleUpdateBlock(block.id, {
                                    checked: !block.checked,
                                  })
                                }
                                aria-label={
                                  block.checked
                                    ? 'Als offen markieren'
                                    : 'Als erledigt markieren'
                                }
                                className={`mt-1 w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                                  block.checked
                                    ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-ink)]'
                                    : 'bg-[var(--bg-card)] border-[var(--border-strong)] hover:border-[var(--accent)]'
                                }`}
                              >
                                {block.checked && <Check size={12} strokeWidth={2} />}
                              </button>
                            )}

                            {block.type === 'callout' && (
                              <Lightbulb
                                size={16}
                                strokeWidth={1.5}
                                className="mt-1 shrink-0 text-[var(--accent)]"
                              />
                            )}

                            <textarea
                              ref={(el) => {
                                blockRefs.current[block.id] = el;
                              }}
                              rows={1}
                              value={block.text}
                              onChange={(e) => {
                                handleUpdateBlock(block.id, { text: e.target.value });
                                e.target.style.height = 'auto';
                                e.target.style.height = `${Math.max(e.target.scrollHeight, 28)}px`;
                              }}
                              onKeyDown={(e) => handleBlockKeyDown(e, block, index)}
                              placeholder={BLOCK_META[block.type].placeholder}
                              aria-label={`${BLOCK_META[block.type].label} Block ${index + 1}`}
                              className={`w-full resize-none overflow-hidden bg-transparent border-none p-0 focus:outline-none placeholder:text-[var(--text-muted)] ${blockInputStyle}`}
                            />
                          </div>

                          {/* Clickable inline [[Wikilink]] chips under this block when present */}
                          {inlineLinks.length > 0 && (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              {inlineLinks.map((target) => {
                                const { localMatch, obsidianMatch } =
                                  resolveWikilink(target);
                                const resolved = Boolean(localMatch || obsidianMatch);
                                return (
                                  <button
                                    key={target}
                                    type="button"
                                    onClick={() => handleWikilinkClick(target)}
                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] font-medium border transition-colors cursor-pointer ${
                                      resolved
                                        ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)] hover:opacity-90'
                                        : 'bg-[var(--bg-raised)] text-[var(--text-secondary)] border-[var(--border-hairline)] hover:border-[var(--border-strong)]'
                                    }`}
                                    title={
                                      localMatch
                                        ? `Zur lokalen Seite «${localMatch.title}» springen`
                                        : obsidianMatch
                                          ? `Obsidian-Notiz «${obsidianMatch.title}» öffnen`
                                          : `Neue Seite «${target}» erstellen`
                                    }
                                  >
                                    <Link2 size={11} strokeWidth={1.5} />
                                    [[{target}]]
                                    {!resolved && (
                                      <span className="text-[11px] opacity-75">
                                        · neu
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* Subtle Block Controls */}
                        <div className="flex items-center gap-0.5 pt-1 opacity-70 sm:opacity-35 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity shrink-0">
                          <select
                            aria-label="Blocktyp wechseln"
                            value={block.type}
                            onChange={(e) => {
                              const nextType = e.target.value as BlockType;
                              handleUpdateBlock(block.id, {
                                type: nextType,
                                checked: nextType === 'todo' ? Boolean(block.checked) : undefined,
                              });
                            }}
                            className="h-7 px-1.5 rounded-md bg-[var(--bg-raised)] border border-[var(--border-hairline)] text-[11.5px] font-medium text-[var(--text-secondary)] cursor-pointer"
                          >
                            {(Object.keys(BLOCK_META) as BlockType[]).map((bt) => (
                              <option
                                key={bt}
                                value={bt}
                                style={{
                                  backgroundColor: 'var(--bg-card)',
                                  color: 'var(--text-primary)',
                                }}
                              >
                                {BLOCK_META[bt].label}
                              </option>
                            ))}
                          </select>

                          <button
                            type="button"
                            onClick={() => handleMoveBlock(index, -1)}
                            disabled={index === 0}
                            aria-label="Block nach oben verschieben"
                            className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-raised)] disabled:opacity-30 cursor-pointer disabled:cursor-default"
                          >
                            <ArrowUp size={13} strokeWidth={1.5} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleMoveBlock(index, 1)}
                            disabled={index === activeNote.blocks.length - 1}
                            aria-label="Block nach unten verschieben"
                            className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-raised)] disabled:opacity-30 cursor-pointer disabled:cursor-default"
                          >
                            <ArrowDown size={13} strokeWidth={1.5} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleInsertBlockAfter(index, 'text')}
                            aria-label="Neuen Block darunter einfügen"
                            className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-raised)] cursor-pointer"
                          >
                            <Plus size={13} strokeWidth={1.5} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveBlock(block.id, index - 1)}
                            aria-label="Block entfernen"
                            className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--negative)] hover:bg-[var(--bg-raised)] cursor-pointer"
                          >
                            <Trash2 size={13} strokeWidth={1.5} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Quick Block Insert Palette */}
              <div className="pt-4 border-t border-[var(--border-hairline)] flex flex-wrap items-center gap-1.5">
                <span className="text-[12.5px] text-[var(--text-muted)] mr-1">
                  Block hinzufügen:
                </span>
                {(Object.keys(BLOCK_META) as BlockType[]).map((bt) => (
                  <button
                    key={bt}
                    type="button"
                    onClick={() => handleAppendBlock(bt)}
                    className="btn-ghost h-8 px-2.5 text-[12.5px] border border-[var(--border-hairline)] hover:border-[var(--border-strong)]"
                  >
                    <BlockTypeIcon type={bt} size={14} />
                    {BLOCK_META[bt].label}
                  </button>
                ))}
              </div>

              {/* Related Links & [[Wikilinks]] Strip */}
              <div className="surface-raised p-3.5 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
                    <Link2 size={14} strokeWidth={1.5} className="text-[var(--accent)]" />
                    Verknüpfte Seiten ([[Wikilinks]])
                  </span>
                  <span className="text-[12px] text-[var(--text-muted)]">
                    Schreibe [[Seitentitel]] in einen Block, um Seiten oder Obsidian-Notizen zu verknüpfen.
                  </span>
                </div>

                {outgoingWikilinks.length === 0 && backlinks.length === 0 ? (
                  <p className="text-[12.5px] text-[var(--text-muted)]">
                    Noch keine [[Wikilinks]] auf dieser Seite.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {outgoingWikilinks.map((target) => {
                      const { localMatch, obsidianMatch } = resolveWikilink(target);
                      const statusLabel = localMatch
                        ? 'Lokal'
                        : obsidianMatch
                          ? 'Obsidian'
                          : 'Erstellen';
                      return (
                        <button
                          key={`out-${target}`}
                          type="button"
                          onClick={() => handleWikilinkClick(target)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12.5px] font-medium bg-[var(--bg-card)] border border-[var(--border-hairline)] hover:border-[var(--accent-border)] text-[var(--text-primary)] cursor-pointer transition-colors"
                        >
                          <Link2 size={12} strokeWidth={1.5} className="text-[var(--accent)]" />
                          <span>{target}</span>
                          <span className="text-[11px] text-[var(--text-muted)]">
                            · {statusLabel}
                          </span>
                        </button>
                      );
                    })}

                    {backlinks.map((sourceNote) => (
                      <button
                        key={`in-${sourceNote.id}`}
                        type="button"
                        onClick={() => {
                          setSelectedNoteId(sourceNote.id);
                          setPreviewObsidianNote(null);
                        }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12.5px] bg-[var(--bg-card)] border border-[var(--border-hairline)] hover:border-[var(--border-strong)] text-[var(--text-secondary)] cursor-pointer transition-colors"
                      >
                        <span>Verlinkt von: {sourceNote.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export default NotionWorkspace;
