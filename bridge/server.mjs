#!/usr/bin/env node
/**
 * OpenStudy Local Companion Bridge
 *
 * Security & privacy guarantees:
 * - Listens strictly on 127.0.0.1 (loopback only, never 0.0.0.0).
 * - CORS restricted exclusively to localhost / 127.0.0.1 / [::1] and the official OpenStudy HTTPS origin.
 * - Zero external dependencies (Node.js v20+ built-ins only).
 * - Never reads credential files or writes inside the OpenStudy git repository.
 * - Strictly restricts Hermes Gateway proxy requests to local loopback addresses (zero SSRF).
 * - Invokes only sanctioned local CLIs with strict argument arrays (no shell interpolation).
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const VERSION = '1.1.0';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;
const AGENT_TIMEOUT_MS = 45_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CHAT_BODY_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_OBSIDIAN_FILES = 350;
const MAX_OBSIDIAN_OVERVIEW_FILES = 12_000;
const MAX_OBSIDIAN_SEARCH_FILES = 8_000;
const MAX_OBSIDIAN_SEARCH_NOTE_BYTES = 300 * 1024;
const MAX_OBSIDIAN_READ_BYTES = 512 * 1024;
const MAX_OBSIDIAN_SEARCH_EXCERPT_CHARS = 420;
const OBSIDIAN_SEARCH_TIME_BUDGET_MS = 680;
const MAX_NOTE_BYTES = 256 * 1024;
const MAX_NOTE_CONTENT_CHARS = 12_000;
const MAX_EXCERPT_CHARS = 220;

const ONENOTE_TIMEOUT_MS = 6_000;
const MAX_ONENOTE_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_ONENOTE_RECENT_PAGES = 120;
const MAX_ONENOTE_PAGE_CHARS = 16_000;

const SYNC_MIN_INTERVAL_MINUTES = 15;
const SYNC_MAX_INTERVAL_MINUTES = 10_080;
const SYNC_DEFAULT_INTERVAL_MINUTES = 2_880;
const SYNC_SAMPLE_OBSIDIAN_LIMIT = 60;
const SYNC_UPCOMING_DAYS = 90;

const DEFAULT_HERMES_GATEWAY_URL = 'http://127.0.0.1:9119';
const HERMES_PROBE_TIMEOUT_MS = 1_500;
const HERMES_CHAT_TIMEOUT_MS = 45_000;
const MAX_HERMES_SKILL_BYTES = 32 * 1024;
const MAX_HERMES_SKILLS = 100;
const MAX_HERMES_MEMORY_ENTRIES = 100;

const DESKTOP_WINDOW_TIMEOUT_MS = 1_500;
const DESKTOP_SCREENSHOT_TIMEOUT_MS = 4_500;
const MAX_SCREENSHOT_STDOUT_BYTES = 10 * 1024 * 1024;
const HIGHLIGHT_MIN_DURATION_MS = 1_500;
const HIGHLIGHT_MAX_DURATION_MS = 7_000;
const HIGHLIGHT_DEFAULT_DURATION_MS = 4_500;

const PORTAL_DEFAULT_HORIZON_DAYS = 90;
const PORTAL_MIN_HORIZON_DAYS = 7;
const PORTAL_MAX_HORIZON_DAYS = 180;
const PORTAL_LAUNCH_TIMEOUT_MS = 10_000;
const PORTAL_CDP_TIMEOUT_MS = 10_000;
const PORTAL_PAGE_SETTLE_MS = 1_500;
const PORTAL_PAGINATION_SETTLE_MS = 1_000;
const PORTAL_MAX_SUBVIEWS = 4;
const PORTAL_MAX_NEXT_CLICKS_PER_VIEW = 3;
const PORTAL_MAX_TOTAL_NEXT_CLICKS = 6;
const PORTAL_CRAWL_BUDGET_MS = 30_000;
const PORTAL_MAX_BUNDLE_CHARS = 28_000;
const PORTAL_MAX_ITEMS = 200;

const PORT = (() => {
  const raw = Number(process.env.OPENSTUDY_BRIDGE_PORT || DEFAULT_PORT);
  if (Number.isInteger(raw) && raw >= 1024 && raw <= 65535) {
    return raw;
  }
  return DEFAULT_PORT;
})();

const CLI_DEFINITIONS = {
  antigravity: {
    id: 'antigravity',
    binaries: ['agy', 'antigravity'],
    agentSupported: true,
  },
  claude: {
    id: 'claude',
    binaries: ['claude'],
    agentSupported: true,
  },
  codex: {
    id: 'codex',
    binaries: ['codex'],
    agentSupported: true,
  },
  hermes: {
    id: 'hermes',
    binaries: ['hermes'],
    agentSupported: true,
  },
  ollama: {
    id: 'ollama',
    binaries: ['ollama'],
    agentSupported: false,
  },
};

const SENSITIVE_NAME_PATTERN =
  /(^|[._\-\s])(env|passwords?|passwd|passwort|passwörter|passwoerter|secrets?|credits?|kreditkarten?|cardnumber|apikeys?|api_keys?|keys?|tokens?|credentials?|private|id_rsa|id_ed25519|seedphrase|recovery|banking|steuer|passport|ausweis)([._\-\s]|$)|^\.env/i;

const SENSITIVE_ONENOTE_PATTERN =
  /(^|[._\-\s/])(env|passwords?|passwd|passwort|passwörter|passwoerter|secrets?|credits?|kreditkarten?|cardnumber|apikeys?|api_keys?|tokens?|credentials?|private|privat|vault|tresor|geheim|banking|e-?banking|steuer|passport|ausweis|recovery|seedphrase|wallet|zugangsdaten|logins?)([._\-\s/]|$)/i;

const SENSITIVE_WINDOW_PATTERN =
  /1password|bitwarden|keepass|lastpass|keychain|credential|private|incognito|inprivate|banking|e-?banking|kreditkarte|credit\s*card|passwort|password|passwörter|passwoerter|dashlane|enpass|proton\s*pass|nordpass/i;

const IGNORED_DIRS = new Set([
  '.obsidian',
  '.git',
  '.trash',
  '.stfolder',
  'node_modules',
  '.venv',
  'venv',
]);

const SANCTIONED_HTTPS_HOSTS = new Set(['simoneggert16-png.github.io']);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
    if (parsed.protocol === 'https:' && SANCTIONED_HTTPS_HOSTS.has(host)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    if (!isAllowedOrigin(origin)) {
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.headers['access-control-request-private-network'] === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return true;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const limitKb = Math.round(maxBytes / 1024);
        reject(Object.assign(new Error(`Request body exceeds ${limitKb} KB limit.`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON request body.'), { status: 400 }));
      }
    });

    req.on('error', (err) => {
      reject(Object.assign(new Error(`Request read failed: ${err.message}`), { status: 400 }));
    });
  });
}

function isRegularExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely locates a CLI binary on PATH without executing shell commands
 * and without touching any user config or credential files.
 */
function findExecutableOnPath(binaryName) {
  const envPath = process.env.PATH || process.env.Path || '';
  if (!envPath) return null;

  const directories = envPath
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  if (process.platform === 'win32') {
    const rawExts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean);

    // Prefer native executables (.exe) over script wrappers (.cmd/.bat).
    const orderedExts = [
      ...rawExts.filter((ext) => ext === '.exe'),
      ...rawExts.filter((ext) => ext !== '.exe'),
    ];

    for (const dir of directories) {
      for (const ext of orderedExts) {
        const candidate = path.join(dir, binaryName.toLowerCase().endsWith(ext) ? binaryName : `${binaryName}${ext}`);
        if (isRegularExecutable(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }

  for (const dir of directories) {
    const candidate = path.join(dir, binaryName);
    if (isRegularExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function detectAvailableTools() {
  const available = [];
  const details = {};

  for (const def of Object.values(CLI_DEFINITIONS)) {
    let resolvedPath = null;
    let matchedBinary = def.binaries[0];

    for (const bin of def.binaries) {
      const found = findExecutableOnPath(bin);
      if (found) {
        resolvedPath = found;
        matchedBinary = bin;
        break;
      }
    }

    const isAvailable = Boolean(resolvedPath);
    if (isAvailable) {
      available.push(def.id);
    }

    details[def.id] = {
      available: isAvailable,
      cli: matchedBinary,
      agentSupported: def.agentSupported,
    };
  }

  return { tools: available, details };
}

/**
 * On Windows, npm installs CLI tools as .cmd shims that invoke Node on a JS entrypoint.
 * Resolving that JS entrypoint directly lets us spawn node.exe with shell: false,
 * completely preventing command-shell injection.
 */
function resolveWindowsCmdToNodeEntry(cmdPath) {
  try {
    const content = fs.readFileSync(cmdPath, 'utf8');
    const match = content.match(/"%dp0%\\([^"\r\n]+\.(?:c?m?js))"/i);
    if (!match) return null;
    const candidate = path.resolve(path.dirname(cmdPath), match[1]);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeToolId(rawTool) {
  if (typeof rawTool !== 'string') return null;
  const key = rawTool.trim().toLowerCase();
  if (key === 'agy' || key === 'antigravity') return 'antigravity';
  if (key === 'claude') return 'claude';
  if (key === 'codex') return 'codex';
  if (key === 'hermes') return 'hermes';
  return null;
}

function buildCombinedPrompt(systemPrompt, userPrompt) {
  const sections = [];
  if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
    sections.push(`System instructions:\n${systemPrompt.trim()}`);
  }
  sections.push(userPrompt.trim());
  return sections.join('\n\n');
}

function runSanctionedCli(toolId, systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const def = CLI_DEFINITIONS[toolId];
    if (!def || !def.agentSupported) {
      reject(Object.assign(new Error('Unsupported CLI tool requested.'), { status: 400 }));
      return;
    }

    let executablePath = null;
    for (const bin of def.binaries) {
      executablePath = findExecutableOnPath(bin);
      if (executablePath) break;
    }

    if (!executablePath) {
      reject(
        Object.assign(
          new Error(
            `The local CLI "${def.binaries[0]}" was not found on PATH. Install and sign in to it locally first.`
          ),
          { status: 404 }
        )
      );
      return;
    }

    const combinedPrompt = buildCombinedPrompt(systemPrompt, userPrompt);
    let spawnCommand = executablePath;
    let spawnArgs = [];
    let stdinPayload = null;

    if (toolId === 'antigravity') {
      spawnArgs = [
        '--output-format',
        'text',
        '--disable-slash-commands',
        '--print',
        combinedPrompt,
      ];
    } else if (toolId === 'claude') {
      spawnArgs = ['-p', '--output-format', 'text'];
      stdinPayload = combinedPrompt;
    } else if (toolId === 'codex') {
      spawnArgs = ['exec', '-'];
      stdinPayload = combinedPrompt;
    } else if (toolId === 'hermes') {
      spawnArgs = ['chat', '-q', combinedPrompt];
    }

    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executablePath)) {
      const nodeEntry = resolveWindowsCmdToNodeEntry(executablePath);
      if (!nodeEntry) {
        reject(
          Object.assign(
            new Error(
              `Refusing to execute non-Node batch wrapper for "${toolId}". Install the native executable or Node CLI.`
            ),
            { status: 400 }
          )
        );
        return;
      }
      spawnCommand = process.execPath;
      spawnArgs = [nodeEntry, ...spawnArgs];
    }

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        shell: false,
        windowsHide: true,
        cwd: os.tmpdir(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(
        Object.assign(
          new Error(`Failed to launch local CLI "${toolId}": ${err.message}`),
          { status: 500 }
        )
      );
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;

    const finish = (err, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(output);
      }
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 1500).unref();

      finish(
        Object.assign(
          new Error(`Local CLI "${toolId}" timed out after ${AGENT_TIMEOUT_MS / 1000} seconds.`),
          { status: 504 }
        )
      );
    }, AGENT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (stdoutLen < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrLen < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    child.on('error', (err) => {
      finish(
        Object.assign(new Error(`CLI execution error for "${toolId}": ${err.message}`), {
          status: 500,
        })
      );
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (code !== 0) {
        const detail = (stderr || stdout).slice(0, 320);
        finish(
          Object.assign(
            new Error(
              `Local CLI "${toolId}" exited with code ${code}${detail ? `: ${detail}` : '.'}`
            ),
            { status: 502 }
          )
        );
        return;
      }

      if (!stdout) {
        finish(
          Object.assign(new Error(`Local CLI "${toolId}" returned an empty response.`), {
            status: 502,
          })
        );
        return;
      }

      finish(null, stdout);
    });

    try {
      if (stdinPayload !== null) {
        child.stdin.write(stdinPayload, 'utf8');
      }
      child.stdin.end();
    } catch {
      // ignore EPIPE if process exits early
    }
  });
}

function isForbiddenVaultRoot(resolvedPath) {
  const normalized = path.resolve(resolvedPath);
  const parsed = path.parse(normalized);

  // Never allow scanning an entire drive or filesystem root.
  if (normalized === parsed.root) return true;

  const lower = normalized.toLowerCase();
  const forbiddenPrefixes = [
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/var',
    '/proc',
    '/sys',
    '/system',
    '/library',
  ];

  if (process.platform === 'win32') {
    const winDir = (process.env.WINDIR || 'C:\\Windows').toLowerCase();
    const progFiles = (process.env.ProgramFiles || 'C:\\Program Files').toLowerCase();
    if (lower === winDir || lower.startsWith(`${winDir}\\`)) return true;
    if (lower === progFiles || lower.startsWith(`${progFiles}\\`)) return true;
  } else {
    for (const prefix of forbiddenPrefixes) {
      if (lower === prefix || lower.startsWith(`${prefix}/`)) return true;
    }
  }

  return false;
}

function isSensitiveRelativePath(relPath) {
  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    if (SENSITIVE_NAME_PATTERN.test(segment)) {
      return true;
    }
  }
  return false;
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function extractNoteTitle(markdownBody, fileName) {
  const headingMatch = markdownBody.match(/^#\s+(.+)$/m);
  if (headingMatch && headingMatch[1].trim()) {
    return headingMatch[1].trim().slice(0, 140);
  }
  return fileName.replace(/\.md$/i, '');
}

function extractWikilinks(markdown) {
  const links = new Set();
  const regex = /\[\[([^\]\r\n]+)\]\]/g;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const rawTarget = match[1].split('|')[0].split('#')[0].trim();
    if (rawTarget) {
      links.add(rawTarget);
    }
    if (links.size >= 40) break;
  }
  return Array.from(links);
}

function buildExcerpt(markdownBody) {
  const plain = markdownBody
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (plain.length <= MAX_EXCERPT_CHARS) return plain;
  return `${plain.slice(0, MAX_EXCERPT_CHARS - 1).trimEnd()}…`;
}

function getObsidianConfigPath() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'obsidian', 'obsidian.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  }
  return path.join(os.homedir(), '.config', 'obsidian', 'obsidian.json');
}

async function detectObsidianVaults() {
  const configPath = getObsidianConfigPath();
  let raw;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch {
    return { ok: true, vaults: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: true, vaults: [] };
  }

  const rawVaults = parsed && typeof parsed.vaults === 'object' && parsed.vaults !== null ? parsed.vaults : null;
  if (!rawVaults) {
    return { ok: true, vaults: [] };
  }

  const vaults = [];
  for (const [id, entry] of Object.entries(rawVaults)) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
    const rawPath = entry.path.trim();
    if (!rawPath) continue;

    const resolvedPath = path.resolve(rawPath);
    if (isForbiddenVaultRoot(resolvedPath)) continue;

    let exists = false;
    try {
      exists = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory();
    } catch {
      exists = false;
    }

    if (!exists) continue;

    vaults.push({
      id: String(id),
      name: path.basename(resolvedPath) || resolvedPath,
      path: resolvedPath,
      isOpen: Boolean(entry.open),
      exists: true,
    });
  }

  vaults.sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { ok: true, vaults };
}

async function scanObsidianVault(rawDir) {
  if (typeof rawDir !== 'string' || !rawDir.trim()) {
    throw Object.assign(new Error('Parameter "vaultPath" (or "dir") is required.'), { status: 400 });
  }

  const requestedPath = path.resolve(rawDir.trim());
  if (isForbiddenVaultRoot(requestedPath)) {
    throw Object.assign(
      new Error('Scanning a system directory or drive root is not allowed. Select your Obsidian vault folder.'),
      { status: 403 }
    );
  }

  let rootRealPath;
  try {
    rootRealPath = await fsp.realpath(requestedPath);
    const stat = await fsp.stat(rootRealPath);
    if (!stat.isDirectory()) {
      throw new Error('Not a directory');
    }
  } catch {
    throw Object.assign(new Error('The selected Obsidian vault directory does not exist.'), {
      status: 404,
    });
  }

  const notes = [];
  let skippedSensitive = 0;

  async function walk(currentDir) {
    if (notes.length >= MAX_OBSIDIAN_FILES) return;

    let entries;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (notes.length >= MAX_OBSIDIAN_FILES) break;

      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootRealPath, fullPath);
      const relPosix = relPath.split(path.sep).join('/');

      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name.toLowerCase())) {
        if (SENSITIVE_NAME_PATTERN.test(entry.name)) {
          skippedSensitive += 1;
        }
        continue;
      }

      if (isSensitiveRelativePath(relPosix)) {
        skippedSensitive += 1;
        continue;
      }

      // Guard against symlink escapes outside the chosen vault root.
      let entryRealPath;
      try {
        entryRealPath = await fsp.realpath(fullPath);
      } catch {
        continue;
      }
      const relativeCheck = path.relative(rootRealPath, entryRealPath);
      if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(entryRealPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
        continue;
      }

      try {
        const fileStat = await fsp.stat(entryRealPath);
        if (fileStat.size > MAX_NOTE_BYTES) {
          continue;
        }
        const rawText = await fsp.readFile(entryRealPath, 'utf8');
        const body = stripFrontmatter(rawText);
        const title = extractNoteTitle(body, entry.name);
        const excerpt = buildExcerpt(body);
        const wikilinks = extractWikilinks(rawText);
        const content =
          rawText.length > MAX_NOTE_CONTENT_CHARS
            ? rawText.slice(0, MAX_NOTE_CONTENT_CHARS)
            : rawText;

        notes.push({
          path: relPosix,
          title,
          excerpt,
          content,
          wikilinks,
          selectedForContext: false,
        });
      } catch {
        // skip unreadable note cleanly
      }
    }
  }

  await walk(rootRealPath);

  return {
    ok: true,
    count: notes.length,
    truncated: notes.length >= MAX_OBSIDIAN_FILES,
    skippedSensitive,
    notes,
  };
}

const OBSIDIAN_MOC_NAME_PATTERN =
  /^(?:_?moc(?:$|[\s_\-.])|00[_.\-\s]|readme$|index$|dashboard$)|(?:[\s_\-.]moc)$/i;
const OBSIDIAN_GENERIC_MOC_STEM_PATTERN = /^(?:_?moc|readme|index|dashboard)$/i;

function foldSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

function getObsidianTopFolder(relPosix) {
  const slashIdx = relPosix.indexOf('/');
  return slashIdx > 0 ? relPosix.slice(0, slashIdx) : '';
}

function isObsidianMocFileName(fileName) {
  const stem = String(fileName || '').replace(/\.md$/i, '').trim();
  return OBSIDIAN_MOC_NAME_PATTERN.test(stem);
}

