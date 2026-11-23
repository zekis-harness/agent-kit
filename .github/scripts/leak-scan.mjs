#!/usr/bin/env node
// Leak scan: fails when tracked files or commit metadata contain anything on the private denylist,
// when a commit author or committer email is not a GitHub noreply address, or when a file type
// is not on the allowlist. Findings print the file, line and denylist entry number only, never
// the matched text, because CI logs of a public repo are public.
//
// Usage: node leak-scan.mjs [--repo <dir>] [--denylist <file>] [--range <base>..<head>] [--require-denylist]
// The denylist comes from --denylist, else $LEAK_DENYLIST_FILE, else the $LEAK_DENYLIST text.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const repo = opt('--repo') ?? process.cwd();
const range = opt('--range');
const requireDenylist = args.includes('--require-denylist');

const ALLOWED_EXT = new Set(['.md', '.json', '.jsonl', '.mjs', '.js', '.ts', '.tsx', '.css', '.html', '.ps1', '.psm1', '.sh', '.py', '.yml', '.yaml', '.toml', '.txt', '.lock']);
const ALLOWED_NAMES = new Set(['LICENSE', '.gitignore', '.gitattributes', 'pre-push', 'pre-commit', 'CODEOWNERS']);
// The org name (and its env-var form) is public by choice; strip it before matching so it does not trip the name entries.
const ALLOW = new RegExp('zekis-harness'.replace('-', '[-_]'), 'gi');
const clean = (s) => s.replace(ALLOW, '');
const NOREPLY = /(^|\+)[^@\s]+@users\.noreply\.github\.com$|^noreply@github\.com$/i;

function loadDenylist() {
  const file = opt('--denylist') ?? process.env.LEAK_DENYLIST_FILE;
  let text = '';
  if (file && existsSync(file)) text = readFileSync(file, 'utf8');
  else if (process.env.LEAK_DENYLIST) text = process.env.LEAK_DENYLIST;
  const entries = [];
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('re:')) entries.push(new RegExp(line.slice(3)));
    else entries.push(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  });
  return entries;
}

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const deny = loadDenylist();
const problems = [];

if (deny.length === 0) {
  if (requireDenylist) problems.push('denylist is empty or missing (set LEAK_DENYLIST)');
  else console.log('leak-scan: no denylist configured; checking file types and commit emails only');
}

const files = git('ls-files', '-z').split('\0').filter(Boolean);
for (const f of files) {
  const name = basename(f);
  if (!ALLOWED_EXT.has(extname(f).toLowerCase()) && !ALLOWED_NAMES.has(name)) problems.push(`${f}: file type not allowed`);
  deny.forEach((re, i) => { if (re.test(clean(f))) problems.push(`${f}: path matches denylist entry #${i + 1}`); });
  const full = join(repo, f);
  if (!existsSync(full)) continue;
  const buf = readFileSync(full);
  if (buf.includes(0)) { problems.push(`${f}: binary content`); continue; }
  buf.toString('utf8').split(/\r?\n/).forEach((line, n) => {
    deny.forEach((re, i) => { if (re.test(clean(line))) problems.push(`${f}:${n + 1}: matches denylist entry #${i + 1}`); });
  });
}

if (range) {
  // Author and committer names are the public GitHub login, so only emails and the message are checked.
  const log = git('log', '--format=%H%x00%ae%x00%ce%x00%B%x1e', range);
  for (const rec of log.split('\x1e').map((s) => s.trim()).filter(Boolean)) {
    const [sha, ae, ce, body = ''] = rec.split('\0');
    const short = sha.slice(0, 10);
    if (!NOREPLY.test(ae)) problems.push(`commit ${short}: author email is not a GitHub noreply address`);
    if (!NOREPLY.test(ce)) problems.push(`commit ${short}: committer email is not a GitHub noreply address`);
    deny.forEach((re, i) => { if (re.test(clean(body))) problems.push(`commit ${short}: message matches denylist entry #${i + 1}`); });
  }
}

if (problems.length) {
  console.error(`leak-scan: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`leak-scan: clean (${files.length} files${range ? `, range ${range}` : ''}, ${deny.length} denylist entries)`);
