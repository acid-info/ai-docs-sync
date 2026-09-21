// Pure functions only: config, globs, packing, gates, parsers. No process.env, no network, no
// side effects at import time, so test/ can import this without running the tool. Anything that
// needs git, the filesystem or fetch takes it as an argument.

import { existsSync, lstatSync } from 'node:fs';
import { posix as path } from 'node:path';

export const VERSION = '0.1.0';

// ------------------------------------------------------------------ constants ---

export const API = {
  github: {
    baseUrl: 'https://api.github.com',
    version: '2026-03-10',
    accept: 'application/vnd.github+json',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    version: '2023-06-01',
    messagesPath: '/v1/messages',
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    responsesPath: '/v1/responses',
  },
};

// Models, effort and budgets are owned here. Change a model in DEFAULTS, then update PRICES and
// check EFFORT_MODELS still matches it: all three or the cost line and effort silently drift.
export const DEFAULTS = {
  anthropic_triage_model: 'claude-sonnet-5',
  anthropic_writer_model: 'claude-opus-5',
  anthropic_checker_model: 'claude-sonnet-5',
  openai_triage_model: 'gpt-5.6-terra',
  openai_writer_model: 'gpt-5.6-terra',
  openai_checker_model: 'gpt-5.4-2026-03-05',
  triage_effort: 'low',
  writer_effort: 'medium',
  checker_effort: 'medium',
  max_diff_tokens: 60_000,
  max_doc_tokens: 16_000,
  writer_max_tokens: 32_000,
  response_max_tokens: 16_000,
  writer_concurrency: 3,
  max_commits: 250,
  max_pr_lookups: 50,
  // Repo-overridable, see REPO_OVERRIDABLE.
  doc_paths: [],
  never_touch: [],
  extra_ignore: [],
  guidelines_files: ['AGENTS.md', 'CLAUDE.md'],
  branch: 'docs/repo/sync',
  narrative_max_tokens: 6000,
  label: 'docs-sync',
  max_docs_per_run: 8,
  format_check: 'off',
  setup_command: '',
};

export const REPO_OVERRIDABLE = new Set([
  'doc_paths',
  'never_touch',
  'extra_ignore',
  'guidelines_files',
  'branch',
  'narrative_max_tokens',
  'label',
  'max_docs_per_run',
  'format_check',
  'setup_command',
]);

export const BUILT_IN_IGNORE = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/poetry.lock',
  '**/Cargo.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.map',
  '**/dist/**',
  '**/vendor/**',
  '**/__snapshots__/**',
  '**/*.generated.*',
];

// Never writable, whatever doc_paths says.
export const DENYLIST = ['.github/**', '.git/**', '**/node_modules/**'];

// $/MTok. Cache reads are billed at a tenth of input, cache writes at 1.25x.
export const PRICES = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'gpt-5.6-terra': { in: 2.5, out: 15 },
  'gpt-5.4-2026-03-05': { in: 2.5, out: 15 },
};

// `output_config.effort` is rejected by Haiku 4.5, Sonnet 4.5 and older.
export const EFFORT_MODELS = /^claude-(fable-5|mythos-5|opus-(5|4-[5-8])|sonnet-(5|4-6))\b/;

export const BOT_NAME = 'github-actions[bot]';
export const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

// With DOCS_SYNC_TOKEN the committer is the PAT's bot account, whose address is not known here;
// any GitHub bot-account address counts as ours.
export const isBotEmail = (email) =>
  email === BOT_EMAIL || /\[bot\]@users\.noreply\.github\.com$/i.test(email ?? '');

export const approxTokens = (s) => Math.ceil((s ?? '').length / 4);

// -------------------------------------------------------------------- config ---