function tokenizeObsidianQuery(rawQuery) {
  const cleaned = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (!cleaned) return [];
  const rawTokens = cleaned
    .split(/[\s,;:!?/\\|()[\]{}"']+/)
    .map((token) => foldSearchText(token).trim())
    .filter(Boolean);

  const filtered = rawTokens.filter((token) => token.length >= 2);
  const chosen = filtered.length > 0 ? filtered : rawTokens;
  return Array.from(new Set(chosen)).slice(0, 12);
}

function buildTokenLightStems(token) {
  const stems = [];
  if (token.length >= 6 && /(?:en|er|es)$/.test(token)) {
    stems.push(token.slice(0, -2));
  }
  if (token.length >= 5 && /[ens]$/.test(token)) {
    stems.push(token.slice(0, -1));
  }
  return stems;
}

function cleanMarkdownForSnippet(markdownBody) {
  return String(markdownBody || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildContextualExcerpt(markdownBody, tokens, rawPhrase, maxChars = MAX_OBSIDIAN_SEARCH_EXCERPT_CHARS) {
  const plain = cleanMarkdownForSnippet(markdownBody);
  if (!plain) return '';
  if (plain.length <= maxChars) return plain;

  const foldedPlain = foldSearchText(plain);
  const foldedPhrase = foldSearchText(rawPhrase || '').replace(/\s+/g, ' ').trim();

  let hitIdx = -1;
  if (foldedPhrase.length >= 3) {
    hitIdx = foldedPlain.indexOf(foldedPhrase);
  }
  if (hitIdx < 0 && Array.isArray(tokens) && tokens.length > 0) {
    // Prefer the longest token match for the most informative context window
    const sortedTokens = [...tokens].sort((a, b) => b.length - a.length);
    for (const token of sortedTokens) {
      const idx = foldedPlain.indexOf(token);
      if (idx >= 0) {
        hitIdx = idx;
        break;
      }
    }
    if (hitIdx < 0) {
      for (const token of sortedTokens) {
        for (const stem of buildTokenLightStems(token)) {
          const idx = foldedPlain.indexOf(stem);
          if (idx >= 0) {
            hitIdx = idx;
            break;
          }
        }
        if (hitIdx >= 0) break;
      }
    }
  }

  // Note: foldedPlain can differ slightly in length from plain when ä/ö/ü/ß expand to 2 chars.
  // Scale index proportionally back into plain safely.
  if (hitIdx > 0 && foldedPlain.length > 0 && foldedPlain.length !== plain.length) {
    hitIdx = Math.min(plain.length - 1, Math.round((hitIdx / foldedPlain.length) * plain.length));
  }

  if (hitIdx < 0 || hitIdx < Math.floor(maxChars * 0.45)) {
    let end = maxChars - 1;
    const lastSpace = plain.lastIndexOf(' ', end);
    if (lastSpace > maxChars * 0.7) end = lastSpace;
    return `${plain.slice(0, end).trimEnd()}…`;
  }

  let start = Math.max(0, hitIdx - 110);
  if (start > 0) {
    const nextSpace = plain.indexOf(' ', start);
    if (nextSpace > 0 && nextSpace < hitIdx && nextSpace - start < 28) {
      start = nextSpace + 1;
    }
  }

  let end = Math.min(plain.length, start + (maxChars - (start > 0 ? 2 : 1)));
  if (end < plain.length) {
    const lastSpace = plain.lastIndexOf(' ', end);
    if (lastSpace > start + maxChars * 0.65) {
      end = lastSpace;
    }
  }

  const prefix = start > 0 ? '…' : '';
  const suffix = end < plain.length ? '…' : '';
  return `${prefix}${plain.slice(start, end).trim()}${suffix}`;
}

async function resolveObsidianVaultRoot(rawVaultPath) {
  let candidatePath = typeof rawVaultPath === 'string' ? rawVaultPath.trim() : '';

  if (!candidatePath) {
    const detected = await detectObsidianVaults();
    const preferred = detected.vaults.find((v) => v.isOpen) || detected.vaults[0] || null;
    if (!preferred || !preferred.path) {
      throw Object.assign(
        new Error('Kein Obsidian-Vault angegeben und kein geöffneter Vault gefunden.'),
        { status: 404 }
      );
    }
    candidatePath = preferred.path;
  }

  const requestedPath = path.resolve(candidatePath);
  if (isForbiddenVaultRoot(requestedPath)) {
    throw Object.assign(
      new Error('Scanning a system directory or drive root is not allowed. Select your Obsidian vault folder.'),
      { status: 403 }
    );
  }

  let rootRealPath;
  try {
    rootRealPath = await fsp.realpath(requestedPath);
    const stat = await fsp.stat(rootRealPath);
    if (!stat.isDirectory()) {
      throw new Error('Not a directory');
    }
  } catch {
    throw Object.assign(new Error('The selected Obsidian vault directory does not exist.'), {
      status: 404,
    });
  }

  return {
    vaultPath: rootRealPath,
    vaultName: path.basename(rootRealPath) || rootRealPath,
  };
}

function isPathInsideRoot(rootRealPath, candidateRealPath) {
  const rel = path.relative(rootRealPath, candidateRealPath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function walkObsidianMarkdownFiles(rootRealPath, maxFiles) {
  const files = [];
  const visitedDirs = new Set([rootRealPath]);

  async function walk(currentDir, relPrefix) {
    if (files.length >= maxFiles) return;

    let entries;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;

      const name = entry.name;
      if (!name || name.startsWith('.') || IGNORED_DIRS.has(name.toLowerCase())) {
        continue;
      }
      if (SENSITIVE_NAME_PATTERN.test(name)) {
        continue;
      }

      const relPosix = relPrefix ? `${relPrefix}/${name}` : name;
      if (isSensitiveRelativePath(relPosix)) {
        continue;
      }

      const fullPath = path.join(currentDir, name);

      if (entry.isSymbolicLink()) {
        let entryRealPath;
        try {
          entryRealPath = await fsp.realpath(fullPath);
        } catch {
          continue;
        }
        if (!isPathInsideRoot(rootRealPath, entryRealPath)) {
          continue;
        }
        const realRelPosix = path.relative(rootRealPath, entryRealPath).split(path.sep).join('/');
        if (isSensitiveRelativePath(realRelPosix)) {
          continue;
        }
        let targetStat;
        try {
          targetStat = await fsp.stat(entryRealPath);
        } catch {
          continue;
        }
        if (targetStat.isDirectory()) {
          if (visitedDirs.has(entryRealPath)) continue;
          visitedDirs.add(entryRealPath);
          await walk(entryRealPath, relPosix);
          continue;
        }
        if (!targetStat.isFile() || !name.toLowerCase().endsWith('.md')) {
          continue;
        }
        files.push({
          fullPath: entryRealPath,
          relPosix,
          fileName: name,
          stem: name.slice(0, -3),
          folder: getObsidianTopFolder(relPosix),
        });
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath, relPosix);
        continue;
      }

      if (!entry.isFile() || !name.toLowerCase().endsWith('.md')) {
        continue;
      }

      files.push({
        fullPath,
        relPosix,
        fileName: name,
        stem: name.slice(0, -3),
        folder: getObsidianTopFolder(relPosix),
      });
    }
  }

  await walk(rootRealPath, '');
  return files;
}

async function getObsidianVaultOverview(rawVaultPath) {
  const { vaultPath, vaultName } = await resolveObsidianVaultRoot(rawVaultPath);
  const entries = await walkObsidianMarkdownFiles(vaultPath, MAX_OBSIDIAN_OVERVIEW_FILES);

  const folderCounts = new Map();
  const mocCandidates = [];

  for (const item of entries) {
    const folderKey = item.folder || '(Root)';
    folderCounts.set(folderKey, (folderCounts.get(folderKey) || 0) + 1);

    if (isObsidianMocFileName(item.fileName)) {
      const depth = item.relPosix.split('/').length;
      const displayTitle =
        item.folder && OBSIDIAN_GENERIC_MOC_STEM_PATTERN.test(item.stem)
          ? `${item.folder}/${item.stem}`
          : item.stem;
      mocCandidates.push({
        depth,
        path: item.relPosix,
        title: displayTitle,
      });
    }
  }

  // Fast batched stat-only pass to collect the 20 most recently modified notes without reading file bodies
  const recentCandidates = [];
  const STAT_BATCH_SIZE = 32;
  for (let i = 0; i < entries.length; i += STAT_BATCH_SIZE) {
    const batch = entries.slice(i, i + STAT_BATCH_SIZE);
    const stats = await Promise.all(
      batch.map(async (item) => {
        try {
          const st = await fsp.stat(item.fullPath);
          if (!st.isFile()) return null;
          return {
            path: item.relPosix,
            title: item.stem,
            folder: item.folder,
            mtimeMs: st.mtimeMs,
          };
        } catch {
          return null;
        }
      })
    );
    for (const st of stats) {
      if (st) recentCandidates.push(st);
    }
  }

  recentCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recentNotes = recentCandidates.slice(0, 20).map((item) => ({
    path: item.path,
    title: item.title,
    folder: item.folder,
    updatedAt: new Date(item.mtimeMs).toISOString(),
  }));

  const folders = Array.from(folderCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 30);

  mocCandidates.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path);
  });
  const mocNotes = [];
  const seenMocTitles = new Set();
  for (const moc of mocCandidates) {
    if (seenMocTitles.has(moc.title)) continue;
    seenMocTitles.add(moc.title);
    mocNotes.push(moc.title);
    if (mocNotes.length >= 20) break;
  }

  return {
    ok: true,
    vaultPath,
    vaultName,
    totalNotes: entries.length,
    folders,
    mocNotes,
    recentNotes,
  };
}

function matchesObsidianFolderFilter(item, rawFolderFilter) {
  if (!rawFolderFilter) return true;
  const trimmed = rawFolderFilter.trim();
  if (!trimmed) return true;
  if (trimmed === '/' || trimmed.toLowerCase() === '(root)') {
    return item.folder === '';
  }

  const normalized = foldSearchText(trimmed.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
  if (!normalized) return true;

  const foldedRel = foldSearchText(item.relPosix);
  const foldedTop = foldSearchText(item.folder);
  const lastSlash = foldedRel.lastIndexOf('/');
  const foldedDir = lastSlash >= 0 ? foldedRel.slice(0, lastSlash) : '';

  return (
    foldedTop === normalized ||
    foldedRel.startsWith(`${normalized}/`) ||
    foldedDir.includes(normalized)
  );
}

function scoreObsidianPathMatch(item, tokens, foldedPhrase) {
  const foldedStem = foldSearchText(item.stem);
  const foldedRel = foldSearchText(item.relPosix);
  const lastSlash = foldedRel.lastIndexOf('/');
  const foldedDir = lastSlash >= 0 ? foldedRel.slice(0, lastSlash) : '';

  let score = 0;
  let matchedTokenCount = 0;

  for (const token of tokens) {
    let tokenMatched = false;
    if (foldedStem === token) {
      score += 100;
      tokenMatched = true;
    } else if (foldedStem.startsWith(token)) {
      score += 62;
      tokenMatched = true;
    } else if (foldedStem.includes(token)) {
      score += 48;
      tokenMatched = true;
    }

    if (foldedDir && foldedDir.includes(token)) {
      score += 34;
      tokenMatched = true;
    }

    if (!tokenMatched) {
      const stems = buildTokenLightStems(token);
      for (const stem of stems) {
        if (foldedStem.includes(stem)) {
          score += 24;
          tokenMatched = true;
          break;
        }
        if (foldedDir && foldedDir.includes(stem)) {
          score += 18;
          tokenMatched = true;
          break;
        }
      }
    }

    if (tokenMatched) matchedTokenCount += 1;
  }

  if (score > 0) {
    if (foldedPhrase.length >= 3 && (foldedStem.includes(foldedPhrase) || foldedRel.includes(foldedPhrase))) {
      score += 36;
    }
    if (tokens.length > 1 && matchedTokenCount === tokens.length) {
      score += 32;
    }
    if (isObsidianMocFileName(item.fileName)) {
      score += 8;
    }
  }

  return { score, matchedTokenCount };
}

function countTokenHitsInFoldedText(foldedText, token, maxHits = 8) {
  let count = 0;
  let pos = 0;
  while (count < maxHits) {
    const idx = foldedText.indexOf(token, pos);
    if (idx < 0) break;
    count += 1;
    pos = idx + token.length;
  }
  return count;
}

async function safeReadVaultMarkdownFile(vaultPath, item, maxBytes) {
  let realFilePath;
  try {
    realFilePath = await fsp.realpath(item.fullPath);
  } catch {
    return { status: 'error' };
  }
  if (!isPathInsideRoot(vaultPath, realFilePath)) {
    return { status: 'blocked' };
  }
  const realRelPosix = path.relative(vaultPath, realFilePath).split(path.sep).join('/');
  if (isSensitiveRelativePath(realRelPosix)) {
    return { status: 'blocked' };
  }
  try {
    const st = await fsp.stat(realFilePath);
    if (!st.isFile()) {
      return { status: 'error' };
    }
    if (st.size > maxBytes) {
      return { status: 'oversized' };
    }
    const rawText = await fsp.readFile(realFilePath, 'utf8');
    return { status: 'ok', rawText, mtimeMs: st.mtimeMs };
  } catch {
    return { status: 'error' };
  }
}

async function searchObsidianVault(rawVaultPath, rawQuery, rawFolder, rawLimit) {
  const searchStartedAt = Date.now();
  const contentDeadline = searchStartedAt + OBSIDIAN_SEARCH_TIME_BUDGET_MS;

  const { vaultPath, vaultName } = await resolveObsidianVaultRoot(rawVaultPath);
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const folder = typeof rawFolder === 'string' ? rawFolder.trim() : '';
  const parsedLimit = Number(rawLimit);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(50, Math.max(1, Math.round(parsedLimit)))
    : 12;

  const allEntries = await walkObsidianMarkdownFiles(vaultPath, MAX_OBSIDIAN_SEARCH_FILES);
  const scopedEntries = folder
    ? allEntries.filter((item) => matchesObsidianFolderFilter(item, folder))
    : allEntries;

  const tokens = tokenizeObsidianQuery(query);
  const foldedPhrase = foldSearchText(query).replace(/\s+/g, ' ').trim();

  // Folder listing mode when query is empty
  if (tokens.length === 0) {
    const sorted = [...scopedEntries].sort((a, b) => {
      const aMoc = isObsidianMocFileName(a.fileName) ? 1 : 0;
      const bMoc = isObsidianMocFileName(b.fileName) ? 1 : 0;
      if (aMoc !== bMoc) return bMoc - aMoc;
      return a.relPosix.localeCompare(b.relPosix);
    });

    const results = [];
    let skippedCount = 0;
    for (const item of sorted) {
      if (results.length >= limit) break;
      const readRes = await safeReadVaultMarkdownFile(vaultPath, item, MAX_OBSIDIAN_SEARCH_NOTE_BYTES);
      if (readRes.status === 'oversized' || readRes.status === 'blocked') {
        skippedCount += 1;
        continue;
      }
      const body = readRes.status === 'ok' ? stripFrontmatter(readRes.rawText) : '';
      const title = readRes.status === 'ok' ? extractNoteTitle(body, item.fileName) : item.stem;
      const excerpt =
        readRes.status === 'ok'
          ? buildContextualExcerpt(body, [], '', MAX_OBSIDIAN_SEARCH_EXCERPT_CHARS)
          : '';
      results.push({
        path: item.relPosix,
        title,
        folder: item.folder,
        score: isObsidianMocFileName(item.fileName) ? 60 : 50,
        excerpt,
      });
    }

    return {
      ok: true,
      vaultName,
      query,
      totalMatches: Math.max(results.length, scopedEntries.length - skippedCount),
      results,
    };
  }

  // Phase 1: Instant filename + folder path scoring across all scoped notes
  const pathScored = [];
  const nonPathEntries = [];
  for (const item of scopedEntries) {
    const { score, matchedTokenCount } = scoreObsidianPathMatch(item, tokens, foldedPhrase);
    if (score > 0) {
      pathScored.push({
        item,
        score,
        matchedTokenCount,
        title: item.stem,
        excerpt: '',
        scanned: false,
      });
    } else {
      nonPathEntries.push(item);
    }
  }

  pathScored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.item.relPosix.length - b.item.relPosix.length;
  });

  const matchedByPath = new Map();
  for (const entry of pathScored) {
    matchedByPath.set(entry.item.relPosix, entry);
  }

  const scoreAndReadContent = async (item, basePathScore, baseMatchedTokens) => {
    const readRes = await safeReadVaultMarkdownFile(vaultPath, item, MAX_OBSIDIAN_SEARCH_NOTE_BYTES);
    if (readRes.status === 'oversized' || readRes.status === 'blocked') {
      return { drop: true, path: item.relPosix };
    }
    if (readRes.status !== 'ok') return null;

    const body = stripFrontmatter(readRes.rawText);
    const title = extractNoteTitle(body, item.fileName);
    const foldedTitle = foldSearchText(title);
    const foldedBody = foldSearchText(body);

    let contentScore = 0;
    let combinedTokenHits = 0;

    for (const token of tokens) {
      let tokenSeen = false;
      if (foldedTitle !== foldSearchText(item.stem) && foldedTitle.includes(token)) {
        contentScore += 32;
        tokenSeen = true;
      }
      const hits = countTokenHitsInFoldedText(foldedBody, token, 8);
      if (hits > 0) {
        contentScore += 16 + Math.min(hits - 1, 5) * 2;
        tokenSeen = true;
      } else if (!tokenSeen) {
        for (const stem of buildTokenLightStems(token)) {
          const stemHits = countTokenHitsInFoldedText(foldedBody, stem, 4);
          if (stemHits > 0) {
            contentScore += 9 + Math.min(stemHits - 1, 3);
            tokenSeen = true;
            break;
          }
        }
      }
      if (tokenSeen) combinedTokenHits += 1;
    }

    if (foldedPhrase.length >= 3 && foldedBody.includes(foldedPhrase)) {
      contentScore += 24;
    }
    if (tokens.length > 1 && combinedTokenHits === tokens.length) {
      contentScore += 20;
    }

    const totalScore = basePathScore + contentScore;
    if (totalScore <= 0) return null;

    const excerpt = buildContextualExcerpt(
      body,
      tokens,
      query,
      MAX_OBSIDIAN_SEARCH_EXCERPT_CHARS
    );

    return {
      item,
      score: totalScore,
      matchedTokenCount: Math.max(baseMatchedTokens, combinedTokenHits),
      title,
      excerpt,
      scanned: true,
    };
  };

  // Phase 2A: Enrich top path/title matches with real H1 title, content score boost & contextual snippet
  const topPathEnrichCount = Math.min(pathScored.length, Math.max(limit * 3, 36));
  const CONTENT_BATCH_SIZE = 16;
  for (let i = 0; i < topPathEnrichCount; i += CONTENT_BATCH_SIZE) {
    if (Date.now() >= contentDeadline && i >= limit) break;
    const batch = pathScored.slice(i, Math.min(i + CONTENT_BATCH_SIZE, topPathEnrichCount));
    const enriched = await Promise.all(
      batch.map((entry) => scoreAndReadContent(entry.item, entry.score, entry.matchedTokenCount))
    );
    for (let j = 0; j < batch.length; j += 1) {
      const updated = enriched[j];
      if (!updated) continue;
      if (updated.drop) {
        matchedByPath.delete(updated.path);
      } else {
        matchedByPath.set(updated.item.relPosix, updated);
      }
    }
  }

  // Phase 2B: Scan file bodies of non-path-matched notes while inside strict <800ms time budget
  // (Prioritize MOC/index notes first, then remaining files in batches of 16)
  if (nonPathEntries.length > 0 && Date.now() < contentDeadline) {
    const prioritizedBodyQueue = [...nonPathEntries].sort((a, b) => {
      const aMoc = isObsidianMocFileName(a.fileName) ? 1 : 0;
      const bMoc = isObsidianMocFileName(b.fileName) ? 1 : 0;
      if (aMoc !== bMoc) return bMoc - aMoc;
      return a.relPosix.length - b.relPosix.length;
    });

    for (let i = 0; i < prioritizedBodyQueue.length; i += CONTENT_BATCH_SIZE) {
      if (Date.now() >= contentDeadline) break;
      const batch = prioritizedBodyQueue.slice(i, i + CONTENT_BATCH_SIZE);
      const scanned = await Promise.all(
        batch.map((item) => scoreAndReadContent(item, 0, 0))
      );
      for (const hit of scanned) {
        if (hit && !hit.drop && hit.score > 0) {
          matchedByPath.set(hit.item.relPosix, hit);
        }
      }
    }
  }

  const allMatches = Array.from(matchedByPath.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.item.relPosix.localeCompare(b.item.relPosix);
  });

  const topResults = allMatches.slice(0, limit);
  return {
    ok: true,
    vaultName,
    query,
    totalMatches: allMatches.length,
    results: topResults.map((entry) => ({
      path: entry.item.relPosix,
      title: entry.title,
      folder: entry.item.folder,
      score: Math.round(entry.score),
      excerpt: entry.excerpt,
    })),
  };
}

async function readObsidianNote(rawVaultPath, rawRelPath) {
  const { vaultPath } = await resolveObsidianVaultRoot(rawVaultPath);

  if (typeof rawRelPath !== 'string' || !rawRelPath.trim()) {
    throw Object.assign(new Error('Parameter "relPath" is required.'), { status: 400 });
  }
  const trimmedRel = rawRelPath.trim();
  if (trimmedRel.length > 500 || trimmedRel.includes('\0')) {
    throw Object.assign(new Error('Invalid "relPath" parameter.'), { status: 400 });
  }

  const normalizedRel = trimmedRel.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalizedRel.split('/');
  if (
    !normalizedRel ||
    segments.some(
      (seg) =>
        !seg ||
        seg === '.' ||
        seg === '..' ||
        seg.startsWith('.') ||
        IGNORED_DIRS.has(seg.toLowerCase())
    )
  ) {
    throw Object.assign(new Error('Invalid or forbidden note path.'), { status: 403 });
  }

  if (!normalizedRel.toLowerCase().endsWith('.md')) {
    throw Object.assign(new Error('Only Markdown (.md) notes can be read.'), { status: 400 });
  }

  if (isSensitiveRelativePath(normalizedRel)) {
    throw Object.assign(
      new Error('Reading sensitive or credential-like files is blocked.'),
      { status: 403 }
    );
  }

  const candidatePath = path.resolve(vaultPath, ...segments);
  if (!isPathInsideRoot(vaultPath, candidatePath)) {
    throw Object.assign(new Error('Path traversal outside the Obsidian vault is blocked.'), {
      status: 403,
    });
  }

  let fileRealPath;
  try {
    fileRealPath = await fsp.realpath(candidatePath);
  } catch {
    throw Object.assign(new Error('The requested Obsidian note does not exist.'), { status: 404 });
  }

  if (!isPathInsideRoot(vaultPath, fileRealPath)) {
    throw Object.assign(new Error('Symlink escape outside the Obsidian vault is blocked.'), {
      status: 403,
    });
  }

  const finalRelPosix = path.relative(vaultPath, fileRealPath).split(path.sep).join('/');
  const finalSegments = finalRelPosix.split('/');
  if (
    !finalRelPosix.toLowerCase().endsWith('.md') ||
    finalSegments.some((seg) => seg.startsWith('.') || IGNORED_DIRS.has(seg.toLowerCase())) ||
    isSensitiveRelativePath(finalRelPosix)
  ) {
    throw Object.assign(new Error('Access to this file path is blocked.'), { status: 403 });
  }

  let stat;
  try {
    stat = await fsp.stat(fileRealPath);
  } catch {
    throw Object.assign(new Error('Could not stat the requested Obsidian note.'), { status: 404 });
  }
  if (!stat.isFile()) {
    throw Object.assign(new Error('Requested path is not a file.'), { status: 400 });
  }
  if (stat.size > MAX_OBSIDIAN_READ_BYTES) {
    throw Object.assign(new Error('The requested note exceeds the maximum readable size.'), {
      status: 413,
    });
  }

  const rawText = await fsp.readFile(fileRealPath, 'utf8');
  const body = stripFrontmatter(rawText);
  const title = extractNoteTitle(body, path.basename(fileRealPath));
  const content =
    rawText.length > MAX_NOTE_CONTENT_CHARS
      ? rawText.slice(0, MAX_NOTE_CONTENT_CHARS)
      : rawText;

  return {
    ok: true,
    path: finalRelPosix,
    title,
    content,
  };
}

function getRemindersPath() {
  return path.join(os.homedir(), '.openstudy', 'reminders.json');
}

function createDefaultReminders() {
  return {
    enabled: false,
    dailyTime: '18:00',
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    items: [],
    updatedAt: new Date().toISOString(),
  };
}

function isValidTimeString(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

const VALID_DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

async function loadReminders() {
  const filePath = getRemindersPath();
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const defaults = createDefaultReminders();
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : defaults.enabled,
      dailyTime: isValidTimeString(parsed.dailyTime) ? parsed.dailyTime : defaults.dailyTime,
      days: Array.isArray(parsed.days)
        ? parsed.days.filter((d) => VALID_DAYS.has(d))
        : defaults.days,
      items: Array.isArray(parsed.items) ? parsed.items.slice(0, 50) : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : defaults.updatedAt,
    };
  } catch {
    return createDefaultReminders();
  }
}

async function saveReminders(data) {
  const filePath = getRemindersPath();
  const dirPath = path.dirname(filePath);
  await fsp.mkdir(dirPath, { recursive: true });

  const nextPayload = {
    enabled: Boolean(data.enabled),
    dailyTime: isValidTimeString(data.dailyTime) ? data.dailyTime.trim() : '18:00',
    days: Array.isArray(data.days)
      ? Array.from(new Set(data.days.filter((d) => VALID_DAYS.has(d))))
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    items: Array.isArray(data.items) ? data.items.slice(0, 50) : [],
    updatedAt: new Date().toISOString(),
  };

  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(nextPayload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fsp.rename(tempPath, filePath);
  return nextPayload;
}

function computeNextReminderIso(reminders) {
  if (!reminders.enabled || !isValidTimeString(reminders.dailyTime) || reminders.days.length === 0) {
    return null;
  }

  const dayMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const [hours, minutes] = reminders.dailyTime.split(':').map(Number);
  const now = new Date();

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    const dayLabel = dayMap[candidate.getDay()];
    if (reminders.days.includes(dayLabel) && candidate.getTime() > now.getTime()) {
      return candidate.toISOString();
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Nous Research Hermes Gateway, Local Skills (SKILL.md) & Learner Memory    */
/* -------------------------------------------------------------------------- */

function validateLoopbackGatewayUrl(rawUrl) {
  if (rawUrl === undefined || rawUrl === null || String(rawUrl).trim() === '') {
    return { ok: true, url: DEFAULT_HERMES_GATEWAY_URL };
  }
  if (typeof rawUrl !== 'string') {
    return { ok: false, error: 'Invalid "gatewayUrl". Expected a localhost URL string.' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'Malformed "gatewayUrl". Expected e.g. http://127.0.0.1:9119.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Invalid "gatewayUrl" protocol. Only http and https are allowed.' };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, error: 'Invalid "gatewayUrl". Credentials, query strings, and fragments are not permitted.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
    return {
      ok: false,
      error: 'Blocked non-loopback "gatewayUrl". Only 127.0.0.1, localhost, and [::1] are permitted.',
    };
  }

  const cleanPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${parsed.origin}${cleanPath}` };
}

async function readLimitedText(response, maxBytes = MAX_OUTPUT_BYTES) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining));
        }
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function probeHermesGateway(rawGatewayUrl) {
  const checked = validateLoopbackGatewayUrl(rawGatewayUrl);
  if (!checked.ok) {
    return {
      valid: false,
      online: false,
      gatewayUrl: DEFAULT_HERMES_GATEWAY_URL,
      models: [],
      error: checked.error,
    };
  }

  const baseUrl = checked.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HERMES_PROBE_TIMEOUT_MS);

  try {
    const modelsRes = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });

    if (modelsRes.ok) {
      let models = [];
      try {
        const text = await readLimitedText(modelsRes, 64 * 1024);
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.data)) {
          models = parsed.data
            .map((item) => (typeof item?.id === 'string' ? item.id : null))
            .filter(Boolean)
            .slice(0, 30);
        }
      } catch {
        // non-JSON /v1/models response still indicates online gateway
      }
      return { valid: true, online: true, gatewayUrl: baseUrl, models };
    }

    if (modelsRes.status === 401 || modelsRes.status === 403) {
      return { valid: true, online: true, gatewayUrl: baseUrl, models: [] };
    }

    if (modelsRes.status === 404 || modelsRes.status === 405) {
      const healthRes = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
      return {
        valid: true,
        online: healthRes.ok || healthRes.status === 401 || healthRes.status === 403,
        gatewayUrl: baseUrl,
        models: [],
      };
    }

    return { valid: true, online: false, gatewayUrl: baseUrl, models: [] };
  } catch {
    return { valid: true, online: false, gatewayUrl: baseUrl, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

function extractAssistantReply(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

async function proxyHermesChat(body) {
  const checked = validateLoopbackGatewayUrl(body.gatewayUrl);
  if (!checked.ok) {
    return { status: 400, payload: { ok: false, error: checked.error } };
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      status: 400,
      payload: { ok: false, error: 'Field "messages" must be a non-empty array.' },
    };
  }

  const validMessages = body.messages.every(
    (msg) => msg && typeof msg === 'object' && typeof msg.role === 'string' && msg.role.trim().length > 0
  );
  if (!validMessages) {
    return {
      status: 400,
      payload: { ok: false, error: 'Each entry in "messages" must include a valid "role".' },
    };
  }

  const baseUrl = checked.url;
  const forwardPayload = {
    model:
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim().slice(0, 120)
        : 'hermes-agent',
    messages: body.messages,
    stream: false,
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    forwardPayload.tools = body.tools;
    if (typeof body.tool_choice === 'string' || (body.tool_choice && typeof body.tool_choice === 'object')) {
      forwardPayload.tool_choice = body.tool_choice;
    }
  }
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    forwardPayload.temperature = Math.min(2, Math.max(0, body.temperature));
  }
  if (typeof body.max_tokens === 'number' && Number.isInteger(body.max_tokens) && body.max_tokens > 0) {
    forwardPayload.max_tokens = Math.min(32_768, body.max_tokens);
  }

  const headers = { 'Content-Type': 'application/json' };
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    headers.Authorization = `Bearer ${body.apiKey.trim()}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HERMES_CHAT_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(forwardPayload),
      redirect: 'manual',
      signal: controller.signal,
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      return {
        status: 502,
        payload: {
          ok: false,
          gatewayOnline: true,
          gatewayUrl: baseUrl,
          error: 'Hermes Gateway returned an unexpected redirect.',
        },
      };
    }

    const rawText = await readLimitedText(upstream, MAX_OUTPUT_BYTES);
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!upstream.ok) {
      const upstreamError =
        parsed?.error?.message ||
        (typeof parsed?.error === 'string' ? parsed.error : '') ||
        parsed?.message ||
        rawText.slice(0, 260) ||
        `Hermes Gateway returned HTTP ${upstream.status}.`;
      return {
        status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
        payload: {
          ok: false,
          gatewayOnline: true,
          gatewayUrl: baseUrl,
          error: upstreamError,
        },
      };
    }

    if (!parsed || typeof parsed !== 'object') {
      return {
        status: 502,
        payload: {
          ok: false,
          gatewayOnline: true,
          gatewayUrl: baseUrl,
          error: 'Hermes Gateway returned a non-JSON response.',
        },
      };
    }

    const reply = extractAssistantReply(parsed);
    return {
      status: 200,
      payload: {
        ok: true,
        ...parsed,
        reply,
      },
    };
  } catch (err) {
    const cliAvailable = Boolean(findExecutableOnPath('hermes'));
    const timedOut = err && err.name === 'AbortError';
    return {
      status: timedOut ? 504 : 503,
      payload: {
        ok: false,
        gatewayOnline: false,
        cliAvailable,
        fallbackAvailable: cliAvailable,
        gatewayUrl: baseUrl,
        error: timedOut
          ? `Hermes Gateway unter ${baseUrl} hat nicht rechtzeitig geantwortet.`
          : cliAvailable
            ? `Hermes Gateway ist unter ${baseUrl} nicht gestartet. Die lokale hermes-CLI wurde erkannt und kann über /api/agent genutzt werden.`
            : `Hermes Gateway ist unter ${baseUrl} nicht erreichbar und die lokale hermes-CLI wurde nicht gefunden.`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function getHermesDir() {
  return path.join(os.homedir(), '.openstudy', 'hermes');
}

function getHermesSkillsDir() {
  return path.join(getHermesDir(), 'skills');
}

function getHermesMemoryPath() {
  return path.join(getHermesDir(), 'memory.json');
}

function sanitizeSkillSlug(rawName) {
  if (typeof rawName !== 'string') return '';
  const slug = rawName
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[\s/\\.]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64);

  if (!slug || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
    return '';
  }
  if (SENSITIVE_NAME_PATTERN.test(slug)) {
    return '';
  }
  return slug;
}

function parseYamlScalar(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseSkillMarkdown(rawText, fallbackSlug, fileName) {
  const normalized = String(rawText || '').replace(/\r\n/g, '\n');
  const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  const meta = {};
  let body = normalized.trim();

  if (frontmatterMatch) {
    const yamlBlock = frontmatterMatch[1];
    body = frontmatterMatch[2].trim();
    for (const line of yamlBlock.split('\n')) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1);
      if (key) {
        meta[key] = parseYamlScalar(value);
      }
    }
  }

  const name =
    typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim().slice(0, 120) : fallbackSlug;
  const description =
    typeof meta.description === 'string' ? meta.description.trim().slice(0, 400) : '';
  const trigger = typeof meta.trigger === 'string' ? meta.trigger.trim().slice(0, 240) : '';
  const enabled = typeof meta.enabled === 'boolean' ? meta.enabled : true;
  const updatedAt =
    typeof meta.updatedAt === 'string' && meta.updatedAt.trim()
      ? meta.updatedAt.trim()
      : new Date().toISOString();

  return {
    id: fallbackSlug,
    slug: fallbackSlug,
    fileName,
    name,
    description,
    trigger,
    instructions: body,
    enabled,
    updatedAt,
    rawMarkdown: normalized,
  };
}

function serializeSkillMarkdown(skill) {
  const name = String(skill.name || skill.slug || '').trim().slice(0, 120);
  const description = String(skill.description || '').trim().slice(0, 400);
  const trigger = String(skill.trigger || '').trim().slice(0, 240);
  const enabled = skill.enabled !== false;
  const updatedAt = new Date().toISOString();
  const instructions = String(skill.instructions ?? skill.content ?? '').replace(/\r\n/g, '\n').trim();

  const frontmatter = [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    `trigger: ${JSON.stringify(trigger)}`,
    `enabled: ${enabled ? 'true' : 'false'}`,
    `updatedAt: ${JSON.stringify(updatedAt)}`,
    '---',
  ].join('\n');

  const markdown = instructions ? `${frontmatter}\n\n${instructions}\n` : `${frontmatter}\n`;
  if (Buffer.byteLength(markdown, 'utf8') > MAX_HERMES_SKILL_BYTES) {
    throw Object.assign(new Error('Skill file exceeds the 32 KB size limit.'), { status: 413 });
  }

  return { markdown, updatedAt, name, description, trigger, enabled, instructions };
}

async function loadHermesSkills() {
  const skillsDir = getHermesSkillsDir();
  let rootRealPath;
  try {
    rootRealPath = await fsp.realpath(skillsDir);
  } catch {
    return [];
  }

  let entries;
  try {
    entries = await fsp.readdir(rootRealPath, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const skills = [];

  for (const entry of entries) {
    if (skills.length >= MAX_HERMES_SKILLS) break;
    if (entry.name.startsWith('.') || SENSITIVE_NAME_PATTERN.test(entry.name)) continue;

    let candidatePath = null;
    let fallbackSlug = '';
    let fileName = '';

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      fallbackSlug = sanitizeSkillSlug(entry.name.replace(/\.md$/i, ''));
      if (!fallbackSlug) continue;
      candidatePath = path.join(rootRealPath, entry.name);
      fileName = entry.name;
    } else if (entry.isDirectory()) {
      fallbackSlug = sanitizeSkillSlug(entry.name);
      if (!fallbackSlug) continue;
      const nestedSkill = path.join(rootRealPath, entry.name, 'SKILL.md');
      try {
        const nestedStat = await fsp.stat(nestedSkill);
        if (nestedStat.isFile()) {
          candidatePath = nestedSkill;
          fileName = `${entry.name}/SKILL.md`;
        }
      } catch {
        continue;
      }
    }

    if (!candidatePath) continue;

    try {
      const realFile = await fsp.realpath(candidatePath);
      const relCheck = path.relative(rootRealPath, realFile);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) continue;

      const stat = await fsp.stat(realFile);
      if (!stat.isFile() || stat.size > MAX_HERMES_SKILL_BYTES) continue;

      const rawText = await fsp.readFile(realFile, 'utf8');
      skills.push(parseSkillMarkdown(rawText, fallbackSlug, fileName));
    } catch {
      // skip unreadable skill file cleanly
    }
  }

  skills.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return skills;
}

async function saveHermesSkill(rawSkill) {
  if (!rawSkill || typeof rawSkill !== 'object') {
    throw Object.assign(new Error('Skill payload must be a JSON object.'), { status: 400 });
  }

  const rawIdentifier =
    typeof rawSkill.slug === 'string' && rawSkill.slug.trim()
      ? rawSkill.slug
      : typeof rawSkill.name === 'string' && rawSkill.name.trim()
        ? rawSkill.name
        : typeof rawSkill.id === 'string'
          ? rawSkill.id
          : '';

  const slug = sanitizeSkillSlug(rawIdentifier);
  if (!slug) {
    throw Object.assign(
      new Error('Skill "name" must produce a valid safe slug using [a-z0-9-_].'),
      { status: 400 }
    );
  }

  const skillsDir = getHermesSkillsDir();
  await fsp.mkdir(skillsDir, { recursive: true });
  const resolvedDir = path.resolve(skillsDir);
  const fileName = `${slug}.md`;
  const targetPath = path.resolve(resolvedDir, fileName);

  const relCheck = path.relative(resolvedDir, targetPath);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck) || relCheck !== fileName) {
    throw Object.assign(new Error('Invalid skill target path.'), { status: 400 });
  }

  const serialized = serializeSkillMarkdown({
    ...rawSkill,
    slug,
    name: typeof rawSkill.name === 'string' && rawSkill.name.trim() ? rawSkill.name : slug,
  });

  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, serialized.markdown, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fsp.rename(tempPath, targetPath);

  return {
    id: slug,
    slug,
    fileName,
    name: serialized.name,
    description: serialized.description,
    trigger: serialized.trigger,
    instructions: serialized.instructions,
    enabled: serialized.enabled,
    updatedAt: serialized.updatedAt,
    rawMarkdown: serialized.markdown,
  };
}

