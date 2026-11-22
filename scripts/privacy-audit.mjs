#!/usr/bin/env node
/**
 * OpenStudy Automated Privacy & Secret Audit
 *
 * Scans the repository for accidentally committed secrets, personal email
 * addresses, local OS user paths, private folders, and optional custom
 * forbidden keywords supplied via `--forbid` or `PRIVACY_FORBID_WORDS`.
 *
 * Zero personal data is hardcoded in this script.
 *
 * Usage:
 *   node scripts/privacy-audit.mjs
 *   node scripts/privacy-audit.mjs --forbid "word1,word2"
 *   PRIVACY_FORBID_WORDS="word1,word2" npm run privacy-check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-ssr',
  '.cache',
  '.vite',
]);

const SKIP_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
]);

const FORBIDDEN_PATH_SEGMENTS = new Set([
  'private',
  'secrets',
  'credentials',
  'obsidian-vault',
  'vault',
]);

const FORBIDDEN_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.sqlite',
  '.sqlite3',
  '.db',
]);

const ALLOWED_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'localhost',
  'openstudy.local',
  'users.noreply.github.com',
]);

const ALLOWED_HOME_PLACEHOLDERS = new Set([
  'user',
  'username',
  'yourname',
  'your-name',
  'your_name',
  'example',
  'student',
  'learner',
  'runner',
  'public',
  'default',
  '<user>',
  '<username>',
]);

// Construct detection patterns cleanly so this script audits itself cleanly too.
const SECRET_RULES = [
  {
    id: 'google-api-key',
    label: 'Google / Gemini API key',
    regex: new RegExp('AI' + 'za[0-9A-Za-z_-]{20,}', 'g'),
  },
  {
    id: 'sk-secret-key',
    label: 'Secret API key (sk-...)',
    regex: new RegExp('\\b' + 'sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\\b', 'g'),
  },
  {
    id: 'github-token',
    label: 'GitHub personal/OAuth token',
    regex: new RegExp('\\b(?:' + 'ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\\b', 'g'),
  },
  {
    id: 'github-fine-grained-pat',
    label: 'GitHub fine-grained token',
    regex: new RegExp('\\b' + 'github_pat_[A-Za-z0-9_]{20,}\\b', 'g'),
  },
  {
    id: 'notion-token',
    label: 'Notion integration token',
    regex: new RegExp('\\b(?:' + 'ntn_[A-Za-z0-9]{12,}|secret_[A-Za-z0-9]{20,})\\b', 'g'),
  },
  {
    id: 'aws-access-key',
    label: 'AWS access key ID',
    regex: new RegExp('\\b' + 'AKIA[0-9A-Z]{16}\\b', 'g'),
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    regex: new RegExp('\\b' + 'xox[baprs]-[0-9A-Za-z-]{10,}\\b', 'g'),
  },
  {
    id: 'private-key-header',
    label: 'Private key PEM block',
    regex: new RegExp('-----BEGIN (?:RSA |EC |OPENSSH |DSA )?' + 'PRIVATE KEY-----', 'g'),
  },
];

const EMAIL_REGEX = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const WIN_USER_PATH_REGEX = new RegExp('[A-Za-z]:[\\\\/]+' + 'Users[\\\\/]+([^\\\\/\\s"\'`<>|]+)', 'gi');
const POSIX_HOME_PATH_REGEX = new RegExp('(?:^|[\\s"\'`(=:])\\/(?:' + 'Users|home)\\/([^/\\s"\'`<>|:]+)', 'g');

function parseForbidWords() {
  const words = new Set();

  const addFromRaw = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    for (const part of raw.split(/[,;\r\n]+/)) {
      const cleaned = part.trim();
      if (cleaned.length >= 2) {
        words.add(cleaned);
      }
    }
  };

  addFromRaw(process.env.PRIVACY_FORBID_WORDS || '');

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--forbid' && i + 1 < args.length) {
      addFromRaw(args[i + 1]);
      i += 1;
    } else if (arg.startsWith('--forbid=')) {
      addFromRaw(arg.slice('--forbid='.length));
    }
  }

  return Array.from(words);
}

function redactMatch(raw) {
  if (!raw || raw.length <= 8) return '[redacted]';
  return `${raw.slice(0, 4)}...${raw.slice(-2)} (${raw.length} chars)`;
}

function checkForbiddenPath(relPosix) {
  const findings = [];
  const lower = relPosix.toLowerCase();
  const baseName = path.posix.basename(lower);
  const segments = lower.split('/').filter(Boolean);

  if ((baseName === '.env' || baseName.startsWith('.env.')) && baseName !== '.env.example') {
    findings.push({
      file: relPosix,
      line: 0,
      rule: 'tracked-env-file',
      message: `Environment file "${baseName}" must never be stored in the public repository.`,
    });
  }

  if (lower.startsWith('data/private/') || segments.some((seg) => FORBIDDEN_PATH_SEGMENTS.has(seg))) {
    findings.push({
      file: relPosix,
      line: 0,
      rule: 'private-folder',
      message: 'Files inside private/secret/vault directories must never be tracked.',
    });
  }

  const ext = path.posix.extname(baseName);
  if (FORBIDDEN_EXTENSIONS.has(ext)) {
    findings.push({
      file: relPosix,
      line: 0,
      rule: 'sensitive-file-extension',
      message: `Sensitive file type "${ext}" must not be present in the repository.`,
    });
  }

  return findings;
}

function auditFileContent(relPosix, content, customForbidWords) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  const isLockFile = path.posix.basename(relPosix).toLowerCase() === 'package-lock.json';

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;

    // 1. Secret keys & tokens (always checked, including lockfiles)
    for (const rule of SECRET_RULES) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(line)) !== null) {
        findings.push({
          file: relPosix,
          line: lineNum,
          rule: rule.id,
          message: `Detected potential ${rule.label}: ${redactMatch(match[0])}`,
        });
      }
    }

    if (isLockFile) {
      continue;
    }

    // 2. Real email addresses (excluding generic placeholder domains)
    EMAIL_REGEX.lastIndex = 0;
    let emailMatch;
    while ((emailMatch = EMAIL_REGEX.exec(line)) !== null) {
      const domain = emailMatch[2].toLowerCase();
      if (!ALLOWED_EMAIL_DOMAINS.has(domain)) {
        findings.push({
          file: relPosix,
          line: lineNum,
          rule: 'personal-email',
          message: `Non-placeholder email domain detected (@${domain}). Use @example.com for placeholders.`,
        });
      }
    }

    // 3. Hardcoded Windows local user directory paths
    WIN_USER_PATH_REGEX.lastIndex = 0;
    let winMatch;
    while ((winMatch = WIN_USER_PATH_REGEX.exec(line)) !== null) {
      const userSeg = winMatch[1].toLowerCase();
      if (!ALLOWED_HOME_PLACEHOLDERS.has(userSeg)) {
        findings.push({
          file: relPosix,
          line: lineNum,
          rule: 'local-windows-user-path',
          message: 'Hardcoded Windows local user directory path detected. Use environment variables instead.',
        });
      }
    }

    // 4. Hardcoded macOS / Linux local user home paths
    POSIX_HOME_PATH_REGEX.lastIndex = 0;
    let posixMatch;
    while ((posixMatch = POSIX_HOME_PATH_REGEX.exec(line)) !== null) {
      const userSeg = posixMatch[1].toLowerCase();
      if (!ALLOWED_HOME_PLACEHOLDERS.has(userSeg)) {
        findings.push({
          file: relPosix,
          line: lineNum,
          rule: 'local-posix-user-path',
          message: 'Hardcoded local home directory path detected. Use $HOME or os.homedir() instead.',
        });
      }
    }

    // 5. Caller-supplied custom forbidden terms (--forbid / PRIVACY_FORBID_WORDS)
    if (customForbidWords.length > 0) {
      const lowerLine = line.toLowerCase();
      for (const word of customForbidWords) {
        if (lowerLine.includes(word.toLowerCase())) {
          findings.push({
            file: relPosix,
            line: lineNum,
            rule: 'custom-forbidden-term',
            message: `Matched caller-supplied forbidden term (${redactMatch(word)}).`,
          });
        }
      }
    }
  }

  return findings;
}

function runAudit() {
  const startedAt = Date.now();
  const customForbidWords = parseForbidWords();
  const allFindings = [];
  let scannedFiles = 0;

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(REPO_ROOT, fullPath);
      const relPosix = relPath.split(path.sep).join('/');

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        if (FORBIDDEN_PATH_SEGMENTS.has(entry.name.toLowerCase())) {
          allFindings.push({
            file: relPosix,
            line: 0,
            rule: 'private-folder',
            message: `Forbidden directory "${relPosix}" exists inside repository.`,
          });
          continue;
        }
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const pathFindings = checkForbiddenPath(relPosix);
      allFindings.push(...pathFindings);

      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXTENSIONS.has(ext)) {
        continue;
      }

      let buffer;
      try {
        buffer = fs.readFileSync(fullPath);
      } catch (err) {
        allFindings.push({
          file: relPosix,
          line: 0,
          rule: 'unreadable-file',
          message: `Could not read file: ${err.message}`,
        });
        continue;
      }

      // Skip binary blobs that contain NUL bytes
      if (buffer.includes(0)) {
        continue;
      }

      scannedFiles += 1;
      const content = buffer.toString('utf8');
      const contentFindings = auditFileContent(relPosix, content, customForbidWords);
      allFindings.push(...contentFindings);
    }
  }

  walk(REPO_ROOT);

  const elapsedMs = Date.now() - startedAt;

  if (allFindings.length > 0) {
    console.error(
      `\nFAIL: Privacy audit found ${allFindings.length} issue(s) across ${scannedFiles} scanned files (${elapsedMs} ms):\n`
    );
    for (const finding of allFindings) {
      const loc = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`  - ${loc} [${finding.rule}] ${finding.message}`);
    }
    console.error('\nFix every finding before committing or pushing to a public repository.\n');
    process.exit(1);
  }

  const extraNote =
    customForbidWords.length > 0
      ? ` + ${customForbidWords.length} custom forbidden term(s)`
      : '';
  console.log(
    `PASS: Privacy audit completed cleanly (${scannedFiles} files scanned${extraNote}, 0 findings, ${elapsedMs} ms).`
  );
  process.exit(0);
}

runAudit();