// Minimal YAML subset: `key: value`, `key:` followed by `- item` lines, `#` comments. Enough for
// the documented config and nothing more, so the tool stays dependency-free.
export function parseYamlSubset(text) {
  const out = {};
  let currentList = null;
  const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem) {
      if (currentList) out[currentList].push(unquote(listItem[1]));
      continue;
    }
    const kv = line.match(/^([\w_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val === '') {
      out[key] = [];
      currentList = key;
    } else {
      const scalar = unquote(val);
      out[key] = /^\d+$/.test(scalar) ? Number(scalar) : scalar;
      currentList = null;
    }
  }
  return out;
}

export function loadConfig(text, { warn = () => {} } = {}) {
  const cfg = { ...DEFAULTS };
  const parsed = parseYamlSubset(text ?? '');
  for (const [key, val] of Object.entries(parsed)) {
    if (!REPO_OVERRIDABLE.has(key)) {
      warn(
        `.github/docs-sync.yml: "${key}" is owned centrally by acid-info/ai-docs-sync and was ignored. ` +
          `Settable per repo: ${[...REPO_OVERRIDABLE].join(', ')}.`
      );
      continue;
    }
    cfg[key] = val;
  }
  for (const k of ['doc_paths', 'never_touch', 'extra_ignore', 'guidelines_files']) {
    if (!Array.isArray(cfg[k])) cfg[k] = cfg[k] === '' || cfg[k] == null ? [] : [String(cfg[k])];
  }
  if (!cfg.doc_paths.length) throw new Error('.github/docs-sync.yml: doc_paths is required and must list at least one glob');
  if (!['off', 'strict'].includes(cfg.format_check))
    throw new Error(`.github/docs-sync.yml: format_check must be "off" or "strict", got "${cfg.format_check}"`);
  if (cfg.format_check === 'strict' && !cfg.setup_command)
    throw new Error('.github/docs-sync.yml: format_check: strict needs setup_command');
  if (!Number.isInteger(cfg.max_docs_per_run) || cfg.max_docs_per_run < 1)
    throw new Error('.github/docs-sync.yml: max_docs_per_run must be a positive integer');
  if (!Number.isInteger(cfg.narrative_max_tokens) || cfg.narrative_max_tokens < 1)
    throw new Error('.github/docs-sync.yml: narrative_max_tokens must be a positive integer');
  cfg.branch = String(cfg.branch);
  cfg.setup_command = String(cfg.setup_command ?? '');
  cfg.ignore = [...BUILT_IN_IGNORE, ...cfg.extra_ignore];
  return cfg;
}

// --------------------------------------------------------------------- paths ---

export function globToRegex(glob) {
  // placeholders keep the single-star pass from mangling the double-star expansions
  return new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '(?:.*/)?')
        .replace(/\u0001/g, '.*') +
      '$'
  );
}

export const makeMatcher = (globs) => {
  const res = globs.map(globToRegex);
  return (p) => res.some((re) => re.test(p));
};

// Returns the canonical relative path or null. Rejects rather than normalises `.` and `..`: a
// model that emits either is not naming a file it read from the manifest.
export function canonicalise(p) {
  if (typeof p !== 'string' || !p) return null;
  if (p.includes('\0') || p.includes('\\')) return null;
  if (p.startsWith('/')) return null;
  const segs = p.split('/').filter((s) => s !== '');
  if (!segs.length) return null;
  if (segs.some((s) => s === '.' || s === '..')) return null;
  if (p.endsWith('/')) return null;
  return segs.join('/');
}

export function makeIsEditableDocPath(cfg) {
  const inDocs = makeMatcher(cfg.doc_paths);
  const inNever = makeMatcher(cfg.never_touch);
  const denied = makeMatcher(DENYLIST);
  return (p) => {
    const c = canonicalise(p);
    if (!c || !c.endsWith('.md')) return false;
    return inDocs(c) && !inNever(c) && !denied(c);
  };
}