async function deleteHermesSkill(rawName) {
  const slug = sanitizeSkillSlug(rawName || '');
  if (!slug) {
    throw Object.assign(new Error('Query parameter "name" must be a valid skill slug.'), {
      status: 400,
    });
  }

  const skillsDir = path.resolve(getHermesSkillsDir());
  const fileName = `${slug}.md`;
  const targetPath = path.resolve(skillsDir, fileName);
  const relCheck = path.relative(skillsDir, targetPath);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck) || relCheck !== fileName) {
    throw Object.assign(new Error('Invalid skill target path.'), { status: 400 });
  }

  try {
    await fsp.unlink(targetPath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

const VALID_MEMORY_CATEGORIES = new Set(['preference', 'strength', 'weakness', 'goal', 'workflow']);
const VALID_MEMORY_SOURCES = new Set(['agent', 'user']);

function sanitizeMemoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawFact =
    typeof raw.fact === 'string'
      ? raw.fact
      : typeof raw.content === 'string'
        ? raw.content
        : typeof raw.text === 'string'
          ? raw.text
          : '';
  const fact = rawFact.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!fact) return null;

  const category = VALID_MEMORY_CATEGORIES.has(raw.category) ? raw.category : 'preference';
  const source = VALID_MEMORY_SOURCES.has(raw.source) ? raw.source : 'user';
  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim().slice(0, 80)
      : crypto.randomUUID();
  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt.trim()
      ? raw.createdAt.trim().slice(0, 40)
      : new Date().toISOString();

  return { id, fact, category, createdAt, source };
}

function deduplicateMemoryEntries(rawList) {
  const seenFacts = new Set();
  const entries = [];
  for (const item of rawList) {
    const clean = sanitizeMemoryEntry(item);
    if (!clean) continue;
    const key = clean.fact.toLowerCase();
    if (seenFacts.has(key)) continue;
    seenFacts.add(key);
    entries.push(clean);
    if (entries.length >= MAX_HERMES_MEMORY_ENTRIES) break;
  }
  return entries;
}

async function loadHermesMemory() {
  const filePath = getHermesMemoryPath();
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.entries)
        ? parsed.entries
        : Array.isArray(parsed?.memory)
          ? parsed.memory
          : [];
    const entries = deduplicateMemoryEntries(list);
    return {
      entries,
      updatedAt:
        typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return {
      entries: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveHermesMemory(rawEntries) {
  const filePath = getHermesMemoryPath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  const entries = deduplicateMemoryEntries(Array.isArray(rawEntries) ? rawEntries : []);
  const payload = {
    entries,
    updatedAt: new Date().toISOString(),
  };

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fsp.rename(tempPath, filePath);
  return payload;
}

/* -------------------------------------------------------------------------- */
/*  Safe Desktop Teacher Helper (Windows Read-Only Context & Click-Through)   */
/* -------------------------------------------------------------------------- */

const ACTIVE_WINDOW_PS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  'Add-Type -Name Win -Namespace OpenStudyWinCtx -MemberDefinition @"',
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
  '"@',
  '$h = [OpenStudyWinCtx.Win]::GetForegroundWindow()',
  '$sb = New-Object System.Text.StringBuilder 512',
  'if ($h -ne [IntPtr]::Zero) { [void][OpenStudyWinCtx.Win]::GetWindowText($h, $sb, 512) }',
  '$pidOut = [uint32]0',
  'if ($h -ne [IntPtr]::Zero) { [void][OpenStudyWinCtx.Win]::GetWindowThreadProcessId($h, [ref]$pidOut) }',
  '$procName = ""',
  'if ($pidOut -gt 0) { try { $procName = [System.Diagnostics.Process]::GetProcessById([int]$pidOut).ProcessName } catch { $procName = "" } }',
  '@{ title = $sb.ToString(); processName = $procName } | ConvertTo-Json -Compress',
].join('\n');

const ACTIVE_WINDOW_PS_B64 = Buffer.from(ACTIVE_WINDOW_PS_SCRIPT, 'utf16le').toString('base64');

function filterWindowPrivacy(rawTitle, rawProcessName) {
  const title = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const processName =
    typeof rawProcessName === 'string' ? rawProcessName.replace(/\s+/g, ' ').trim().slice(0, 80) : '';

  if (SENSITIVE_WINDOW_PATTERN.test(title) || SENSITIVE_WINDOW_PATTERN.test(processName)) {
    return {
      title: '[Geschütztes Fenster]',
      processName: '',
      redacted: true,
    };
  }

  return { title, processName, redacted: false };
}

function getActiveDesktopWindow() {
  if (process.platform !== 'win32') {
    return Promise.resolve({
      ok: true,
      available: false,
      title: '',
      processName: '',
    });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          ACTIVE_WINDOW_PS_B64,
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
    } catch {
      resolve({ ok: true, available: false, title: '', processName: '' });
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      done({ ok: true, available: true, title: '', processName: '' });
    }, DESKTOP_WINDOW_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (totalBytes < 16 * 1024) {
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
    });

    child.on('error', () => {
      done({ ok: true, available: false, title: '', processName: '' });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        done({ ok: true, available: true, title: '', processName: '' });
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        const parsed = raw ? JSON.parse(raw) : {};
        const filtered = filterWindowPrivacy(parsed?.title, parsed?.processName);
        done({
          ok: true,
          available: true,
          title: filtered.title,
          processName: filtered.processName,
          redacted: filtered.redacted,
        });
      } catch {
        done({ ok: true, available: true, title: '', processName: '' });
      }
    });
  });
}

function sanitizeHighlightLabel(rawLabel) {
  if (typeof rawLabel !== 'string') return '';
  return rawLabel
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\p{L}\p{N} .,:\-()/+]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

const HIGHLIGHT_PS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  "$xPct = [double]::Parse($env:OPENSTUDY_HALO_X, [System.Globalization.CultureInfo]::InvariantCulture)",
  "$yPct = [double]::Parse($env:OPENSTUDY_HALO_Y, [System.Globalization.CultureInfo]::InvariantCulture)",
  '$labelText = [string]$env:OPENSTUDY_HALO_LABEL',
  '$stepNum = 0',
  '[void][int]::TryParse($env:OPENSTUDY_HALO_STEP, [ref]$stepNum)',
  '$durationMs = 4500',
  '[void][int]::TryParse($env:OPENSTUDY_HALO_DURATION, [ref]$durationMs)',
  '$csharp = @"',
  'using System;',
  'using System.Drawing;',
  'using System.Drawing.Drawing2D;',
  'using System.Drawing.Imaging;',
  'using System.Drawing.Text;',
  'using System.Runtime.InteropServices;',
  'using System.Windows.Forms;',
  'public class OpenStudyTeacherHalo : Form {',
  '    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }',
  '    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; }',
  '    [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLENDFUNCTION {',
  '        public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat;',
  '    }',
  '    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]',
  '    private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pprSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);',
  '    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)] private static extern IntPtr GetDC(IntPtr hWnd);',
  '    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);',
  '    [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)] private static extern IntPtr CreateCompatibleDC(IntPtr hDC);',
  '    [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)] private static extern bool DeleteDC(IntPtr hdc);',
  '    [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)] private static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);',
  '    [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)] private static extern bool DeleteObject(IntPtr hObject);',
  '    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);',
  '    private readonly string _label;',
  '    private readonly int _stepNumber;',
  '    private readonly int _durationMs;',
  '    private readonly int _ringCx;',
  '    private readonly int _ringCy;',
  '    private readonly bool _pillOnLeft;',
  '    private readonly Timer _timer;',
  '    private readonly int _startTick;',
  '    public OpenStudyTeacherHalo(int targetX, int targetY, Rectangle bounds, string label, int stepNumber, int durationMs) {',
  '        _label = label ?? "";',
  '        _stepNumber = stepNumber;',
  '        _durationMs = durationMs;',
  '        _pillOnLeft = targetX > (bounds.Left + (int)(bounds.Width * 0.62));',
  '        int formW = 460;',
  '        int formH = 140;',
  '        _ringCx = _pillOnLeft ? (formW - 58) : 58;',
  '        _ringCy = formH / 2;',
  '        int left = Math.Max(bounds.Left + 4, Math.Min(bounds.Right - formW - 4, targetX - _ringCx));',
  '        int top = Math.Max(bounds.Top + 4, Math.Min(bounds.Bottom - formH - 4, targetY - _ringCy));',
  '        FormBorderStyle = FormBorderStyle.None;',
  '        StartPosition = FormStartPosition.Manual;',
  '        ShowInTaskbar = false;',
  '        TopMost = true;',
  '        Bounds = new Rectangle(left, top, formW, formH);',
  '        _startTick = Environment.TickCount;',
  '        _timer = new Timer { Interval = 33 };',
  '        _timer.Tick += OnTick;',
  '    }',
  '    protected override bool ShowWithoutActivation { get { return true; } }',
  '    protected override CreateParams CreateParams {',
  '        get {',
  '            CreateParams cp = base.CreateParams;',
  '            cp.ExStyle |= 0x00080000 | 0x00000020 | 0x08000000 | 0x00000080 | 0x00000008;',
  '            return cp;',
  '        }',
  '    }',
  '    protected override void WndProc(ref Message m) {',
  '        if (m.Msg == 0x0084) { m.Result = new IntPtr(-1); return; }',
  '        if (m.Msg == 0x0021) { m.Result = new IntPtr(3); return; }',
  '        base.WndProc(ref m);',
  '    }',
  '    protected override void OnShown(EventArgs e) {',
  '        base.OnShown(e);',
  '        SetWindowPos(Handle, new IntPtr(-1), Left, Top, Width, Height, 0x0010 | 0x0002 | 0x0001);',
  '        RenderFrame(0);',
  '        _timer.Start();',
  '    }',
  '    private void OnTick(object sender, EventArgs e) {',
  '        int elapsed = unchecked(Environment.TickCount - _startTick);',
  '        if (elapsed >= _durationMs) {',
  '            _timer.Stop();',
  '            Close();',
  '            return;',
  '        }',
  '        RenderFrame(elapsed);',
  '    }',
  '    private static GraphicsPath CreateRoundedRect(RectangleF rect, float radius) {',
  '        float d = radius * 2f;',
  '        GraphicsPath path = new GraphicsPath();',
  '        path.AddArc(rect.X, rect.Y, d, d, 180, 90);',
  '        path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);',
  '        path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);',
  '        path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);',
  '        path.CloseFigure();',
  '        return path;',
  '    }',
  '    private void RenderFrame(int elapsed) {',
  '        float alphaFactor = 1f;',
  '        if (elapsed < 220) { alphaFactor = elapsed / 220f; }',
  '        else if (elapsed > _durationMs - 340) { alphaFactor = Math.Max(0f, (_durationMs - elapsed) / 340f); }',
  '        byte globalAlpha = (byte)Math.Max(0, Math.Min(255, (int)(alphaFactor * 255f)));',
  '        float pulse = (float)(0.5 + 0.5 * Math.Sin(elapsed / 260.0));',
  '        using (Bitmap bmp = new Bitmap(Width, Height, PixelFormat.Format32bppPArgb)) {',
  '            using (Graphics g = Graphics.FromImage(bmp)) {',
  '                g.SmoothingMode = SmoothingMode.AntiAlias;',
  '                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;',
  '                g.Clear(Color.Transparent);',
  '                float haloR = 30f + pulse * 8f;',
  '                using (SolidBrush haloFill = new SolidBrush(Color.FromArgb(40, 217, 107, 39))) {',
  '                    g.FillEllipse(haloFill, _ringCx - haloR, _ringCy - haloR, haloR * 2f, haloR * 2f);',
  '                }',
  '                float outerPulseR = 26f + pulse * 7f;',
  '                using (Pen pulsePen = new Pen(Color.FromArgb((int)(145 - pulse * 75), 217, 107, 39), 2f)) {',
  '                    g.DrawEllipse(pulsePen, _ringCx - outerPulseR, _ringCy - outerPulseR, outerPulseR * 2f, outerPulseR * 2f);',
  '                }',
  '                float mainR = 23f;',
  '                using (Pen creamHalo = new Pen(Color.FromArgb(200, 250, 247, 242), 5.5f)) {',
  '                    g.DrawEllipse(creamHalo, _ringCx - mainR, _ringCy - mainR, mainR * 2f, mainR * 2f);',
  '                }',
  '                using (Pen mainPen = new Pen(Color.FromArgb(250, 217, 107, 39), 3.2f)) {',
  '                    g.DrawEllipse(mainPen, _ringCx - mainR, _ringCy - mainR, mainR * 2f, mainR * 2f);',
  '                }',
  '                using (SolidBrush dotFill = new SolidBrush(Color.FromArgb(255, 217, 107, 39)))',
  '                using (Pen dotBorder = new Pen(Color.FromArgb(240, 250, 247, 242), 1.6f)) {',
  '                    g.FillEllipse(dotFill, _ringCx - 4f, _ringCy - 4f, 8f, 8f);',
  '                    g.DrawEllipse(dotBorder, _ringCx - 4f, _ringCy - 4f, 8f, 8f);',
  '                }',
  '                if (_stepNumber > 0) {',
  '                    float bx = _ringCx + 15f;',
  '                    float by = _ringCy - 30f;',
  '                    using (SolidBrush badgeFill = new SolidBrush(Color.FromArgb(255, 217, 107, 39)))',
  '                    using (Pen badgeRing = new Pen(Color.FromArgb(250, 250, 247, 242), 1.8f))',
  '                    using (Font badgeFont = new Font("Segoe UI", 8.5f, FontStyle.Bold))',
  '                    using (SolidBrush badgeText = new SolidBrush(Color.FromArgb(255, 250, 247, 242)))',
  '                    using (StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }) {',
  '                        g.FillEllipse(badgeFill, bx, by, 22f, 22f);',
  '                        g.DrawEllipse(badgeRing, bx, by, 22f, 22f);',
  '                        g.DrawString(_stepNumber.ToString(), badgeFont, badgeText, new RectangleF(bx, by, 22f, 22f), sf);',
  '                    }',
  '                }',
  '                if (!string.IsNullOrWhiteSpace(_label)) {',
  '                    using (Font labelFont = new Font("Segoe UI", 10f, FontStyle.Regular)) {',
  '                        SizeF textSize = g.MeasureString(_label, labelFont, 320);',
  '                        float padX = 13f;',
  '                        float padY = 7f;',
  '                        float pillW = Math.Min(346f, textSize.Width + padX * 2f);',
  '                        float pillH = Math.Max(32f, textSize.Height + padY * 2f);',
  '                        float pillX = _pillOnLeft ? (_ringCx - 38f - pillW) : (_ringCx + 38f);',
  '                        float pillY = _ringCy - pillH / 2f;',
  '                        RectangleF pillRect = new RectangleF(pillX, pillY, pillW, pillH);',
  '                        using (GraphicsPath pillPath = CreateRoundedRect(pillRect, 10f))',
  '                        using (SolidBrush pillBg = new SolidBrush(Color.FromArgb(245, 250, 247, 242)))',
  '                        using (Pen pillBorder = new Pen(Color.FromArgb(220, 217, 107, 39), 1.4f))',
  '                        using (SolidBrush textBrush = new SolidBrush(Color.FromArgb(255, 28, 25, 23)))',
  '                        using (StringFormat sf = new StringFormat { Alignment = StringAlignment.Near, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap }) {',
  '                            g.FillPath(pillBg, pillPath);',
  '                            g.DrawPath(pillBorder, pillPath);',
  '                            g.DrawString(_label, labelFont, textBrush, new RectangleF(pillX + padX, pillY, pillW - padX * 2f, pillH), sf);',
  '                        }',
  '                    }',
  '                }',
  '            }',
  '            ApplyBitmap(bmp, globalAlpha);',
  '        }',
  '    }',
  '    private void ApplyBitmap(Bitmap bitmap, byte opacity) {',
  '        IntPtr screenDc = GetDC(IntPtr.Zero);',
  '        IntPtr memDc = CreateCompatibleDC(screenDc);',
  '        IntPtr hBitmap = IntPtr.Zero;',
  '        IntPtr oldBitmap = IntPtr.Zero;',
  '        try {',
  '            hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));',
  '            oldBitmap = SelectObject(memDc, hBitmap);',
  '            SIZE size = new SIZE { cx = bitmap.Width, cy = bitmap.Height };',
  '            POINT src = new POINT { x = 0, y = 0 };',
  '            POINT dst = new POINT { x = Left, y = Top };',
  '            BLENDFUNCTION blend = new BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = opacity, AlphaFormat = 1 };',
  '            UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, 2);',
  '        } finally {',
  '            ReleaseDC(IntPtr.Zero, screenDc);',
  '            if (hBitmap != IntPtr.Zero) { SelectObject(memDc, oldBitmap); DeleteObject(hBitmap); }',
  '            DeleteDC(memDc);',
  '        }',
  '    }',
  '    protected override void Dispose(bool disposing) {',
  '        if (disposing && _timer != null) { _timer.Dispose(); }',
  '        base.Dispose(disposing);',
  '    }',
  '}',
  '"@',
  'Add-Type -TypeDefinition $csharp -ReferencedAssemblies System.Windows.Forms, System.Drawing',
  '[void][OpenStudyTeacherHalo]::SetProcessDPIAware()',
  '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  '$tx = $bounds.Left + [int][Math]::Round($bounds.Width * ($xPct / 100.0))',
  '$ty = $bounds.Top + [int][Math]::Round($bounds.Height * ($yPct / 100.0))',
  '$form = New-Object OpenStudyTeacherHalo($tx, $ty, $bounds, $labelText, $stepNum, $durationMs)',
  '[System.Windows.Forms.Application]::Run($form)',
].join('\n');

const HIGHLIGHT_PS_B64 = Buffer.from(HIGHLIGHT_PS_SCRIPT, 'utf16le').toString('base64');

let activeHighlightProcess = null;
let activeHighlightSafetyTimer = null;

function cancelActiveHighlight() {
  if (activeHighlightSafetyTimer) {
    clearTimeout(activeHighlightSafetyTimer);
    activeHighlightSafetyTimer = null;
  }
  if (activeHighlightProcess) {
    const proc = activeHighlightProcess;
    activeHighlightProcess = null;
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore if already exited
    }
  }
}

function showDesktopHighlight(body) {
  if (body && body.clear === true) {
    cancelActiveHighlight();
    return {
      ok: true,
      available: process.platform === 'win32',
      shown: false,
      cleared: true,
    };
  }

  const xPercent = Number(body.xPercent);
  const yPercent = Number(body.yPercent);

  if (
    !Number.isFinite(xPercent) ||
    !Number.isFinite(yPercent) ||
    xPercent < 0 ||
    xPercent > 100 ||
    yPercent < 0 ||
    yPercent > 100
  ) {
    throw Object.assign(
      new Error('Fields "xPercent" and "yPercent" must be numbers between 0 and 100.'),
      { status: 400 }
    );
  }

  const label = sanitizeHighlightLabel(body.label || '');
  const rawStep = body.stepNumber;
  const stepNumber =
    Number.isInteger(Number(rawStep)) && Number(rawStep) >= 1 && Number(rawStep) <= 99
      ? Number(rawStep)
      : 0;

  const rawDuration = Number(body.durationMs);
  const durationMs = Number.isFinite(rawDuration)
    ? Math.min(HIGHLIGHT_MAX_DURATION_MS, Math.max(HIGHLIGHT_MIN_DURATION_MS, Math.round(rawDuration)))
    : HIGHLIGHT_DEFAULT_DURATION_MS;

  if (process.platform !== 'win32') {
    return {
      ok: true,
      available: false,
      shown: false,
      xPercent,
      yPercent,
      label,
      stepNumber: stepNumber || null,
      durationMs,
    };
  }

  cancelActiveHighlight();

  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      HIGHLIGHT_PS_B64,
    ],
    {
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OPENSTUDY_HALO_X: String(xPercent),
        OPENSTUDY_HALO_Y: String(yPercent),
        OPENSTUDY_HALO_LABEL: label,
        OPENSTUDY_HALO_STEP: String(stepNumber),
        OPENSTUDY_HALO_DURATION: String(durationMs),
      },
    }
  );

  activeHighlightProcess = child;

  child.on('exit', () => {
    if (activeHighlightProcess === child) {
      activeHighlightProcess = null;
    }
    if (activeHighlightSafetyTimer) {
      clearTimeout(activeHighlightSafetyTimer);
      activeHighlightSafetyTimer = null;
    }
  });

  child.on('error', () => {
    if (activeHighlightProcess === child) {
      activeHighlightProcess = null;
    }
  });

  activeHighlightSafetyTimer = setTimeout(() => {
    if (activeHighlightProcess === child) {
      cancelActiveHighlight();
    }
  }, durationMs + 4_000);
  activeHighlightSafetyTimer.unref();

  child.unref();

  return {
    ok: true,
    available: true,
    shown: true,
    xPercent,
    yPercent,
    label,
    stepNumber: stepNumber || null,
    durationMs,
  };
}

