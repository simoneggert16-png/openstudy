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
const MAX_NOTE_BYTES = 256 * 1024;
const MAX_NOTE_CONTENT_CHARS = 12_000;
const MAX_EXCERPT_CHARS = 220;

const ONENOTE_TIMEOUT_MS = 6_000;
const MAX_ONENOTE_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_ONENOTE_RECENT_PAGES = 120;
const MAX_ONENOTE_PAGE_CHARS = 16_000;

const SYNC_MIN_INTERVAL_MINUTES = 15;
const SYNC_MAX_INTERVAL_MINUTES = 1_440;
const SYNC_DEFAULT_INTERVAL_MINUTES = 60;
const SYNC_SAMPLE_OBSIDIAN_LIMIT = 60;
const SYNC_UPCOMING_DAYS = 30;

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
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Ungültige "portalUrl". Erwartet wird eine http:// oder https:// Adresse.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Für "portalUrl" sind nur http:// und https:// erlaubt.' };
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
    summary: {
      obsidianNotesCount,
      oneNotePagesCount,
      upcoming30Days,
      recentOneNotePages,
      sampleObsidianNotes,
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
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
