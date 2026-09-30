#!/usr/bin/env node
// The only file that reads process.env, runs git or touches the network; the rest is in lib.mjs.

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

// Walks the checkout for files matching `pred`; symlinked directories are never entered.
function walkDocs(pred, dir = '') {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = dir ? `${dir}/${name}` : name;
    const st = lstatSync(join(ROOT, rel));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...walkDocs(pred, rel));
    else if (st.isFile() && pred(rel)) out.push(rel);
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

  // 5.12 step 1: rolling-branch edits overlay the checkout only while their PR is open; merged
  // means they are in the target, closed means "not now".
  const owner = REPO.split('/')[0];
  const findOpenPr = async () =>
    (await gh(`/repos/${REPO}/pulls?state=open&head=${encodeURIComponent(`${owner}:${cfg.branch}`)}&base=${encodeURIComponent(TARGET_BRANCH)}`))[0] ?? null;
  const openPr = await findOpenPr();
  const carried = new Map(); // path -> { mode, blob, content }
  const tombstones = new Set(); // docs the rolling branch deletes
  const staleCarried = []; // { path, kind, reason? }
  const obsolete = [];
  // Reviewer decisions, recorded in the tool's commit because every rebuild drops the reviewers' commits.
  let decisions = [];
  const discardedReviewer = [];
  const revertedFixups = new Map(); // restored doc -> carried fix-ups sent back to triage
  let carryBase = null;
  const remote = `refs/remotes/origin/${cfg.branch}`;
  // The lease for the force push: what we inspected, or "must not exist".
  const remoteSha = gitOk(['rev-parse', '--verify', '--quiet', remote]) ? git(['rev-parse', remote]) : '';
  if (remoteSha) {
    const base = git(['merge-base', 'HEAD', remote]);
    const branchCommits = L.parseGitLog(git(['log', `--format=${L.GIT_LOG_FORMAT}`, `${base}..${remote}`]));
    const changesOf = (sha) => L.parseNameStatus(git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '-M', sha]));
    const foreign = L.foreignBranchCommit(branchCommits, { changesOf, isEditableDoc });
    if (foreign)
      throw new Error(
        `origin/${cfg.branch} has ${foreign.short} "${foreign.subject}" (${foreign.email}), which is neither the tool's nor an addition, edit, deletion or rename of an editable doc; ` +
          `refusing to build on it. Rename or delete that branch.`
      );
    if (openPr) {
      carryBase = base;
      const plan = L.planCarryForward({
        branchChanges: L.parseNameStatus(git(['diff', '--name-status', '-z', '--no-renames', base, remote])),
        targetHas: (f) => treeEntry(head, f) != null,
        targetChangedSinceBase: (f) => !gitOk(['diff', '--quiet', base, 'HEAD', '--', f]),
        isEditableDoc,
      });
      const lastTool = branchCommits.find(L.isToolCommit);
      const reconciled = L.reconcileReviewerCarry({
        decisions: L.classifyReviewerChanges({
          commits: [...branchCommits].reverse(),
          changesOf,
          baseHas: (f) => treeEntry(base, f) != null,
          remoteHas: (f) => treeEntry(remote, f) != null,
          isEditableDoc,
          previous: lastTool ? L.parseReviewerDecisions(`${lastTool.subject}\n\n${lastTool.body}`, isEditableDocPath) : [],
        }),
        stale: plan.stale,
        obsolete: plan.obsolete,
      });
      decisions = reconciled.decisions;
      discardedReviewer.push(...reconciled.discarded);
      for (const f of plan.restore) carried.set(f, { ...treeEntry(remote, f), content: git(['show', `${remote}:${f}`], { raw: true }) });
      for (const f of plan.restoreDeletes) tombstones.add(f);
      staleCarried.push(...reconciled.stale);
      obsolete.push(...plan.obsolete);
      for (const d of decisions.filter((x) => x.kind === 'declined-delete')) {
        const fixups = L.fixupsOfRevertedDelete(d.path, carried, readCheckout);
        for (const q of fixups) {
          carried.delete(q);
          staleCarried.push({ path: q, kind: 'edit', reason: 'the delete they followed was reverted by a reviewer' });
        }
        if (fixups.length) revertedFixups.set(d.path, fixups);
      }
      log(
        `Open PR #${openPr.number}; carrying forward ${plan.restore.length} unmerged edit(s) and ${plan.restoreDeletes.length} delete(s) from origin/${cfg.branch}` +
          (plan.stale.length ? `; ${plan.stale.length} stale (target changed): ${plan.stale.map((x) => `${x.path} (${x.kind})`).join(', ')}` : '') +
          (plan.obsolete.length ? `; ${plan.obsolete.length} obsolete (target deleted the file): ${plan.obsolete.join(', ')}` : '')
      );
      for (const d of decisions) log(`  reviewer decision: ${L.describeDecision(d)}`);
      for (const d of reconciled.discarded) log(`  reviewer ${d.kind === 'renamed' ? 'rename' : 'delete'} of ${d.path} discarded: ${TARGET_BRANCH} changed the file`);
      for (const [p, qs] of revertedFixups) log(`  carried link fix-up(s) for ${p}, restored by a reviewer, sent back to triage: ${qs.join(', ')}`);
    } else {
      log(`origin/${cfg.branch} exists with no open PR into ${TARGET_BRANCH}; its edits are not carried forward`);
    }
  }
  // A tombstone triage names again reads as the target's copy, but stays deleted unless kept.
  const undeleted = new Set();
  const isTombstone = (p) => tombstones.has(p) && !undeleted.has(p);
  const readCurrent = (p) => (carried.has(p) ? carried.get(p).content : isTombstone(p) ? null : readCheckout(p));
  const prevRuns = L.parseMarker(openPr?.body);
  // The PR must stop showing a discarded or obsolete change even when nothing else changes.
  const mustRefresh = Boolean(openPr && (staleCarried.length || obsolete.length || discardedReviewer.length));
  const reviewerRemoved = new Map(decisions.filter((d) => d.kind === 'deleted' || d.kind === 'renamed').map((d) => [d.path, d]));
  const stalePaths = staleCarried.map((x) => x.path);

  // Discarded edits go back to triage with the earlier code changes they documented. Where that
  // range starts comes from the PR marker, so it is only trusted once git confirms the ancestry.
  let staleText = '';
  const earlierByPath = new Map();
  const earlierPaths = new Set();
  if (staleCarried.length) {
    const starts = stalePaths.map((p) => {
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
      for (const p of older) for (const q of [p.path, p.oldPath]) if (q) earlierPaths.add(q);
      earlierDiff = packedOld.diff;
      earlierCommits = L.parseGitLog(git(['log', '--reverse', '--no-merges', `--format=${L.GIT_LOG_FORMAT}`, `${earliest}..${from}`]))
        .filter((c) => !L.isBotEmail(c.email))
        .slice(-50)
        .map((c) => ({ short: c.short, subject: c.subject }));
    }
    const current = Object.fromEntries(
      stalePaths.map((p) => {
        const text = readCurrent(p);
        return [p, text != null && L.approxTokens(text) <= cfg.max_doc_tokens ? text : null];
      })
    );
    staleText = L.renderStaleBlock({ docs: staleCarried, from: earliest, to: from, commits: earlierCommits, diff: earlierDiff, current });
    log(`Stale change(s) sent back to triage: ${stalePaths.join(', ')}` + (earlierDiff ? ` (earlier changes ${earliest.slice(0, 7)}..${from.slice(0, 7)}, ${earlierByPath.size} file(s))` : ''));
  }

  // 5.6 manifest. Every Markdown file is kept for the inbound-link check on deletes.
  const denied = L.makeMatcher(L.DENYLIST);
  const allMarkdown = [...new Set([...walkDocs((p) => p.endsWith('.md') && !denied(p)), ...carried.keys()])].filter((p) => !tombstones.has(p));
  const docPaths = allMarkdown.filter((p) => carried.has(p) || isEditableDoc(p));
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
  const triageText = L.triageUser({ guidelines: guidelines.text, narrative, diff: packed.diff, manifest: manifestText, stale: staleText, reviewer: L.renderReviewerBlock(decisions) });
  const triageRaw = await callModel(models.triage, 'triage', { system: L.TRIAGE_SYSTEM, blocks: [{ text: triageText }], maxTokens: cfg.response_max_tokens });
  const triage = L.parseTriage(triageRaw.text, { isEditableDocPath, exists: (p) => readCurrent(p) != null || tombstones.has(p) });
  if (!triage) throw new Error('triage returned unparseable output (run with DEBUG=1 to see it)');
  for (const d of triage.dropped) warn(`triage named "${d.path}": ${d.reason}; dropped`);
  // A reviewer's decision beats triage, even a nomination that would undo a carried delete.
  const ruled = L.applyReviewerDecisions({ affected: triage.affected, deletes: triage.deletes, decisions });
  for (const d of ruled.dropped) log(`  triage ${d.action} of ${d.path} dropped: ${d.reason}`);
  for (const a of [...ruled.affected, ...ruled.deletes]) if (tombstones.has(a.path)) undeleted.add(a.path);

  const codePaths = new Set([...classified.code.flatMap((c) => [c.path, c.oldPath]).filter(Boolean), ...earlierPaths]);
  const delPlan = L.planDeletes({ deletes: ruled.deletes, codePaths, readCurrent, guidelineFiles });
  const markdownNow = () => allMarkdown.map((p) => ({ path: p, content: readCurrent(p) }));
  const linkPlan = L.applyInboundLinks({
    affected: ruled.affected,
    deletes: delPlan.deletes,
    reviewer: [...reviewerRemoved.values()],
    inbound: L.inboundLinks(markdownNow(), [...delPlan.deletes.map((d) => d.path), ...reviewerRemoved.keys()]),
    isEditableDoc,
  });
  const deletes = linkPlan.deletes;
  const deletedPaths = new Set(deletes.map((d) => d.path));
  const createPlan = L.planCreates({ affected: linkPlan.affected, manifest, deleted: deletedPaths, isEditable: isEditableDoc, guidelineFiles });
  const tasks = createPlan.affected;
  const indexTasks = createPlan.indexTasks;
  const heldBack = [...createPlan.refused];
  log(`Triage: ${triage.affected.length} affected, ${deletes.length} delete(s)` + (delPlan.suggested.length ? `, ${delPlan.suggested.length} suggested deletion(s)` : ''));
  for (const a of tasks) log(`  ${a.action} ${a.path}: ${a.reason}${a.source_files.length ? ` [${a.source_files.join(', ')}]` : ''}`);
  for (const d of deletes) log(`  delete ${d.path}: ${d.reason} [${d.source_files.join(', ')}]`);
  for (const d of delPlan.suggested) log(`  suggested deletion ${d.path}: ${d.reason} (${d.why})`);
  for (const c of tasks.filter((a) => a.action === 'create'))
    log(`  create ${c.path}: placement ok; exemplar ${c.exemplar?.path ?? '(none)'}; index ${c.index ?? '(none, will be flagged)'}`);
  for (const r of createPlan.refused) log(`  create ${r.path}: held back, ${r.reason}`);
  for (const t of indexTasks) log(`  index update ${t.path} (second wave) links ${t.dependsOn.join(', ')}`);
  for (const [p, qs] of linkPlan.reviewerFixups) log(`  link fix-up(s) for ${p} (${reviewerRemoved.get(p).kind} by a reviewer): ${qs.join(', ')}`);
  if (!tasks.length && !deletes.length) log(`  ${triage.unaffectedReason || 'no reason given'}`);
  if (TRIAGE_ONLY) {
    log(`TRIAGE_ONLY set; stopping. ${costLine(usage)}`);
    return;
  }
  if (!tasks.length && !deletes.length && !mustRefresh) {
    log(costLine(usage));
    moveCursor('No docs affected; nothing to write');
    return;
  }

  // 5.8 writer, one call per doc, cached prefix, concurrency of three
  const prefix = L.writerPrefix({
    guidelines: guidelines.text,
    narrative,
    diff: packed.diff,
    manifest: L.renderManifest(manifest.filter((m) => !deletedPaths.has(m.path))),
    stale: staleText,
    deleted: [
      ...deletes.map((d) => ({ path: d.path, reason: d.reason })),
      ...[...reviewerRemoved.values()].map((d) => ({ path: d.path, reason: d.kind === 'renamed' ? `renamed by a reviewer to ${d.to}; link there instead` : 'deleted by a reviewer' })),
    ],
  });
  const patchByPath = new Map(patches.map((p) => [p.path, p]));
  const fits = (a) => {
    const current = readCurrent(a.path);
    if (current == null || L.approxTokens(current) <= cfg.max_doc_tokens) return true;
    heldBack.push({ path: a.path, reason: 'too large for a full rewrite in v1' });
    return false;
  };
  const writable = tasks.filter(fits);
  log(`Writer: ${writable.length} call(s) planned` + (indexTasks.length ? `, then up to ${indexTasks.length} index update(s)` : '') + (heldBack.length ? `, ${heldBack.length} held back` : ''));
  const docPart = (a) =>
    L.writerDocPart({
      path: a.path,
      action: a.action,
      reason: a.reason,
      sourcePatches: a.source_files.flatMap((f) => [earlierByPath.get(f)?.patch, patchByPath.get(f)?.patch]).filter(Boolean).join('\n\n'),
      current: readCurrent(a.path) ?? '',
      exemplar: a.exemplar ? { path: a.exemplar.path, content: readCurrent(a.exemplar.path) } : null,
      exemplarTokens: cfg.max_doc_tokens / 2,
    });
  // { content } with content null when unparseable, or { error } once the call's retries are spent.
  const writeDoc = async (a, extra = '') => {
    try {
      const r = await callModel(models.writer, `writer ${a.path}`, {
        system: L.WRITER_SYSTEM,
        blocks: [{ text: prefix, cache: true }, { text: docPart(a) + extra }],
        maxTokens: cfg.writer_max_tokens,
        stream: models.writer.provider === 'anthropic',
      });
      return { content: L.parseWriterOutput(r.text) };
    } catch (error) {
      warn(`writer ${a.path} failed (${error.message})`);
      return { error };
    }
  };
  const drafts = [];
  const collect = (wave, written) =>
    wave.forEach((a, i) => {
      if (written[i].error) heldBack.push({ path: a.path, reason: `writer call failed: ${written[i].error.message}` });
      else if (written[i].content == null) heldBack.push({ path: a.path, reason: 'writer output could not be parsed as a fenced file' });
      else drafts.push({ ...a, content: written[i].content, current: readCurrent(a.path) });
    });
  // Wave 1, every triage task and link fix-up. The first call alone warms the cached prefix; the
  // rest run three at a time against it.
  const written = writable.length ? [await writeDoc(writable[0])] : [];
  written.push(...(await L.mapConcurrent(writable.slice(1), cfg.writer_concurrency, (a) => writeDoc(a))));
  // Nothing written and an outage among the causes: fail so the cursor stays put and a later run
  // retries. A request-specific failure (a 400, a timeout) would fail every run, so it is held back.
  if (written.length && written.every((w) => w.error) && written.some((w) => L.isTransientError(w.error)))
    throw written.find((w) => L.isTransientError(w.error)).error;
  collect(writable, written);
  // Wave 2, index updates, which need the drafted title of the doc they link.
  const wave2 = L.finaliseIndexTasks(indexTasks, new Map(drafts.filter((d) => d.action === 'create').map((d) => [d.path, d.content])));
  heldBack.push(...wave2.orphaned);
  const writable2 = wave2.tasks.filter(fits);
  if (writable2.length) {
    log(`Writer: ${writable2.length} index update(s)`);
    collect(writable2, await L.mapConcurrent(writable2, cfg.writer_concurrency, (a) => writeDoc(a)));
  }
  log(`Writer: ${drafts.length} draft(s)` + (heldBack.length ? `, ${heldBack.length} held back` : ''));

  // 5.9 checker in batches, then at most one correction per file; a delete is never corrected
  const toCheck = [...drafts.map((d) => ({ ...d, editDiff: L.unifiedDiff(d.current ?? '', d.content, d.path) })), ...deletes];
  let verdicts = new Map();
  if (toCheck.length) {
    const r = await L.checkInBatches(toCheck, {
      budget: cfg.checker_batch_tokens,
      concurrency: cfg.writer_concurrency,
      check: async (batch, i, n) => {
        const res = await callModel(models.checker, n > 1 ? `checker ${i + 1}/${n}` : 'checker', {
          system: L.CHECKER_SYSTEM,
          blocks: [{ text: L.checkerUser({ narrative, diff: packed.diff, manifest: manifestText, stale: staleText, docs: batch }) }],
          maxTokens: cfg.response_max_tokens,
        });
        return L.parseChecker(res.text);
      },
    });
    verdicts = r.verdicts;
    for (const f of r.failed)
      warn(`checker ${f.error ? `failed (${f.error.message})` : 'returned unparseable output'}; proceeding unchecked for ${f.paths.join(', ')}`);
  }
  const toCorrect = [];
  let candidates = [];
  for (const d of toCheck) {
    const decision = L.decideAfterCheck(verdicts.get(d.path), d.action);
    const entry = { ...d, check: decision };
    if (decision.action === 'drop') heldBack.push({ path: d.path, reason: 'checker: drop' + (decision.issues.length ? ` (${decision.issues.map((i) => i.note).join('; ')})` : '') });
    else if (decision.action === 'correct') toCorrect.push(entry);
    else candidates.push(entry);
  }
  // A delete the checker dropped takes its link fix-ups with it, before a correction is spent.
  const alive = new Set([...toCorrect, ...candidates].map((d) => d.path));
  const correctable = L.dropOrphanedDependents(toCorrect, alive);
  heldBack.push(...correctable.orphaned);
  const pruned = L.dropOrphanedDependents(candidates, alive);
  heldBack.push(...pruned.orphaned);
  candidates = pruned.kept;
  if (correctable.kept.length) {
    log(`Correction pass for ${correctable.kept.length} file(s)`);
    const corrected = await L.mapConcurrent(correctable.kept, cfg.writer_concurrency, (d) =>
      writeDoc(d, '\n\n' + L.correctionPart({ draft: d.content, issues: d.check.issues }))
    );
    correctable.kept.forEach((d, i) => {
      const content = corrected[i].content;
      if (content == null) warn(`correction for ${d.path} ${corrected[i].error ? 'failed' : 'unparseable'}; keeping the first draft`);
      candidates.push({ ...d, content: content ?? d.content, corrected: content != null });
    });
  }

  // 5.10 gates
  const format = candidates.some((c) => c.action !== 'delete') ? makeFormatter(cfg) : { mode: 'off' };
  const gated = L.runGates(candidates, {
    isEditableDoc,
    readCurrent,
    readTarget: readCheckout,
    // Carried-forward creates live on the rolling branch only, so links to them must resolve.
    existsInCheckout: (p) => carried.has(p) || existsSync(join(ROOT, p)),
    carriedDeletes: tombstones,
    guidelineFiles,
    format,
  });
  const { dropped } = gated;
  heldBack.push(...gated.orphaned);
  const keptEdits = new Map(gated.kept.filter((k) => k.action !== 'delete').map((k) => [k.path, k.content]));
  const gone = new Set(gated.kept.filter((k) => k.action === 'delete').map((k) => k.path));
  // An earlier run's create, edited again, is still new to the target.
  const kept = L.markNewDocLinks(
    gated.kept.filter((k) => k.action !== 'delete').map((k) => (k.action === 'update' && !treeEntry(head, k.path) ? { ...k, action: 'create' } : k)),
    allMarkdown.filter((p) => !keptEdits.has(p) && !gone.has(p)).map((p) => ({ path: p, content: readCurrent(p) }))
  );
  // On the final content, so a link fix-up that was held back still shows.
  const finalInbound = L.inboundLinks(
    [...new Set([...allMarkdown, ...keptEdits.keys()])].map((p) => ({ path: p, content: keptEdits.has(p) ? keptEdits.get(p) : readCurrent(p) })),
    [...gone, ...reviewerRemoved.keys()]
  );
  const keptDeletes = L.flagBrokenInbound(gated.kept.filter((k) => k.action === 'delete'), finalInbound);

  // ------------------------------------------------------------- summary ---

  log('\n===== RESULT =====');
  log(`Range ${from.slice(0, 7)}..${head.slice(0, 7)} on ${TARGET_BRANCH}; rolling branch ${cfg.branch}`);
  for (const k of kept) {
    const notes = [];
    if (k.check?.unchecked) notes.push('unchecked');
    else if (k.corrected) notes.push(`corrected after: ${k.check.issues.map((i) => `[${i.severity}] ${i.note}`).join('; ')}`);
    else if (k.check?.issues?.length) notes.push(`checker notes: ${k.check.issues.map((i) => `[${i.severity}] ${i.note}`).join('; ')}`);
    if (k.dashesFixed) notes.push(`${k.dashesFixed} dash line(s) fixed`);
    if (k.action === 'create') notes.push(k.linkedFrom.length ? `linked from ${k.linkedFrom.join(', ')}` : 'not linked from any doc');
    log(`KEEP ${k.action} ${k.path} -- ${k.reason}` + (notes.length ? `\n     ${notes.join('\n     ')}` : ''));
    for (const f of k.flags) {
      if (f.kind === 'guideline_edit') log(`     FLAG guideline file edited; full diff:\n${f.detail.replace(/^/gm, '       ')}`);
      else log(`     FLAG ${f.kind}: ${f.detail.join(', ')}`);
    }
  }
  for (const d of keptDeletes) {
    log(`DELETE ${d.path} -- ${d.reason}` + (d.check?.unchecked ? '\n     unchecked' : ''));
    for (const f of d.flags) {
      if (f.kind === 'guideline_delete') log(`     FLAG guideline file deleted; removed content:\n${f.detail.replace(/^/gm, '       ')}`);
      else log(`     FLAG ${f.kind}: ${f.detail.join(', ')}`);
    }
  }
  for (const d of dropped) log(`DROP ${d.path} -- gate ${d.gate}: ${d.reason}`);
  for (const h of heldBack) log(`HELD ${h.path} -- ${h.reason}`);
  const keptPaths = new Set([...kept, ...keptDeletes].map((k) => k.path));
  for (const { path: p, kind, reason } of staleCarried)
    log(
      `STALE carried ${kind} discarded, ${reason ?? `target changed ${p}`}; ` +
        (keptPaths.has(p) ? 'redone this run' : `not reselected (force with since=${L.regenerateFrom(prevRuns, p, carryBase)})`)
    );
  const reviewer = [
    ...decisions.map((d) => ({
      ...d,
      fixed: (linkPlan.reviewerFixups.get(d.path) ?? []).filter((q) => keptEdits.has(q)),
      linkers: [...(finalInbound.get(d.path) ?? [])].sort(),
      requeued: (revertedFixups.get(d.path) ?? []).map((q) => ({ path: q, redone: keptPaths.has(q) })),
      flags: reviewerRemoved.has(d.path) && L.isGuidelineFile(d.path, guidelineFiles) ? [{ kind: 'guideline_delete', detail: L.unifiedDiff(readCheckout(d.path) ?? '', '', d.path) }] : [],
    })),
    ...discardedReviewer.map((d) => ({ kind: 'discarded', path: d.path })),
  ];
  for (const r of reviewer)
    log(
      `REVIEWER ${r.kind === 'discarded' ? `delete of ${r.path} discarded, ${TARGET_BRANCH} changed the file` : L.describeDecision(r)}` +
        (r.fixed?.length ? `; links fixed in ${r.fixed.join(', ')}` : '') +
        (r.linkers?.length ? `; still linked from ${r.linkers.join(', ')}` : '') +
        (r.requeued?.length ? `; fix-ups sent back to triage: ${r.requeued.map((q) => `${q.path} (${q.redone ? 'redone' : 'not reselected'})`).join(', ')}` : '')
    );
  for (const p of obsolete) log(`OBSOLETE carried change dropped, target deleted ${p}`);
  for (const d of delPlan.suggested) log(`SUGGESTED deletion (not acted on): ${d.path} -- ${d.reason} (${d.why})`);
  if (carried.size) log(`CARRIED forward from earlier runs: ${[...carried.keys()].join(', ')}`);
  if (tombstones.size) log(`CARRIED deletes from earlier runs: ${[...tombstones].join(', ')}`);
  if (packed.omitted.length) log(`DIFF over budget, not shown to the models: ${packed.omitted.join(', ')}`);
  log(costLine(usage));

  if (!keptPaths.size && !mustRefresh) {
    moveCursor('Nothing survived the gates; the rolling PR is left as it is');
    return;
  }

  // ------------------------------------------------------------- publish ---

  const scope = L.commitScope(cfg.branch);
  const carriedOnly = [...carried.keys()].filter((p) => !keptPaths.has(p));
  const carriedDeletesOnly = [...tombstones].filter((p) => !keptPaths.has(p));
  const toolCarriedDeletes = carriedDeletesOnly.filter((p) => !reviewerRemoved.has(p));
  const title = L.prTitle({ scope, target: TARGET_BRANCH, to: head });
  const prBody = L.renderPrBody({
    repo: REPO,
    target: TARGET_BRANCH,
    from,
    to: head,
    commitCount: count,
    capped,
    runUrl: RUN_URL,
    kept,
    deleted: keptDeletes,
    reviewer,
    carried: [
      ...carriedOnly.map((p) => ({ path: p, run: L.lastRunFor(prevRuns, p), created: !treeEntry(head, p) })),
      ...toolCarriedDeletes.map((p) => ({ path: p, run: L.lastRunFor(prevRuns, p), deleted: true })),
    ],
    stale: staleCarried.filter((x) => !x.reason).map(({ path: p, kind }) => ({ path: p, kind, since: L.regenerateFrom(prevRuns, p, carryBase), redone: keptPaths.has(p) })),
    dropped,
    heldBack,
    suggestedDeletes: delPlan.suggested,
    omittedDiff: packed.omitted,
    outline: L.narrativeOutline({ commits, linked, prs }),
    usage: { entries: usage.entries, total: usage.total(), unpriced: usage.unpriced() },
    runs: [...prevRuns, { at: new Date().toISOString(), from, to: head, files: [...keptPaths] }],
  });

  if (DRY_RUN) {
    log(`\n===== DRY RUN -- would push ${cfg.branch} and ${openPr ? `update PR #${openPr.number}` : 'open a PR'} =====`);
    log(
      `Files: ${[...keptPaths].join(', ')}` +
        (carriedOnly.length ? `; carried: ${carriedOnly.join(', ')}` : '') +
        (carriedDeletesOnly.length ? `; carried deletes: ${carriedDeletesOnly.join(', ')}` : '')
    );
    if (decisions.length) log(`Commit message would record:\n${L.renderReviewerDecisions(decisions).join('\n')}`);
    for (const k of kept) log(`\n${L.unifiedDiff(k.current ?? '', k.content, k.path) || `(no textual diff for ${k.path})`}`);
    for (const d of keptDeletes) log(`\n${L.unifiedDiff(d.current, '', d.path) || `(${d.path} is empty; deleted)`}`);
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
    for (const p of [...keptDeletes.map((d) => d.path), ...carriedDeletesOnly]) git(['update-index', '--force-remove', '--', p], { env });
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
    input: L.commitMessage({
      scope,
      from,
      to: head,
      target: TARGET_BRANCH,
      files: kept.map((k) => k.path),
      deleted: keptDeletes.map((d) => d.path),
      carried: carriedOnly,
      carriedDeleted: toolCarriedDeletes,
      reviewerDeleted: carriedDeletesOnly.filter((p) => reviewerRemoved.has(p)),
      decisions,
      runUrl: RUN_URL,
    }),
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
        description:
          `${kept.filter((k) => k.action === 'create').length} new, ${kept.filter((k) => k.action !== 'create').length} edited, ${keptDeletes.length} deleted, ${dropped.length + heldBack.length} held back` +
          (decisions.length ? `, ${decisions.length} reviewer change(s)` : ''),
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