// True when the file or any directory on the way to it is a symlink. Missing components end the
// walk: a file to be created is fine as long as its existing parents are real directories.
export function hasSymlinkComponent(root, canonical) {
  const segs = canonical.split('/');
  for (let i = 1; i <= segs.length; i++) {
    const st = lstatSync(path.join(root, ...segs.slice(0, i)), { throwIfNoEntry: false });
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

export function makeIsEditableDoc(cfg, root) {
  const pure = makeIsEditableDocPath(cfg);
  return (p) => pure(p) && !hasSymlinkComponent(root, canonicalise(p));
}

export const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

export function validateRollingBranch(branch, { targetBranch, defaultBranch }) {
  if (!BRANCH_NAME_RE.test(branch) || branch.startsWith('-') || branch.includes('..'))
    throw new Error(`Refusing rolling branch name "${branch}": only [A-Za-z0-9._/-] is allowed`);
  if (branch === targetBranch) throw new Error(`Refusing rolling branch "${branch}": it is the target branch`);
  if (defaultBranch && branch === defaultBranch)
    throw new Error(`Refusing rolling branch "${branch}": it is the default branch`);
}

// ---------------------------------------------------------------------- range ---

// `isAncestor(sha)` must also be false when the object is not present locally.
export function selectRange({ since, cursor, pushBefore, pushForced }, isAncestor) {
  if (since) {
    if (!isAncestor(since)) throw new Error(`since=${since} is not an ancestor of the target branch head`);
    return { from: since, source: 'since' };
  }
  if (cursor && isAncestor(cursor)) return { from: cursor, source: 'cursor' };
  const forced = /^(1|true)$/i.test(String(pushForced ?? ''));
  if (pushBefore && !/^0+$/.test(pushBefore) && !forced && isAncestor(pushBefore))
    return { from: pushBefore, source: 'push_before' };
  return { from: 'HEAD~1', source: 'head~1' };
}

// ------------------------------------------------------------------ narrative ---

// Committer email identifies the tool's own commits; author email survives a rebase merge and
// is what PR commits are matched on.
export const GIT_LOG_FORMAT = '%H%x00%h%x00%an%x00%ae%x00%ce%x00%P%x00%s%x00%b%x01';

export function parseGitLog(raw) {
  return raw
    .split('\x01')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [sha, short, author, authorEmail, email, parents, subject, body = ''] = rec.split('\x00');
      return {
        sha,
        short,
        author,
        authorEmail,
        email,
        parents: parents ? parents.split(' ') : [],
        subject: subject ?? '',
        body: body.trim(),
      };
    });
}