const SCREENSHOT_PS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$inv = [System.Globalization.CultureInfo]::InvariantCulture',
  '$xPct = [double]::Parse($env:OPENSTUDY_SHOT_X, $inv)',
  '$yPct = [double]::Parse($env:OPENSTUDY_SHOT_Y, $inv)',
  '$wPct = [double]::Parse($env:OPENSTUDY_SHOT_W, $inv)',
  '$hPct = [double]::Parse($env:OPENSTUDY_SHOT_H, $inv)',
  '$maxW = [int]::Parse($env:OPENSTUDY_SHOT_MAX_WIDTH, $inv)',
  '$quality = [long]::Parse($env:OPENSTUDY_SHOT_QUALITY, $inv)',
  '$csharp = @"',
  'using System;',
  'using System.ComponentModel;',
  'using System.Drawing;',
  'using System.Drawing.Drawing2D;',
  'using System.Drawing.Imaging;',
  'using System.IO;',
  'using System.Runtime.InteropServices;',
  'using System.Windows.Forms;',
  'public static class OpenStudyScreenCapture {',
  '    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '    public static string CaptureJson(double xPct, double yPct, double wPct, double hPct, int maxW, long quality) {',
  '        SetProcessDPIAware();',
  '        Rectangle bounds = Screen.PrimaryScreen.Bounds;',
  '        int sw = bounds.Width;',
  '        int sh = bounds.Height;',
  '        int cx = Math.Max(0, Math.Min(sw - 1, (int)Math.Floor(sw * (xPct / 100.0))));',
  '        int cy = Math.Max(0, Math.Min(sh - 1, (int)Math.Floor(sh * (yPct / 100.0))));',
  '        int cw = Math.Max(1, Math.Min(sw - cx, (int)Math.Round(sw * (wPct / 100.0))));',
  '        int ch = Math.Max(1, Math.Min(sh - cy, (int)Math.Round(sh * (hPct / 100.0))));',
  '        using (Bitmap raw = new Bitmap(cw, ch, PixelFormat.Format24bppRgb)) {',
  '            try {',
  '                using (Graphics g = Graphics.FromImage(raw)) {',
  '                    g.CopyFromScreen(bounds.Left + cx, bounds.Top + cy, 0, 0, new Size(cw, ch), CopyPixelOperation.SourceCopy);',
  '                }',
  '            } catch (Win32Exception) {',
  '                return "{\\"error\\":\\"Desktop ist aktuell gesperrt oder nicht erreichbar.\\"}";',
  '            }',
  '            Bitmap output = raw;',
  '            Bitmap resized = null;',
  '            int ow = cw;',
  '            int oh = ch;',
  '            try {',
  '                if (cw > maxW) {',
  '                    ow = maxW;',
  '                    oh = Math.Max(1, (int)Math.Round(ch * (maxW / (double)cw)));',
  '                    resized = new Bitmap(ow, oh, PixelFormat.Format24bppRgb);',
  '                    using (Graphics rg = Graphics.FromImage(resized)) {',
  '                        rg.InterpolationMode = InterpolationMode.HighQualityBicubic;',
  '                        rg.SmoothingMode = SmoothingMode.HighQuality;',
  '                        rg.PixelOffsetMode = PixelOffsetMode.HighQuality;',
  '                        rg.CompositingQuality = CompositingQuality.HighQuality;',
  '                        rg.DrawImage(raw, 0, 0, ow, oh);',
  '                    }',
  '                    output = resized;',
  '                }',
  '                ImageCodecInfo jpegCodec = null;',
  '                foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders()) {',
  '                    if (codec.MimeType == "image/jpeg") { jpegCodec = codec; break; }',
  '                }',
  '                using (MemoryStream ms = new MemoryStream()) {',
  '                    if (jpegCodec != null) {',
  '                        using (EncoderParameters ep = new EncoderParameters(1)) {',
  '                            ep.Param[0] = new EncoderParameter(Encoder.Quality, quality);',
  '                            output.Save(ms, jpegCodec, ep);',
  '                        }',
  '                    } else {',
  '                        output.Save(ms, ImageFormat.Jpeg);',
  '                    }',
  '                    string b64 = Convert.ToBase64String(ms.ToArray());',
  '                    return string.Format("{{\\"width\\":{0},\\"height\\":{1},\\"base64\\":\\"{2}\\"}}", ow, oh, b64);',
  '                }',
  '            } finally {',
  '                if (resized != null) resized.Dispose();',
  '            }',
  '        }',
  '    }',
  '}',
  '"@',
  'Add-Type -TypeDefinition $csharp -ReferencedAssemblies System.Windows.Forms, System.Drawing',
  '[Console]::Out.Write([OpenStudyScreenCapture]::CaptureJson($xPct, $yPct, $wPct, $hPct, $maxW, $quality))',
].join('\n');

const SCREENSHOT_PS_B64 = Buffer.from(SCREENSHOT_PS_SCRIPT, 'utf16le').toString('base64');

function parseClampedQueryNumber(rawValue, fallback, min, max) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function captureDesktopScreenshot(searchParams) {
  if (process.platform !== 'win32') {
    return {
      status: 200,
      payload: {
        ok: false,
        available: false,
      },
    };
  }

  // Privacy Guard FIRST: refuse capture whenever a password manager, banking, or private window is active
  const windowCtx = await getActiveDesktopWindow();
  if (windowCtx?.redacted === true) {
    return {
      status: 403,
      payload: {
        ok: false,
        redacted: true,
        error: 'Geschütztes Fenster aktiv — kein Screenshot erstellt.',
      },
    };
  }

  const x = parseClampedQueryNumber(searchParams.get('x'), 0, 0, 95);
  const y = parseClampedQueryNumber(searchParams.get('y'), 0, 0, 95);
  const w = parseClampedQueryNumber(searchParams.get('w'), 100, 5, 100);
  const h = parseClampedQueryNumber(searchParams.get('h'), 100, 5, 100);
  const maxWidth = Math.round(parseClampedQueryNumber(searchParams.get('maxWidth'), 1920, 400, 2560));
  const quality = Math.round(parseClampedQueryNumber(searchParams.get('quality'), 88, 60, 95));

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          SCREENSHOT_PS_B64,
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            OPENSTUDY_SHOT_X: String(x),
            OPENSTUDY_SHOT_Y: String(y),
            OPENSTUDY_SHOT_W: String(w),
            OPENSTUDY_SHOT_H: String(h),
            OPENSTUDY_SHOT_MAX_WIDTH: String(maxWidth),
            OPENSTUDY_SHOT_QUALITY: String(quality),
          },
        }
      );
    } catch {
      resolve({
        status: 500,
        payload: {
          ok: false,
          available: false,
          error: 'Windows-Screenshot-Helfer konnte nicht gestartet werden.',
        },
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      done({
        status: 504,
        payload: {
          ok: false,
          error: 'Zeitüberschreitung beim Erstellen des Desktop-Screenshots.',
        },
      });
    }, DESKTOP_SCREENSHOT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes + chunk.length <= MAX_SCREENSHOT_STDOUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes < 4096) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on('error', () => {
      done({
        status: 500,
        payload: {
          ok: false,
          available: false,
          error: 'Desktop-Screenshot fehlgeschlagen.',
        },
      });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const errDetail = Buffer.concat(stderrChunks).toString('utf8').replace(/\s+/g, ' ').trim();
        done({
          status: 500,
          payload: {
            ok: false,
            error: errDetail
              ? `Desktop-Screenshot fehlgeschlagen: ${errDetail.slice(0, 180)}`
              : 'Desktop-Screenshot fehlgeschlagen.',
          },
        });
        return;
      }

      try {
        const raw = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed.error === 'string' && parsed.error.length > 0) {
          done({
            status: 503,
            payload: {
              ok: false,
              error: parsed.error,
            },
          });
          return;
        }
        if (
          !parsed ||
          typeof parsed.base64 !== 'string' ||
          parsed.base64.length === 0 ||
          typeof parsed.width !== 'number' ||
          typeof parsed.height !== 'number' ||
          parsed.width <= 0 ||
          parsed.height <= 0
        ) {
          done({
            status: 500,
            payload: {
              ok: false,
              error: 'Desktop-Screenshot lieferte keine gültigen Bilddaten.',
            },
          });
          return;
        }

        done({
          status: 200,
          payload: {
            ok: true,
            width: parsed.width,
            height: parsed.height,
            mimeType: 'image/jpeg',
            base64: parsed.base64,
            activeWindow: windowCtx.title || '',
          },
        });
      } catch {
        done({
          status: 500,
          payload: {
            ok: false,
            error: 'Desktop-Screenshot-Antwort konnte nicht gelesen werden.',
          },
        });
      }
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Local Windows OneNote Desktop COM Scanner (Read-Only, Privacy-Filtered)   */
/* -------------------------------------------------------------------------- */

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function isSensitiveOneNoteName(rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) return false;
  return SENSITIVE_NAME_PATTERN.test(name) || SENSITIVE_ONENOTE_PATTERN.test(name);
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function stripMarkupToReadableText(rawText) {
  const withBreaks = String(rawText || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(withBreaks)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function createUnavailableOneNoteResult() {
  return {
    ok: true,
    available: false,
    source: 'none',
    notebooks: [],
    recentPages: [],
    totalPages: 0,
    message: 'Lokales OneNote Desktop nicht gefunden.',
  };
}

const ONENOTE_SCAN_PS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$on = $null',
  'try {',
  '  $on = New-Object -ComObject OneNote.Application',
  '} catch {',
  '  [Console]::Out.Write(\'{"available":false}\')',
  '  exit 0',
  '}',
  'try {',
  "  $xml = ''",
  "  $on.GetHierarchy('', 4, [ref]$xml)",
  '  if ([string]::IsNullOrWhiteSpace($xml)) {',
  '    [Console]::Out.Write(\'{"available":true,"notebooks":[]}\')',
  '    exit 0',
  '  }',
  '  [xml]$doc = $xml',
  "  $sensRx = '(?i)(^|[._\\-\\s/])(env|passwords?|passwd|passwort|passwörter|passwoerter|secrets?|credits?|kreditkarten?|cardnumber|apikeys?|api_keys?|tokens?|credentials?|private|privat|vault|tresor|geheim|banking|e-?banking|steuer|passport|ausweis|recovery|seedphrase|wallet|zugangsdaten|logins?)([._\\-\\s/]|$)'",
  '  function Test-Sens([string]$s) {',
  '    if ([string]::IsNullOrWhiteSpace($s)) { return $false }',
  '    return ($s -match $sensRx)',
  '  }',
  '  function Collect-Sections($node, [string]$prefix, $targetList) {',
  '    foreach ($child in $node.ChildNodes) {',
  "      if ($child.NodeType -ne 'Element') { continue }",
  '      $ln = $child.LocalName',
  "      if ($ln -eq 'SectionGroup') {",
  "        if ($child.GetAttribute('isRecycleBin') -eq 'true') { continue }",
  "        $gName = [string]$child.GetAttribute('name')",
  '        if (Test-Sens $gName) { continue }',
  '        $nextPrefix = if ($prefix) { "$prefix / $gName" } else { $gName }',
  '        Collect-Sections $child $nextPrefix $targetList',
  "      } elseif ($ln -eq 'Section') {",
  "        if ($child.GetAttribute('isInRecycleBin') -eq 'true' -or $child.GetAttribute('encrypted') -eq 'true' -or $child.GetAttribute('locked') -eq 'true') { continue }",
  "        $sName = [string]$child.GetAttribute('name')",
  '        if (Test-Sens $sName) { continue }',
  '        $fullName = if ($prefix) { "$prefix / $sName" } else { $sName }',
  '        $pages = New-Object System.Collections.ArrayList',
  '        foreach ($p in $child.ChildNodes) {',
  "          if ($p.NodeType -ne 'Element' -or $p.LocalName -ne 'Page') { continue }",
  "          if ($p.GetAttribute('isInRecycleBin') -eq 'true') { continue }",
  "          $pName = [string]$p.GetAttribute('name')",
  '          if (Test-Sens $pName) { continue }',
  "          $pMod = [string]$p.GetAttribute('lastModifiedTime')",
  "          if ([string]::IsNullOrWhiteSpace($pMod)) { $pMod = [string]$p.GetAttribute('dateTime') }",
  '          [void]$pages.Add(@{',
  "            id = [string]$p.GetAttribute('ID')",
  '            name = $pName',
  '            lastModified = $pMod',
  '          })',
  '        }',
  '        [void]$targetList.Add(@{',
  "          id = [string]$child.GetAttribute('ID')",
  '          name = $fullName',
  '          pages = $pages.ToArray()',
  '        })',
  '      }',
  '    }',
  '  }',
  '  $notebooks = New-Object System.Collections.ArrayList',
  '  if ($doc.DocumentElement) {',
  '    foreach ($nb in $doc.DocumentElement.ChildNodes) {',
  "      if ($nb.NodeType -ne 'Element' -or $nb.LocalName -ne 'Notebook') { continue }",
  "      $nbName = [string]$nb.GetAttribute('name')",
  '      if (Test-Sens $nbName) { continue }',
  '      $secList = New-Object System.Collections.ArrayList',
  "      Collect-Sections $nb '' $secList",
  '      [void]$notebooks.Add(@{',
  "        id = [string]$nb.GetAttribute('ID')",
  '        name = $nbName',
  '        sections = $secList.ToArray()',
  '      })',
  '    }',
  '  }',
  '  $payload = @{ available = $true; notebooks = $notebooks.ToArray() }',
  '  [Console]::Out.Write(($payload | ConvertTo-Json -Depth 8 -Compress))',
  '} catch {',
  '  [Console]::Out.Write(\'{"available":false}\')',
  '} finally {',
  '  if ($null -ne $on) {',
  '    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($on) } catch {}',
  '  }',
  '}',
].join('\n');

const ONENOTE_SCAN_PS_B64 = Buffer.from(ONENOTE_SCAN_PS_SCRIPT, 'utf16le').toString('base64');

const ONENOTE_PAGE_PS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$pageId = $env:OPENSTUDY_ONENOTE_PAGE_ID',
  'if ([string]::IsNullOrWhiteSpace($pageId)) {',
  '  [Console]::Out.Write(\'{"available":true,"error":"missing_id"}\')',
  '  exit 0',
  '}',
  '$on = $null',
  'try {',
  '  $on = New-Object -ComObject OneNote.Application',
  '} catch {',
  '  [Console]::Out.Write(\'{"available":false}\')',
  '  exit 0',
  '}',
  'try {',
  "  $xml = ''",
  '  $on.GetPageContent($pageId, [ref]$xml, 0)',
  '  if ([string]::IsNullOrWhiteSpace($xml)) {',
  '    [Console]::Out.Write(\'{"available":true,"title":"","lines":[]}\')',
  '    exit 0',
  '  }',
  '  [xml]$doc = $xml',
  "  $pageName = ''",
  '  if ($doc.DocumentElement) {',
  "    $pageName = [string]$doc.DocumentElement.GetAttribute('name')",
  '  }',
  '  $titleParts = New-Object System.Collections.ArrayList',
  "  $titleNodes = $doc.SelectNodes('//*[local-name()=\"Title\"]//*[local-name()=\"T\"]')",
  '  if ($titleNodes) {',
  '    foreach ($tn in $titleNodes) {',
  '      $t = [string]$tn.InnerText',
  '      if (-not [string]::IsNullOrWhiteSpace($t)) { [void]$titleParts.Add($t) }',
  '    }',
  '  }',
  '  $lines = New-Object System.Collections.ArrayList',
  "  $tNodes = $doc.SelectNodes('//*[local-name()=\"Outline\"]//*[local-name()=\"T\"]')",
  '  if (-not $tNodes -or $tNodes.Count -eq 0) {',
  "    $tNodes = $doc.SelectNodes('//*[local-name()=\"T\"]')",
  '  }',
  '  if ($tNodes) {',
  '    foreach ($n in $tNodes) {',
  '      $txt = [string]$n.InnerText',
  '      if (-not [string]::IsNullOrWhiteSpace($txt)) { [void]$lines.Add($txt) }',
  '    }',
  '  }',
  "  $title = ($titleParts.ToArray() -join ' ').Trim()",
  '  if ([string]::IsNullOrWhiteSpace($title)) { $title = $pageName }',
  '  $payload = @{ available = $true; title = $title; lines = $lines.ToArray() }',
  '  [Console]::Out.Write(($payload | ConvertTo-Json -Depth 4 -Compress))',
  '} catch {',
  '  [Console]::Out.Write(\'{"available":true,"error":"read_failed"}\')',
  '} finally {',
  '  if ($null -ne $on) {',
  '    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($on) } catch {}',
  '  }',
  '}',
].join('\n');

const ONENOTE_PAGE_PS_B64 = Buffer.from(ONENOTE_PAGE_PS_SCRIPT, 'utf16le').toString('base64');

function runOneNotePowerShell(encodedScript, extraEnv = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          encodedScript,
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: {
            ...process.env,
            ...extraEnv,
          },
        }
      );
    } catch {
      resolve(null);
      return;
    }

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      done(null);
    }, ONENOTE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes + chunk.length <= MAX_ONENOTE_STDOUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code !== 0) {
        done(null);
        return;
      }
      try {
        const raw = Buffer.concat(stdoutChunks).toString('utf8').trim();
        done(raw ? JSON.parse(raw) : null);
      } catch {
        done(null);
      }
    });
  });
}

function compareIsoDesc(a, b) {
  const ta = Date.parse(a || '') || 0;
  const tb = Date.parse(b || '') || 0;
  return tb - ta;
}

async function scanLocalOneNote() {
  if (process.platform !== 'win32') {
    return createUnavailableOneNoteResult();
  }

  const parsed = await runOneNotePowerShell(ONENOTE_SCAN_PS_B64);
  if (!parsed || parsed.available !== true) {
    return createUnavailableOneNoteResult();
  }

  const rawNotebooks = toArray(parsed.notebooks);
  const notebooks = [];
  const allRecentCandidates = [];
  let totalPages = 0;

  for (const rawNb of rawNotebooks) {
    if (!rawNb || typeof rawNb !== 'object') continue;
    const nbId = typeof rawNb.id === 'string' ? rawNb.id.trim() : '';
    const nbName = typeof rawNb.name === 'string' ? rawNb.name.trim() : '';
    if (!nbId || !nbName || isSensitiveOneNoteName(nbName)) continue;

    const rawSections = toArray(rawNb.sections);
    const sections = [];
    let notebookPageCount = 0;

    for (const rawSec of rawSections) {
      if (!rawSec || typeof rawSec !== 'object') continue;
      const secId = typeof rawSec.id === 'string' ? rawSec.id.trim() : '';
      const secName = typeof rawSec.name === 'string' ? rawSec.name.trim() : '';
      if (!secId || !secName || isSensitiveOneNoteName(secName)) continue;

      const rawPages = toArray(rawSec.pages);
      const cleanPages = [];

      for (const rawPage of rawPages) {
        if (!rawPage || typeof rawPage !== 'object') continue;
        const pageId = typeof rawPage.id === 'string' ? rawPage.id.trim() : '';
        const pageName = typeof rawPage.name === 'string' ? rawPage.name.trim() : '';
        const lastModified = typeof rawPage.lastModified === 'string' ? rawPage.lastModified.trim() : '';
        if (!pageId || !pageName || isSensitiveOneNoteName(pageName)) continue;

        cleanPages.push({
          id: pageId,
          name: pageName,
          lastModified,
        });
        allRecentCandidates.push({
          id: pageId,
          name: pageName,
          notebook: nbName,
          section: secName,
          lastModified,
        });
      }

      cleanPages.sort((a, b) => compareIsoDesc(a.lastModified, b.lastModified));
      notebookPageCount += cleanPages.length;
      totalPages += cleanPages.length;

      sections.push({
        id: secId,
        name: secName,
        pages: cleanPages.slice(0, 60),
      });
    }

    notebooks.push({
      id: nbId,
      name: nbName,
      sectionCount: sections.length,
      pageCount: notebookPageCount,
      sections,
    });
  }

  allRecentCandidates.sort((a, b) => compareIsoDesc(a.lastModified, b.lastModified));
  const recentPages = allRecentCandidates.slice(0, MAX_ONENOTE_RECENT_PAGES);

  return {
    ok: true,
    available: true,
    source: 'onenote-desktop',
    notebooks,
    recentPages,
    totalPages,
  };
}

async function readLocalOneNotePage(rawPageId) {
  const pageId = typeof rawPageId === 'string' ? rawPageId.trim() : '';
  if (!pageId || pageId.length > 160 || !/^[{}A-Za-z0-9\-]+$/.test(pageId)) {
    return {
      status: 400,
      payload: {
        ok: false,
        error: 'Ungültige OneNote-Seiten-ID.',
      },
    };
  }

  if (process.platform !== 'win32') {
    return {
      status: 200,
      payload: {
        ok: false,
        available: false,
        id: pageId,
        title: '',
        content: '',
        message: 'Lokales OneNote Desktop nicht gefunden.',
      },
    };
  }

  const parsed = await runOneNotePowerShell(ONENOTE_PAGE_PS_B64, {
    OPENSTUDY_ONENOTE_PAGE_ID: pageId,
  });

  if (!parsed || parsed.available !== true) {
    return {
      status: 200,
      payload: {
        ok: false,
        available: false,
        id: pageId,
        title: '',
        content: '',
        message: 'Lokales OneNote Desktop nicht gefunden.',
      },
    };
  }

  if (parsed.error) {
    return {
      status: 404,
      payload: {
        ok: false,
        available: true,
        id: pageId,
        error: 'OneNote-Seite konnte nicht gelesen werden.',
      },
    };
  }

  const title = stripMarkupToReadableText(parsed.title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  if (isSensitiveOneNoteName(title)) {
    return {
      status: 403,
      payload: {
        ok: false,
        redacted: true,
        error: 'Geschützte OneNote-Seite wurde aus Datenschutzgründen blockiert.',
      },
    };
  }

  const rawLines = toArray(parsed.lines);
  const cleanedLines = [];
  for (const rawLine of rawLines) {
    if (typeof rawLine !== 'string') continue;
    const cleaned = stripMarkupToReadableText(rawLine);
    if (cleaned) {
      cleanedLines.push(cleaned);
    }
  }

  let content = cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (content.length > MAX_ONENOTE_PAGE_CHARS) {
    content = content.slice(0, MAX_ONENOTE_PAGE_CHARS).trimEnd();
  }

  return {
    status: 200,
    payload: {
      ok: true,
      id: pageId,
      title: title || 'OneNote-Seite',
      content,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Hermes Background Auto-Sync Cron (Obsidian + OneNote + Next 30 Days)      */
/* -------------------------------------------------------------------------- */

const SCHEDULE_KEYWORD_PATTERN =
  /(prüfung|pruefung|test|klausur|exam|abgabe|vortrag|präsentation|praesentation|termin|quiz|arbeit|aufgabe|due|deadline)/i;

let autoSyncTimer = null;
let autoSyncNextRunAt = null;
let activeSyncPromise = null;

function getHermesSyncConfigPath() {
  return path.join(getHermesDir(), 'sync-config.json');
}

function clampSyncIntervalMinutes(rawValue) {
  const num = Number(rawValue);
  if (!Number.isFinite(num)) return SYNC_DEFAULT_INTERVAL_MINUTES;
  return Math.min(SYNC_MAX_INTERVAL_MINUTES, Math.max(SYNC_MIN_INTERVAL_MINUTES, Math.round(num)));
}

function createDefaultSyncConfig() {
  return {
    enabled: false,
    intervalMinutes: SYNC_DEFAULT_INTERVAL_MINUTES,
    vaultPath: '',
    portalUrl: '',
    scanOneNote: process.platform === 'win32',
    lastRunAt: '',
    lastSummary: {
      obsidianNotesCount: 0,
      oneNotePagesCount: 0,
      upcoming30Days: [],
    },
  };
}

function sanitizeSyncPortalUrl(rawUrl) {
  if (rawUrl === undefined || rawUrl === null) return { ok: true, url: '' };
  if (typeof rawUrl !== 'string') {
    return { ok: false, error: 'Feld "portalUrl" muss ein Text sein.' };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: true, url: '' };
  if (trimmed.length > 300) {
    return { ok: false, error: 'Feld "portalUrl" ist zu lang (max. 300 Zeichen).' };
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: 'Ungültige "portalUrl". Erwartet wird eine gültige Webadresse.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Für "portalUrl" sind nur http:// und https:// erlaubt.' };
  }
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    return { ok: false, error: 'Ungültige Domain in "portalUrl".' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Zugangsdaten in "portalUrl" sind nicht erlaubt.' };
  }
  return { ok: true, url: parsed.toString() };
}

function sanitizeSyncVaultPath(rawPath) {
  if (rawPath === undefined || rawPath === null) return { ok: true, vaultPath: '' };
  if (typeof rawPath !== 'string') {
    return { ok: false, error: 'Feld "vaultPath" muss ein Text sein.' };
  }
  const trimmed = rawPath.trim();
  if (!trimmed) return { ok: true, vaultPath: '' };
  if (trimmed.length > 500) {
    return { ok: false, error: 'Feld "vaultPath" ist zu lang (max. 500 Zeichen).' };
  }
  const resolved = path.resolve(trimmed);
  if (isForbiddenVaultRoot(resolved)) {
    return {
      ok: false,
      error: 'Systemordner oder Laufwerkswurzeln sind als Obsidian-Vault nicht erlaubt.',
    };
  }
  return { ok: true, vaultPath: resolved };
}

function sanitizeUpcomingList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList.slice(0, 80)) {
    if (!item || typeof item !== 'object') continue;
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 140) : '';
    const date = typeof item.date === 'string' ? item.date.trim() : '';
    const courseTitle = typeof item.courseTitle === 'string' ? item.courseTitle.trim().slice(0, 80) : 'Allgemein';
    const source = typeof item.source === 'string' ? item.source.trim().slice(0, 32) : 'obsidian';
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({ title, date, courseTitle: courseTitle || 'Allgemein', source: source || 'obsidian' });
  }
  return out;
}

