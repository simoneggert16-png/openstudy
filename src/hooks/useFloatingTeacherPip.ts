import { useCallback, useEffect, useState } from 'react';
import { ColorSchemeId } from '../types';
import { getColorSchemeById } from '../data/colorSchemes';

interface DocumentPictureInPictureApi {
  requestWindow: (options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
  }) => Promise<Window>;
  window?: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }
}

function copyStylesIntoWindow(targetDoc: Document, schemeId: ColorSchemeId) {
  const scheme = getColorSchemeById(schemeId);
  targetDoc.documentElement.setAttribute('data-scheme', scheme.id);
  targetDoc.documentElement.setAttribute('data-theme', scheme.isDark ? 'dark' : 'light');
  targetDoc.title = 'OpenStudy — Hermes Lehrer';

  // Copy font links and compiled stylesheets so the floating window inherits exact Focus styling.
  const headNodes = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'));
  for (const node of headNodes) {
    if (node.tagName === 'LINK') {
      const link = targetDoc.createElement('link');
      link.rel = 'stylesheet';
      link.href = (node as HTMLLinkElement).href;
      targetDoc.head.appendChild(link);
    } else if (node.tagName === 'STYLE') {
      const style = targetDoc.createElement('style');
      style.textContent = node.textContent;
      targetDoc.head.appendChild(style);
    }
  }

  targetDoc.body.style.margin = '0';
  targetDoc.body.style.overflowX = 'hidden';
  targetDoc.body.style.backgroundColor = 'var(--bg-page)';
  targetDoc.body.style.color = 'var(--text-primary)';
}

export function useFloatingTeacherPip(colorScheme: ColorSchemeId) {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
  const [pipMode, setPipMode] = useState<'none' | 'document-pip' | 'popup'>('none');

  const supportsDocumentPip =
    typeof window !== 'undefined' &&
    Boolean(window.documentPictureInPicture?.requestWindow);

  // Sync theme live into the floating always-on-top window whenever scheme changes.
  useEffect(() => {
    if (!pipWindow || pipWindow.closed) return;
    const scheme = getColorSchemeById(colorScheme);
    pipWindow.document.documentElement.setAttribute('data-scheme', scheme.id);
    pipWindow.document.documentElement.setAttribute('data-theme', scheme.isDark ? 'dark' : 'light');
  }, [colorScheme, pipWindow]);

  const closeFloatingWindow = useCallback(() => {
    if (pipWindow && !pipWindow.closed) {
      try {
        pipWindow.close();
      } catch {
        // ignore
      }
    }
    setPipWindow(null);
    setMountNode(null);
    setPipMode('none');
  }, [pipWindow]);

  const openFloatingWindow = useCallback(async () => {
    if (pipWindow && !pipWindow.closed) {
      pipWindow.focus();
      return true;
    }

    let win: Window | null = null;
    let mode: 'document-pip' | 'popup' = 'popup';

    if (window.documentPictureInPicture?.requestWindow) {
      try {
        win = await window.documentPictureInPicture.requestWindow({
          width: 400,
          height: 580,
        });
        mode = 'document-pip';
      } catch {
        win = null;
      }
    }

    if (!win) {
      win = window.open(
        '',
        'openstudy-hermes-teacher',
        'popup=yes,width=410,height=600,menubar=no,toolbar=no,location=no,status=no'
      );
      mode = 'popup';
    }

    if (!win) return false;

    win.document.head.innerHTML = '';
    win.document.body.innerHTML = '';
    copyStylesIntoWindow(win.document, colorScheme);

    const container = win.document.createElement('div');
    container.id = 'openstudy-floating-teacher-root';
    container.style.minHeight = '100vh';
    win.document.body.appendChild(container);

    const handleClose = () => {
      setPipWindow(null);
      setMountNode(null);
      setPipMode('none');
    };
    win.addEventListener('pagehide', handleClose);
    win.addEventListener('unload', handleClose);

    setPipWindow(win);
    setMountNode(container);
    setPipMode(mode);
    return true;
  }, [colorScheme, pipWindow]);

  useEffect(() => {
    return () => {
      if (pipWindow && !pipWindow.closed) {
        try {
          pipWindow.close();
        } catch {
          // ignore
        }
      }
    };
  }, [pipWindow]);

  return {
    isOpen: Boolean(pipWindow && !pipWindow.closed && mountNode),
    mountNode,
    pipMode,
    supportsDocumentPip,
    openFloatingWindow,
    closeFloatingWindow,
  };
}
