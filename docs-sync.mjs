#!/usr/bin/env node
// Entry point: env parsing and stage orchestration. Everything pure lives in lib.mjs; this is the
// only file that reads process.env, runs git or touches the network.
//
// Env: GITHUB_TOKEN, REPO ("owner/name"), TARGET_BRANCH, ANTHROPIC_API_KEY, OPENAI_API_KEY.
// Optional: PUSH_BEFORE, PUSH_FORCED, SINCE, DRY_RUN, TRIAGE_ONLY, DEBUG, RUN_URL.
// Runs from the target-branch checkout with full history (fetch-depth: 0).

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as L from './lib.mjs';

const {
  GITHUB_TOKEN,
  ANTHROPIC_API_KEY,
  OPENAI_API_KEY,
  REPO,
  TARGET_BRANCH,
  PUSH_BEFORE,
  PUSH_FORCED,
  SINCE,
  RUN_URL,
} = process.env;
// Children (setup_command, prettier, git) inherit process.env; only the push gets a token back.
for (const k of ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
const truthy = (v) => /^(1|true|yes)$/i.test(v ?? '');
const DRY_RUN = truthy(process.env.DRY_RUN);
const TRIAGE_ONLY = truthy(process.env.TRIAGE_ONLY);
const DEBUG = truthy(process.env.DEBUG);
const ROOT = process.cwd();

const log = (m) => console.log(m);
const warn = (m) => console.warn(`[warn] ${m}`);
const debug = (label, text) => {
  if (DEBUG) console.error(`[debug] ${label}:\n${text}\n[debug] end ${label}`);
};

// ---------------------------------------------------------------------- helpers ---

// `raw` keeps the trailing newline: file contents must round-trip byte for byte.
function git(args, { quiet = false, input, env, raw = false } = {}) {
  // Unquoted paths, so non-ASCII names match the -z output they are compared with.
  const out = execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    input,
    env: env ? { ...process.env, ...env } : undefined,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', quiet ? 'ignore' : 'inherit'],
  });
  return raw ? out : out.replace(/\n$/, '');
}
const gitOk = (args) => {
  try {
    git(args, { quiet: true });
    return true;
  } catch {
    return false;
  }
};