async function loadSyncConfig() {
  const filePath = getHermesSyncConfigPath();
  const defaults = createDefaultSyncConfig();
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const checkedVault = sanitizeSyncVaultPath(parsed.vaultPath);
    const checkedPortal = sanitizeSyncPortalUrl(parsed.portalUrl);
    const rawSummary = parsed.lastSummary && typeof parsed.lastSummary === 'object' ? parsed.lastSummary : {};

    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : defaults.enabled,
      intervalMinutes: clampSyncIntervalMinutes(parsed.intervalMinutes),
      vaultPath: checkedVault.ok ? checkedVault.vaultPath : '',
      portalUrl: checkedPortal.ok ? checkedPortal.url : '',
      scanOneNote: typeof parsed.scanOneNote === 'boolean' ? parsed.scanOneNote : defaults.scanOneNote,
      lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : '',
      lastSummary: {
        obsidianNotesCount:
          typeof rawSummary.obsidianNotesCount === 'number' && Number.isFinite(rawSummary.obsidianNotesCount)
            ? Math.max(0, Math.round(rawSummary.obsidianNotesCount))
            : 0,
        oneNotePagesCount:
          typeof rawSummary.oneNotePagesCount === 'number' && Number.isFinite(rawSummary.oneNotePagesCount)
            ? Math.max(0, Math.round(rawSummary.oneNotePagesCount))
            : 0,
        upcoming30Days: sanitizeUpcomingList(rawSummary.upcoming30Days),
      },
    };
  } catch {
    return defaults;
  }
}

async function saveSyncConfig(config) {
  const filePath = getHermesSyncConfigPath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  const checkedVault = sanitizeSyncVaultPath(config.vaultPath);
  const checkedPortal = sanitizeSyncPortalUrl(config.portalUrl);
  const rawSummary = config.lastSummary && typeof config.lastSummary === 'object' ? config.lastSummary : {};

  const nextPayload = {
    enabled: Boolean(config.enabled),
    intervalMinutes: clampSyncIntervalMinutes(config.intervalMinutes),
    vaultPath: checkedVault.ok ? checkedVault.vaultPath : '',
    portalUrl: checkedPortal.ok ? checkedPortal.url : '',
    scanOneNote: Boolean(config.scanOneNote),
    lastRunAt: typeof config.lastRunAt === 'string' ? config.lastRunAt : '',
    lastSummary: {
      obsidianNotesCount:
        typeof rawSummary.obsidianNotesCount === 'number' && Number.isFinite(rawSummary.obsidianNotesCount)
          ? Math.max(0, Math.round(rawSummary.obsidianNotesCount))
          : 0,
      oneNotePagesCount:
        typeof rawSummary.oneNotePagesCount === 'number' && Number.isFinite(rawSummary.oneNotePagesCount)
          ? Math.max(0, Math.round(rawSummary.oneNotePagesCount))
          : 0,
      upcoming30Days: sanitizeUpcomingList(rawSummary.upcoming30Days),
    },
  };

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(nextPayload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fsp.rename(tempPath, filePath);
  return nextPayload;
}

function formatLocalIsoDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toValidIsoDate(year, month, day) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }
  return formatLocalIsoDate(candidate);
}

function extractIsoDatesFromLine(line) {
  const found = new Set();
  const isoRegex = /\b(20\d{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/g;
  const euRegex = /\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.(20\d{2})\b/g;

  let match;
  while ((match = isoRegex.exec(line)) !== null) {
    const iso = toValidIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) found.add(iso);
  }
  while ((match = euRegex.exec(line)) !== null) {
    const iso = toValidIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
    if (iso) found.add(iso);
  }
  return Array.from(found);
}

function inferCourseTitleFromNote(note) {
  const relPath = typeof note.path === 'string' ? note.path : '';
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length > 1) {
    for (let i = 0; i < parts.length - 1; i += 1) {
      const cleaned = parts[i].replace(/^\d+[\s._-]+/, '').replace(/[_-]+/g, ' ').trim();
      if (
        cleaned &&
        !/^(notes|notizen|inbox|daily|tagebuch|journal|archive|archiv|templates|vorlagen|misc|allgemein)$/i.test(
          cleaned
        )
      ) {
        return cleaned.slice(0, 60);
      }
    }
  }
  const titlePart = typeof note.title === 'string' ? note.title.trim() : '';
  return titlePart ? titlePart.slice(0, 60) : 'Allgemein';
}

function cleanScheduleLineTitle(line, fallbackTitle) {
  const cleaned = String(line || '')
    .replace(/^\s*[-*+]\s*\[[ xX]\]\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/^\s*\|+\s*|\s*\|+\s*$/g, '')
    .replace(/\s*\|\s*/g, ' — ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length < 4) {
    return String(fallbackTitle || 'Termin').trim().slice(0, 110);
  }
  return cleaned.slice(0, 110);
}

function getNext30DaysBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + SYNC_UPCOMING_DAYS);
  return {
    startIso: formatLocalIsoDate(start),
    endIso: formatLocalIsoDate(end),
  };
}

function deduplicateAndSortUpcoming(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const normTitle = item.title
      .toLowerCase()
      .replace(/\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\.\d{1,2}\.20\d{2}\b/g, '')
      .replace(/[^a-z0-9äöü]+/g, ' ')
      .trim()
      .slice(0, 60);
    const key = `${item.date}|${normTitle || item.title.toLowerCase().slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  result.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.title.localeCompare(b.title);
  });
  return result.slice(0, 80);
}

function extractUpcoming30DayEventsFromNotes(notes) {
  const { startIso, endIso } = getNext30DaysBounds();
  const extracted = [];

  for (const note of notes) {
    if (!note || typeof note.content !== 'string') continue;
    const lines = note.content.replace(/\r\n/g, '\n').split('\n');
    const noteTitle = typeof note.title === 'string' ? note.title : '';
    const titleHasKeyword = SCHEDULE_KEYWORD_PATTERN.test(noteTitle);
    const courseTitle = inferCourseTitleFromNote(note);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || line.length < 8) continue;

      const dates = extractIsoDatesFromLine(line).filter((d) => d >= startIso && d <= endIso);
      if (dates.length === 0) continue;

      const prevLine = i > 0 ? lines[i - 1] : '';
      const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
      const nearKeyword =
        SCHEDULE_KEYWORD_PATTERN.test(line) ||
        SCHEDULE_KEYWORD_PATTERN.test(prevLine) ||
        SCHEDULE_KEYWORD_PATTERN.test(nextLine) ||
        titleHasKeyword;

      if (!nearKeyword) continue;

      const title = cleanScheduleLineTitle(line, noteTitle);
      for (const date of dates) {
        extracted.push({
          title,
          date,
          courseTitle,
          source: 'obsidian',
        });
      }
    }
  }

  return extracted;
}

function extractUpcoming30DayEventsFromOneNotePages(recentPages) {
  const { startIso, endIso } = getNext30DaysBounds();
  const extracted = [];

  for (const page of recentPages) {
    if (!page || typeof page.name !== 'string') continue;
    const dates = extractIsoDatesFromLine(page.name).filter((d) => d >= startIso && d <= endIso);
    if (dates.length === 0) continue;
    if (!SCHEDULE_KEYWORD_PATTERN.test(page.name)) continue;

    const courseTitle =
      (typeof page.section === 'string' && page.section.trim()) ||
      (typeof page.notebook === 'string' && page.notebook.trim()) ||
      'OneNote';

    for (const date of dates) {
      extracted.push({
        title: page.name.trim().slice(0, 110),
        date,
        courseTitle: courseTitle.slice(0, 60),
        source: 'onenote',
      });
    }
  }

  return extracted;
}

async function executeAutoSyncPass(inputConfig, options = {}) {
  const baseConfig = inputConfig ? { ...(await loadSyncConfig()), ...inputConfig } : await loadSyncConfig();
  const allowAutoDetect = options.allowAutoDetect !== undefined ? Boolean(options.allowAutoDetect) : baseConfig.enabled;

  let effectiveVaultPath = baseConfig.vaultPath || '';
  if (!effectiveVaultPath && allowAutoDetect) {
    const detected = await detectObsidianVaults();
    const openVault = detected.vaults.find((v) => v.isOpen) || detected.vaults[0];
    if (openVault) {
      effectiveVaultPath = openVault.path;
    }
  }

  let obsidianNotesCount = 0;
  let sampleObsidianNotes = [];
  let upcomingFromObsidian = [];

  if (effectiveVaultPath) {
    try {
      const scanResult = await scanObsidianVault(effectiveVaultPath);
      obsidianNotesCount = scanResult.notes.length;
      sampleObsidianNotes = scanResult.notes.slice(0, SYNC_SAMPLE_OBSIDIAN_LIMIT);
      upcomingFromObsidian = extractUpcoming30DayEventsFromNotes(scanResult.notes);
    } catch {
      obsidianNotesCount = 0;
      sampleObsidianNotes = [];
      upcomingFromObsidian = [];
    }
  }

  let oneNotePagesCount = 0;
  let recentOneNotePages = [];
  let upcomingFromOneNote = [];

  if (baseConfig.scanOneNote && process.platform === 'win32') {
    const oneNoteResult = await scanLocalOneNote();
    if (oneNoteResult.available) {
      oneNotePagesCount = oneNoteResult.totalPages || 0;
      recentOneNotePages = oneNoteResult.recentPages || [];
      upcomingFromOneNote = extractUpcoming30DayEventsFromOneNotePages(recentOneNotePages);
    }
  }

  const upcoming30Days = deduplicateAndSortUpcoming([
    ...upcomingFromObsidian,
    ...upcomingFromOneNote,
  ]);

  const savedConfig = await saveSyncConfig({
    ...baseConfig,
    lastRunAt: new Date().toISOString(),
    lastSummary: {
      obsidianNotesCount,
      oneNotePagesCount,
      upcoming30Days,
    },
  });

  return {
    ok: true,
    config: savedConfig,
    portalProfileReady: isPortalProfileReady(),
    summary: {
      obsidianNotesCount,
      oneNotePagesCount,
      upcoming30Days,
      recentOneNotePages,
      sampleObsidianNotes,
      portalProfileReady: isPortalProfileReady(),
    },
  };
}

function runAutoSyncPass(inputConfig = null, options = {}) {
  if (activeSyncPromise) {
    return activeSyncPromise;
  }
  activeSyncPromise = executeAutoSyncPass(inputConfig, options).finally(() => {
    activeSyncPromise = null;
  });
  return activeSyncPromise;
}

function stopAutoSyncTimer() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
  autoSyncNextRunAt = null;
}

function scheduleAutoSyncTimer(config) {
  stopAutoSyncTimer();
  if (!config || !config.enabled) {
    return;
  }
  const intervalMinutes = clampSyncIntervalMinutes(config.intervalMinutes);
  const intervalMs = intervalMinutes * 60_000;
  autoSyncNextRunAt = new Date(Date.now() + intervalMs).toISOString();

  autoSyncTimer = setInterval(() => {
    autoSyncNextRunAt = new Date(Date.now() + intervalMs).toISOString();
    runAutoSyncPass(null, { allowAutoDetect: true }).catch(() => {
      // keep background auto-sync resilient
    });
  }, intervalMs);
  autoSyncTimer.unref();
}

async function initAutoSyncScheduler() {
  try {
    const config = await loadSyncConfig();
    if (config.enabled) {
      scheduleAutoSyncTimer(config);
      console.log(
        `[OpenStudy Bridge] Hermes Auto-Sync Cron active (every ${config.intervalMinutes} min)`
      );
    }
  } catch {
    // ignore startup sync config load failure
  }
}

/* -------------------------------------------------------------------------- */
/*  Hermes Native Portal Browser Reader (Zero-Dep Node WebSocket + Local CDP) */
/* -------------------------------------------------------------------------- */

let activePortalSession = null;

function getPortalProfileDir() {
  return path.join(getHermesDir(), 'portal-browser-profile');
}

function isPortalProfileReady() {
  try {
    const dir = getPortalProfileDir();
    if (!fs.existsSync(dir)) return false;
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
    const entries = fs.readdirSync(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPortalHorizonDays(rawValue) {
  const num = Number(rawValue);
  if (!Number.isFinite(num)) return PORTAL_DEFAULT_HORIZON_DAYS;
  return Math.min(PORTAL_MAX_HORIZON_DAYS, Math.max(PORTAL_MIN_HORIZON_DAYS, Math.round(num)));
}

function isPrivateOrReservedIp(rawHost) {
  const host = String(rawHost || '').replace(/^\[|\]$/g, '').toLowerCase();
  const ipVersion = net.isIP(host);
  if (ipVersion === 0) return false;

  if (ipVersion === 4) {
    const parts = host.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  // IPv6 loopback, unspecified, link-local, unique-local, IPv4-mapped private
  if (host === '::' || host === '::1') return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) {
      return isPrivateOrReservedIp(mapped);
    }
    return true;
  }
  return false;
}

function validatePortalHttpsUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return { ok: false, error: 'Bitte gib eine gültige Portal-Adresse ein.' };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: 'Bitte gib zuerst die Adresse deines Schul- oder Uni-Portals ein.' };
  }
  if (trimmed.length > 400) {
    return { ok: false, error: 'Die Portal-Adresse ist zu lang (maximal 400 Zeichen).' };
  }
  if (/[\s\r\n\0<>]/.test(trimmed)) {
    return { ok: false, error: 'Die Portal-Adresse enthält ungültige Zeichen.' };
  }
  if (trimmed.startsWith('//')) {
    return { ok: false, error: 'Bitte gib eine vollständige https://-Adresse oder Domain ein.' };
  }

  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'https') {
      return {
        ok: false,
        error: 'Aus Sicherheitsgründen sind für Portale ausschliesslich https://-Adressen erlaubt.',
      };
    }
  }

  const normalizedInput = schemeMatch ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(normalizedInput);
  } catch {
    return { ok: false, error: 'Die eingegebene Portal-Adresse konnte nicht gelesen werden.' };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: 'Aus Sicherheitsgründen sind für Portale ausschliesslich https://-Adressen erlaubt.',
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Zugangsdaten in der URL sind nicht erlaubt.' };
  }

  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/^\[|\]$/g, '');
  if (!bareHost) {
    return { ok: false, error: 'In der Portal-Adresse fehlt ein gültiger Hostname.' };
  }
  if (
    bareHost === 'localhost' ||
    bareHost.endsWith('.localhost') ||
    bareHost.endsWith('.local') ||
    bareHost.endsWith('.internal') ||
    bareHost.endsWith('.home.arpa') ||
    isPrivateOrReservedIp(bareHost)
  ) {
    return {
      ok: false,
      error: 'Lokale Adressen und private Netzwerke sind für den Portal-Leser gesperrt.',
    };
  }
  if (net.isIP(bareHost) !== 0) {
    return {
      ok: false,
      error: 'Bitte verwende die normale https://-Domain deines Portals statt einer direkten IP-Adresse.',
    };
  }
  if (!bareHost.includes('.') || /^[.-]|[.-]$|\.\./.test(bareHost)) {
    return { ok: false, error: 'Bitte gib eine gültige Domain mit Endung ein (z. B. portal.schule.ch).' };
  }

  return {
    ok: true,
    url: parsed.toString(),
    origin: parsed.origin,
  };
}

function detectLocalChromiumBrowser() {
  const candidates = [];

  if (process.platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);

    const winSpecs = [
      { browserName: 'Google Chrome', rel: path.join('Google', 'Chrome', 'Application', 'chrome.exe'), bin: 'chrome' },
      { browserName: 'Microsoft Edge', rel: path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'), bin: 'msedge' },
      { browserName: 'Brave', rel: path.join('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), bin: 'brave' },
      { browserName: 'Chromium', rel: path.join('Chromium', 'Application', 'chrome.exe'), bin: 'chromium' },
    ];

    for (const spec of winSpecs) {
      for (const root of roots) {
        candidates.push({ browserName: spec.browserName, executablePath: path.join(root, spec.rel) });
      }
      const onPath = findExecutableOnPath(spec.bin);
      if (onPath) {
        candidates.push({ browserName: spec.browserName, executablePath: onPath });
      }
    }
  } else if (process.platform === 'darwin') {
    const homeApps = path.join(os.homedir(), 'Applications');
    const macSpecs = [
      { browserName: 'Google Chrome', rel: 'Google Chrome.app/Contents/MacOS/Google Chrome' },
      { browserName: 'Microsoft Edge', rel: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { browserName: 'Brave', rel: 'Brave Browser.app/Contents/MacOS/Brave Browser' },
      { browserName: 'Chromium', rel: 'Chromium.app/Contents/MacOS/Chromium' },
    ];
    for (const spec of macSpecs) {
      candidates.push({ browserName: spec.browserName, executablePath: path.join('/Applications', spec.rel) });
      candidates.push({ browserName: spec.browserName, executablePath: path.join(homeApps, spec.rel) });
    }
  } else {
    const linuxSpecs = [
      { browserName: 'Google Chrome', bins: ['google-chrome', 'google-chrome-stable'] },
      { browserName: 'Microsoft Edge', bins: ['microsoft-edge', 'microsoft-edge-stable'] },
      { browserName: 'Brave', bins: ['brave-browser', 'brave'] },
      { browserName: 'Chromium', bins: ['chromium', 'chromium-browser'] },
    ];
    for (const spec of linuxSpecs) {
      for (const bin of spec.bins) {
        const onPath = findExecutableOnPath(bin);
        if (onPath) {
          candidates.push({ browserName: spec.browserName, executablePath: onPath });
        }
        candidates.push({ browserName: spec.browserName, executablePath: `/usr/bin/${bin}` });
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate.executablePath && isRegularExecutable(candidate.executablePath)) {
      return candidate;
    }
  }
  return null;
}

function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probeServer = net.createServer();
    probeServer.unref();
    probeServer.on('error', (err) => reject(err));
    probeServer.listen(0, HOST, () => {
      const address = probeServer.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probeServer.close(() => {
        if (!port) {
          reject(new Error('Konnte keinen freien lokalen Debug-Port reservieren.'));
          return;
        }
        resolve(port);
      });
    });
  });
}

async function fetchLoopbackJson(port, endpointPath, timeoutMs = 2_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${HOST}:${port}${endpointPath}`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const raw = await readLimitedText(res, 256 * 1024);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function listCdpTargets(port, timeoutMs = 2_500) {
  const data = await fetchLoopbackJson(port, '/json/list', timeoutMs);
  return Array.isArray(data) ? data : null;
}

function selectPrimaryPageTarget(targets, preferredOrigin = '') {
  if (!Array.isArray(targets)) return null;
  const pageTargets = targets.filter(
    (t) =>
      t &&
      t.type === 'page' &&
      typeof t.webSocketDebuggerUrl === 'string' &&
      t.webSocketDebuggerUrl.startsWith('ws://127.0.0.1:') &&
      typeof t.url === 'string' &&
      !t.url.startsWith('devtools://') &&
      !t.url.startsWith('chrome-extension://')
  );
  if (pageTargets.length === 0) return null;

  if (preferredOrigin) {
    const exactOrigin = pageTargets.find((t) => {
      try {
        return new URL(t.url).origin === preferredOrigin;
      } catch {
        return false;
      }
    });
    if (exactOrigin) return exactOrigin;
  }

  const httpsTarget = pageTargets.find((t) => t.url.startsWith('https://'));
  if (httpsTarget) return httpsTarget;

  const nonBlank = pageTargets.find((t) => t.url && t.url !== 'about:blank' && !t.url.startsWith('chrome://'));
  return nonBlank || pageTargets[0];
}

class NativeCdpClient {
  constructor(wsUrl, expectedPort) {
    const expectedPrefix = `ws://${HOST}:${expectedPort}/`;
    if (typeof wsUrl !== 'string' || !wsUrl.startsWith(expectedPrefix)) {
      throw new Error('Ungültige lokale CDP-WebSocket-Adresse.');
    }
    if (typeof globalThis.WebSocket !== 'function') {
      throw new Error('Node.js WebSocket-Unterstützung fehlt (benötigt Node v22+).');
    }
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  connect(timeoutMs = 6_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new globalThis.WebSocket(this.wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error('Verbindung zum lokalen Portal-Browser hat das Zeitlimit überschritten.'));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });

      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Lokale CDP-Verbindung zum Browser fehlgeschlagen.'));
        }
      });

      ws.addEventListener('close', () => {
        this.closed = true;
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Portal-Browser-Verbindung wurde beendet.'));
        }
        this.pending.clear();
      });

      ws.addEventListener('message', (event) => {
        let msg;
        try {
          const text = typeof event.data === 'string' ? event.data : String(event.data || '');
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof msg.id !== 'number') return;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || 'CDP-Befehl fehlgeschlagen.'));
        } else {
          entry.resolve(msg.result || {});
        }
      });
    });
  }

  send(method, params = {}, timeoutMs = PORTAL_CDP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.ws || this.ws.readyState !== globalThis.WebSocket.OPEN) {
        reject(new Error('CDP-Verbindung ist nicht geöffnet.'));
        return;
      }
      const id = this.nextId;
      this.nextId += 1;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP-Befehl "${method}" hat das Zeitlimit überschritten.`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async evaluate(expression, options = {}) {
    const timeoutMs = options.timeoutMs || PORTAL_CDP_TIMEOUT_MS;
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: options.awaitPromise !== false,
        returnByValue: true,
        userGesture: Boolean(options.userGesture),
      },
      timeoutMs
    );
    if (result?.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'DOM-Auswertung fehlgeschlagen.';
      throw new Error(desc);
    }
    return result?.result?.value;
  }

  close() {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    if (this.ws) {
      try {
        if (
          this.ws.readyState === globalThis.WebSocket.OPEN ||
          this.ws.readyState === globalThis.WebSocket.CONNECTING
        ) {
          this.ws.close();
        }
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

const PORTAL_LOGIN_URL_PATTERN =
  /(\/|^|[._-])(login|signin|sign-in|log-in|anmeld|auth|oauth|saml|shibboleth|adfs|sso|idp|cas\/login|keycloak|okta|microsoftonline|accounts\.google)(\/|$|[._?-])/i;

const PORTAL_LOGIN_TITLE_PATTERN =
  /\b(login|log in|sign in|anmelden|anmeldung|passwort|password|authentifizierung|single sign-on|sso)\b/i;

function heuristicLooksLikeLogin(url, title) {
  const safeUrl = typeof url === 'string' ? url : '';
  const safeTitle = typeof title === 'string' ? title : '';
  if (PORTAL_LOGIN_URL_PATTERN.test(safeUrl)) return true;
  if (PORTAL_LOGIN_TITLE_PATTERN.test(safeTitle)) return true;
  return false;
}

const PORTAL_LOGIN_CHECK_EXPRESSION = `(() => {
  try {
    const isVisible = (el) => {
      if (!el || typeof el.getBoundingClientRect !== 'function') return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4;
    };
    let hasPasswordInput = false;
    const pwInputs = document.querySelectorAll('input[type="password"]');
    for (const input of pwInputs) {
      if (isVisible(input)) {
        hasPasswordInput = true;
        break;
      }
    }
    if (!hasPasswordInput) {
      const frames = document.querySelectorAll('iframe');
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (!doc) continue;
          const framePw = doc.querySelectorAll('input[type="password"]');
          for (const input of framePw) {
            const rect = input.getBoundingClientRect();
            if (rect.width > 4 && rect.height > 4) {
              hasPasswordInput = true;
              break;
            }
          }
          if (hasPasswordInput) break;
        } catch {
          // ignore cross-origin iframe
        }
      }
    }
    return {
      url: String(location.href || ''),
      title: String(document.title || ''),
      hasPasswordInput,
      readyState: String(document.readyState || ''),
    };
  } catch {
    return {
      url: String(location.href || ''),
      title: String(document.title || ''),
      hasPasswordInput: false,
      readyState: '',
    };
  }
})()`;

async function inspectTargetLoginState(port, target) {
  const fallbackUrl = typeof target?.url === 'string' ? target.url : '';
  const fallbackTitle = typeof target?.title === 'string' ? target.title : '';
  let currentUrl = fallbackUrl;
  let pageTitle = fallbackTitle;
  let hasPasswordInput = false;

  if (target?.webSocketDebuggerUrl) {
    const client = new NativeCdpClient(target.webSocketDebuggerUrl, port);
    try {
      await client.connect(2_000);
      const info = await client.evaluate(PORTAL_LOGIN_CHECK_EXPRESSION, { timeoutMs: 2_000 });
      if (info && typeof info === 'object') {
        if (typeof info.url === 'string' && info.url) currentUrl = info.url;
        if (typeof info.title === 'string' && info.title) pageTitle = info.title;
        hasPasswordInput = Boolean(info.hasPasswordInput);
      }
    } catch {
      // Fall back to target metadata during active page navigation / SSO redirects
    } finally {
      client.close();
    }
  }

  const looksLikeLogin = hasPasswordInput || heuristicLooksLikeLogin(currentUrl, pageTitle);
  return {
    currentUrl,
    pageTitle,
    looksLikeLogin,
  };
}

const PORTAL_LAUNCH_PS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '$exe = $env:OPENSTUDY_BROWSER_EXE',
  '$rawArgs = $env:OPENSTUDY_BROWSER_ARGS_JSON | ConvertFrom-Json',
  '$argList = [string[]]@(foreach ($item in $rawArgs) {',
  '  $s = [string]$item',
  '  if ($s -match \'[\\s"]\') {',
  '    $escaped = $s -replace \'(\\\\*)"\', \'$1$1\\"\'',
  '    $escaped = $escaped -replace \'(\\\\+)$\', \'$1$1\'',
  '    \'"\' + $escaped + \'"\'',
  '  } else {',
  '    $s',
  '  }',
  '})',
  '$p = Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Normal -PassThru',
  'if ($p -and $p.Id) { Write-Output $p.Id }',
].join('\n');

const PORTAL_LAUNCH_PS_B64 = Buffer.from(PORTAL_LAUNCH_PS_SCRIPT, 'utf16le').toString('base64');

const PORTAL_FOREGROUND_PS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '$targetPid = 0',
  '[void][int]::TryParse($env:OPENSTUDY_BROWSER_PID, [ref]$targetPid)',
  '$exeName = [string]$env:OPENSTUDY_BROWSER_EXE_NAME',
  '$csharp = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class OpenStudyPortalWin32 {',
  '    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
  '    [DllImport("user32.dll", SetLastError = true)]',
  '    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);',
  '    public static void NudgeToFront(IntPtr hWnd) {',
  '        if (hWnd == IntPtr.Zero) return;',
  '        ShowWindow(hWnd, 9);',
  '        SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);',
  '        SetWindowPos(hWnd, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);',
  '        BringWindowToTop(hWnd);',
  '        SetForegroundWindow(hWnd);',
  '    }',
  '}',
  '"@',
  'Add-Type -TypeDefinition $csharp -ErrorAction SilentlyContinue',
  '$hwnd = [IntPtr]::Zero',
  'if ($targetPid -gt 0) {',
  '  for ($i = 0; $i -lt 6; $i++) {',
  '    $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue',
  '    if ($p) {',
  '      $p.Refresh()',
  '      if ($p.MainWindowHandle -ne [IntPtr]::Zero) {',
  '        $hwnd = $p.MainWindowHandle',
  '        break',
  '      }',
  '    }',
  '    Start-Sleep -Milliseconds 50',
  '  }',
  '}',
  'if ($hwnd -eq [IntPtr]::Zero -and $exeName) {',
  '  $cutoff = (Get-Date).AddSeconds(-15)',
  '  $cand = Get-Process -Name $exeName -ErrorAction SilentlyContinue |',
  '    Where-Object {',
  '      $_.MainWindowHandle -ne [IntPtr]::Zero -and (try { $_.StartTime -ge $cutoff } catch { $false })',
  '    } |',
  '    Sort-Object { try { $_.StartTime } catch { [datetime]::MinValue } } -Descending |',
  '    Select-Object -First 1',
  '  if ($cand) { $hwnd = $cand.MainWindowHandle }',
  '}',
  'if ($hwnd -ne [IntPtr]::Zero) {',
  '  [OpenStudyPortalWin32]::NudgeToFront($hwnd)',
  '}',
].join('\n');

const PORTAL_FOREGROUND_PS_B64 = Buffer.from(PORTAL_FOREGROUND_PS_SCRIPT, 'utf16le').toString('base64');

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function runWindowsTaskkill(pid, timeoutMs = 2_000) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    let killer;
    try {
      killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      done();
      return;
    }
    const timer = setTimeout(() => {
      try {
        killer.kill('SIGKILL');
      } catch {
        // ignore
      }
      done();
    }, timeoutMs);
    killer.on('error', done);
    killer.on('exit', done);
  });
}

function launchWindowsVisibleBrowser(executablePath, spawnArgs) {
  return new Promise((resolve, reject) => {
    let psChild;
    try {
      psChild = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          PORTAL_LAUNCH_PS_B64,
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            OPENSTUDY_BROWSER_EXE: executablePath,
            OPENSTUDY_BROWSER_ARGS_JSON: JSON.stringify(spawnArgs),
          },
        }
      );
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const finish = (err, pid) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve({ pid });
      }
    };

    const timer = setTimeout(() => {
      try {
        psChild.kill('SIGTERM');
      } catch {
        // ignore
      }
      finish(new Error('Zeitüberschreitung beim Starten des sichtbaren Browser-Fensters.'));
    }, 6_000);

    psChild.stdout.on('data', (chunk) => {
      if (stdoutChunks.length < 16) stdoutChunks.push(chunk);
    });
    psChild.stderr.on('data', (chunk) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });
    psChild.on('error', (err) => finish(err));
    psChild.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const pidMatch = stdout.match(/\b(\d+)\b/);
      const pid = pidMatch ? Number(pidMatch[1]) : null;
      if (code === 0 && Number.isInteger(pid) && pid > 0) {
        finish(null, pid);
        return;
      }
      finish(new Error(stderr || `PowerShell-Browserstart fehlgeschlagen (Code ${code ?? 'unbekannt'}).`));
    });
  });
}

function nudgeWindowsBrowserToFront(pid, executablePath) {
  if (process.platform !== 'win32') return Promise.resolve();
  const exeName = path.basename(String(executablePath || ''), '.exe');
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    let psChild;
    try {
      psChild = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          PORTAL_FOREGROUND_PS_B64,
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            OPENSTUDY_BROWSER_PID: Number.isInteger(pid) && pid > 0 ? String(pid) : '',
            OPENSTUDY_BROWSER_EXE_NAME: exeName,
          },
        }
      );
    } catch {
      done();
      return;
    }
    const timer = setTimeout(() => {
      try {
        psChild.kill('SIGTERM');
      } catch {
        // ignore
      }
      done();
    }, 2_500);
    psChild.on('error', done);
    psChild.on('close', done);
  });
}

async function bringPortalWindowToFront(session, primaryTarget) {
  // 1. Best-effort CDP Page.bringToFront + Browser.getWindowForTarget -> Browser.setWindowBounds
  try {
    if (primaryTarget?.webSocketDebuggerUrl) {
      const pageClient = new NativeCdpClient(primaryTarget.webSocketDebuggerUrl, session.port);
      try {
        await pageClient.connect(1_500);
        await pageClient.send('Page.bringToFront', {}, 1_500).catch(() => {});
      } finally {
        pageClient.close();
      }
    }
  } catch {
    // best-effort
  }

  try {
    const versionInfo = await fetchLoopbackJson(session.port, '/json/version', 1_200);
    const browserWsUrl = versionInfo?.webSocketDebuggerUrl;
    if (typeof browserWsUrl === 'string' && browserWsUrl.startsWith(`ws://${HOST}:${session.port}/`)) {
      const browserClient = new NativeCdpClient(browserWsUrl, session.port);
      try {
        await browserClient.connect(1_500);
        const targetId = typeof primaryTarget?.id === 'string' ? primaryTarget.id : '';
        const winInfo = await browserClient
          .send('Browser.getWindowForTarget', targetId ? { targetId } : {}, 1_500)
          .catch(() => null);
        const windowId = winInfo?.windowId;
        if (typeof windowId === 'number') {
          await browserClient
            .send(
              'Browser.setWindowBounds',
              { windowId, bounds: { windowState: 'normal' } },
              1_500
            )
            .catch(() => {});
          await browserClient
            .send(
              'Browser.setWindowBounds',
              {
                windowId,
                bounds: { windowState: 'normal', left: 100, top: 60, width: 1200, height: 840 },
              },
              1_500
            )
            .catch(() => {});
        }
      } finally {
        browserClient.close();
      }
    }
  } catch {
    // best-effort
  }

  // 2. On Windows, also run a fast Win32 ShowWindow(SW_RESTORE) + SetForegroundWindow nudge
  if (process.platform === 'win32') {
    await nudgeWindowsBrowserToFront(session.browserPid, session.executablePath).catch(() => {});
  }
}