export function prNumberFromSubject(subject) {
  const merge = subject.match(/^Merge pull request #(\d+)\b/);
  if (merge) return Number(merge[1]);
  const squash = subject.match(/\(#(\d+)\)\s*$/);
  return squash ? Number(squash[1]) : null;
}

export function cleanPrBody(body) {
  return (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^\s*[-*]\s+\[[ xX]\]/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const normalisePr = (pr) => ({
  number: pr.number,
  title: pr.title ?? '',
  body: cleanPrBody(pr.body),
  labels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
  head: pr.head?.ref ?? '',
  base: pr.base?.ref ?? '',
  user: pr.user?.login ?? '',
});

// Links commits to PRs: subjects first (free), then `commits/{sha}/pulls` for the rest, marking
// every commit of a found PR as linked so one PR costs one lookup. `api` is injected:
// { pr(n), pullsForCommit(sha), prCommits(n) }; prCommits returns { sha, subject, email } per
// commit. A rebase merge rewrites SHAs, so a PR commit also matches by subject + author email.
export async function collectPrs(commits, api, { targetBranch, rollingBranch, maxLookups = DEFAULTS.max_pr_lookups }) {
  const linked = new Map(); // sha -> pr number
  const prs = new Map(); // number -> normalised pr
  const candidates = commits.filter((c) => !isBotEmail(c.email));
  const wanted = new Set();
  for (const c of candidates) {
    const n = prNumberFromSubject(c.subject);
    if (n) {
      linked.set(c.sha, n);
      wanted.add(n);
    }
  }
  for (const n of wanted) {
    try {
      const pr = await api.pr(n);
      if (pr) prs.set(n, normalisePr(pr));
    } catch (e) {
      // A subject can cite a PR from another repo or a deleted one; that is not fatal.
      prs.set(n, null);
      void e;
    }
  }
  let lookups = 0;
  let lookupsExhausted = false;
  for (const c of candidates) {
    if (linked.has(c.sha) || c.parents.length > 1) continue;
    if (lookups >= maxLookups) {
      lookupsExhausted = true;
      break;
    }
    lookups++;
    let found = [];
    try {
      found = (await api.pullsForCommit(c.sha)) ?? [];
    } catch {
      continue;
    }
    const pr = found.find((p) => p.base?.ref === targetBranch) ?? found[0];
    if (!pr) continue;
    linked.set(c.sha, pr.number);
    if (!prs.has(pr.number)) prs.set(pr.number, normalisePr(pr));
    try {
      const prCommits = (await api.prCommits(pr.number)) ?? [];
      const bySha = new Set(prCommits.map((x) => (typeof x === 'string' ? x : x.sha)));
      const byIdentity = new Set(prCommits.filter((x) => typeof x !== 'string').map((x) => `${x.email}\n${x.subject}`));
      for (const other of candidates) {
        if (linked.has(other.sha)) continue;
        if (bySha.has(other.sha) || byIdentity.has(`${other.authorEmail}\n${other.subject}`)) linked.set(other.sha, pr.number);
      }
    } catch {
      // Without the commit list the other commits of this PR cost one lookup each; acceptable.
    }
  }
  // Only PRs into the target branch, and never the rolling PR: its body is the tool's own text.
  for (const [n, pr] of prs) {
    if (!pr || pr.base !== targetBranch || pr.head === rollingBranch) prs.delete(n);
  }
  return { linked, prs, lookups, lookupsExhausted };
}

// Packs the narrative into `budget` tokens: subjects and headers always fit; commit bodies are
// truncated before PR bodies, longest first, with a marker.
export function buildNarrative({ commits, linked, prs, targetBranch, from, to, budget = DEFAULTS.narrative_max_tokens, capped = false }) {
  const short = (s) => (s ?? '').slice(0, 7);
  const kept = commits.filter((c) => !isBotEmail(c.email));
  const groups = new Map(); // pr number -> commits
  const loose = [];
  for (const c of kept) {
    const n = linked.get(c.sha);
    const isMerge = c.parents.length > 1;
    if (n && prs.has(n)) {
      if (!groups.has(n)) groups.set(n, []);
      if (!isMerge) groups.get(n).push(c);
    } else if (!isMerge) {
      loose.push(c);
    }
    // A merge commit contributes only its PR number; one for a filtered PR contributes nothing.
  }
  const bodies = []; // { kind: 'pr'|'commit', text }
  const body = (kind, text) => {
    const b = { kind, text: text ?? '' };
    bodies.push(b);
    return b;
  };
  const sections = [];
  for (const [n, list] of groups) {
    const pr = prs.get(n);
    const meta = [pr.user, pr.head ? `head ${pr.head}` : ''].filter(Boolean).join(', ');
    const lines = [`### PR #${n} "${pr.title}"${meta ? ` (${meta})` : ''}`];
    if (pr.labels.length) lines.push(`labels: ${pr.labels.join(', ')}`);
    const prBody = body('pr', pr.body);
    const commitLines = list.map((c) => ({ head: `- ${c.short || short(c.sha)} ${c.subject}`, body: body('commit', c.body) }));
    sections.push({ lines, prBody, commitLines });
  }
  if (loose.length) {
    sections.push({
      lines: ['### Commits not from a PR'],
      prBody: null,
      commitLines: loose.map((c) => ({ head: `- ${c.short || short(c.sha)} ${c.subject}`, body: body('commit', c.body) })),
    });
  }
  const title = `## Change narrative (${targetBranch}, ${short(from)}..${short(to)})`;
  const notes = [];
  if (capped) notes.push(`Range capped at the newest ${DEFAULTS.max_commits} commits.`);

  const render = () => {
    const out = [title];
    if (notes.length) out.push('', ...notes);
    for (const s of sections) {
      out.push('', ...s.lines);
      if (s.prBody?.text) out.push(s.prBody.text);
      for (const c of s.commitLines) {
        out.push(c.head);
        if (c.body.text) out.push(c.body.text.replace(/^/gm, '  '));
      }
    }
    return out.join('\n');
  };

  const MARK = ' [truncated]';
  for (let guard = 0; guard < 10_000; guard++) {
    const text = render();
    const over = approxTokens(text) - budget;
    if (over <= 0) return text;
    const pick = (kind) => bodies.filter((b) => b.kind === kind && b.text).sort((a, b) => b.text.length - a.text.length)[0];
    const target = pick('commit') ?? pick('pr');
    if (!target) return text;
    const bare = target.text.endsWith(MARK) ? target.text.slice(0, -MARK.length) : target.text;
    const keep = Math.max(0, bare.length - over * 4 - MARK.length);
    target.text = keep > 0 ? bare.slice(0, keep).trimEnd() + MARK : '';
  }
  return render();
}

// -------------------------------------------------------------- changed files ---

// Parses `git diff --name-status -z -M`: R/C records carry two paths, everything else one.
export function parseNameStatus(zOutput) {
  const parts = zOutput.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (newPath === undefined) break;
      out.push({ status: status[0], path: newPath, oldPath });
    } else {
      const p = parts[i++];
      if (p === undefined) break;
      out.push({ status: status[0], path: p });
    }
  }
  return out;
}

// The loop guard and the "no code files" exit. `isEditableDoc` should be the full predicate.
export function classifyChanges(changes, { isEditableDoc, isIgnored }) {
  const docs = [];
  const code = [];
  const ignored = [];
  for (const c of changes) {
    if (isEditableDoc(c.path)) docs.push(c);
    else if (isIgnored(c.path)) ignored.push(c);
    else code.push(c);
  }
  let skipReason = null;
  if (!changes.length) skipReason = 'no files changed in range';
  else if (docs.length === changes.length) skipReason = 'every changed file is an editable doc (loop guard)';
  else if (!code.length) skipReason = 'no code files changed after ignores';
  return { docs, code, ignored, skipReason };
}

// ---------------------------------------------------------------------- diff ---

// Splits one `git diff` output into per-file patches keyed by the new path.
export function splitUnifiedDiff(raw) {
  const out = [];
  const chunks = raw.split(/^(?=diff --git )/m).filter((c) => c.trim());
  for (const chunk of chunks) {
    const header = chunk.match(/^diff --git a\/(.*?) b\/(.*)$/m);
    if (!header) continue;
    let status = 'M';
    if (/^new file mode/m.test(chunk)) status = 'A';
    else if (/^deleted file mode/m.test(chunk)) status = 'D';
    else if (/^rename from /m.test(chunk)) status = 'R';
    out.push({ path: header[2], oldPath: header[1], status, patch: chunk.trimEnd() });
  }
  return out;
}

export function packDiff(patches, budget = DEFAULTS.max_diff_tokens) {
  const sorted = [...patches].sort((x, y) => x.patch.length - y.patch.length || x.path.localeCompare(y.path));
  const chunks = [];
  const included = [];
  const omitted = [];
  let left = budget;
  for (const f of sorted) {
    const label = f.status === 'R' && f.oldPath ? `${f.oldPath} -> ${f.path} (rename)` : `${f.path} (${f.status})`;
    const chunk = `--- FILE: ${label} ---\n${f.patch}\n`;
    const cost = approxTokens(chunk);
    if (cost > left) {
      omitted.push(f.path);
      continue;
    }
    left -= cost;
    chunks.push(chunk);
    included.push(f.path);
  }
  let diff = chunks.join('\n');
  if (omitted.length) diff += `\n--- NOT INCLUDED (over budget): ${omitted.join(', ')} ---\n`;
  return { diff, included, omitted };
}

// ------------------------------------------------------------------- manifest ---

const LINK_RE = /!?\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;

// Relative link targets in a Markdown file, without fragment or query.
export function extractRelativeLinks(md) {
  const out = [];
  for (const m of md.matchAll(LINK_RE)) {
    const target = m[1] ?? m[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
    const clean = target.split('#')[0].split('?')[0];
    if (clean) out.push(clean);
  }
  return out;
}

export function firstHeading(md) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : '';
}

export function buildManifest(files) {
  return files
    .map(({ path: p, content }) => {
      const dir = path.dirname(p);
      const dirs = new Set();
      for (const l of extractRelativeLinks(content)) {
        const resolved = path.normalize(path.join(dir === '.' ? '' : dir, l));
        if (resolved.startsWith('..')) continue;
        const d = path.dirname(resolved);
        dirs.add(d === '.' ? '/' : d + '/');
      }
      return { path: p, heading: firstHeading(content), bytes: Buffer.byteLength(content), linkDirs: [...dirs].sort() };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function renderManifest(manifest) {
  if (!manifest.length) return '(no editable docs found)';
  return manifest
    .map((m) => `- ${m.path} (${m.bytes} bytes)${m.heading ? ` "${m.heading}"` : ''}${m.linkDirs.length ? ` links: ${m.linkDirs.join(' ')}` : ''}`)
    .join('\n');
}

// -------------------------------------------------------------- carry forward ---

export function allOwnCommits(commits) {
  return commits.every((c) => isBotEmail(c.email));
}

// Read side of 5.12 step 1: which unmerged rolling-branch edits to restore on top of the target.
export function planCarryForward({ branchFiles, targetChangedSinceBase, isEditableDoc }) {
  const restore = [];
  const stale = [];
  const ignored = [];
  for (const f of branchFiles) {
    if (!isEditableDoc(f)) ignored.push(f);
    else if (targetChangedSinceBase(f)) stale.push(f);
    else restore.push(f);
  }
  return { restore, stale, ignored };
}

// ---------------------------------------------------------------- guidelines ---

export function collectAgentsFiles(root, changedFiles) {
  const found = new Set();
  if (existsSync(path.join(root, 'AGENTS.md'))) found.add('AGENTS.md');
  for (const file of changedFiles) {
    const c = canonicalise(file);
    if (!c) continue;
    const segs = c.split('/');
    for (let i = 1; i < segs.length; i++) {
      const candidate = `${segs.slice(0, i).join('/')}/AGENTS.md`;
      if (existsSync(path.join(root, candidate))) found.add(candidate);
    }
  }
  return [...found].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

// Reads from the target-branch checkout, never from a carried-forward draft.
export function loadGuidelines(cfg, root, changedFiles, readFile, { log = () => {}, warn = () => {} } = {}) {
  for (const name of cfg.guidelines_files) {
    if (name === 'AGENTS.md') {
      const files = collectAgentsFiles(root, changedFiles);
      if (files.length) {
        log(`Guidelines loaded from: ${files.join(', ')}`);
        return { files, text: files.map((f) => `--- ${f} ---\n${readFile(f)}`).join('\n\n').slice(0, 20_000) };
      }
    } else if (existsSync(path.join(root, name))) {
      log(`Guidelines loaded from: ${name}`);
      return { files: [name], text: readFile(name).slice(0, 20_000) };
    }
  }
  warn(`none of the configured guideline files exist (${cfg.guidelines_files.join(', ')}); running without guidelines.`);
  return { files: [], text: '' };
}

export const guidelineFileSet = (cfg, root) => {
  const set = new Set(cfg.guidelines_files);
  for (const f of collectAgentsFiles(root, [])) set.add(f);
  return set;
};

export const isGuidelineFile = (p, set) => set.has(p) || /(^|\/)(AGENTS|CLAUDE)\.md$/.test(p);