async function gh(path, { allow404 = false, method = 'GET', body } = {}) {
  const res = await L.fetchRetry(
    fetch,
    `${L.API.github.baseUrl}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: L.API.github.accept,
        'X-GitHub-Api-Version': L.API.github.version,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { timeoutMs: 60_000, onRetry: (m) => warn(`GitHub ${method} ${path}: ${m}`) }
  );
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`GitHub ${method} ${path} -> ${res.status}: ${text}`), { status: res.status, text });
  }
  return res.status === 204 ? null : res.json();
}

// Pushes from a throwaway repo that borrows the checkout's objects: setup_command can write hooks
// and config into .git, and none of it may run next to the token.
function pushWithToken(args) {
  const objects = resolve(ROOT, git(['rev-parse', '--git-path', 'objects']));
  const dir = mkdtempSync(join(tmpdir(), 'ai-docs-sync-push-'));
  try {
    mkdirSync(join(dir, 'objects', 'info'), { recursive: true });
    mkdirSync(join(dir, 'refs'));
    writeFileSync(join(dir, 'objects', 'info', 'alternates'), `${objects}\n`);
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
    const env = { GIT_DIR: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...L.gitAuthEnv(GITHUB_TOKEN) };
    git(['push', '--quiet', ...args], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `git ls-tree` entry for one path: { mode, blob } or null.
function treeEntry(treeish, p) {
  const line = git(['ls-tree', '-z', treeish, '--', p]).replace(/\0$/, '');
  const m = line.match(/^(\d+) blob ([0-9a-f]+)\t/);
  return m ? { mode: m[1], blob: m[2] } : null;
}

async function ghAll(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const readCheckout = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);

// Walks the checkout for editable docs; symlinked directories are never entered.
function walkDocs(isEditableDoc, dir = '') {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = dir ? `${dir}/${name}` : name;
    const st = lstatSync(join(ROOT, rel));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...walkDocs(isEditableDoc, rel));
    else if (st.isFile() && isEditableDoc(rel)) out.push(rel);
  }
  return out;
}

function makeFormatter(cfg) {
  if (cfg.format_check !== 'strict') return { mode: 'off' };
  log(`Running setup_command for format_check: strict`);
  execSync(cfg.setup_command, { cwd: ROOT, stdio: 'inherit' });
  const prettier = join(ROOT, 'node_modules', '.bin', 'prettier');
  if (!existsSync(prettier)) throw new Error('format_check: strict but node_modules/.bin/prettier is missing after setup_command');
  return {
    mode: 'strict',
    run: (content, filePath) => {
      try {
        const out = execFileSync(prettier, ['--stdin-filepath', filePath], { cwd: ROOT, encoding: 'utf8', input: content, stdio: ['pipe', 'pipe', 'pipe'] });
        return { ok: true, content: out };
      } catch (e) {
        return { ok: false, error: (e.stderr || e.message || '').toString().trim().split('\n')[0] };
      }
    },
  };
}

// ------------------------------------------------------------------------- main ---

async function main() {
  const missing = [
    ['GITHUB_TOKEN', GITHUB_TOKEN],
    ['REPO', REPO],
    ['TARGET_BRANCH', TARGET_BRANCH],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (missing.length) throw new Error(`Missing required env var(s): ${missing.join(', ')}`);

  const models = L.pickModels({ anthropic: ANTHROPIC_API_KEY, openai: OPENAI_API_KEY });
  const usage = L.makeUsageLog(log, warn);

  // 5.1 config, allowlist, guidelines
  const cfgPath = join(ROOT, '.github', 'docs-sync.yml');
  if (!existsSync(cfgPath)) throw new Error('.github/docs-sync.yml not found on the target branch');
  const cfg = L.loadConfig(readFileSync(cfgPath, 'utf8'), { warn });
  const isEditableDocPath = L.makeIsEditableDocPath(cfg);
  const isEditableDoc = L.makeIsEditableDoc(cfg, ROOT);
  const isIgnored = L.makeMatcher(cfg.ignore);

  let defaultBranch = '';
  try {
    defaultBranch = (await gh(`/repos/${REPO}`)).default_branch ?? '';
  } catch (e) {
    warn(`could not read the default branch (${e.message}); rolling branch checked against the target only`);
  }
  L.validateRollingBranch(cfg.branch, { targetBranch: TARGET_BRANCH, defaultBranch });

  const head = git(['rev-parse', 'HEAD']);
  log(`ai-docs-sync ${L.VERSION}: ${REPO} target ${TARGET_BRANCH} at ${head.slice(0, 7)}` + (DRY_RUN ? ' (dry run)' : '') + (TRIAGE_ONLY ? ' (triage only)' : ''));

  // 5.2 range: cursor ref, then PUSH_BEFORE, then HEAD~1; SINCE overrides all
  let cursor = null;
  if (!SINCE) {
    const ref = await gh(`/repos/${REPO}/git/ref/ai-docs-sync/cursor`, { allow404: true });
    cursor = ref?.object?.sha ?? null;
    log(cursor ? `Cursor ref at ${cursor.slice(0, 7)}` : 'No cursor ref yet');
  }
  const isAncestor = (sha) => gitOk(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) && gitOk(['merge-base', '--is-ancestor', sha, 'HEAD']);
  const range = L.selectRange({ since: SINCE, cursor, pushBefore: PUSH_BEFORE, pushForced: PUSH_FORCED }, isAncestor);
  const pushUrl = `${L.API.github.gitUrl}/${REPO}.git`;
  // Every run that reaches a decision moves the cursor, so each commit is triaged once.
  const moveCursor = (why) => {
    if (TRIAGE_ONLY) return log(`${why}. TRIAGE_ONLY: cursor not moved.`);
    if (cursor === head) return log(`${why}. Cursor already at ${head.slice(0, 7)}.`);
    pushWithToken(['--force', pushUrl, `${head}:${L.CURSOR_REF}`]);
    log(`${why}. Cursor moved to ${head.slice(0, 7)}.`);
  };

  if (range.from === 'HEAD~1' && !gitOk(['rev-parse', '--verify', '--quiet', 'HEAD~1'])) {
    moveCursor('Single-commit history; nothing to compare');
    return;
  }
  let from = git(['rev-parse', range.from]);
  let capped = false;
  let count = Number(git(['rev-list', '--count', `${from}..HEAD`]));
  if (count > cfg.max_commits) {
    // First-parent, so the new start is on the target's own line and never before the old one.
    const line = git(['rev-list', '--first-parent', `--max-count=${cfg.max_commits + 1}`, `${from}..HEAD`]).split('\n');
    if (line.length > cfg.max_commits) {
      from = line[line.length - 1];
      capped = true;
      const all = count;
      count = Number(git(['rev-list', '--count', `${from}..HEAD`]));
      log(`Range has ${all} commits; capped at the newest ${cfg.max_commits} first-parent commits (from ${from.slice(0, 7)}). Backfill in slices with since=.`);
    }
  }
  log(`Range ${from.slice(0, 7)}..${head.slice(0, 7)} (${range.source}, ${count} commits)`);
  if (from === head) {
    moveCursor('Empty range; nothing to do');
    return;
  }

  // 5.4 changed files and free exits
  const changes = L.parseNameStatus(git(['diff', '--name-status', '-z', '-M', `${from}..HEAD`]));
  const classified = L.classifyChanges(changes, { isEditableDoc, isIgnored });
  log(`Changed files: ${changes.length} (${classified.docs.length} docs, ${classified.code.length} code, ${classified.ignored.length} ignored)`);
  for (const c of changes) log(`  ${c.status} ${c.oldPath ? `${c.oldPath} -> ` : ''}${c.path}`);
  if (classified.skipReason) {
    moveCursor(`Skip: ${classified.skipReason}`);
    return;
  }
  const changedPaths = changes.map((c) => c.path);

  // 5.3 narrative
  const commits = L.parseGitLog(git(['log', '--reverse', `--format=${L.GIT_LOG_FORMAT}`, `${from}..HEAD`]));
  const api = {
    pr: (n) => gh(`/repos/${REPO}/pulls/${n}`),
    pullsForCommit: (sha) => gh(`/repos/${REPO}/commits/${sha}/pulls`),
    prCommits: async (n) =>
      (await ghAll(`/repos/${REPO}/pulls/${n}/commits`)).map((c) => ({
        sha: c.sha,
        subject: (c.commit?.message ?? '').split('\n')[0],
        email: c.commit?.author?.email ?? '',
      })),
  };
  const { linked, prs, lookups, lookupsExhausted } = await L.collectPrs(commits, api, {
    targetBranch: TARGET_BRANCH,
    rollingBranch: cfg.branch,
    maxLookups: cfg.max_pr_lookups,
  });
  if (lookupsExhausted) warn(`PR lookup cap (${cfg.max_pr_lookups}) reached; remaining commits listed as not from a PR`);
  const narrative = L.buildNarrative({ commits, linked, prs, targetBranch: TARGET_BRANCH, from, to: head, budget: cfg.narrative_max_tokens, capped });
  log(`Narrative: ${commits.length} commits, ${prs.size} PRs (${lookups} lookups), ~${L.approxTokens(narrative)} tokens`);
  log(`\n${narrative}\n`);

  // 5.5 packed code diff from local git: one diff for the range, filtered to code files, so a
  // large push never turns into an oversized argument list.
  const codeSet = new Set(classified.code.map((c) => c.path));
  const patches = L.splitUnifiedDiff(git(['diff', '-M', `${from}..HEAD`])).filter((p) => codeSet.has(p.path));
  const packed = L.packDiff(patches, cfg.max_diff_tokens);
  log(`Packed diff: ${packed.included.length} files, ~${L.approxTokens(packed.diff)} tokens` + (packed.omitted.length ? `, ${packed.omitted.length} over budget` : ''));

  // 5.12 step 1, read side: carried-forward edits from the rolling branch overlay the checkout.
  // Edits are carried only while a PR for them is open: after a merge they are in the target, and
  // after a close a human has said "not now".
  const owner = REPO.split('/')[0];
  const findOpenPr = async () =>
    (await gh(`/repos/${REPO}/pulls?state=open&head=${encodeURIComponent(`${owner}:${cfg.branch}`)}&base=${encodeURIComponent(TARGET_BRANCH)}`))[0] ?? null;
  const openPr = await findOpenPr();
  const carried = new Map(); // path -> { mode, blob, content }
  const staleCarried = [];
  let carryBase = null;
  const remote = `refs/remotes/origin/${cfg.branch}`;
  // The lease for the force push: what we inspected, or "must not exist".
  const remoteSha = gitOk(['rev-parse', '--verify', '--quiet', remote]) ? git(['rev-parse', remote]) : '';
  if (remoteSha) {
    const base = git(['merge-base', 'HEAD', remote]);
    const branchCommits = L.parseGitLog(git(['log', `--format=${L.GIT_LOG_FORMAT}`, `${base}..${remote}`]));
    const foreign = L.foreignBranchCommit(branchCommits, {
      changesOf: (sha) => L.parseNameStatus(git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '-M', sha])),
      isEditableDoc,
    });
    if (foreign)
      throw new Error(
        `origin/${cfg.branch} has ${foreign.short} "${foreign.subject}" (${foreign.email}), which is neither the tool's nor a doc addition or edit; ` +
          `refusing to build on it. Rename or delete that branch.`
      );
    if (openPr) {
      carryBase = base;
      const plan = L.planCarryForward({
        branchFiles: git(['diff', '--name-only', '-z', base, remote]).split('\0').filter(Boolean),
        targetChangedSinceBase: (f) => !gitOk(['diff', '--quiet', base, 'HEAD', '--', f]),
        isEditableDoc,
      });
      for (const f of plan.restore) carried.set(f, { ...treeEntry(remote, f), content: git(['show', `${remote}:${f}`], { raw: true }) });
      staleCarried.push(...plan.stale);
      log(`Open PR #${openPr.number}; carrying forward ${plan.restore.length} unmerged edit(s) from origin/${cfg.branch}` + (plan.stale.length ? `; ${plan.stale.length} stale (target changed): ${plan.stale.join(', ')}` : ''));
    } else {
      log(`origin/${cfg.branch} exists with no open PR into ${TARGET_BRANCH}; its edits are not carried forward`);
    }
  }
  const readCurrent = (p) => (carried.has(p) ? carried.get(p).content : readCheckout(p));
  const prevRuns = L.parseMarker(openPr?.body);
  // The PR must stop showing a discarded edit even when nothing else changes this run.
  const mustRefresh = Boolean(openPr && staleCarried.length);

  // Discarded edits go back to triage with the earlier code changes they documented. Where that
  // range starts comes from the PR marker, so it is only trusted once git confirms the ancestry.
  let staleText = '';
  const earlierByPath = new Map();
  if (staleCarried.length) {
    const starts = staleCarried.map((p) => {
      const s = L.regenerateFrom(prevRuns, p, carryBase);
      return s && isAncestor(s) ? s : carryBase;
    });
    const earliest = starts.sort((a, b) => Number(git(['rev-list', '--count', `${b}..HEAD`])) - Number(git(['rev-list', '--count', `${a}..HEAD`])))[0];
    let earlierDiff = '';
    let earlierCommits = [];
    if (earliest !== from && gitOk(['merge-base', '--is-ancestor', earliest, from])) {
      const older = L.splitUnifiedDiff(git(['diff', '-M', `${earliest}..${from}`])).filter((p) => !isEditableDoc(p.path) && !isIgnored(p.path));
      const packedOld = L.packDiff(older, cfg.max_stale_diff_tokens);
      for (const p of older) if (packedOld.included.includes(p.path)) earlierByPath.set(p.path, p);
      earlierDiff = packedOld.diff;
      earlierCommits = L.parseGitLog(git(['log', '--reverse', '--no-merges', `--format=${L.GIT_LOG_FORMAT}`, `${earliest}..${from}`]))
        .filter((c) => !L.isBotEmail(c.email))
        .slice(-50)
        .map((c) => ({ short: c.short, subject: c.subject }));
    }
    const current = Object.fromEntries(
      staleCarried.map((p) => {
        const text = readCurrent(p);
        return [p, text != null && L.approxTokens(text) <= cfg.max_doc_tokens ? text : null];
      })
    );
    staleText = L.renderStaleBlock({ docs: staleCarried, from: earliest, to: from, commits: earlierCommits, diff: earlierDiff, current });
    log(`Stale edit(s) sent back to triage: ${staleCarried.join(', ')}` + (earlierDiff ? ` (earlier changes ${earliest.slice(0, 7)}..${from.slice(0, 7)}, ${earlierByPath.size} file(s))` : ''));
  }

  // 5.6 manifest
  const docPaths = [...new Set([...walkDocs(isEditableDoc), ...carried.keys()])];
  const manifest = L.buildManifest(docPaths.map((p) => ({ path: p, content: readCurrent(p) })));
  const manifestText = L.renderManifest(manifest);
  log(`Manifest: ${manifest.length} editable docs\n${manifestText}\n`);

  const guidelines = L.loadGuidelines(cfg, ROOT, changedPaths, readCheckout, { log, warn });
  const guidelineFiles = L.guidelineFileSet(cfg, ROOT);

  // ----------------------------------------------------------- paid stages ---

  const callModel = async (spec, label, { system, blocks, maxTokens, stream = false }) => {
    const apiKey = spec.provider === 'anthropic' ? ANTHROPIC_API_KEY : OPENAI_API_KEY;
    const fn = spec.provider === 'anthropic' ? L.anthropicCall : L.openaiCall;
    const r = await fn({ fetch, apiKey, model: spec.model, system, blocks, maxTokens, effort: spec.effort, stream, retry: { onRetry: (m) => warn(`${label}: ${m}`) } });
    usage.log(label, spec.model, r.usage);
    debug(`${label} raw output`, r.text);
    if (r.truncated) warn(`${label}: output cut off by the token budget (stop_reason=${r.stopReason})`);
    return r;
  };

  // 5.7 triage
  const prefix = L.writerPrefix({ guidelines: guidelines.text, narrative, diff: packed.diff, manifest: manifestText, stale: staleText });
  const triageRaw = await callModel(models.triage, 'triage', { system: L.TRIAGE_SYSTEM, blocks: [{ text: prefix }], maxTokens: cfg.response_max_tokens });
  const triage = L.parseTriage(triageRaw.text, { isEditableDocPath, exists: (p) => readCurrent(p) != null, maxDocs: cfg.max_docs_per_run });
  if (!triage) throw new Error('triage returned unparseable output (run with DEBUG=1 to see it)');
  for (const d of triage.dropped) warn(`triage named "${d.path}": ${d.reason}; dropped`);
  log(`Triage: ${triage.affected.length} affected` + (triage.overflow.length ? `, ${triage.overflow.length} over max_docs_per_run` : '') + (triage.deleteCandidates.length ? `, ${triage.deleteCandidates.length} delete candidate(s)` : ''));
  for (const a of triage.affected) log(`  ${a.action} ${a.path}: ${a.reason}${a.source_files.length ? ` [${a.source_files.join(', ')}]` : ''}`);
  for (const a of triage.overflow) log(`  (not this run) ${a.path}: ${a.reason}`);
  for (const d of triage.deleteCandidates) log(`  delete candidate ${d.path}: ${d.reason}`);
  if (!triage.affected.length) log(`  ${triage.unaffectedReason || 'no reason given'}`);
  if (TRIAGE_ONLY) {
    log(`TRIAGE_ONLY set; stopping. ${costLine(usage)}`);
    return;
  }
  if (!triage.affected.length && !mustRefresh) {
    log(costLine(usage));
    moveCursor('No docs affected; nothing to write');
    return;
  }

  // 5.8 writer, one call per doc, cached prefix, concurrency of three
  const heldBack = [];
  const patchByPath = new Map(patches.map((p) => [p.path, p]));
  const writable = triage.affected.filter((a) => {
    const current = readCurrent(a.path);
    if (current != null && L.approxTokens(current) > cfg.max_doc_tokens) {
      heldBack.push({ path: a.path, reason: 'too large for a full rewrite in v1' });
      return false;
    }
    return true;
  });
  const docPart = (a) =>
    L.writerDocPart({
      path: a.path,
      action: a.action,
      reason: a.reason,
      sourcePatches: a.source_files.flatMap((f) => [earlierByPath.get(f)?.patch, patchByPath.get(f)?.patch]).filter(Boolean).join('\n\n'),
      current: readCurrent(a.path) ?? '',
    });
  const writeDoc = async (a, extra = '') => {
    const r = await callModel(models.writer, `writer ${a.path}`, {
      system: L.WRITER_SYSTEM,
      blocks: [{ text: prefix, cache: true }, { text: docPart(a) + extra }],
      maxTokens: cfg.writer_max_tokens,
      stream: models.writer.provider === 'anthropic',
    });
    return L.parseWriterOutput(r.text);
  };
  // The first call alone warms the cached prefix; the rest run three at a time against it.
  const drafts = [];
  const written = writable.length ? [await writeDoc(writable[0])] : [];
  written.push(...(await L.mapConcurrent(writable.slice(1), cfg.writer_concurrency, (a) => writeDoc(a))));
  writable.forEach((a, i) => {
    if (written[i] == null) heldBack.push({ path: a.path, reason: 'writer output could not be parsed as a fenced file' });
    else drafts.push({ ...a, content: written[i], current: readCurrent(a.path) });
  });
  log(`Writer: ${drafts.length} draft(s)` + (heldBack.length ? `, ${heldBack.length} held back` : ''));

  // 5.9 checker, then at most one correction per file
  let checked = null;
  if (drafts.length) {
    try {
      const r = await callModel(models.checker, 'checker', {
        system: L.CHECKER_SYSTEM,
        blocks: [
          {
            text: L.checkerUser({
              narrative,
              diff: packed.diff,
              stale: staleText,
              docs: drafts.map((d) => ({ ...d, editDiff: L.unifiedDiff(d.current ?? '', d.content, d.path) })),
            }),
          },
        ],
        maxTokens: cfg.response_max_tokens,
      });
      checked = L.parseChecker(r.text);
      if (!checked) warn('checker returned unparseable output; proceeding unchecked');
    } catch (e) {
      warn(`checker failed (${e.message}); proceeding unchecked`);
    }
  }
  const toCorrect = [];
  const candidates = [];
  for (const d of drafts) {
    const decision = L.decideAfterCheck(checked?.get(d.path));
    const entry = { ...d, check: decision };
    if (decision.action === 'drop') heldBack.push({ path: d.path, reason: `checker: drop (${decision.issues.map((i) => i.note).join('; ')})` });
    else if (decision.action === 'correct') toCorrect.push(entry);
    else candidates.push(entry);
  }
  if (toCorrect.length) {
    log(`Correction pass for ${toCorrect.length} file(s)`);
    const corrected = await L.mapConcurrent(toCorrect, cfg.writer_concurrency, (d) => writeDoc(d, '\n\n' + L.correctionPart({ draft: d.content, issues: d.check.issues })));
    toCorrect.forEach((d, i) => {
      if (corrected[i] == null) warn(`correction for ${d.path} unparseable; keeping the first draft`);
      candidates.push({ ...d, content: corrected[i] ?? d.content, corrected: corrected[i] != null });
    });
  }

  // 5.10 gates
  const format = candidates.length ? makeFormatter(cfg) : { mode: 'off' };
  const { kept, dropped } = L.runGates(candidates, {
    isEditableDoc,
    readCurrent,
    readTarget: readCheckout,
    // Carried-forward creates live on the rolling branch only, so links to them must resolve.
    existsInCheckout: (p) => carried.has(p) || existsSync(join(ROOT, p)),
    guidelineFiles,
    format,
  });

  // ------------------------------------------------------------- summary ---

  log('\n===== RESULT =====');
  log(`Range ${from.slice(0, 7)}..${head.slice(0, 7)} on ${TARGET_BRANCH}; rolling branch ${cfg.branch}`);
  for (const k of kept) {
    const notes = [];
    if (k.check?.unchecked) notes.push('unchecked');
    else if (k.corrected) notes.push(`corrected after: ${k.check.issues.map((i) => `[${i.severity}] ${i.note}`).join('; ')}`);
    else if (k.check?.issues?.length) notes.push(`checker notes: ${k.check.issues.map((i) => `[${i.severity}] ${i.note}`).join('; ')}`);
    if (k.dashesFixed) notes.push(`${k.dashesFixed} dash line(s) fixed`);
    log(`KEEP ${k.action} ${k.path} -- ${k.reason}` + (notes.length ? `\n     ${notes.join('\n     ')}` : ''));
    for (const f of k.flags) {
      if (f.kind === 'guideline_edit') log(`     FLAG guideline file edited; full diff:\n${f.detail.replace(/^/gm, '       ')}`);
      else log(`     FLAG ${f.kind}: ${f.detail.join(', ')}`);
    }
  }
  for (const d of dropped) log(`DROP ${d.path} -- gate ${d.gate}: ${d.reason}`);
  for (const h of heldBack) log(`HELD ${h.path} -- ${h.reason}`);
  for (const s of staleCarried)
    log(`STALE carried edit discarded, target changed ${s}; ` + (kept.some((k) => k.path === s) ? 'redone this run' : `not reselected (force with since=${L.regenerateFrom(prevRuns, s, carryBase)})`));
  for (const a of triage.overflow) log(`ALSO likely affected, not edited this run: ${a.path}`);
  for (const d of triage.deleteCandidates) log(`DELETE candidate (never acted on): ${d.path} -- ${d.reason}`);
  if (carried.size) log(`CARRIED forward from earlier runs: ${[...carried.keys()].join(', ')}`);
  if (packed.omitted.length) log(`DIFF over budget, not shown to the models: ${packed.omitted.join(', ')}`);
  log(costLine(usage));

  if (!kept.length && !mustRefresh) {
    moveCursor('Nothing survived the gates; the rolling PR is left as it is');
    return;
  }

  // ------------------------------------------------------------- publish ---

  const scope = L.commitScope(cfg.branch);
  const keptPaths = new Set(kept.map((k) => k.path));
  const carriedOnly = [...carried.keys()].filter((p) => !keptPaths.has(p));
  const title = L.prTitle({ scope, target: TARGET_BRANCH, to: head });
  const prBody = L.renderPrBody({
    target: TARGET_BRANCH,
    from,
    to: head,
    commitCount: count,
    capped,
    runUrl: RUN_URL,
    kept,
    carried: carriedOnly.map((p) => ({ path: p, run: L.lastRunFor(prevRuns, p) })),
    stale: staleCarried.map((p) => ({ path: p, since: L.regenerateFrom(prevRuns, p, carryBase), redone: keptPaths.has(p) })),
    dropped,
    heldBack,
    deleteCandidates: triage.deleteCandidates,
    overflow: triage.overflow,
    omittedDiff: packed.omitted,
    outline: L.narrativeOutline({ commits, linked, prs }),
    usage: { entries: usage.entries, total: usage.total(), unpriced: usage.unpriced() },
    runs: [...prevRuns, { at: new Date().toISOString(), from, to: head, files: [...keptPaths] }],
  });

  if (DRY_RUN) {
    log(`\n===== DRY RUN -- would push ${cfg.branch} and ${openPr ? `update PR #${openPr.number}` : 'open a PR'} =====`);
    log(`Files: ${[...keptPaths].join(', ')}` + (carriedOnly.length ? `; carried: ${carriedOnly.join(', ')}` : ''));
    for (const k of kept) log(`\n${L.unifiedDiff(k.current ?? '', k.content, k.path) || `(no textual diff for ${k.path})`}`);
    log(`\n----- PR title -----\n${title}\n----- PR body -----\n${prBody}`);
    moveCursor('Dry run');
    return;
  }

  // Built with plumbing in a throwaway index: the working tree never changes and no file is
  // written through a path on disk.
  const tmp = mkdtempSync(join(tmpdir(), 'ai-docs-sync-'));
  let tree;
  try {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') };
    const stage = (mode, blob, p) => {
      if (!/^1006[04][04]$/.test(mode)) throw new Error(`refusing to stage ${p}: tree mode ${mode} is not a regular file`);
      git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${p}`], { env });
    };
    git(['read-tree', head], { env });
    for (const p of carriedOnly) stage(carried.get(p).mode, carried.get(p).blob, p);
    for (const k of kept) stage(treeEntry(head, k.path)?.mode ?? '100644', git(['hash-object', '-w', '--stdin'], { input: k.content }), k.path);
    tree = git(['write-tree'], { env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // With an open PR the push still happens, so the PR stops showing edits that were dropped.
  if (tree === git(['rev-parse', `${head}^{tree}`]) && !openPr) {
    moveCursor('The edits reproduce the target tree exactly; nothing to publish');
    return;
  }
  const commit = git(['commit-tree', '--no-gpg-sign', tree, '-p', head, '-F', '-'], {
    input: L.commitMessage({ scope, from, to: head, target: TARGET_BRANCH, files: [...keptPaths], carried: carriedOnly, runUrl: RUN_URL }),
    env: { GIT_AUTHOR_NAME: L.BOT_NAME, GIT_AUTHOR_EMAIL: L.BOT_EMAIL, GIT_COMMITTER_NAME: L.BOT_NAME, GIT_COMMITTER_EMAIL: L.BOT_EMAIL },
  });
  // The lease pins the push to the branch state the ownership check inspected.
  pushWithToken([`--force-with-lease=refs/heads/${cfg.branch}:${remoteSha}`, pushUrl, `${commit}:refs/heads/${cfg.branch}`]);
  log(`Pushed ${cfg.branch} at ${commit.slice(0, 7)}`);

  let pr = openPr;
  if (pr) {
    await gh(`/repos/${REPO}/pulls/${pr.number}`, { method: 'PATCH', body: { title, body: prBody } });
    log(`Updated PR #${pr.number}: ${pr.html_url}`);
  } else {
    try {
      pr = await gh(`/repos/${REPO}/pulls`, { method: 'POST', body: { title, head: cfg.branch, base: TARGET_BRANCH, body: prBody } });
      log(`Opened PR #${pr.number}: ${pr.html_url}`);
    } catch (e) {
      if (e.status === 403)
        throw new Error(
          `Creating the PR was refused (403). Enable "Allow GitHub Actions to create and approve pull requests" ` +
            `(Settings -> Actions -> General -> Workflow permissions) or set DOCS_SYNC_TOKEN. ${cfg.branch} was pushed; ` +
            `the next run rebuilds it. GitHub said: ${e.text}`
        );
      // A create retried after a 5xx can find its own first attempt.
      if (e.status !== 422 || !(pr = await findOpenPr())) throw e;
      await gh(`/repos/${REPO}/pulls/${pr.number}`, { method: 'PATCH', body: { title, body: prBody } });
      log(`Updated PR #${pr.number}: ${pr.html_url}`);
    }
  }
  if (cfg.label) {
    try {
      await gh(`/repos/${REPO}/issues/${pr.number}/labels`, { method: 'POST', body: { labels: [cfg.label] } });
    } catch (e) {
      warn(`could not add label "${cfg.label}" (${e.status ?? e.message}); continuing`);
    }
  }

  moveCursor('Published');

  try {
    await gh(`/repos/${REPO}/statuses/${commit}`, {
      method: 'POST',
      body: {
        state: 'success',
        context: L.STATUS_CONTEXT,
        description: `${kept.length} edited, ${dropped.length + heldBack.length} held back`,
        ...(RUN_URL ? { target_url: RUN_URL } : {}),
      },
    });
  } catch (e) {
    warn(`could not post the ${L.STATUS_CONTEXT} status (${e.status ?? e.message})`);
  }
}

const costLine = (usage) =>
  `[cost] TOTAL ~$${usage.total().toFixed(4)}` + (usage.unpriced().length ? ` (excludes unpriced model(s): ${usage.unpriced().join(', ')})` : '');

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  if (DEBUG && err?.stack) console.error(err.stack);
  process.exit(1);
});