async function closeActivePortalSession(options = {}) {
  const session = activePortalSession;
  if (!session) {
    return { ok: true, closed: false };
  }
  const targetSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  if (targetSessionId && !options.force && targetSessionId !== session.sessionId) {
    return { ok: true, closed: false };
  }

  activePortalSession = null;

  // Attempt graceful CDP Browser.close first so cookies & session storage flush cleanly to disk.
  if (!session.exited) {
    try {
      const versionInfo = await fetchLoopbackJson(session.port, '/json/version', options.quick ? 700 : 1_500);
      const browserWsUrl = versionInfo?.webSocketDebuggerUrl;
      if (typeof browserWsUrl === 'string' && browserWsUrl.startsWith(`ws://${HOST}:${session.port}/`)) {
        const browserClient = new NativeCdpClient(browserWsUrl, session.port);
        try {
          await browserClient.connect(options.quick ? 700 : 1_500);
          await browserClient.send('Browser.close', {}, options.quick ? 700 : 1_500).catch(() => {});
        } finally {
          browserClient.close();
        }
      }
    } catch {
      // ignore and fall back to process signal below
    }
  }

  const waitUntilExited = (ms) => {
    if (session.child) {
      return new Promise((resolve) => {
        if (session.exited || session.child.exitCode !== null) {
          resolve(true);
          return;
        }
        const onExit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          session.child.off('exit', onExit);
          resolve(false);
        }, ms);
        session.child.once('exit', onExit);
      });
    }

    if (!Number.isInteger(session.browserPid) || session.browserPid <= 0) {
      return Promise.resolve(true);
    }

    return (async () => {
      const waitDeadline = Date.now() + ms;
      while (Date.now() < waitDeadline) {
        if (session.exited || !isProcessAlive(session.browserPid)) {
          return true;
        }
        await sleep(100);
      }
      return !isProcessAlive(session.browserPid);
    })();
  };

  const exitedGracefully = await waitUntilExited(options.quick ? 500 : 2_000);
  if (!exitedGracefully && !session.exited) {
    if (session.child) {
      try {
        session.child.kill('SIGTERM');
      } catch {
        // ignore
      }
      const exitedAfterTerm = await waitUntilExited(options.quick ? 400 : 1_200);
      if (!exitedAfterTerm && !session.exited) {
        try {
          session.child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    } else if (process.platform === 'win32' && Number.isInteger(session.browserPid) && session.browserPid > 0) {
      await runWindowsTaskkill(session.browserPid, options.quick ? 800 : 2_000);
    } else if (Number.isInteger(session.browserPid) && session.browserPid > 0) {
      try {
        process.kill(session.browserPid, 'SIGTERM');
      } catch {
        // ignore
      }
      const exitedAfterTerm = await waitUntilExited(options.quick ? 400 : 1_200);
      if (!exitedAfterTerm) {
        try {
          process.kill(session.browserPid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }

  session.exited = true;
  return { ok: true, closed: true };
}

async function startPortalSession(rawPortalUrl) {
  const checkedUrl = validatePortalHttpsUrl(rawPortalUrl);
  if (!checkedUrl.ok) {
    throw Object.assign(new Error(checkedUrl.error), { status: 400 });
  }

  if (typeof globalThis.WebSocket !== 'function') {
    throw Object.assign(
      new Error('Die lokale Bridge benötigt Node.js v22 oder neuer für den integrierten Portal-Leser.'),
      { status: 500 }
    );
  }

  const browser = detectLocalChromiumBrowser();
  if (!browser) {
    throw Object.assign(
      new Error(
        'Kein lokaler Chromium-Browser (Chrome, Edge oder Brave) gefunden. Installiere Chrome oder Edge, um dein Portal direkt einzulesen.'
      ),
      { status: 404 }
    );
  }

  // Strictly max 1 active portal session at a time: close any previous session cleanly first.
  if (activePortalSession) {
    await closeActivePortalSession({ force: true });
    await sleep(350);
  }

  const profileDir = getPortalProfileDir();
  await fsp.mkdir(profileDir, { recursive: true });
  const port = await findFreeLoopbackPort();

  const spawnArgs = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--window-size=1200,840',
    '--window-position=100,60',
    '--new-window',
    checkedUrl.url,
  ];

  let child = null;
  let browserPid = null;
  try {
    if (process.platform === 'win32') {
      // Launch via Start-Process -WindowStyle Normal to break SW_HIDE inheritance from hidden bridge daemons.
      const launched = await launchWindowsVisibleBrowser(browser.executablePath, spawnArgs);
      browserPid = launched.pid;
    } else {
      child = spawn(browser.executablePath, spawnArgs, {
        shell: false,
        detached: true,
        stdio: 'ignore',
      });
      browserPid = child.pid || null;
      child.unref();
    }
  } catch (err) {
    throw Object.assign(
      new Error(`Portal-Browser (${browser.browserName}) konnte nicht gestartet werden: ${err.message}`),
      { status: 500 }
    );
  }

  const sessionId = crypto.randomUUID();
  const session = {
    sessionId,
    port,
    browserName: browser.browserName,
    executablePath: browser.executablePath,
    portalUrl: checkedUrl.url,
    origin: checkedUrl.origin,
    child,
    browserPid,
    startedAt: Date.now(),
    exited: false,
    extracting: false,
  };

  if (child) {
    child.on('exit', () => {
      session.exited = true;
      if (activePortalSession && activePortalSession.sessionId === sessionId) {
        activePortalSession = null;
      }
    });

    child.on('error', () => {
      session.exited = true;
    });
  }

  activePortalSession = session;

  // Wait for CDP endpoint to come online on 127.0.0.1:<port>
  const deadline = Date.now() + PORTAL_LAUNCH_TIMEOUT_MS;
  let primaryTarget = null;

  while (Date.now() < deadline) {
    if (session.exited) {
      break;
    }
    const targets = await listCdpTargets(port, 1_000);
    if (targets && targets.length > 0) {
      primaryTarget = selectPrimaryPageTarget(targets, checkedUrl.origin);
      if (primaryTarget) {
        break;
      }
    }
    await sleep(220);
  }

  if (!primaryTarget) {
    await closeActivePortalSession({ sessionId, force: true });
    throw Object.assign(
      new Error(
        `Der Portal-Browser (${browser.browserName}) hat nicht rechtzeitig reagiert. Schliesse eventuell offene alte Portal-Fenster und versuche es erneut.`
      ),
      { status: 504 }
    );
  }

  // Bring browser window visibly to foreground (CDP + Win32 nudge on Windows) while page resolves
  await Promise.all([sleep(650), bringPortalWindowToFront(session, primaryTarget)]);
  const refreshedTargets = (await listCdpTargets(port, 1_500)) || [];
  const latestTarget = selectPrimaryPageTarget(refreshedTargets, checkedUrl.origin) || primaryTarget;
  const inspected = await inspectTargetLoginState(port, latestTarget);

  return {
    ok: true,
    sessionId,
    browserName: browser.browserName,
    portalUrl: checkedUrl.url,
    currentUrl: inspected.currentUrl || checkedUrl.url,
    pageTitle: inspected.pageTitle || '',
    looksLikeLogin: inspected.looksLikeLogin,
  };
}

async function getPortalSessionStatus(rawSessionId) {
  const session = activePortalSession;
  const requestedId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';

  if (!session || session.exited || (requestedId && requestedId !== session.sessionId)) {
    return {
      ok: true,
      active: false,
      currentUrl: '',
      pageTitle: '',
      looksLikeLogin: false,
    };
  }

  const targets = await listCdpTargets(session.port, 2_000);
  if (!targets || targets.length === 0) {
    const processExited = session.child
      ? session.child.exitCode !== null
      : !isProcessAlive(session.browserPid);
    if (session.exited || processExited) {
      session.exited = true;
      activePortalSession = null;
    }
    return {
      ok: true,
      active: false,
      currentUrl: '',
      pageTitle: '',
      looksLikeLogin: false,
    };
  }

  const target = selectPrimaryPageTarget(targets, session.origin);
  if (!target) {
    return {
      ok: true,
      active: false,
      currentUrl: '',
      pageTitle: '',
      looksLikeLogin: false,
    };
  }

  const inspected = await inspectTargetLoginState(session.port, target);
  return {
    ok: true,
    active: true,
    currentUrl: inspected.currentUrl,
    pageTitle: inspected.pageTitle,
    looksLikeLogin: inspected.looksLikeLogin,
  };
}

const PORTAL_SNAPSHOT_EXPRESSION = `(() => {
  try {
    const MAX_BODY_CHARS = 40000;
    const MAX_ROWS = 320;
    const MAX_LINKS = 140;

    const isVisible = (el) => {
      if (!el || typeof el.getBoundingClientRect !== 'function') return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };

    const normalizeInline = (text) =>
      String(text || '').replace(/\\s+/g, ' ').trim();

    const collectFromDocument = (doc, outBodyParts, outRows, outLinks, outButtons) => {
      if (!doc || !doc.body) return;

      const pwInputs = doc.querySelectorAll('input[type="password"]');
      let hasPw = false;
      for (const input of pwInputs) {
        try {
          const rect = input.getBoundingClientRect();
          if (rect.width > 4 && rect.height > 4) {
            hasPw = true;
            break;
          }
        } catch {
          // ignore
        }
      }

      const rawInner = String(doc.body.innerText || '').trim();
      if (rawInner) {
        outBodyParts.push(rawInner);
      }

      // Structured table rows
      const rowSet = new Set();
      const pushRow = (text) => {
        const clean = normalizeInline(text);
        if (!clean || clean.length < 4 || clean.length > 420) return;
        if (rowSet.has(clean) || outRows.length >= MAX_ROWS) return;
        rowSet.add(clean);
        outRows.push(clean);
      };

      const rows = doc.querySelectorAll('table tr, [role="row"]');
      for (const row of rows) {
        if (outRows.length >= MAX_ROWS) break;
        const cells = row.querySelectorAll('th, td, [role="cell"], [role="gridcell"], [role="columnheader"]');
        if (cells.length > 0) {
          const parts = [];
          for (const cell of cells) {
            const cellDate = cell.getAttribute('data-date') || cell.getAttribute('datetime') || '';
            const cellAria = cell.getAttribute('aria-label') || '';
            const cellText = normalizeInline(cell.innerText || cell.textContent || '');
            const combined = cellDate && cellText && !cellText.includes(cellDate)
              ? '[' + cellDate + '] ' + cellText
              : cellText || cellAria;
            if (combined) parts.push(combined);
          }
          if (parts.length > 0) {
            pushRow(parts.join(' | '));
          }
        } else {
          pushRow(row.innerText || '');
        }
      }

      // Calendar cells & event tiles (FullCalendar, Moodle, Canvas, WebUntis, custom widgets)
      const calNodes = doc.querySelectorAll(
        '[data-date], [data-day], .fc-event, .fc-daygrid-day, .calendar-event, .event-item, [class*="event"], [class*="termin"], [class*="exam"], [class*="pruefung"], [role="gridcell"][aria-label]'
      );
      for (const node of calNodes) {
        if (outRows.length >= MAX_ROWS) break;
        const dataDate = node.getAttribute('data-date') || node.getAttribute('data-day') || '';
        const aria = normalizeInline(node.getAttribute('aria-label') || '');
        const titleAttr = normalizeInline(node.getAttribute('title') || '');
        const text = normalizeInline(node.innerText || '');
        if (!text && !aria && !titleAttr) continue;
        if (text.length > 360) continue;
        const chunks = [];
        if (dataDate) chunks.push('[' + dataDate + ']');
        if (text) chunks.push(text);
        if (aria && (!text || !text.toLowerCase().includes(aria.toLowerCase().slice(0, 24)))) {
          chunks.push(aria);
        }
        if (titleAttr && (!text || !text.toLowerCase().includes(titleAttr.toLowerCase().slice(0, 24)))) {
          chunks.push(titleAttr);
        }
        if (chunks.length > 0) {
          pushRow(chunks.join(' | '));
        }
      }

      // Same-origin links & menu buttons
      const anchors = doc.querySelectorAll('a[href]');
      for (const a of anchors) {
        if (outLinks.length >= MAX_LINKS) break;
        const href = String(a.getAttribute('href') || '').trim();
        if (!href) continue;
        const text = normalizeInline(a.innerText || a.textContent || '').slice(0, 120);
        const ariaLabel = normalizeInline(a.getAttribute('aria-label') || '').slice(0, 120);
        const title = normalizeInline(a.getAttribute('title') || '').slice(0, 120);
        let resolvedHref = '';
        try {
          resolvedHref = new URL(href, doc.baseURI || location.href).toString();
        } catch {
          continue;
        }
        outLinks.push({
          href: resolvedHref,
          rawHref: href,
          text,
          ariaLabel,
          title,
        });
      }

      const menuButtons = doc.querySelectorAll(
        'nav button, header button, aside button, [role="tab"], [role="menuitem"], .nav button, .menu button, .sidebar button'
      );
      for (const btn of menuButtons) {
        if (outButtons.length >= 40) break;
        if (!isVisible(btn)) continue;
        const text = normalizeInline(btn.innerText || btn.textContent || '').slice(0, 100);
        const ariaLabel = normalizeInline(btn.getAttribute('aria-label') || '').slice(0, 100);
        const title = normalizeInline(btn.getAttribute('title') || '').slice(0, 100);
        if (!text && !ariaLabel && !title) continue;
        outButtons.push({ text, ariaLabel, title });
      }

      return hasPw;
    };

    const bodyParts = [];
    const structuredRows = [];
    const links = [];
    const menuButtons = [];
    let hasPasswordInput = Boolean(
      collectFromDocument(document, bodyParts, structuredRows, links, menuButtons)
    );

    // Also inspect same-origin iframes safely (many school portals embed agenda/schedule frames)
    const frames = document.querySelectorAll('iframe');
    let frameCount = 0;
    for (const frame of frames) {
      if (frameCount >= 4) break;
      try {
        const frameDoc = frame.contentDocument;
        if (!frameDoc || !frameDoc.body) continue;
        frameCount += 1;
        const frameHasPw = collectFromDocument(frameDoc, bodyParts, structuredRows, links, menuButtons);
        if (frameHasPw) hasPasswordInput = true;
      } catch {
        // Cross-origin iframe — skip cleanly
      }
    }

    const bodyText = bodyParts.join('\\n\\n').slice(0, MAX_BODY_CHARS);
    return {
      url: String(location.href || ''),
      origin: String(location.origin || ''),
      title: String(document.title || ''),
      hasPasswordInput,
      bodyText,
      structuredRows,
      links,
      menuButtons,
    };
  } catch (err) {
    return {
      url: String(location.href || ''),
      origin: String(location.origin || ''),
      title: String(document.title || ''),
      hasPasswordInput: false,
      bodyText: '',
      structuredRows: [],
      links: [],
      menuButtons: [],
      error: String(err && err.message ? err.message : err),
    };
  }
})()`;

const PORTAL_AGENDA_NEGATIVE_PATTERN =
  /(logout|log-out|log_out|signout|sign-out|abmelden|ausloggen|delete|remove|löschen|loeschen|destroy|reset|password|passwort|kennwort|print|drucken|export|download|hilfe|help|impressum|datenschutz|privacy|support|profil|profile|settings|einstellungen|account|konto|warenkorb|cart|bezahlen|pay)/i;

const PORTAL_AGENDA_FILE_EXT_PATTERN = /\.(pdf|zip|rar|7z|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|svg|mp4|mp3|ics|csv)(\?|$)/i;

const PORTAL_AGENDA_HIGH_KEYWORDS = [
  'prüfung',
  'pruefung',
  'prüfungen',
  'pruefungen',
  'klausur',
  'klausuren',
  'leistungsnachweis',
  'leistungsnachweise',
  'exam',
  'exams',
  'agenda',
  'kalender',
  'calendar',
];

const PORTAL_AGENDA_MEDIUM_KEYWORDS = [
  'stundenplan',
  'schedule',
  'timetable',
  'wochenplan',
  'termin',
  'termine',
  'aufgabe',
  'aufgaben',
  'hausaufgabe',
  'homework',
  'deadline',
  'deadlines',
  'abgabe',
  'abgaben',
  'test',
  'tests',
  'events',
  'veranstaltung',
  'monat',
  'monatsansicht',
  'woche',
];

function scoreAgendaCandidateText(combinedText, hrefPath = '') {
  const hay = `${combinedText} ${hrefPath}`.toLowerCase();
  if (!hay.trim()) return -100;
  if (PORTAL_AGENDA_NEGATIVE_PATTERN.test(hay)) return -100;
  if (PORTAL_AGENDA_FILE_EXT_PATTERN.test(hrefPath)) return -100;

  let score = 0;
  for (const kw of PORTAL_AGENDA_HIGH_KEYWORDS) {
    if (hay.includes(kw)) score += 12;
  }
  for (const kw of PORTAL_AGENDA_MEDIUM_KEYWORDS) {
    if (hay.includes(kw)) score += 6;
  }
  return score;
}

function selectSameOriginAgendaLinks(links, baseOrigin, currentUrl, visitedUrls) {
  const byUrl = new Map();
  const normalizedCurrent = normalizeComparableUrl(currentUrl);

  for (const item of Array.isArray(links) ? links : []) {
    if (!item || typeof item.href !== 'string') continue;
    const rawHref = typeof item.rawHref === 'string' ? item.rawHref.trim().toLowerCase() : '';
    if (
      !rawHref ||
      rawHref === '#' ||
      rawHref.startsWith('javascript:') ||
      rawHref.startsWith('mailto:') ||
      rawHref.startsWith('tel:')
    ) {
      continue;
    }

    let parsed;
    try {
      parsed = new URL(item.href);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== baseOrigin) {
      continue;
    }

    const comparable = normalizeComparableUrl(parsed.toString());
    if (comparable === normalizedCurrent || visitedUrls.has(comparable)) {
      continue;
    }

    const label = [item.text, item.ariaLabel, item.title].filter(Boolean).join(' ').trim();
    const pathAndQuery = `${parsed.pathname} ${parsed.search} ${parsed.hash}`;
    const score = scoreAgendaCandidateText(label, pathAndQuery);
    if (score <= 0) continue;

    const existing = byUrl.get(comparable);
    if (!existing || score > existing.score) {
      byUrl.set(comparable, {
        url: parsed.toString(),
        comparable,
        label: label || parsed.pathname,
        score,
      });
    }
  }

  return Array.from(byUrl.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, PORTAL_MAX_SUBVIEWS);
}

function selectAgendaMenuButtons(buttons) {
  const seen = new Set();
  const scored = [];
  for (const btn of Array.isArray(buttons) ? buttons : []) {
    if (!btn || typeof btn !== 'object') continue;
    const label = [btn.text, btn.ariaLabel, btn.title].filter(Boolean).join(' ').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const score = scoreAgendaCandidateText(label, '');
    if (score >= 6) {
      scored.push({
        text: btn.text || '',
        ariaLabel: btn.ariaLabel || '',
        title: btn.title || '',
        score,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 2);
}

function normalizeComparableUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    // Keep hash if it looks like an SPA hash route (e.g. #/calendar or #!/agenda)
    const keepHash = parsed.hash && /^#[/!]/.test(parsed.hash) ? parsed.hash : '';
    const cleanPath = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${cleanPath}${parsed.search}${keepHash}`;
  } catch {
    return String(rawUrl || '').trim();
  }
}

function fingerprintSnapshot(snapshot) {
  const sample = `${snapshot?.url || ''}|${(snapshot?.structuredRows || []).join('\n').slice(0, 2500)}|${(snapshot?.bodyText || '').slice(0, 4000)}`;
  return crypto.createHash('sha1').update(sample).digest('hex');
}

async function waitForPageReady(client, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await client.evaluate('document.readyState', { timeoutMs: 1_500 });
      if (state === 'complete' || state === 'interactive') {
        if (state === 'complete') return true;
      }
    } catch {
      // Context may be resetting during navigation
    }
    await sleep(220);
  }
  return false;
}

const PORTAL_CLICK_NEXT_PERIOD_EXPRESSION = `(() => {
  try {
    const NEG = /(zurück|zurueck|prev|previous|vorherig|logout|signout|abmelden|löschen|loeschen|delete|remove|abbrechen|cancel|schliessen|schließen|close|speichern|save|senden|submit|hilfe|help)/i;
    const EXPLICIT_NEXT = /(nächste[rns]?\\s*(monat|woche|zeitraum|periode|ansicht)?|naechste[rns]?\\s*(monat|woche|zeitraum|periode|ansicht)?|next\\s*(month|week|period)?|vorwärts|vorwaerts|monat\\s*vor|woche\\s*vor|weiter\\s*(monat|woche)?)/i;
    const CALENDAR_HINT = /(next|weiter|vor|month|monat|week|woche|calendar|kalender|agenda|fc-next|cal-next|chevron-right|arrow-right)/i;
    const MONTH_HEADER = /(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|may|june|july|october|december|kw\\s*\\d{1,2})\\s*20\\d{2}|20\\d{2}/i;

    const isVisible = (el) => {
      if (!el || typeof el.getBoundingClientRect !== 'function') return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width >= 12 && rect.height >= 12 && rect.width <= 320 && rect.height <= 90;
    };

    const pageHasCalendarMonth = MONTH_HEADER.test((document.body && document.body.innerText || '').slice(0, 6000));

    const findBestInDoc = (doc) => {
      const els = doc.querySelectorAll('button, a, [role="button"], input[type="button"]');
      let best = null;
      let bestScore = 0;

      for (const el of els) {
        if (!isVisible(el)) continue;
        if (el.tagName === 'A') {
          const rawHref = String(el.getAttribute('href') || '').trim();
          if (rawHref && !rawHref.startsWith('#') && !rawHref.startsWith('javascript:')) {
            try {
              const targetUrl = new URL(rawHref, doc.baseURI || location.href);
              if (targetUrl.origin !== location.origin) continue;
            } catch {
              continue;
            }
          }
        }
        const typeAttr = String(el.getAttribute('type') || '').toLowerCase();
        if (typeAttr === 'submit') continue;

        const text = String(el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim();
        const aria = String(el.getAttribute('aria-label') || '').trim();
        const title = String(el.getAttribute('title') || '').trim();
        const cls = String(el.className || '');
        const dataAction = String(el.getAttribute('data-action') || el.getAttribute('data-testid') || '');
        const combined = (text + ' ' + aria + ' ' + title + ' ' + cls + ' ' + dataAction).trim();

        if (!combined || text.length > 48) continue;
        if (NEG.test(text + ' ' + aria + ' ' + title)) continue;

        let score = 0;
        if (EXPLICIT_NEXT.test(aria) || EXPLICIT_NEXT.test(title) || EXPLICIT_NEXT.test(text)) {
          score += 20;
        }
        if (/fc-next-button|next-month|cal-next|calendar-next|btn-next/i.test(cls + ' ' + dataAction)) {
          score += 18;
        }
        const isArrowGlyph = /^[>›»→\\u203a\\u00bb\\u2192]$|^->$/.test(text);
        if (isArrowGlyph) {
          if (CALENDAR_HINT.test(aria + ' ' + title + ' ' + cls + ' ' + dataAction)) {
            score += 14;
          } else if (pageHasCalendarMonth) {
            const parentText = String(el.parentElement && el.parentElement.innerText || '').slice(0, 120);
            if (MONTH_HEADER.test(parentText)) {
              score += 12;
            }
          }
        }
        if (score > bestScore) {
          bestScore = score;
          best = { el, label: aria || title || text || cls.slice(0, 40), score };
        }
      }
      return best;
    };

    let picked = findBestInDoc(document);
    if (!picked) {
      const frames = document.querySelectorAll('iframe');
      for (const frame of frames) {
        try {
          const fdoc = frame.contentDocument;
          if (!fdoc) continue;
          const candidate = findBestInDoc(fdoc);
          if (candidate && (!picked || candidate.score > picked.score)) {
            picked = candidate;
          }
        } catch {
          // ignore cross-origin iframe
        }
      }
    }

    if (!picked || picked.score < 12) {
      return { clicked: false };
    }
    picked.el.click();
    return { clicked: true, label: picked.label };
  } catch (err) {
    return { clicked: false, error: String(err && err.message ? err.message : err) };
  }
})()`;

function buildClickMenuButtonExpression(targetButton) {
  const serialized = JSON.stringify({
    text: String(targetButton.text || ''),
    ariaLabel: String(targetButton.ariaLabel || ''),
    title: String(targetButton.title || ''),
  });
  return `(() => {
    try {
      const target = ${serialized};
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const btns = document.querySelectorAll(
        'nav button, header button, aside button, [role="tab"], [role="menuitem"], .nav button, .menu button, .sidebar button'
      );
      for (const btn of btns) {
        const text = norm(btn.innerText || btn.textContent || '');
        const aria = norm(btn.getAttribute('aria-label') || '');
        const title = norm(btn.getAttribute('title') || '');
        if (
          (target.text && text === target.text) ||
          (target.ariaLabel && aria === target.ariaLabel) ||
          (target.title && title === target.title)
        ) {
          btn.click();
          return { clicked: true };
        }
      }
      return { clicked: false };
    } catch {
      return { clicked: false };
    }
  })()`;
}

function viewLooksCalendarLike(snapshot) {
  const hay = `${snapshot?.url || ''} ${snapshot?.title || ''} ${(snapshot?.bodyText || '').slice(0, 1200)}`.toLowerCase();
  return /(agenda|kalender|calendar|stundenplan|schedule|timetable|wochenplan|monat|prüfung|pruefung|termin|events|januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|october|december)/i.test(
    hay
  );
}

/* ---- Deterministic 90-Day Universal Agenda Parser ---- */

const MONTH_NAME_MAP = {
  januar: 1,
  jan: 1,
  january: 1,
  jän: 1,
  jaen: 1,
  februar: 2,
  feb: 2,
  february: 2,
  märz: 3,
  maerz: 3,
  mär: 3,
  mar: 3,
  march: 3,
  april: 4,
  apr: 4,
  mai: 5,
  may: 5,
  juni: 6,
  jun: 6,
  june: 6,
  juli: 7,
  jul: 7,
  july: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  oktober: 10,
  okt: 10,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  dezember: 12,
  dez: 12,
  december: 12,
  dec: 12,
};

const PORTAL_EXAM_PATTERN =
  /\b(prüfung|pruefung|prüfungen|pruefungen|klausur|test|tests|exam|exams|lernkontrolle|leistungsnachweis|vortrag|präsentation|praesentation|referat|matura|semesterprüfung|aufsatz|diktat|vokabeltest|wörtlitest|woertlitest|mündlich|muendlich|schriftlich|quiz)\b/i;

const PORTAL_HOMEWORK_PATTERN =
  /\b(hausaufgabe|hausaufgaben|aufgabe|aufgaben|abgabe|abgaben|homework|assignment|assignments|deadline|deadlines|einreichen|submission|due|dossier|projektarbeit|übung|uebung|übungsblatt|arbeitsblatt)\b/i;

const PORTAL_LESSON_PATTERN =
  /\b(lektion|unterricht|vorlesung|seminar|stunde|stundenplan|tutorium|praktikum|klasse|doppellektion|kurs|module?)\b/i;

const PORTAL_METADATA_DATE_PATTERN =
  /(stand\s*:|aktualisiert|letzte[rn]?\s*(anmeldung|login|besuch|änderung)|last\s*login|druckdatum|gedruckt\s*am|copyright|©|erstellt\s*am|version\s+\d)/i;

const PORTAL_NOISE_LINE_PATTERN =
  /^(impressum|datenschutz|hilfe|help|abmelden|logout|anmelden|login|einstellungen|settings|menü|menu|suche|search|drucken|print|zurück|weiter|heute|today|monat|woche|tag|liste|mo|di|mi|do|fr|sa|so|mon|tue|wed|thu|fri|sat|sun|\d{1,2})$/i;

const KNOWN_SUBJECT_RULES = [
  { pattern: /\b(mathematik|mathe|analysis|algebra|geometrie|statistik)\b/i, name: 'Mathematik' },
  { pattern: /\b(deutsch|germanistik|literatur)\b/i, name: 'Deutsch' },
  { pattern: /\b(englisch|english)\b/i, name: 'Englisch' },
  { pattern: /\b(französisch|franzoesisch|français|francais|french)\b/i, name: 'Französisch' },
  { pattern: /\b(italienisch|italiano|italian)\b/i, name: 'Italienisch' },
  { pattern: /\b(spanisch|español|espanol|spanish)\b/i, name: 'Spanisch' },
  { pattern: /\b(latein|latin)\b/i, name: 'Latein' },
  { pattern: /\b(biologie|biology)\b/i, name: 'Biologie' },
  { pattern: /\b(chemie|chemistry)\b/i, name: 'Chemie' },
  { pattern: /\b(physik|physics)\b/i, name: 'Physik' },
  { pattern: /\b(geschichte|history)\b/i, name: 'Geschichte' },
  { pattern: /\b(geografie|geographie|geography)\b/i, name: 'Geografie' },
  { pattern: /\b(wirtschaft\s*(?:&|und)?\s*recht|wirtschaft|ökonomie|oekonomie|bwl|vwl|recht|economics|law)\b/i, name: 'Wirtschaft & Recht' },
  { pattern: /\b(informatik|programmieren|computer\s*science|software|datenbanken|algorithmen)\b/i, name: 'Informatik' },
  { pattern: /\b(philosophie|philosophy)\b/i, name: 'Philosophie' },
  { pattern: /\b(psychologie|psychology|pädagogik|paedagogik)\b/i, name: 'Psychologie' },
  { pattern: /\b(musik|music)\b/i, name: 'Musik' },
  { pattern: /\b(bildnerisches\s*gestalten|kunst|zeichnen|art)\b/i, name: 'Bildnerisches Gestalten' },
  { pattern: /\b(sport|turnen)\b/i, name: 'Sport' },
  { pattern: /\b(ethik|religion|religionslehre)\b/i, name: 'Ethik & Religion' },
  { pattern: /\b(medizin|anatomie|biochemie)\b/i, name: 'Medizin' },
  { pattern: /\b(architektur|bauwesen)\b/i, name: 'Architektur' },
];

const SHORT_SUBJECT_CODES = {
  MA: 'Mathematik',
  MAT: 'Mathematik',
  DE: 'Deutsch',
  DEU: 'Deutsch',
  EN: 'Englisch',
  ENG: 'Englisch',
  FR: 'Französisch',
  FRA: 'Französisch',
  IT: 'Italienisch',
  ES: 'Spanisch',
  BI: 'Biologie',
  BIO: 'Biologie',
  CH: 'Chemie',
  CHE: 'Chemie',
  PH: 'Physik',
  PHY: 'Physik',
  GS: 'Geschichte',
  GG: 'Geografie',
  GEO: 'Geografie',
  WR: 'Wirtschaft & Recht',
  WIR: 'Wirtschaft & Recht',
  IN: 'Informatik',
  INF: 'Informatik',
  BG: 'Bildnerisches Gestalten',
  MU: 'Musik',
  MUS: 'Musik',
  SP: 'Sport',
  PS: 'Psychologie',
  PL: 'Philosophie',
};

function getPortalHorizonBounds(horizonDays) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + horizonDays);
  return {
    startDate: start,
    startIso: formatLocalIsoDate(start),
    endIso: formatLocalIsoDate(end),
    currentYear: start.getFullYear(),
  };
}

function detectMonthYearContext(text) {
  const monthNames = Object.keys(MONTH_NAME_MAP).join('|');
  const namedRegex = new RegExp(`\\b(${monthNames})\\.?\\s+(20\\d{2})\\b`, 'i');
  const namedMatch = text.match(namedRegex);
  if (namedMatch) {
    const month = MONTH_NAME_MAP[namedMatch[1].toLowerCase()];
    const year = Number(namedMatch[2]);
    if (month && year >= 2000 && year <= 2100) {
      return { year, month };
    }
  }
  const slashMatch = text.match(/\b(0?[1-9]|1[0-2])\/(20\d{2})\b/);
  if (slashMatch) {
    return { year: Number(slashMatch[2]), month: Number(slashMatch[1]) };
  }
  return null;
}

function resolveDayMonthWithoutYear(day, month, contextMonthYear, bounds) {
  const candidateYears = [];
  if (contextMonthYear) {
    if (contextMonthYear.month === 12 && month === 1) {
      candidateYears.push(contextMonthYear.year + 1, contextMonthYear.year);
    } else if (contextMonthYear.month === 1 && month === 12) {
      candidateYears.push(contextMonthYear.year - 1, contextMonthYear.year);
    } else {
      candidateYears.push(contextMonthYear.year, contextMonthYear.year + 1);
    }
  } else {
    candidateYears.push(bounds.currentYear, bounds.currentYear + 1, bounds.currentYear - 1);
  }

  for (const yr of candidateYears) {
    const iso = toValidIsoDate(yr, month, day);
    if (iso && iso >= bounds.startIso && iso <= bounds.endIso) {
      return iso;
    }
  }
  return null;
}

function extractPortalDatesFromLine(line, contextMonthYear, bounds) {
  const results = new Set();
  let hasAnyDate = false;
  const text = String(line || '');

  // 1. ISO YYYY-MM-DD
  const isoRegex = /\b(20\d{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/g;
  let match;
  while ((match = isoRegex.exec(text)) !== null) {
    const iso = toValidIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) {
      hasAnyDate = true;
      if (iso >= bounds.startIso && iso <= bounds.endIso) results.add(iso);
    }
  }

  // 2. European DD.MM.YYYY
  const euFullRegex = /\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.(20\d{2})\b/g;
  while ((match = euFullRegex.exec(text)) !== null) {
    const iso = toValidIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
    if (iso) {
      hasAnyDate = true;
      if (iso >= bounds.startIso && iso <= bounds.endIso) results.add(iso);
    }
  }

  // 3. European short year DD.MM.YY (not followed by digits)
  const euShortYearRegex = /\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.(\d{2})(?!\d)/g;
  while ((match = euShortYearRegex.exec(text)) !== null) {
    const iso = toValidIsoDate(2000 + Number(match[3]), Number(match[2]), Number(match[1]));
    if (iso) {
      hasAnyDate = true;
      if (iso >= bounds.startIso && iso <= bounds.endIso) results.add(iso);
    }
  }

  // 4. Written German / English day-month: "14. Dezember 2026" or "14. Dez."
  const monthNames = Object.keys(MONTH_NAME_MAP).join('|');
  const writtenEuRegex = new RegExp(
    `\\b(0?[1-9]|[12]\\d|3[01])\\.?\\s+(${monthNames})\\.?(?:\\s+(20\\d{2}))?\\b`,
    'gi'
  );
  while ((match = writtenEuRegex.exec(text)) !== null) {
    const day = Number(match[1]);
    const month = MONTH_NAME_MAP[match[2].toLowerCase()];
    if (!month) continue;
    hasAnyDate = true;
    const iso = match[3]
      ? toValidIsoDate(Number(match[3]), month, day)
      : resolveDayMonthWithoutYear(day, month, contextMonthYear, bounds);
    if (iso && iso >= bounds.startIso && iso <= bounds.endIso) results.add(iso);
  }

  // 5. Written US English: "Dec 14, 2026" or "December 14"
  const writtenUsRegex = new RegExp(
    `\\b(${monthNames})\\.?\\s+(0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?:,?\\s*(20\\d{2}))?\\b`,
    'gi'
  );
  while ((match = writtenUsRegex.exec(text)) !== null) {
    const month = MONTH_NAME_MAP[match[1].toLowerCase()];
    const day = Number(match[2]);
    if (!month) continue;
    hasAnyDate = true;
    const iso = match[3]
      ? toValidIsoDate(Number(match[3]), month, day)
      : resolveDayMonthWithoutYear(day, month, contextMonthYear, bounds);
    if (iso && iso >= bounds.startIso && iso <= bounds.endIso) results.add(iso);
  }

  // 6. European DD.MM. without year (only when not part of DD.MM.YYYY / DD.MM.YY)
  if (!hasAnyDate) {
    const dayMonthRegex = /\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.(?!\d)/g;
    while ((match = dayMonthRegex.exec(text)) !== null) {
      hasAnyDate = true;
      const iso = resolveDayMonthWithoutYear(Number(match[1]), Number(match[2]), contextMonthYear, bounds);
      if (iso) results.add(iso);
    }
  }

  return {
    inHorizon: Array.from(results),
    hasAnyDate,
  };
}

function padTwo(value) {
  return String(value).padStart(2, '0');
}

function extractTimeRange(line) {
  const text = String(line || '');
  const rangeMatch = text.match(
    /\b([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|–|—|bis|to)\s*([01]?\d|2[0-3]):([0-5]\d)\b/i
  );
  if (rangeMatch) {
    return {
      startTime: `${padTwo(rangeMatch[1])}:${rangeMatch[2]}`,
      endTime: `${padTwo(rangeMatch[3])}:${rangeMatch[4]}`,
    };
  }
  const singleMatch = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (singleMatch) {
    return {
      startTime: `${padTwo(singleMatch[1])}:${singleMatch[2]}`,
      endTime: undefined,
    };
  }
  return { startTime: undefined, endTime: undefined };
}

function extractRoomHint(line) {
  const text = String(line || '');
  const labeled = text.match(
    /\b(?:Raum|Zimmer|Zi\.?|Room|Saal|Hörsaal|Hoersaal|Labor|Halle|Gebäude|Gebaeude)\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9.\-/]{0,14})\b/i
  );
  if (labeled) {
    return `${labeled[0].replace(/\s+/g, ' ').trim()}`.slice(0, 40);
  }
  const venue = text.match(/\b(Turnhalle(?:\s*[A-Za-z0-9]+)?|Sporthalle(?:\s*[A-Za-z0-9]+)?|Aula|Mediothek|Bibliothek)\b/i);
  if (venue) {
    return venue[1].trim().slice(0, 40);
  }
  return undefined;
}

function detectCourseFromText(line) {
  const text = String(line || '');
  for (const rule of KNOWN_SUBJECT_RULES) {
    if (rule.pattern.test(text)) {
      return { courseTitle: rule.name, matchedKnown: true };
    }
  }
  // Check standalone uppercase 2–3 letter subject codes separated by delimiters
  const codeMatches = text.match(/(?:^|[\s|,;:(])([A-Z]{2,3})(?=$|[\s|,;:)\-–—])/g);
  if (codeMatches) {
    for (const token of codeMatches) {
      const code = token.replace(/[^A-Z]/g, '');
      if (SHORT_SUBJECT_CODES[code]) {
        return { courseTitle: SHORT_SUBJECT_CODES[code], matchedKnown: true };
      }
    }
  }
  return { courseTitle: 'Allgemein', matchedKnown: false };
}

function classifyPortalCategory(line, hasTimeRange, matchedKnownCourse) {
  if (PORTAL_EXAM_PATTERN.test(line)) return 'exam';
  if (PORTAL_HOMEWORK_PATTERN.test(line)) return 'homework';
  if (PORTAL_LESSON_PATTERN.test(line)) return 'lesson';
  if (hasTimeRange && matchedKnownCourse) return 'lesson';
  return 'event';
}

function cleanPortalItemTitle(rawLine) {
  const stripped = String(rawLine || '')
    .replace(/\[20\d{2}-\d{2}-\d{2}\]/g, ' ')
    .replace(/\b20\d{2}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.(?:20\d{2}|\d{2})?(?!\d)/g, ' ')
    .replace(/\b([01]?\d|2[0-3]):[0-5]\d\s*(?:-|–|—|bis|to)\s*([01]?\d|2[0-3]):[0-5]\d\s*(?:Uhr)?\b/gi, ' ')
    .replace(/\b([01]?\d|2[0-3]):[0-5]\d\s*(?:Uhr)?\b/gi, ' ')
    .replace(/\b(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Mo|Di|Mi|Do|Fr|Sa|So),?\s*/gi, ' ')
    .replace(/\s*\|\s*/g, ' — ')
    .replace(/^[\s\-–—|:;,./]+|[\s\-–—|:;,./]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return stripped.slice(0, 120);
}

function isPureDateHeadingLine(line) {
  const remainder = cleanPortalItemTitle(line)
    .replace(
      /\b(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|may|june|july|october|december|jan|feb|mär|mar|apr|jun|jul|aug|sep|sept|okt|oct|nov|dez|dec)\b/gi,
      ''
    )
    .replace(/\b20\d{2}\b/g, '')
    .replace(/[\s,.\-–—|:;/()]+/g, '')
    .trim();
  return remainder.length <= 2;
}

function scrubSensitiveTokensFromText(rawText) {
  return String(rawText || '')
    // Strip JWTs
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    // Strip Bearer headers / query tokens / csrf tokens
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]')
    .replace(/\b(access_token|id_token|refresh_token|csrf_token|csrf|session_?id|phpsessid|jsessionid|auth_?token)=[^\s&;]+/gi, '$1=[redacted]')
    // Strip long unbroken hex/token hashes >= 40 chars
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted]');
}

function extractPortalAgendaFromViews(capturedViews, horizonDays) {
  const bounds = getPortalHorizonBounds(horizonDays);
  const rawItems = [];
  const bundleSections = [];
  let bundleLength = 0;

  for (let viewIdx = 0; viewIdx < capturedViews.length; viewIdx += 1) {
    const view = capturedViews[viewIdx];
    const viewTitle = String(view.title || 'Portal-Ansicht').trim().slice(0, 120);
    const viewUrl = String(view.url || '').trim();
    const combinedRaw = [
      ...(Array.isArray(view.structuredRows) ? view.structuredRows : []),
      ...String(view.bodyText || '').replace(/\r\n/g, '\n').split('\n'),
    ];

    const dedupedLines = [];
    const seenViewLines = new Set();
    for (const rawLine of combinedRaw) {
      const cleanedLine = scrubSensitiveTokensFromText(rawLine).replace(/\s+/g, ' ').trim();
      if (!cleanedLine || cleanedLine.length < 2) continue;
      const lineKey = cleanedLine.toLowerCase();
      if (seenViewLines.has(lineKey)) continue;
      seenViewLines.add(lineKey);
      dedupedLines.push(cleanedLine);
    }

    // Build cleanedTextBundle section (capped at PORTAL_MAX_BUNDLE_CHARS total)
    if (bundleLength < PORTAL_MAX_BUNDLE_CHARS) {
      let safeHeaderUrl = viewUrl;
      try {
        const parsed = new URL(viewUrl);
        safeHeaderUrl = `${parsed.origin}${parsed.pathname}${parsed.hash && /^#[/!]/.test(parsed.hash) ? parsed.hash : ''}`;
      } catch {
        safeHeaderUrl = '';
      }
      const header = `=== [Ansicht ${viewIdx + 1}] ${viewTitle}${safeHeaderUrl ? ` (${safeHeaderUrl})` : ''} ===`;
      const bodyJoined = dedupedLines.join('\n');
      const section = `${header}\n${bodyJoined}`;
      const remaining = PORTAL_MAX_BUNDLE_CHARS - bundleLength;
      if (section.length <= remaining) {
        bundleSections.push(section);
        bundleLength += section.length + 2;
      } else if (remaining > 120) {
        bundleSections.push(section.slice(0, remaining).trimEnd());
        bundleLength = PORTAL_MAX_BUNDLE_CHARS;
      }
    }

    // Track active month/year header and active date section header across lines
    let contextMonthYear = detectMonthYearContext(`${viewTitle} ${dedupedLines.slice(0, 25).join(' ')}`);
    let activeSectionDate = null;
    let linesSinceDateHeader = 0;

    for (let i = 0; i < dedupedLines.length; i += 1) {
      const line = dedupedLines[i];
      if (PORTAL_METADATA_DATE_PATTERN.test(line)) continue;
      if (PORTAL_NOISE_LINE_PATTERN.test(line)) continue;

      const updatedMonthYear = detectMonthYearContext(line);
      if (updatedMonthYear && line.length <= 60) {
        contextMonthYear = updatedMonthYear;
      }

      const dateScan = extractPortalDatesFromLine(line, contextMonthYear, bounds);
      const inlineDates = dateScan.inHorizon;

      if (inlineDates.length === 0 && dateScan.hasAnyDate) {
        // Explicit date outside horizon (past or beyond horizonDays): never inherit previous section date
        activeSectionDate = null;
        linesSinceDateHeader = 0;
        continue;
      }

      if (inlineDates.length > 0) {
        if (isPureDateHeadingLine(line)) {
          activeSectionDate = inlineDates[0];
          linesSinceDateHeader = 0;
          continue;
        }

        const timeInfo = extractTimeRange(line);
        const room = extractRoomHint(line);
        const courseInfo = detectCourseFromText(line);
        const title = cleanPortalItemTitle(line);
        if (!title || title.length < 3 || PORTAL_NOISE_LINE_PATTERN.test(title)) {
          activeSectionDate = inlineDates[0];
          linesSinceDateHeader = 0;
          continue;
        }

        const category = classifyPortalCategory(
          line,
          Boolean(timeInfo.startTime && timeInfo.endTime),
          courseInfo.matchedKnown
        );

        for (const isoDate of inlineDates) {
          const hash = crypto
            .createHash('sha1')
            .update(`${isoDate}|${timeInfo.startTime || ''}|${title.toLowerCase()}`)
            .digest('hex')
            .slice(0, 8);
          rawItems.push({
            id: `portal-${isoDate}-${hash}`,
            title,
            date: isoDate,
            courseTitle: courseInfo.courseTitle,
            source: 'portal-sync',
            ...(timeInfo.startTime ? { startTime: timeInfo.startTime } : {}),
            ...(timeInfo.endTime ? { endTime: timeInfo.endTime } : {}),
            category,
            ...(room ? { room } : {}),
          });
        }
        activeSectionDate = null;
        linesSinceDateHeader = 0;
        continue;
      }

      // Associate lines immediately following a standalone date header (e.g., agenda day lists)
      if (activeSectionDate && linesSinceDateHeader < 8) {
        linesSinceDateHeader += 1;
        const timeInfo = extractTimeRange(line);
        const room = extractRoomHint(line);
        const courseInfo = detectCourseFromText(line);
        const hasSignal =
          Boolean(timeInfo.startTime) ||
          Boolean(room) ||
          courseInfo.matchedKnown ||
          PORTAL_EXAM_PATTERN.test(line) ||
          PORTAL_HOMEWORK_PATTERN.test(line) ||
          PORTAL_LESSON_PATTERN.test(line);

        if (!hasSignal) continue;
        const title = cleanPortalItemTitle(line);
        if (!title || title.length < 4 || PORTAL_NOISE_LINE_PATTERN.test(title)) continue;

        const category = classifyPortalCategory(
          line,
          Boolean(timeInfo.startTime && timeInfo.endTime),
          courseInfo.matchedKnown
        );
        const hash = crypto
          .createHash('sha1')
          .update(`${activeSectionDate}|${timeInfo.startTime || ''}|${title.toLowerCase()}`)
          .digest('hex')
          .slice(0, 8);

        rawItems.push({
          id: `portal-${activeSectionDate}-${hash}`,
          title,
          date: activeSectionDate,
          courseTitle: courseInfo.courseTitle,
          source: 'portal-sync',
          ...(timeInfo.startTime ? { startTime: timeInfo.startTime } : {}),
          ...(timeInfo.endTime ? { endTime: timeInfo.endTime } : {}),
          category,
          ...(room ? { room } : {}),
        });
      }
    }
  }

  // Deduplicate and sort chronologically
  const deduped = [];
  const seenKeys = new Set();
  for (const item of rawItems) {
    const normTitle = item.title
      .toLowerCase()
      .replace(/[^a-z0-9äöü]+/g, ' ')
      .trim()
      .slice(0, 64);
    const key = `${item.date}|${item.startTime || ''}|${normTitle}`;
    if (!normTitle || seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(item);
  }

  deduped.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const ta = a.startTime || '99:99';
    const tb = b.startTime || '99:99';
    if (ta !== tb) return ta.localeCompare(tb);
    return a.title.localeCompare(b.title);
  });

  return {
    items: deduped.slice(0, PORTAL_MAX_ITEMS),
    cleanedTextBundle: bundleSections.join('\n\n').slice(0, PORTAL_MAX_BUNDLE_CHARS),
  };
}

async function extractPortalSessionAgenda(body = {}) {
  const requestedId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const horizonDays = clampPortalHorizonDays(body.horizonDays);
  const closeAfter = body.closeAfter !== false;

  const session = activePortalSession;
  if (!session || session.exited || (requestedId && requestedId !== session.sessionId)) {
    throw Object.assign(
      new Error('Kein aktives Portal-Fenster gefunden. Öffne zuerst dein Portal über die Bridge.'),
      { status: 404 }
    );
  }
  if (session.extracting) {
    throw Object.assign(
      new Error('Die Portal-Agenda wird bereits eingelesen. Bitte warte einen Moment.'),
      { status: 409 }
    );
  }

  session.extracting = true;
  let client = null;

  try {
    const targets = await listCdpTargets(session.port, 2_500);
    if (!targets || targets.length === 0) {
      throw Object.assign(
        new Error('Das Portal-Fenster wurde geschlossen. Öffne es erneut, um die Agenda einzulesen.'),
        { status: 404 }
      );
    }

    const target = selectPrimaryPageTarget(targets, session.origin);
    if (!target || !target.webSocketDebuggerUrl) {
      throw Object.assign(
        new Error('Keine geöffnete Portal-Seite gefunden.'),
        { status: 404 }
      );
    }

    client = new NativeCdpClient(target.webSocketDebuggerUrl, session.port);
    await client.connect(6_000);
    await client.send('Page.enable', {}, 4_000).catch(() => {});

    const crawlDeadline = Date.now() + PORTAL_CRAWL_BUDGET_MS;
    const capturedViews = [];
    const visitedPages = [];
    const visitedUrlSet = new Set();
    const seenFingerprints = new Set();
    let totalNextClicks = 0;

    const recordView = (snapshot) => {
      if (!snapshot || typeof snapshot !== 'object') return false;
      const fp = fingerprintSnapshot(snapshot);
      if (seenFingerprints.has(fp)) return false;
      seenFingerprints.add(fp);
      capturedViews.push(snapshot);
      const cleanTitle = String(snapshot.title || 'Portal-Ansicht').trim().slice(0, 140);
      let safeUrl = String(snapshot.url || '');
      try {
        const parsed = new URL(safeUrl);
        safeUrl = `${parsed.origin}${parsed.pathname}${parsed.hash && /^#[/!]/.test(parsed.hash) ? parsed.hash : ''}`;
      } catch {
        // keep original
      }
      if (!visitedPages.some((p) => p.url === safeUrl && p.title === cleanTitle)) {
        visitedPages.push({ url: safeUrl, title: cleanTitle });
      }
      return true;
    };

    const paginateCalendarView = async (baseOrigin, lastFingerprint) => {
      let currentFp = lastFingerprint;
      let clicksOnView = 0;
      while (
        clicksOnView < PORTAL_MAX_NEXT_CLICKS_PER_VIEW &&
        totalNextClicks < PORTAL_MAX_TOTAL_NEXT_CLICKS &&
        Date.now() < crawlDeadline - 2_000
      ) {
        const clickResult = await client
          .evaluate(PORTAL_CLICK_NEXT_PERIOD_EXPRESSION, { timeoutMs: 4_000, userGesture: true })
          .catch(() => ({ clicked: false }));

        if (!clickResult || !clickResult.clicked) {
          break;
        }
        clicksOnView += 1;
        totalNextClicks += 1;
        await sleep(PORTAL_PAGINATION_SETTLE_MS);

        const nextSnap = await client
          .evaluate(PORTAL_SNAPSHOT_EXPRESSION, { timeoutMs: 6_000 })
          .catch(() => null);
        if (!nextSnap || nextSnap.hasPasswordInput) break;
        if (nextSnap.origin && nextSnap.origin !== baseOrigin) break;

        const nextFp = fingerprintSnapshot(nextSnap);
        if (nextFp === currentFp) {
          break;
        }
        currentFp = nextFp;
        recordView(nextSnap);
      }
    };

    // Step A: Current page snapshot
    await waitForPageReady(client, 3_500);
    const initialSnapshot = await client.evaluate(PORTAL_SNAPSHOT_EXPRESSION, { timeoutMs: 8_000 });
    if (!initialSnapshot || !initialSnapshot.url) {
      throw Object.assign(
        new Error('Die aktuelle Portal-Seite konnte nicht ausgelesen werden.'),
        { status: 502 }
      );
    }

    let baseOrigin = session.origin;
    try {
      const currentParsed = new URL(initialSnapshot.url);
      if (currentParsed.protocol === 'https:') {
        baseOrigin = currentParsed.origin;
      }
    } catch {
      // keep initial session origin
    }

    visitedUrlSet.add(normalizeComparableUrl(initialSnapshot.url));
    recordView(initialSnapshot);

    // Discover same-origin agenda/exam/schedule links BEFORE paginating the initial view
    const discoveredLinks = selectSameOriginAgendaLinks(
      initialSnapshot.links,
      baseOrigin,
      initialSnapshot.url,
      visitedUrlSet
    );
    const discoveredMenuButtons =
      discoveredLinks.length < 2 ? selectAgendaMenuButtons(initialSnapshot.menuButtons) : [];

    // Step C on initial view if it already shows a calendar/agenda
    if (!initialSnapshot.hasPasswordInput && viewLooksCalendarLike(initialSnapshot)) {
      await paginateCalendarView(baseOrigin, fingerprintSnapshot(initialSnapshot));
    }

    // Step B: Visit up to 4 distinct highest-scoring same-origin agenda views
    for (const candidate of discoveredLinks) {
      if (Date.now() >= crawlDeadline) break;
      if (visitedUrlSet.has(candidate.comparable)) continue;
      visitedUrlSet.add(candidate.comparable);

      try {
        await client.send('Page.navigate', { url: candidate.url }, 8_000);
        await waitForPageReady(client, 5_500);
        await sleep(PORTAL_PAGE_SETTLE_MS);

        const snap = await client.evaluate(PORTAL_SNAPSHOT_EXPRESSION, { timeoutMs: 7_000 });
        if (!snap || !snap.url) continue;

        let snapOrigin = '';
        try {
          snapOrigin = new URL(snap.url).origin;
        } catch {
          snapOrigin = '';
        }

        if (snapOrigin !== baseOrigin || snap.hasPasswordInput) {
          // Bounced to external SSO or login wall — return to logged-in portal URL safely
          await client.send('Page.navigate', { url: initialSnapshot.url }, 6_000).catch(() => {});
          await waitForPageReady(client, 3_000);
          continue;
        }

        visitedUrlSet.add(normalizeComparableUrl(snap.url));
        const wasNew = recordView(snap);

        // Step C: Click next month/period up to 3 times on calendar/agenda sub-views
        if (wasNew && viewLooksCalendarLike(snap)) {
          await paginateCalendarView(baseOrigin, fingerprintSnapshot(snap));
        }
      } catch {
        // Keep crawling remaining candidate views even if one view times out
      }
    }

    // Fallback for pure SPA portals that navigate via menu/tab buttons instead of <a href>
    if (discoveredMenuButtons.length > 0 && Date.now() < crawlDeadline - 3_000) {
      for (const menuBtn of discoveredMenuButtons) {
        if (Date.now() >= crawlDeadline - 2_000) break;
        try {
          const clicked = await client.evaluate(buildClickMenuButtonExpression(menuBtn), {
            timeoutMs: 3_000,
            userGesture: true,
          });
          if (!clicked || !clicked.clicked) continue;
          await sleep(PORTAL_PAGE_SETTLE_MS);
          const snap = await client.evaluate(PORTAL_SNAPSHOT_EXPRESSION, { timeoutMs: 6_000 });
          if (!snap || snap.hasPasswordInput || snap.origin !== baseOrigin) continue;
          const wasNew = recordView(snap);
          if (wasNew && viewLooksCalendarLike(snap)) {
            await paginateCalendarView(baseOrigin, fingerprintSnapshot(snap));
          }
        } catch {
          // ignore SPA button navigation failure
        }
      }
    }

    // Step D: Universal deterministic 90-day agenda extractor & cleaned text bundle
    const extracted = extractPortalAgendaFromViews(capturedViews, horizonDays);

    return {
      ok: true,
      items: extracted.items,
      visitedPages,
      cleanedTextBundle: extracted.cleanedTextBundle,
      horizonDays,
    };
  } finally {
    if (client) {
      client.close();
    }
    session.extracting = false;
    // Step E: Clean shutdown (flushes cookies to ~/.openstudy/hermes/portal-browser-profile/)
    if (closeAfter) {
      await closeActivePortalSession({ sessionId: session.sessionId });
    }
  }
}

async function handleRequest(req, res) {
  if (!applyCorsHeaders(req, res)) {
    sendJson(res, 403, {
      ok: false,
      error: 'Origin not allowed. The OpenStudy bridge accepts only local and sanctioned OpenStudy origins.',
    });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    sendJson(res, 400, { ok: false, error: 'Malformed request URL.' });
    return;
  }

  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/health')) {
    const { tools, details } = detectAvailableTools();
    sendJson(res, 200, {
      online: true,
      ok: true,
      version: VERSION,
      host: HOST,
      port: PORT,
      tools,
      details,
      desktopHelperAvailable: process.platform === 'win32',
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/tools') {
    const { tools, details } = detectAvailableTools();
    sendJson(res, 200, {
      ok: true,
      tools,
      details,
    });
    return;
  }

  if (req.method === 'POST' && (pathname === '/api/agent' || pathname === '/api/agent/run')) {
    try {
      const body = await readJsonBody(req);
      const toolId = normalizeToolId(body.tool);
      if (!toolId) {
        sendJson(res, 400, {
          ok: false,
          error: 'Invalid "tool". Supported values: "antigravity", "claude", "codex", "hermes".',
        });
        return;
      }

      const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : '';
      const userPrompt =
        typeof body.userPrompt === 'string'
          ? body.userPrompt
          : typeof body.prompt === 'string'
            ? body.prompt
            : '';

      if (!userPrompt.trim()) {
        sendJson(res, 400, {
          ok: false,
          error: 'Field "userPrompt" must be a non-empty string.',
        });
        return;
      }

      const text = await runSanctionedCli(toolId, systemPrompt, userPrompt);
      sendJson(res, 200, {
        ok: true,
        tool: toolId,
        text,
        reply: text,
      });
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Local CLI request failed.',
      });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/obsidian/detect') {
    try {
      const result = await detectObsidianVaults();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not detect Obsidian vaults.',
      });
    }
    return;
  }

  if (
    (req.method === 'GET' || req.method === 'POST') &&
    (pathname === '/api/obsidian' || pathname === '/api/obsidian/notes')
  ) {
    try {
      let dir =
        parsedUrl.searchParams.get('vaultPath') ||
        parsedUrl.searchParams.get('dir') ||
        '';
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (typeof body.vaultPath === 'string' && body.vaultPath.trim()) {
          dir = body.vaultPath.trim();
        } else if (typeof body.dir === 'string' && body.dir.trim()) {
          dir = body.dir.trim();
        }
      }
      const result = await scanObsidianVault(dir);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not scan Obsidian directory.',
      });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/obsidian/overview') {
    try {
      const vaultPath =
        parsedUrl.searchParams.get('vaultPath') ||
        parsedUrl.searchParams.get('dir') ||
        '';
      const result = await getObsidianVaultOverview(vaultPath);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not load Obsidian vault overview.',
      });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/obsidian/search') {
    try {
      const vaultPath =
        parsedUrl.searchParams.get('vaultPath') ||
        parsedUrl.searchParams.get('dir') ||
        '';
      const q = parsedUrl.searchParams.get('q') || '';
      const folder = parsedUrl.searchParams.get('folder') || '';
      const limit = parsedUrl.searchParams.get('limit') || '12';
      const result = await searchObsidianVault(vaultPath, q, folder, limit);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not search Obsidian vault.',
      });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/obsidian/read') {
    try {
      const vaultPath =
        parsedUrl.searchParams.get('vaultPath') ||
        parsedUrl.searchParams.get('dir') ||
        '';
      const relPath =
        parsedUrl.searchParams.get('relPath') ||
        parsedUrl.searchParams.get('path') ||
        '';
      const result = await readObsidianNote(vaultPath, relPath);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not read Obsidian note.',
      });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/onenote/scan') {
    const result = await scanLocalOneNote();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/onenote/page') {
    const pageId = parsedUrl.searchParams.get('id') || '';
    const result = await readLocalOneNotePage(pageId);
    sendJson(res, result.status || 200, result.payload);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sync/status') {
    try {
      const config = await loadSyncConfig();
      sendJson(res, 200, {
        ok: true,
        config,
        running: Boolean(activeSyncPromise),
        nextRunAt: config.enabled ? autoSyncNextRunAt : null,
        portalProfileReady: isPortalProfileReady(),
        storage: '~/.openstudy/hermes/sync-config.json',
      });
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not load Hermes auto-sync status.',
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/sync/config') {
    try {
      const body = await readJsonBody(req);
      const current = await loadSyncConfig();

      const nextVaultCheck =
        body.vaultPath !== undefined
          ? sanitizeSyncVaultPath(body.vaultPath)
          : { ok: true, vaultPath: current.vaultPath };
      if (!nextVaultCheck.ok) {
        sendJson(res, 400, { ok: false, error: nextVaultCheck.error });
        return;
      }

      const nextPortalCheck =
        body.portalUrl !== undefined
          ? sanitizeSyncPortalUrl(body.portalUrl)
          : { ok: true, url: current.portalUrl };
      if (!nextPortalCheck.ok) {
        sendJson(res, 400, { ok: false, error: nextPortalCheck.error });
        return;
      }

      const nextConfig = {
        ...current,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
        intervalMinutes:
          body.intervalMinutes !== undefined
            ? clampSyncIntervalMinutes(body.intervalMinutes)
            : current.intervalMinutes,
        vaultPath: nextVaultCheck.vaultPath,
        portalUrl: nextPortalCheck.url,
        scanOneNote:
          typeof body.scanOneNote === 'boolean' ? body.scanOneNote : current.scanOneNote,
      };

      const saved = await saveSyncConfig(nextConfig);
      scheduleAutoSyncTimer(saved);

      sendJson(res, 200, {
        ok: true,
        config: saved,
        nextRunAt: saved.enabled ? autoSyncNextRunAt : null,
        storage: '~/.openstudy/hermes/sync-config.json',
      });
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not update Hermes auto-sync config.',
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/sync/run') {
    try {
      const body = await readJsonBody(req);
      const overrides = {};

      if (body.vaultPath !== undefined) {
        const checkedVault = sanitizeSyncVaultPath(body.vaultPath);
        if (!checkedVault.ok) {
          sendJson(res, 400, { ok: false, error: checkedVault.error });
          return;
        }
        overrides.vaultPath = checkedVault.vaultPath;
      }
      if (body.portalUrl !== undefined) {
        const checkedPortal = sanitizeSyncPortalUrl(body.portalUrl);
        if (!checkedPortal.ok) {
          sendJson(res, 400, { ok: false, error: checkedPortal.error });
          return;
        }
        overrides.portalUrl = checkedPortal.url;
      }
      if (typeof body.scanOneNote === 'boolean') {
        overrides.scanOneNote = body.scanOneNote;
      }
      if (typeof body.enabled === 'boolean') {
        overrides.enabled = body.enabled;
      }
      if (body.intervalMinutes !== undefined) {
        overrides.intervalMinutes = clampSyncIntervalMinutes(body.intervalMinutes);
      }

      const hasOverrides = Object.keys(overrides).length > 0;
      const result = await runAutoSyncPass(hasOverrides ? overrides : null, {
        allowAutoDetect: true,
      });
      if (hasOverrides && (overrides.enabled !== undefined || overrides.intervalMinutes !== undefined)) {
        scheduleAutoSyncTimer(result.config);
      }

      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Hermes auto-sync pass failed.',
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/portal/session/start') {
    try {
      const body = await readJsonBody(req);
      const result = await startPortalSession(body.portalUrl);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Portal-Fenster konnte nicht geöffnet werden.',
      });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/portal/session/status') {
    try {
      const sessionId = parsedUrl.searchParams.get('sessionId') || '';
      const result = await getPortalSessionStatus(sessionId);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        active: false,
        currentUrl: '',
        pageTitle: '',
        looksLikeLogin: false,
        error: err.message || 'Portal-Status konnte nicht abgefragt werden.',
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/portal/session/extract') {
    try {
      const body = await readJsonBody(req);
      const result = await extractPortalSessionAgenda(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Portal-Agenda konnte nicht ausgelesen werden.',
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/portal/session/close') {
    try {
      const body = await readJsonBody(req);
      const result = await closeActivePortalSession({
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
      });
      sendJson(res, 200, { ok: true, closed: Boolean(result.closed) });
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Portal-Fenster konnte nicht geschlossen werden.',
      });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/hermes/status') {
    try {
      const rawGatewayUrl = parsedUrl.searchParams.get('gatewayUrl') || DEFAULT_HERMES_GATEWAY_URL;
      const checked = validateLoopbackGatewayUrl(rawGatewayUrl);
      if (!checked.ok) {
        sendJson(res, 400, { ok: false, error: checked.error });
        return;
      }

      const cliAvailable = Boolean(findExecutableOnPath('hermes'));
      const [probe, skills, memoryData] = await Promise.all([
        probeHermesGateway(checked.url),
        loadHermesSkills(),
        loadHermesMemory(),
      ]);

      sendJson(res, 200, {
        ok: true,
        cliAvailable,
        gatewayOnline: probe.online,
        gatewayUrl: probe.gatewayUrl,
        models: probe.models,
        skillsDir: '~/.openstudy/hermes/skills',
        skillsCount: skills.length,
        memoryCount: memoryData.entries.length,
        desktopHelperAvailable: process.platform === 'win32',
      });
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not query Hermes status.',
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/hermes/chat') {
    try {
      const body = await readJsonBody(req, MAX_CHAT_BODY_BYTES);
      const result = await proxyHermesChat(body);
      sendJson(res, result.status, result.payload);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Hermes Gateway chat proxy failed.',
      });
    }
    return;
  }

  if (pathname === '/api/hermes/skills') {
    try {
      if (req.method === 'GET') {
        const skills = await loadHermesSkills();
        sendJson(res, 200, {
          ok: true,
          count: skills.length,
          skillsDir: '~/.openstudy/hermes/skills',
          skills,
        });
        return;
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (Array.isArray(body.skills)) {
          const savedList = [];
          for (const rawSkill of body.skills.slice(0, MAX_HERMES_SKILLS)) {
            savedList.push(await saveHermesSkill(rawSkill));
          }
          const allSkills = await loadHermesSkills();
          sendJson(res, 200, {
            ok: true,
            savedCount: savedList.length,
            count: allSkills.length,
            skillsDir: '~/.openstudy/hermes/skills',
            skills: allSkills,
          });
          return;
        }

        const candidate = body.skill && typeof body.skill === 'object' ? body.skill : body;
        const saved = await saveHermesSkill(candidate);
        const allSkills = await loadHermesSkills();
        sendJson(res, 200, {
          ok: true,
          skill: saved,
          count: allSkills.length,
          skillsDir: '~/.openstudy/hermes/skills',
          skills: allSkills,
        });
        return;
      }

      if (req.method === 'DELETE') {
        const name = parsedUrl.searchParams.get('name') || parsedUrl.searchParams.get('slug') || '';
        const deleted = await deleteHermesSkill(name);
        const allSkills = await loadHermesSkills();
        sendJson(res, 200, {
          ok: true,
          deleted,
          count: allSkills.length,
          skillsDir: '~/.openstudy/hermes/skills',
          skills: allSkills,
        });
        return;
      }
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not update Hermes skills.',
      });
      return;
    }
  }

  if (pathname === '/api/hermes/memory') {
    try {
      if (req.method === 'GET') {
        const memoryData = await loadHermesMemory();
        sendJson(res, 200, {
          ok: true,
          count: memoryData.entries.length,
          entries: memoryData.entries,
          memory: memoryData.entries,
          updatedAt: memoryData.updatedAt,
          storage: '~/.openstudy/hermes/memory.json',
        });
        return;
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        let nextEntries;

        if (Array.isArray(body.entries) || Array.isArray(body.memory)) {
          nextEntries = Array.isArray(body.entries) ? body.entries : body.memory;
        } else {
          const single = sanitizeMemoryEntry(
            body.entry && typeof body.entry === 'object' ? body.entry : body
          );
          if (!single) {
            sendJson(res, 400, {
              ok: false,
              error: 'Provide either an "entries" array or a non-empty "fact" entry.',
            });
            return;
          }
          const current = await loadHermesMemory();
          nextEntries = [single, ...current.entries];
        }

        const saved = await saveHermesMemory(nextEntries);
        sendJson(res, 200, {
          ok: true,
          count: saved.entries.length,
          entries: saved.entries,
          memory: saved.entries,
          updatedAt: saved.updatedAt,
          storage: '~/.openstudy/hermes/memory.json',
        });
        return;
      }

      if (req.method === 'DELETE') {
        const id = (parsedUrl.searchParams.get('id') || '').trim();
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'Query parameter "id" is required.' });
          return;
        }
        const current = await loadHermesMemory();
        const filtered = current.entries.filter((entry) => entry.id !== id);
        const saved = await saveHermesMemory(filtered);
        sendJson(res, 200, {
          ok: true,
          count: saved.entries.length,
          entries: saved.entries,
          memory: saved.entries,
          updatedAt: saved.updatedAt,
          storage: '~/.openstudy/hermes/memory.json',
        });
        return;
      }
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not update Hermes memory.',
      });
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/api/desktop/active-window') {
    const result = await getActiveDesktopWindow();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/desktop/screenshot') {
    try {
      const result = await captureDesktopScreenshot(parsedUrl.searchParams);
      sendJson(res, result.status || 200, result.payload);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Desktop-Screenshot konnte nicht erstellt werden.',
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/desktop/highlight') {
    try {
      const body = await readJsonBody(req);
      const result = showDesktopHighlight(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not render desktop teacher highlight.',
      });
    }
    return;
  }

  if (pathname === '/api/reminders') {
    try {
      if (req.method === 'GET') {
        const reminders = await loadReminders();
        sendJson(res, 200, {
          ok: true,
          reminders,
          nextReminder: computeNextReminderIso(reminders),
          storage: '~/.openstudy/reminders.json',
        });
        return;
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const current = await loadReminders();

        const next = {
          enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
          dailyTime: isValidTimeString(body.dailyTime) ? body.dailyTime.trim() : current.dailyTime,
          days: Array.isArray(body.days) ? body.days : current.days,
          items: Array.isArray(body.items) ? body.items : [...current.items],
        };

        if (typeof body.title === 'string' && body.title.trim()) {
          const itemTime = isValidTimeString(body.time) ? body.time.trim() : next.dailyTime;
          next.items.unshift({
            id: crypto.randomUUID(),
            title: body.title.trim().slice(0, 140),
            time: itemTime,
            courseId: typeof body.courseId === 'string' ? body.courseId.slice(0, 80) : undefined,
            enabled: body.itemEnabled !== false,
            createdAt: new Date().toISOString(),
          });
        }

        const saved = await saveReminders(next);
        sendJson(res, 200, {
          ok: true,
          reminders: saved,
          nextReminder: computeNextReminderIso(saved),
          storage: '~/.openstudy/reminders.json',
        });
        return;
      }

      if (req.method === 'DELETE') {
        const id = parsedUrl.searchParams.get('id') || '';
        const current = await loadReminders();
        const filtered = id
          ? current.items.filter((item) => item && item.id !== id)
          : current.items;
        const saved = await saveReminders({ ...current, items: filtered });
        sendJson(res, 200, {
          ok: true,
          reminders: saved,
          nextReminder: computeNextReminderIso(saved),
        });
        return;
      }
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        error: err.message || 'Could not update reminders.',
      });
      return;
    }
  }

  sendJson(res, 404, {
    ok: false,
    error: 'Endpoint not found.',
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: err?.message || 'Internal bridge error.' });
    }
  });
});

server.listen(PORT, HOST, () => {
  const { tools } = detectAvailableTools();
  const toolLabel = tools.length > 0 ? tools.join(', ') : 'none detected on PATH';
  console.log(`[OpenStudy Bridge v${VERSION}] Listening on http://${HOST}:${PORT}`);
  console.log(`[OpenStudy Bridge] Local CLIs detected: ${toolLabel}`);
  void initAutoSyncScheduler();
});

function shutdown() {
  stopAutoSyncTimer();
  cancelActiveHighlight();
  setTimeout(() => process.exit(0), 2500).unref();
  Promise.resolve()
    .then(() => closeActivePortalSession({ force: true, quick: true }))
    .catch(() => {})
    .finally(() => {
      server.close(() => {
        process.exit(0);
      });
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
