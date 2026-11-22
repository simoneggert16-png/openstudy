#!/usr/bin/env node
/**
 * OpenStudy Local Companion Bridge
 *
 * Security & privacy guarantees:
 * - Listens strictly on 127.0.0.1 (loopback only, never 0.0.0.0).
 * - CORS restricted exclusively to localhost / 127.0.0.1 origins.
 * - Zero external dependencies (Node.js v20+ built-ins only).
 * - Never reads credential files or writes inside the OpenStudy git repository.
 * - Invokes only sanctioned local CLIs with strict argument arrays (no shell interpolation).
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const VERSION = '1.0.0';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;
const AGENT_TIMEOUT_MS = 45_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_OBSIDIAN_FILES = 250;
const MAX_NOTE_BYTES = 256 * 1024;
const MAX_NOTE_CONTENT_CHARS = 12_000;
const MAX_EXCERPT_CHARS = 220;

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
  ollama: {
    id: 'ollama',
    binaries: ['ollama'],
    agentSupported: false,
  },
};

const SENSITIVE_NAME_PATTERN =
  /(^|[._\-\s])(env|passwords?|passwd|passwort|passwörter|passwoerter|secrets?|credits?|kreditkarten?|cardnumber|apikeys?|api_keys?|keys?|tokens?|credentials?|private|id_rsa|id_ed25519|seedphrase|recovery|banking|steuer|passport|ausweis)([._\-\s]|$)|^\.env/i;

const IGNORED_DIRS = new Set([
  '.obsidian',
  '.git',
  '.trash',
  '.stfolder',
  'node_modules',
  '.venv',
  'venv',
]);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body exceeds 256 KB limit.'), { status: 413 }));
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

async function scanObsidianVault(rawDir) {
  if (typeof rawDir !== 'string' || !rawDir.trim()) {
    throw Object.assign(new Error('Query parameter "dir" is required.'), { status: 400 });
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

async function handleRequest(req, res) {
  if (!applyCorsHeaders(req, res)) {
    sendJson(res, 403, {
      ok: false,
      error: 'Origin not allowed. The OpenStudy bridge accepts localhost origins only.',
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

  if (req.method === 'GET' && pathname === '/api/health') {
    const { tools, details } = detectAvailableTools();
    sendJson(res, 200, {
      online: true,
      ok: true,
      version: VERSION,
      host: HOST,
      port: PORT,
      tools,
      details,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/agent') {
    try {
      const body = await readJsonBody(req);
      const toolId = normalizeToolId(body.tool);
      if (!toolId) {
        sendJson(res, 400, {
          ok: false,
          error: 'Invalid "tool". Supported values: "antigravity", "claude", "codex".',
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

  if (req.method === 'GET' && pathname === '/api/obsidian') {
    try {
      const dir = parsedUrl.searchParams.get('dir') || '';
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
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
