import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VERSION,
  DEFAULTS,
  PRICES,
  EFFORT_MODELS,
  loadConfig,
  parseYamlSubset,
  globToRegex,
  canonicalise,
  makeIsEditableDocPath,
  makeIsEditableDoc,
  hasSymlinkComponent,
  validateRollingBranch,
  selectRange,
  parseGitLog,
  prNumberFromSubject,
  cleanPrBody,
  collectPrs,
  buildNarrative,
  parseNameStatus,
  classifyChanges,
  splitUnifiedDiff,
  packDiff,
  extractRelativeLinks,
  resolveLink,
  buildManifest,
  renderManifest,
  planCarryForward,
  foreignBranchCommit,
  collectAgentsFiles,
  loadGuidelines,
  lineDiff,
  addedLineIndexes,
  unifiedDiff,
  parseTriage,
  parseWriterOutput,
  parseChecker,
  decideAfterCheck,
  pickModels,
  effortConfig,
  anthropicCall,
  openaiCall,
  makeUsageLog,
  mapConcurrent,
  gateAllowlist,
  gateNonEmpty,
  gateLinks,
  gateSize,
  gateStyle,
  gateFlags,
  gateFormat,
  runGates,
  defuse,
  approxTokens,
  isBotEmail,
  BOT_EMAIL,
  fetchRetry,
  isRetryableStatus,
  isTransientError,
  costOf,
  narrativeOutline,
  defuseRefs,
  inlineCode,
  codeBlock,
  commitScope,
  commitMessage,
  prTitle,
  gitAuthEnv,
  parseMarker,
  renderMarker,
  lastRunFor,
  regenerateFrom,
  renderStaleBlock,
  triageUser,
  writerPrefix,
  checkerUser,
  TRIAGE_SYSTEM,
  CHECKER_SYSTEM,
  WRITER_SYSTEM,
  renderPrBody,
  PR_BODY_MAX,
  planDeletes,
  inboundLinks,
  applyInboundLinks,
  flagBrokenInbound,
  dropOrphanedDependents,
  batchByTokens,
  checkInBatches,
  blobUrl,
  MARKER_MAX_CHARS,
  createPlacement,
  pickExemplar,
  findIndexDoc,
  planCreates,
  finaliseIndexTasks,
  markNewDocLinks,
  writerDocPart,
  isToolCommit,
  classifyReviewerChanges,
  parseReviewerDecisions,
  renderReviewerDecisions,
  reconcileReviewerCarry,
  fixupsOfRevertedDelete,
  applyReviewerDecisions,
  renderReviewerBlock,
} from '../lib.mjs';

const CFG_TEXT = `
doc_paths:
  - README.md
  - AGENTS.md
  - docs/**/*.md
  - apps/*/README.md
  - apps/*/docs/**/*.md
never_touch:
  - docs/superpowers/specs/**   # dated design records
extra_ignore:
  - flake.lock
  - 'apps/cms/src/app/(payload)/admin/importMap.js'
guidelines_files:
  - AGENTS.md
  - CLAUDE.md
`;

const cfg = () => loadConfig(CFG_TEXT);

function tmpRepo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-docs-sync-'));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return root;
}

test('lib.mjs imports without side effects', () => {
  assert.equal(typeof VERSION, 'string');
});

// ------------------------------------------------------------------- phase 1 ---

describe('config', () => {
  test('parses the documented subset with comments and quotes', () => {
    const parsed = parseYamlSubset(CFG_TEXT);
    assert.deepEqual(parsed.never_touch, ['docs/superpowers/specs/**']);
    assert.deepEqual(parsed.extra_ignore, ['flake.lock', 'apps/cms/src/app/(payload)/admin/importMap.js']);
  });

  test('inline flow lists parse like block lists', () => {
    const parsed = parseYamlSubset(`doc_paths: [docs/**/*.md, 'README.md', "apps/*/README.md"]  # inline\nnever_touch: []\n`);
    assert.deepEqual(parsed.doc_paths, ['docs/**/*.md', 'README.md', 'apps/*/README.md']);
    assert.deepEqual(parsed.never_touch, []);
    const isDoc = makeIsEditableDocPath(loadConfig('doc_paths: [docs/**/*.md, README.md]\n'));
    assert.ok(isDoc('docs/a/b.md'));
    assert.ok(isDoc('README.md'));
  });

  test('applies defaults and appends extra_ignore to the built-in list', () => {
    const c = cfg();
    assert.equal(c.branch, 'docs/repo/sync');
    assert.equal('max_docs_per_run' in c, false);
    assert.equal(c.format_check, 'off');
    assert.ok(c.ignore.includes('**/pnpm-lock.yaml'));
    assert.ok(c.ignore.includes('flake.lock'));
  });

  test('warns on and ignores centrally owned keys, and does not leak their list items', () => {
    const warnings = [];
    const c = loadConfig(`${CFG_TEXT}\nanthropic_writer_model: claude-haiku-4-5\nignore:\n  - '**/*.ts'\n`, { warn: (m) => warnings.push(m) });
    assert.equal(c.anthropic_writer_model, DEFAULTS.anthropic_writer_model);
    assert.equal(warnings.length, 2);
    assert.ok(!c.guidelines_files.includes('**/*.ts'));
    assert.ok(!c.ignore.includes('**/*.ts'));
  });

  test('max_docs_per_run gets the removed-key warning, not the centrally-owned one, and is ignored', () => {
    const warnings = [];
    const c = loadConfig(`${CFG_TEXT}\nmax_docs_per_run: 3\n`, { warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /max_docs_per_run was removed; every affected doc is written/);
    assert.ok(!/owned centrally/.test(warnings[0]));
    assert.equal('max_docs_per_run' in c, false);
    assert.ok(!('max_docs_per_run' in DEFAULTS));
  });

  test('doc_paths is required', () => {
    assert.throws(() => loadConfig('label: x\n'), /doc_paths is required/);
    assert.throws(() => loadConfig('doc_paths:\n'), /doc_paths is required/);
  });

  test('format_check is validated and strict needs setup_command', () => {
    assert.throws(() => loadConfig(`${CFG_TEXT}\nformat_check: warn\n`), /format_check/);
    assert.throws(() => loadConfig(`${CFG_TEXT}\nformat_check: strict\n`), /setup_command/);
    const c = loadConfig(`${CFG_TEXT}\nformat_check: strict\nsetup_command: 'pnpm install'\n`);
    assert.equal(c.format_check, 'strict');
  });
});

describe('allowlist predicate', () => {
  test('the glob alone is traversable, which is why canonicalise runs first', () => {
    assert.ok(globToRegex('docs/**/*.md').test('docs/../../x.md'));
  });

  test('canonicalise rejects traversal, dot segments, absolute paths and odd bytes', () => {
    assert.equal(canonicalise('docs/../../x.md'), null);
    assert.equal(canonicalise('docs/./x.md'), null);
    assert.equal(canonicalise('/etc/passwd.md'), null);
    assert.equal(canonicalise('docs\\x.md'), null);
    assert.equal(canonicalise('docs/x\0.md'), null);
    assert.equal(canonicalise(''), null);
    assert.equal(canonicalise('docs//x.md'), 'docs/x.md');
  });

  test('doc_paths, never_touch precedence, .md-only rule and the denylist', () => {
    const ok = makeIsEditableDocPath(cfg());
    assert.equal(ok('README.md'), true);
    assert.equal(ok('docs/api/architecture.md'), true);
    assert.equal(ok('apps/api/README.md'), true);
    assert.equal(ok('apps/api/src/README.md'), false, 'one level deep on purpose');
    assert.equal(ok('docs/superpowers/specs/2026-01-01-x.md'), false, 'never_touch wins');
    assert.equal(ok('docs/api/diagram.png'), false, '.md only');
    assert.equal(ok('docs/api/notes.mdx'), false);
    assert.equal(ok('.github/docs-sync.md'), false, 'denylist');
    assert.equal(ok('docs/node_modules/x/README.md'), false, 'denylist');
    assert.equal(ok('content/blog/post.md'), false, 'outside doc_paths');
    assert.equal(ok('docs/../../x.md'), false);
    assert.equal(ok('docs/./x.md'), false);
    const broad = makeIsEditableDocPath(loadConfig('doc_paths:\n  - "**/*.md"\n'));
    assert.equal(broad('.ai-docs-sync/README.md'), false, "the tool's own checkout in the consumer tree");
    assert.equal(broad('docs/x.md'), true);
  });

  test('a symlinked file or directory component is rejected on disk', () => {
    const root = tmpRepo({ 'docs/real.md': '# real\n', 'secret/x.md': '# s\n' });
    symlinkSync(join(root, 'secret'), join(root, 'docs', 'link'));
    symlinkSync(join(root, 'secret', 'x.md'), join(root, 'docs', 'file.md'));
    try {
      assert.equal(hasSymlinkComponent(root, 'docs/real.md'), false);
      assert.equal(hasSymlinkComponent(root, 'docs/link/x.md'), true);
      assert.equal(hasSymlinkComponent(root, 'docs/file.md'), true);
      assert.equal(hasSymlinkComponent(root, 'docs/new.md'), false, 'a file to be created is fine');
      const ok = makeIsEditableDoc(cfg(), root);
      assert.equal(ok('docs/real.md'), true);
      assert.equal(ok('docs/link/x.md'), false);
      assert.equal(ok('docs/file.md'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rolling branch name validation', () => {
    const ctx = { targetBranch: 'develop', defaultBranch: 'main' };
    validateRollingBranch('docs/repo/sync', ctx);
    assert.throws(() => validateRollingBranch('develop', ctx), /target branch/);
    assert.throws(() => validateRollingBranch('main', ctx), /default branch/);
    assert.throws(() => validateRollingBranch('docs/$(rm)', ctx), /Refusing/);
    assert.throws(() => validateRollingBranch('-x', ctx), /Refusing/);
  });
});

describe('range selection', () => {
  const anc = (set) => (sha) => set.has(sha);
  test('since wins when it is an ancestor and fails loudly otherwise', () => {
    assert.deepEqual(selectRange({ since: 'aaa', cursor: 'bbb' }, anc(new Set(['aaa', 'bbb']))), { from: 'aaa', source: 'since' });
    assert.throws(() => selectRange({ since: 'zzz', cursor: 'bbb' }, anc(new Set(['bbb']))), /not an ancestor/);
  });
  test('cursor beats push_before; push_before needs a real, unforced, present sha', () => {
    assert.equal(selectRange({ cursor: 'bbb', pushBefore: 'ccc' }, anc(new Set(['bbb', 'ccc']))).source, 'cursor');
    assert.equal(selectRange({ cursor: 'gone', pushBefore: 'ccc' }, anc(new Set(['ccc']))).source, 'push_before');
    assert.equal(selectRange({ pushBefore: '0000000000000000000000000000000000000000' }, anc(new Set())).source, 'head~1');
    assert.equal(selectRange({ pushBefore: 'ccc', pushForced: 'true' }, anc(new Set(['ccc']))).source, 'head~1');
    assert.equal(selectRange({}, anc(new Set())).from, 'HEAD~1');
  });
});

describe('narrative', () => {
  const LOG =
    'sha1\0abc1234\0Ann\0ann@example.com\0ann@example.com\0p0\0refactor(web): post funnel forms to apps/api (#153)\0Moves the intake POST.\n\n- squashed one\n- squashed two\n\x01' +
    '\nsha2\0abc2345\0Bob\0bob@example.com\0noreply@github.com\0p1 p2\0Merge pull request #154 from org/feature\0\x01' +
    '\nsha3\0abc3456\0Cy\0cy@example.com\0merger@example.com\0p3\0feat(web): list legal links\0Body three.\x01' +
    `\nsha4\0abc4567\0Bot\0${BOT_EMAIL}\0${BOT_EMAIL}\0p4\0docs(repo): sync with 1..2\0Range: x\x01` +
    '\nsha5\0abc5678\0Di\0di@example.com\0merger@example.com\0p5\0chore(deps): bump\0\x01';

  test('parses the git log record format', () => {
    const commits = parseGitLog(LOG);
    assert.equal(commits.length, 5);
    assert.equal(commits[2].authorEmail, 'cy@example.com');
    assert.equal(commits[2].email, 'merger@example.com');
    assert.deepEqual(commits[1].parents, ['p1', 'p2']);
    assert.equal(commits[0].body, 'Moves the intake POST.\n\n- squashed one\n- squashed two');
    assert.equal(prNumberFromSubject(commits[0].subject), 153);
    assert.equal(prNumberFromSubject(commits[1].subject), 154);
    assert.equal(prNumberFromSubject(commits[2].subject), null);
    assert.ok(isBotEmail(commits[3].email));
    assert.ok(isBotEmail('12345+docs-bot[bot]@users.noreply.github.com'));
    assert.ok(!isBotEmail('ann@example.com'));
  });

  test('PR bodies lose HTML comments and template checkboxes', () => {
    assert.equal(cleanPrBody('Real text\n<!-- template -->\n- [ ] I ran the tests\n- [x] done\nMore'), 'Real text\n\nMore');
  });

  test('links commits to PRs: subjects free, one lookup per PR, caps, filters base and the rolling PR', async () => {
    const commits = parseGitLog(LOG);
    const calls = { pr: [], pulls: [], prCommits: [] };
    const api = {
      pr: async (n) => {
        calls.pr.push(n);
        if (n === 153) return { number: 153, title: 'funnel', body: 'b', head: { ref: 'web/funnel' }, base: { ref: 'develop' }, user: { login: 'ann' }, labels: [{ name: 'web' }] };
        if (n === 154) return { number: 154, title: 'rolling', body: '', head: { ref: 'docs/repo/sync' }, base: { ref: 'develop' } };
        throw new Error('404');
      },
      pullsForCommit: async (sha) => {
        calls.pulls.push(sha);
        if (sha === 'sha3') return [{ number: 160, title: 'legal', body: 'x', head: { ref: 'f' }, base: { ref: 'develop' } }];
        return [];
      },
      prCommits: async (n) => {
        calls.prCommits.push(n);
        // sha3 by SHA; sha5 as a rebased commit: new SHA, same subject and author.
        return [{ sha: 'sha3', subject: 'feat(web): list legal links', email: 'cy@example.com' }, { sha: 'rebased-away', subject: 'chore(deps): bump', email: 'di@example.com' }];
      },
    };
    const { linked, prs, lookups } = await collectPrs(commits, api, { targetBranch: 'develop', rollingBranch: 'docs/repo/sync' });
    assert.equal(linked.get('sha1'), 153);
    assert.equal(linked.get('sha3'), 160);
    assert.equal(linked.get('sha5'), 160, 'marked via prCommits by subject + author, not looked up');
    assert.deepEqual(calls.pulls, ['sha3'], 'merge commits and bot commits are never looked up');
    assert.ok(prs.has(153) && prs.has(160));
    assert.ok(!prs.has(154), 'rolling PR excluded');
    assert.equal(lookups, 1);
    assert.deepEqual(prs.get(153).labels, ['web']);
  });

  test('lookup cap is honoured', async () => {
    const commits = Array.from({ length: 5 }, (_, i) => ({ sha: `s${i}`, short: `s${i}`, authorEmail: 'x@y', email: 'x@y', parents: ['p'], subject: `c${i}`, body: '' }));
    let n = 0;
    const api = { pr: async () => null, pullsForCommit: async () => (n++, []), prCommits: async () => [] };
    const r = await collectPrs(commits, api, { targetBranch: 'develop', rollingBranch: 'r', maxLookups: 2 });
    assert.equal(n, 2);
    assert.equal(r.lookupsExhausted, true);
  });

  test('renders PR groups, keeps squash bodies, drops merge boilerplate and bot commits', () => {
    const commits = parseGitLog(LOG);
    const linked = new Map([['sha1', 153], ['sha2', 154]]);
    const prs = new Map([[153, { number: 153, title: 'funnel', body: 'Moves it.', labels: [], head: 'web/funnel', base: 'develop', user: 'ann' }]]);
    const text = buildNarrative({ commits, linked, prs, targetBranch: 'develop', from: 'aaaaaaaaaa', to: 'bbbbbbbbbb' });
    assert.match(text, /^## Change narrative \(develop, aaaaaaa\.\.bbbbbbb\)/);
    assert.match(text, /### PR #153 "funnel" \(ann, head web\/funnel\)\nMoves it\.\n- abc1234 refactor\(web\)/);
    assert.match(text, /  - squashed two/, 'squash body kept whole');
    assert.ok(!text.includes('Merge pull request'), 'merge commit contributes only its PR number');
    assert.ok(!text.includes('docs(repo): sync'), 'bot commit dropped');
    assert.match(text, /### Commits not from a PR\n- abc3456 feat\(web\): list legal links\n  Body three\.\n- abc5678 chore\(deps\): bump/);
  });

  test('packing never drops a subject; bodies are truncated longest first with a marker', () => {
    const commits = Array.from({ length: 10 }, (_, i) => ({
      sha: `sha${i}`,
      short: `sha${i}`,
      authorEmail: 'x@y',
      email: 'x@y',
      parents: ['p'],
      subject: `subject number ${i}`,
      body: i === 3 ? 'L'.repeat(4000) : 'short body',
    }));
    const prs = new Map([[1, { number: 1, title: 't', body: 'P'.repeat(2000), labels: [], head: 'h', base: 'develop', user: 'u' }]]);
    const linked = new Map([['sha0', 1]]);
    const text = buildNarrative({ commits, linked, prs, targetBranch: 'develop', from: 'a', to: 'b', budget: 400 });
    for (let i = 0; i < 10; i++) assert.ok(text.includes(`subject number ${i}`), `subject ${i} present`);
    assert.ok(approxTokens(text) <= 400 + 20, `within budget: ${approxTokens(text)}`);
    assert.ok(!text.includes('L'.repeat(4000)));
    assert.ok(text.includes('[truncated]'));
    assert.ok(text.includes('P'.repeat(200)), 'commit bodies go before PR bodies');
  });
});

describe('changed files and loop guard', () => {
  const isEditableDoc = makeIsEditableDocPath(cfg());
  const isIgnored = (p) => cfg().ignore.some((g) => globToRegex(g).test(p));

  test('parses -z --name-status with renames', () => {
    const z = 'M\0src/a.ts\0R100\0docs/old.md\0docs/new.md\0A\0README.md\0';
    assert.deepEqual(parseNameStatus(z), [
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', path: 'docs/new.md', oldPath: 'docs/old.md' },
      { status: 'A', path: 'README.md' },
    ]);
  });

  test('docs-only pushes (merging the rolling PR) trip the loop guard', () => {
    const r = classifyChanges(parseNameStatus('M\0README.md\0M\0docs/api/architecture.md\0'), { isEditableDoc, isIgnored });
    assert.match(r.skipReason, /loop guard/);
  });

  test('merging a rolling PR that only deletes docs trips the loop guard', () => {
    const r = classifyChanges(parseNameStatus('D\0docs/api/architecture.md\0M\0README.md\0'), { isEditableDoc, isIgnored });
    assert.match(r.skipReason, /loop guard/);
  });

  test('lockfile-only pushes exit as no code files', () => {
    const r = classifyChanges(parseNameStatus('M\0pnpm-lock.yaml\0M\0flake.lock\0M\0README.md\0'), { isEditableDoc, isIgnored });
    assert.match(r.skipReason, /no code files/);
    assert.equal(r.ignored.length, 2);
  });

  test('a code change proceeds and a doc outside doc_paths counts as code', () => {
    const r = classifyChanges(parseNameStatus('M\0apps/api/src/x.ts\0M\0content/blog/a.md\0'), { isEditableDoc, isIgnored });
    assert.equal(r.skipReason, null);
    assert.equal(r.code.length, 2);
  });
});

describe('diff packing', () => {
  const RAW = [
    'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/apps/civi-crm/x.ts b/apps/api/x.ts\nsimilarity index 95%\nrename from apps/civi-crm/x.ts\nrename to apps/api/x.ts\nindex 1..2 100644\n--- a/apps/civi-crm/x.ts\n+++ b/apps/api/x.ts\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/new.ts b/new.ts\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,3 @@\n+1\n+2\n+3\n',
  ].join('');

  test('splits a git diff per file and reports renames as renames', () => {
    const patches = splitUnifiedDiff(RAW);
    assert.deepEqual(patches.map((p) => [p.path, p.status]), [['src/a.ts', 'M'], ['apps/api/x.ts', 'R'], ['new.ts', 'A']]);
    assert.equal(patches[1].oldPath, 'apps/civi-crm/x.ts');
  });

  test('packs smallest first and lists what did not fit', () => {
    const patches = splitUnifiedDiff(RAW);
    const { diff, included, omitted } = packDiff(patches, 75);
    assert.deepEqual(included, ['src/a.ts', 'new.ts']);
    assert.deepEqual(omitted, ['apps/api/x.ts']);
    assert.match(diff, /NOT INCLUDED \(over budget\): apps\/api\/x\.ts/);
    const full = packDiff(patches, 10_000);
    assert.match(full.diff, /--- FILE: apps\/civi-crm\/x\.ts -> apps\/api\/x\.ts \(rename\) ---/);
  });
});

describe('manifest', () => {
  test('extracts relative links only', () => {
    const md = '[a](../api/architecture.md#flow) ![i](./img/x.png) [u](https://x.y/z) [m](mailto:a@b) [h](#top) [t](<docs/spaced file.md> "title")';
    assert.deepEqual(extractRelativeLinks(md), ['../api/architecture.md', './img/x.png', 'docs/spaced file.md']);
  });
  test('resolves links relative to the file, from the repo root for a leading slash, decoded', () => {
    assert.equal(resolveLink('docs/api/a.md', '../b.md'), 'docs/b.md');
    assert.equal(resolveLink('docs/api/a.md', '/docs/setup.md'), 'docs/setup.md');
    assert.equal(resolveLink('README.md', 'my%20file.md'), 'my file.md');
    assert.equal(resolveLink('README.md', '100%.md'), '100%.md');
    assert.equal(resolveLink('docs/a.md', '../../x.md'), null);
    assert.equal(resolveLink('README.md', '/'), '.');
  });

  test('builds and renders entries with heading, size and link directories', () => {
    const m = buildManifest([
      { path: 'docs/api/architecture.md', content: '# API architecture\n\nSee [crm](../civi-crm/architecture.md) and [root](../../README.md).\n' },
      { path: 'README.md', content: 'no heading\n' },
    ]);
    assert.equal(m[0].path, 'README.md');
    assert.equal(m[1].heading, 'API architecture');
    assert.deepEqual(m[1].linkDirs, ['/', 'docs/civi-crm/']);
    assert.match(renderManifest(m), /- docs\/api\/architecture\.md \(\d+ bytes\) "API architecture" links: \/ docs\/civi-crm\//);
  });
});

describe('carry forward (read side) and guidelines', () => {
  test('ownership: tool commits, merges and doc additions, edits and deletes by others are fine; anything else is foreign', () => {
    const m = (path) => ({ status: 'M', path });
    const changes = {
      tool: [m('docs/a.md')],
      merge: [m('src/x.ts')],
      suggestion: [m('docs/a.md'), { status: 'A', path: 'docs/new.md' }],
      code: [m('docs/a.md'), m('src/x.ts')],
      removal: [{ status: 'D', path: 'docs/a.md' }],
      rename: [{ status: 'R', path: 'docs/b.md', oldPath: 'docs/a.md' }],
      copy: [{ status: 'C', path: 'docs/b.md', oldPath: 'docs/a.md' }],
      renameOut: [{ status: 'R', path: 'src/a.md', oldPath: 'docs/a.md' }],
      renameIn: [{ status: 'R', path: 'docs/a.md', oldPath: 'src/a.md' }],
      codeDelete: [{ status: 'D', path: 'src/x.ts' }],
      nonMarkdown: [{ status: 'A', path: 'docs/diagram.png' }],
    };
    const opts = { changesOf: (sha) => changes[sha], isEditableDoc: (f) => f.startsWith('docs/') && f.endsWith('.md') };
    const tool = { sha: 'tool', email: BOT_EMAIL, authorEmail: BOT_EMAIL, parents: ['p'] };
    const web = 'noreply@github.com';
    const merge = { sha: 'merge', email: web, authorEmail: 'human@x', parents: ['a', 'b'] };
    const suggestion = { sha: 'suggestion', email: web, authorEmail: 'human@x', parents: ['p'] };
    const code = { sha: 'code', email: 'human@x', authorEmail: 'human@x', parents: ['p'] };
    assert.equal(foreignBranchCommit([], opts), null, 'nothing on top of the target');
    assert.equal(foreignBranchCommit([tool], opts), null);
    assert.equal(foreignBranchCommit([merge, suggestion, tool], opts), null);
    assert.equal(foreignBranchCommit([code, tool], opts), code);
    assert.equal(foreignBranchCommit([suggestion], opts), suggestion, 'a branch the tool never committed to');
    const removal = { ...suggestion, sha: 'removal' };
    assert.equal(foreignBranchCommit([removal], opts), removal, 'a reviewer delete alone is not a branch the tool owns');
    const rebased = { ...tool, email: web };
    assert.equal(foreignBranchCommit([rebased], opts), null, '"Update with rebase" keeps the tool as author');
    for (const sha of ['removal', 'rename', 'copy']) assert.equal(foreignBranchCommit([{ ...suggestion, sha }, tool], opts), null, `a reviewer ${sha} is carried`);
    for (const sha of ['renameOut', 'renameIn', 'codeDelete', 'nonMarkdown']) {
      const c = { ...suggestion, sha };
      assert.equal(foreignBranchCommit([c, tool], opts), c, `${sha} still refuses`);
    }
  });

  test('carry-forward plan: restore, tombstones, stale by kind, obsolete, ignored', () => {
    const target = new Set(['docs/a.md', 'docs/b.md', 'docs/d.md', 'docs/e.md', 'docs/new-on-target.md']);
    const changedOnTarget = new Set(['docs/b.md', 'docs/e.md', 'docs/gone.md', 'docs/gone-del.md', 'docs/new-on-target.md']);
    const plan = planCarryForward({
      branchChanges: [
        { status: 'M', path: 'docs/a.md' },
        { status: 'M', path: 'docs/b.md' },
        { status: 'A', path: 'docs/c.md' },
        { status: 'D', path: 'docs/d.md' },
        { status: 'D', path: 'docs/e.md' },
        { status: 'M', path: 'docs/gone.md' },
        { status: 'D', path: 'docs/gone-del.md' },
        { status: 'A', path: 'docs/new-on-target.md' },
        { status: 'M', path: 'src/x.ts' },
        { status: 'T', path: 'docs/t.md' },
      ],
      targetHas: (f) => target.has(f),
      targetChangedSinceBase: (f) => changedOnTarget.has(f),
      isEditableDoc: (f) => f.endsWith('.md') && f.startsWith('docs/'),
    });
    assert.deepEqual(plan, {
      restore: ['docs/a.md', 'docs/c.md'],
      restoreDeletes: ['docs/d.md'],
      stale: [
        { path: 'docs/b.md', kind: 'edit' },
        { path: 'docs/e.md', kind: 'delete' },
        { path: 'docs/new-on-target.md', kind: 'edit' },
      ],
      obsolete: ['docs/gone.md', 'docs/gone-del.md'],
      ignored: ['src/x.ts', 'docs/t.md'],
    });
  });

  test('AGENTS.md files are gathered from the root and touched directories', () => {
    const root = tmpRepo({ 'AGENTS.md': 'root', 'apps/api/AGENTS.md': 'api', 'apps/web/AGENTS.md': 'web', 'CLAUDE.md': 'claude' });
    try {
      assert.deepEqual(collectAgentsFiles(root, ['apps/api/src/x.ts', '../escape']), ['AGENTS.md', 'apps/api/AGENTS.md']);
      const g = loadGuidelines(cfg(), root, ['apps/api/src/x.ts'], (f) => `<${f}>`);
      assert.deepEqual(g.files, ['AGENTS.md', 'apps/api/AGENTS.md']);
      assert.match(g.text, /--- AGENTS\.md ---\n<AGENTS\.md>\n\n--- apps\/api\/AGENTS\.md ---/);
      rmSync(join(root, 'AGENTS.md'));
      rmSync(join(root, 'apps'), { recursive: true });
      assert.deepEqual(loadGuidelines(cfg(), root, [], (f) => `<${f}>`).files, ['CLAUDE.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------- phase 2 ---

describe('triage parser', () => {
  const existing = new Set(['docs/api/architecture.md', 'docs/civi-crm/architecture.md']);
  const opts = { isEditableDocPath: makeIsEditableDocPath(cfg()), exists: (p) => existing.has(p) };
  test('accepts a good answer, decides the action from existence, drops disallowed paths, never caps', () => {
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify({
      affected: [
        { path: 'docs/api/architecture.md', action: 'create', reason: 'moved', source_files: ['apps/api/x.ts', '../../evil'] },
        { path: 'content/blog/x.md', action: 'update', reason: 'no' },
        { path: 'docs/../../x.md', action: 'update', reason: 'no' },
        { path: 'apps/api/README.md', action: 'update', reason: 'new app' },
        { path: 'docs/api/architecture.md', action: 'update', reason: 'dupe' },
        ...Array.from({ length: 12 }, (_, i) => ({ path: `docs/extra-${i}.md`, action: 'create', reason: 'more' })),
      ],
      delete_candidates: [{ path: 'docs/civi-crm/architecture.md', reason: 'legacy field' }],
      unaffected_reason: '',
    })}\n\`\`\``;
    const r = parseTriage(text, opts);
    assert.deepEqual(r.affected.slice(0, 2).map((a) => [a.path, a.action]), [['docs/api/architecture.md', 'update'], ['apps/api/README.md', 'create']]);
    assert.equal(r.affected.length, 14, 'no per-run cap');
    assert.deepEqual(r.affected[0].source_files, ['apps/api/x.ts']);
    assert.deepEqual(r.dropped.map((d) => d.path), ['content/blog/x.md', 'docs/../../x.md']);
    assert.equal('overflow' in r, false);
    assert.deepEqual(r.deletes, [], 'legacy delete_candidates ignored');
  });
  test('a delete is kept for an existing doc and dropped for a missing one', () => {
    const r = parseTriage(
      JSON.stringify({
        affected: [
          { path: 'docs/civi-crm/architecture.md', action: 'delete', reason: 'CRM app removed', source_files: ['apps/civi-crm/index.ts'] },
          { path: 'docs/never-was.md', action: 'delete', reason: 'x' },
        ],
      }),
      opts
    );
    assert.deepEqual(r.deletes, [{ path: 'docs/civi-crm/architecture.md', action: 'delete', reason: 'CRM app removed', source_files: ['apps/civi-crm/index.ts'] }]);
    assert.deepEqual(r.affected, []);
    assert.deepEqual(r.dropped, [{ path: 'docs/never-was.md', reason: 'delete of a doc that does not exist' }]);
  });
  test('delete beats update on the same path, in either order', () => {
    for (const order of [['update', 'delete'], ['delete', 'update']]) {
      const r = parseTriage(JSON.stringify({ affected: order.map((action) => ({ path: 'docs/api/architecture.md', action, reason: action })) }), opts);
      assert.deepEqual(r.deletes.map((d) => d.path), ['docs/api/architecture.md'], order.join(','));
      assert.deepEqual(r.affected, []);
    }
  });
  test('returns null on unparseable or schema-less output', () => {
    assert.equal(parseTriage('not json', opts), null);
    assert.equal(parseTriage('{"foo": 1}', opts), null);
  });
  test('empty affected is a valid, complete answer', () => {
    const r = parseTriage('{"affected": [], "unaffected_reason": "deps only"}', opts);
    assert.equal(r.affected.length, 0);
    assert.equal(r.unaffectedReason, 'deps only');
  });
  test('the prompt offers delete and no longer asks for delete_candidates', () => {
    assert.match(TRIAGE_SYSTEM, /"update" \| "create" \| "delete"/);
    assert.ok(!TRIAGE_SYSTEM.includes('delete_candidates'));
  });
});

describe('delete plan', () => {
  const del = (path, source_files) => ({ path, action: 'delete', reason: 'gone', source_files });
  const readCurrent = (p) => `# ${p}\n`;
  test('kept with a cited code path in range, downgraded to a suggestion with none', () => {
    const r = planDeletes({ deletes: [del('docs/a.md', ['apps/a/index.ts']), del('docs/b.md', ['README.md']), del('docs/c.md', [])], codePaths: new Set(['apps/a/index.ts']), readCurrent });
    assert.deepEqual(r.deletes.map((d) => d.path), ['docs/a.md']);
    assert.equal(r.deletes[0].current, '# docs/a.md\n');
    assert.deepEqual(r.suggested.map((d) => [d.path, d.why]), [['docs/b.md', 'no cited source file is in the diff'], ['docs/c.md', 'no cited source file is in the diff']]);
  });
  test('a path from the earlier (stale) diff or the old side of a rename counts', () => {
    const codePaths = new Set(['apps/old/x.ts', 'apps/new/x.ts', 'apps/earlier.ts']);
    const r = planDeletes({ deletes: [del('docs/a.md', ['apps/old/x.ts']), del('docs/b.md', ['apps/earlier.ts'])], codePaths, readCurrent });
    assert.equal(r.deletes.length, 2);
  });
  test('a guideline delete is flagged with the removed content as the diff', () => {
    const r = planDeletes({ deletes: [del('apps/api/AGENTS.md', ['apps/api/x.ts'])], codePaths: new Set(['apps/api/x.ts']), readCurrent, guidelineFiles: new Set() });
    const g = r.deletes[0].flags.find((f) => f.kind === 'guideline_delete');
    assert.match(g.detail, /^--- a\/apps\/api\/AGENTS\.md\n\+\+\+ b\/apps\/api\/AGENTS\.md\n@@ -1,1 \+0,0 @@\n-# apps\/api\/AGENTS\.md\n$/);
  });
});

describe('inbound links to deleted docs', () => {
  const files = [
    { path: 'README.md', content: '# r\n\nSee [crm](/docs/civi%20crm/arch.md) and [api](docs/api.md).\n' },
    { path: 'docs/api.md', content: '# api\n\n```md\n[example](./civi%20crm/arch.md)\n```\nNo live link here.\n' },
    { path: 'docs/guide.md', content: '# g\n\n[crm](civi%20crm/arch.md#setup)\n' },
    { path: 'docs/civi crm/other.md', content: '[sibling](./arch.md)\n' },
    { path: 'docs/specs/old.md', content: '[crm](../civi%20crm/arch.md)\n' },
    { path: 'docs/civi crm/arch.md', content: '[self](./arch.md)\n' },
  ];
  const deleted = ['docs/civi crm/arch.md', 'docs/civi crm/other.md'];
  test('finds linkers, resolving root and percent-encoded links, skipping fences and deleted docs', () => {
    const inbound = inboundLinks(files, deleted);
    assert.deepEqual(inbound.get('docs/civi crm/arch.md'), ['README.md', 'docs/guide.md', 'docs/specs/old.md']);
    assert.deepEqual(inbound.get('docs/civi crm/other.md'), []);
  });
  test('editable linker gets a dependent task; an affected one gets the reason appended; a non-editable one is flagged', () => {
    const inbound = inboundLinks(files, deleted);
    const deletes = [{ path: 'docs/civi crm/arch.md', action: 'delete', reason: 'the CRM app was removed', source_files: ['apps/crm/x.ts'], flags: [] }];
    const affected = [{ path: 'README.md', action: 'update', reason: 'New app listed.', source_files: ['apps/new/x.ts'] }];
    const r = applyInboundLinks({ affected, deletes, inbound, isEditableDoc: (p) => !p.startsWith('docs/specs/') });
    const readme = r.affected.find((a) => a.path === 'README.md');
    assert.equal(readme.reason, 'New app listed. Also remove or retarget the link(s) to docs/civi crm/arch.md, deleted this run because the CRM app was removed.');
    assert.equal(readme.dependsOn, undefined);
    assert.deepEqual(r.affected.find((a) => a.path === 'docs/guide.md'), {
      path: 'docs/guide.md',
      action: 'update',
      reason: 'Remove or retarget the link(s) to docs/civi crm/arch.md, deleted this run because the CRM app was removed.',
      source_files: ['apps/crm/x.ts'],
      dependsOn: ['docs/civi crm/arch.md'],
    });
    assert.deepEqual(r.deletes[0].flags, [{ kind: 'broken_inbound_links', detail: ['docs/specs/old.md'] }]);
    assert.equal(affected[0].reason, 'New app listed.', 'input not mutated');
  });
  test('flagBrokenInbound replaces an earlier flag and drops it when nothing links', () => {
    const d = [{ path: 'x.md', flags: [{ kind: 'broken_inbound_links', detail: ['a.md'] }, { kind: 'guideline_delete', detail: '' }] }];
    assert.deepEqual(flagBrokenInbound(d, new Map([['x.md', ['c.md', 'b.md']]]))[0].flags.map((f) => f.detail), ['', ['b.md', 'c.md']]);
    assert.deepEqual(flagBrokenInbound(d, new Map())[0].flags.map((f) => f.kind), ['guideline_delete']);
  });
  test('dropOrphanedDependents drops tasks whose dependency is gone', () => {
    const tasks = [{ path: 'a.md' }, { path: 'b.md', dependsOn: ['x.md'] }, { path: 'c.md', dependsOn: ['y.md'] }];
    const r = dropOrphanedDependents(tasks, new Set(['a.md', 'x.md']));
    assert.deepEqual(r.kept.map((t) => t.path), ['a.md', 'b.md']);
    assert.deepEqual(r.orphaned, [{ path: 'c.md', reason: 'depends on y.md, which was held back' }]);
  });
});

describe('writer output parser', () => {
  test('takes the outer four-backtick fence even with inner code fences', () => {
    const out = 'Sure.\n````markdown\n# Title\n\n```bash\nnpm test\n```\n\nEnd.\n````\nDone.';
    assert.equal(parseWriterOutput(out), '# Title\n\n```bash\nnpm test\n```\n\nEnd.\n');
  });
  test('tolerates a three-backtick fence by taking the last closing fence', () => {
    const out = '```md\n# T\n```js\nx\n```\ntail\n```';
    assert.equal(parseWriterOutput(out), '# T\n```js\nx\n```\ntail\n');
  });
  test('rejects output with no fence or no closing fence', () => {
    assert.equal(parseWriterOutput('# Just prose'), null);
    assert.equal(parseWriterOutput('````\nunclosed'), null);
  });
});

describe('checker parser and the single-correction rule', () => {
  test('parses verdicts and normalises severities', () => {
    const files = parseChecker(
      JSON.stringify({
        files: [
          { path: 'docs/a.md', verdict: 'revise', issues: [{ severity: 'must', note: 'wrong' }, { severity: 'nit', note: 'meh' }] },
          { path: 'docs/b.md', verdict: 'ok', issues: [] },
          { path: 'docs/c.md', verdict: 'weird' },
          { path: '../x.md', verdict: 'drop' },
        ],
      })
    );
    assert.equal(files.get('docs/a.md').issues[1].severity, 'should');
    assert.equal(files.get('docs/c.md').verdict, 'ok');
    assert.ok(!files.has('../x.md'));
    assert.equal(parseChecker('garbage'), null);
  });
  test('decideAfterCheck', () => {
    assert.equal(decideAfterCheck(undefined).unchecked, true);
    assert.equal(decideAfterCheck({ verdict: 'ok', issues: [] }).action, 'proceed');
    assert.equal(decideAfterCheck({ verdict: 'revise', issues: [{ severity: 'should', note: 'x' }] }).action, 'proceed');
    assert.equal(decideAfterCheck({ verdict: 'revise', issues: [{ severity: 'must', note: 'x' }] }).action, 'correct');
    assert.equal(decideAfterCheck({ verdict: 'drop', issues: [] }).action, 'drop');
  });
  test('decideAfterCheck for a delete: drop or proceed, never correct', () => {
    const must = { verdict: 'revise', issues: [{ severity: 'must', note: 'subject still exists' }] };
    assert.equal(decideAfterCheck(must, 'delete').action, 'drop');
    assert.equal(decideAfterCheck({ verdict: 'drop', issues: [] }, 'delete').action, 'drop');
    assert.equal(decideAfterCheck({ verdict: 'ok', issues: [] }, 'delete').action, 'proceed');
    assert.equal(decideAfterCheck({ verdict: 'revise', issues: [{ severity: 'should', note: 'x' }] }, 'delete').action, 'proceed');
    assert.equal(decideAfterCheck(undefined, 'delete').unchecked, true);
  });
  test('checker input renders deletes with their current content and the manifest', () => {
    const text = checkerUser({
      narrative: 'n',
      diff: 'd',
      manifest: '- docs/a.md',
      docs: [{ path: 'docs/gone.md', action: 'delete', reason: 'removed', source_files: ['apps/x.ts'], current: '# gone\n' }],
    });
    assert.match(text, /<manifest>\n- docs\/a\.md\n<\/manifest>/);
    assert.match(text, /<doc path="docs\/gone\.md" action="delete">\n<reason>removed<\/reason>\n<source_files>apps\/x\.ts<\/source_files>\n<current_content>\n# gone\n\n<\/current_content>\n<\/doc>/);
    assert.match(CHECKER_SYSTEM, /Never\s+"revise" a delete/);
  });
});

describe('checker batching', () => {
  const doc = (path, chars) => ({ path, action: 'update', reason: 'r', editDiff: '', content: 'x'.repeat(chars) });
  test('splits by budget and keeps an oversized doc alone', () => {
    const docs = [doc('a', 100), doc('b', 100), doc('huge', 10_000), doc('c', 100)];
    const batches = batchByTokens(docs, 100, (d) => approxTokens(d.content));
    assert.deepEqual(batches.map((b) => b.map((d) => d.path)), [['a', 'b'], ['huge'], ['c']]);
  });
  test('merges verdicts; a failed batch leaves only its own files unchecked', async () => {
    const docs = [doc('docs/a.md', 400), doc('docs/b.md', 400), doc('docs/c.md', 400)];
    const seen = [];
    const r = await checkInBatches(docs, {
      budget: 150,
      concurrency: 2,
      check: async (batch) => {
        seen.push(batch.map((d) => d.path));
        if (batch[0].path === 'docs/b.md') throw new Error('500');
        if (batch[0].path === 'docs/c.md') return null;
        return new Map([...batch.map((d) => [d.path, { verdict: 'ok', issues: [] }]), ['docs/b.md', { verdict: 'drop', issues: [] }]]);
      },
    });
    assert.equal(r.batches, 3);
    assert.deepEqual([...r.verdicts.keys()], ['docs/a.md'], 'a verdict for a file outside its batch is ignored');
    assert.deepEqual(r.failed.map((f) => f.paths), [['docs/b.md'], ['docs/c.md']]);
    assert.match(r.failed[0].error.message, /500/);
    assert.equal(decideAfterCheck(r.verdicts.get('docs/b.md')).unchecked, true);
  });
});

describe('providers', () => {
  test('triage and checker are OpenAI, the writer is Anthropic, and both keys are required', () => {
    const models = pickModels({ anthropic: 'a', openai: 'o' });
    assert.deepEqual(models.triage, { provider: 'openai', model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(models.writer, { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium' });
    assert.deepEqual(models.checker, { provider: 'openai', model: 'gpt-6-sol', effort: 'medium' });
    assert.throws(() => pickModels({ anthropic: 'a' }), /OPENAI_API_KEY/);
    assert.throws(() => pickModels({ openai: 'o' }), /ANTHROPIC_API_KEY/);
    assert.throws(() => pickModels({}), /Missing required env var/);
  });
  test('every model in DEFAULTS is priced and effort-gated correctly', () => {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (!k.endsWith('_model')) continue;
      assert.ok(PRICES[v], `${v} priced`);
      if (v.startsWith('claude-')) assert.ok(EFFORT_MODELS.test(v), `${v} accepts effort`);
    }
    assert.deepEqual(effortConfig('claude-opus-5-5', 'medium'), { output_config: { effort: 'medium' } });
    assert.deepEqual(effortConfig('claude-haiku-4-5', 'low'), {});
  });
});

const sseResponse = (events) => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const ev of events) c.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      c.close();
    },
  });
  return { ok: true, status: 200, body };
};

describe('model calls over fetch', () => {
  test('streaming writer call accumulates only text deltas and reads usage from both ends', async () => {
    let sent;
    const fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return sseResponse([
        { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '````markdown\n# A\n' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '````' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
        { type: 'message_stop' },
      ]);
    };
    const r = await anthropicCall({
      fetch,
      apiKey: 'k',
      model: 'claude-opus-5',
      system: 'S',
      blocks: [{ text: 'prefix', cache: true }, { text: 'doc' }],
      maxTokens: 32_000,
      effort: 'medium',
      stream: true,
    });
    assert.equal(r.text, '````markdown\n# A\n````');
    assert.deepEqual(r.usage, { input: 100, cacheRead: 5000, cacheWrite: 0, output: 40 });
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.equal(sent.messages[0].content[1].cache_control, undefined);
    assert.deepEqual(sent.output_config, { effort: 'medium' });
    assert.equal(sent.thinking, undefined, 'adaptive by default on these models');
  });

  test('non-streaming call and error surfacing', async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 10, output_tokens: 2 }, stop_reason: 'end_turn' }) });
    const r = await anthropicCall({ fetch, apiKey: 'k', model: 'claude-sonnet-5', system: 'S', blocks: [{ text: 'x' }], maxTokens: 100, effort: 'low' });
    assert.equal(r.text, '{"a":1}');
    const bad = async () => ({ ok: false, status: 401, text: async () => 'nope' });
    await assert.rejects(() => anthropicCall({ fetch: bad, apiKey: 'k', model: 'claude-sonnet-5', system: 'S', blocks: [{ text: 'x' }], maxTokens: 100 }), /Anthropic 401: nope/);
  });

  test('openai responses call', async () => {
    let sent;
    const fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '{"files":[]}' }] }], usage: { input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } }, status: 'completed' }) };
    };
    const r = await openaiCall({ fetch, apiKey: 'k', model: 'gpt-6-luna', system: 'S', blocks: [{ text: 'a' }, { text: 'b' }], maxTokens: 100, effort: 'low' });
    assert.equal(r.text, '{"files":[]}');
    assert.deepEqual(r.usage, { input: 30, cacheRead: 20, cacheWrite: 0, output: 5 });
    assert.equal(sent.input[1].content, 'a\n\nb');
    assert.deepEqual(sent.reasoning, { effort: 'low' });
  });

  test('failures carry their status; outages are transient, request problems and timeouts are not', async () => {
    const bad = (status) => async () => ({ ok: false, status, text: async () => 'x' });
    const err = (p) => p.then(() => null, (e) => e);
    const a400 = await err(anthropicCall({ fetch: bad(400), apiKey: 'k', model: 'claude-sonnet-5', system: 'S', blocks: [{ text: 'x' }], maxTokens: 1 }));
    const o529 = await err(openaiCall({ fetch: bad(529), apiKey: 'k', model: 'gpt-6-luna', system: 'S', blocks: [{ text: 'x' }], maxTokens: 1, retry: { retries: 0 } }));
    assert.equal(a400.status, 400);
    assert.equal(isTransientError(a400), false);
    assert.equal(isTransientError(o529), true);
    assert.equal(isTransientError(new TypeError('fetch failed')), true);
    assert.equal(isTransientError(Object.assign(new Error('t'), { name: 'TimeoutError' })), false);
  });

  test('both providers report truncation by the output budget', async () => {
    const oa = (reason) => async () => ({ ok: true, status: 200, json: async () => ({ output: [], usage: {}, status: reason ? 'incomplete' : 'completed', ...(reason ? { incomplete_details: { reason } } : {}) }) });
    const call = (f) => openaiCall({ fetch: f, apiKey: 'k', model: 'gpt-6-luna', system: 'S', blocks: [{ text: 'a' }], maxTokens: 1 });
    assert.equal((await call(oa('max_output_tokens'))).truncated, true);
    assert.equal((await call(oa('content_filter'))).truncated, false);
    assert.equal((await call(oa())).truncated, false);
    const an = (stop_reason) => async () => ({ ok: true, status: 200, json: async () => ({ content: [], usage: {}, stop_reason }) });
    const acall = (f) => anthropicCall({ fetch: f, apiKey: 'k', model: 'claude-sonnet-5', system: 'S', blocks: [{ text: 'a' }], maxTokens: 1 });
    assert.equal((await acall(an('max_tokens'))).truncated, true);
    assert.equal((await acall(an('end_turn'))).truncated, false);
  });

  test('usage log prices Opus 5.5 cache reads at 5% and reports unpriced models', () => {
    const lines = [];
    const warns = [];
    const u = makeUsageLog((l) => lines.push(l), (w) => warns.push(w));
    u.log('writer', 'claude-opus-5-5', { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 100_000 });
    assert.equal(u.total().toFixed(2), (4 + 0.2 + 2).toFixed(2));
    u.log('x', 'mystery', { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });
    assert.equal(warns.length, 1);
    assert.deepEqual(u.unpriced(), ['mystery']);
    assert.match(lines[0], /\[cost\] writer \(claude-opus-5-5\)/);
  });

  test('mapConcurrent bounds parallelism and keeps order', async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await mapConcurrent([1, 2, 3, 4, 5, 6], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight--;
      return n * 2;
    });
    assert.deepEqual(r, [2, 4, 6, 8, 10, 12]);
    assert.equal(peak, 3);
  });
});

// ------------------------------------------------------------------- phase 3 ---

describe('line diff', () => {
  test('finds added lines and renders a unified diff', () => {
    const a = 'one\ntwo\nthree\nfour\n';
    const b = 'one\n2\nthree\nfour\nfive\n';
    const ops = lineDiff(a, b);
    assert.deepEqual([...addedLineIndexes(ops)], [1, 4]);
    const d = unifiedDiff(a, b, 'x.md');
    assert.match(d, /^--- a\/x\.md\n\+\+\+ b\/x\.md\n@@ -1,4 \+1,5 @@\n one\n-two\n\+2\n three\n four\n\+five\n$/);
    assert.equal(unifiedDiff(a, a, 'x.md'), '');
  });
  test('a new file is all additions', () => {
    assert.equal(addedLineIndexes(lineDiff('', 'a\nb\n')).size, 2);
  });
});

describe('gates', () => {
  const c = cfg();
  const OLD = '# API\n\nThe handler validates hCaptcha -- then posts.\nSee [crm](../civi-crm/architecture.md).\nKeep \u2014 this dash.\n' + 'filler line\n'.repeat(40);
  const files = { 'docs/api/architecture.md': OLD, 'docs/civi-crm/architecture.md': '# crm\n', 'AGENTS.md': '# rules\n', 'README.md': '# r\n' };

  function ctx(root, extra = {}) {
    return {
      isEditableDoc: makeIsEditableDoc(c, root),
      readCurrent: (p) => files[p] ?? null,
      readTarget: (p) => files[p] ?? null,
      existsInCheckout: (p) => p in files,
      guidelineFiles: new Set(['AGENTS.md', 'CLAUDE.md']),
      format: { mode: 'off' },
      ...extra,
    };
  }

  test('gate 0 drops every path a model could invent, symlinks included', () => {
    const root = tmpRepo(files);
    symlinkSync(join(root, 'README.md'), join(root, 'docs', 'link.md'));
    try {
      const good = '# ok\n\nfine\n';
      const { kept, dropped } = runGates(
        [
          { path: 'content/blog/x.md', action: 'update', content: good },
          { path: 'docs/../../x.md', action: 'create', content: good },
          { path: '.github/workflows/x.md', action: 'create', content: good },
          { path: 'docs/link.md', action: 'update', content: good },
          { path: 'docs/new.md', action: 'create', content: good },
        ],
        ctx(root)
      );
      assert.deepEqual(kept.map((k) => k.path), ['docs/new.md']);
      assert.deepEqual(dropped.map((d) => [d.path, d.gate]), [['content/blog/x.md', 0], ['docs/../../x.md', 0], ['.github/workflows/x.md', 0], ['docs/link.md', 0]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('gate 1: empty output and no-op edits are dropped', () => {
    assert.equal(gateNonEmpty({ content: '  \n' }, { current: 'x' }).ok, false);
    assert.equal(gateNonEmpty({ content: '# API\r\n\nsame  \n' }, { current: '# API\n\nsame\n' }).reason, 'no change');
    assert.equal(gateNonEmpty({ content: '# API\n\nchanged\n' }, { current: '# API\n\nsame\n' }).ok, true);
  });

  test('gate 2: links resolve against the post-edit tree including files created this run', () => {
    const root = tmpRepo(files);
    try {
      const { kept, dropped } = runGates(
        [
          { path: 'docs/api/architecture.md', action: 'update', content: OLD.replace('posts.', 'posts. See [new](../new-app/README.md) and [gone](./missing.md).') },
          { path: 'docs/new-app/README.md', action: 'create', content: '# new app\n\nLinks back to [api](../api/architecture.md) and [root](../../README.md).\n' },
          { path: 'docs/escape.md', action: 'create', content: '# e\n\n[up](../../../etc/passwd)\n' },
        ],
        ctx(root)
      );
      assert.deepEqual(kept.map((k) => k.path), ['docs/new-app/README.md']);
      assert.match(dropped.find((d) => d.path === 'docs/api/architecture.md').reason, /broken relative link\(s\): \.\/missing\.md/);
      assert.equal(dropped.find((d) => d.path === 'docs/escape.md').gate, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('gate 2: only added prose lines are checked; root-relative and encoded links resolve', () => {
    const exists = (p) => ['docs/setup.md', 'docs/my file.md'].includes(p);
    const current = '# g\n\n[old](./already-broken.md)\n';
    const ok = gateLinks(
      { path: 'docs/g.md', content: current + '[s](/docs/setup.md) [f](my%20file.md)\n\n```md\n[example](./not-a-real-file.md)\n```\n' },
      { existsInTree: exists, current }
    );
    assert.deepEqual(ok, { ok: true });
    const bad = gateLinks({ path: 'docs/g.md', content: current + '[new](./nope.md)\n' }, { existsInTree: exists, current });
    assert.match(bad.reason, /broken relative link\(s\): \.\/nope\.md$/);
  });

  test('gate 3: size sanity measured from the target branch with the 400-byte floor', () => {
    assert.equal(gateSize({ action: 'update', content: '# short\n' }, { target: OLD }).ok, false);
    assert.match(gateSize({ action: 'update', content: '# short\n' }, { target: OLD }).reason, /shrank 9\d%/);
    assert.equal(gateSize({ action: 'update', content: OLD.repeat(4) }, { target: OLD }).ok, false);
    assert.equal(gateSize({ action: 'update', content: OLD + 'more\n' }, { target: OLD }).ok, true);
    assert.equal(gateSize({ action: 'update', content: '# ten lines\n'.repeat(10) }, { target: '# tiny\n' }).ok, true, 'floor');
    assert.equal(gateSize({ action: 'create', content: 'x' }, { target: null }).ok, true);
  });

  test('gate 4: dashes fixed on changed lines only, attribution drops the file', () => {
    const changed = OLD.replace('validates hCaptcha -- then posts.', 'posts \u2014 nothing else.');
    const r = gateStyle({ path: 'docs/api/architecture.md', content: changed }, { current: OLD });
    assert.equal(r.ok, true);
    assert.equal(r.fixed, 1);
    assert.ok(r.content.includes('posts -- nothing else.'));
    assert.ok(r.content.includes('Keep \u2014 this dash.'), 'untouched paragraph left alone');
    const attributed = OLD + '\nGenerated with an assistant.\n';
    assert.match(gateStyle({ path: 'x', content: attributed }, { current: OLD }).reason, /attribution string on line \d+/);
    assert.equal(gateStyle({ path: 'x', content: OLD + '\nCo-Authored-By: someone\n' }, { current: OLD }).ok, false);
  });

  test('gate 5: new URLs and raw HTML are flagged, comments and anchors are not; guideline edits carry a banner diff', () => {
    const content = OLD + '\nSee https://example.com/new and <img src="x"> plus <!-- prettier-ignore --> and <a name="top"></a>.\nAlso https://old.example already there.\n';
    const cur = OLD + '\nhttps://old.example\n';
    const r = gateFlags({ path: 'docs/api/architecture.md', content }, { current: cur, isGuideline: false });
    const kinds = Object.fromEntries(r.flags.map((f) => [f.kind, f.detail]));
    assert.deepEqual(kinds.new_urls, ['https://example.com/new']);
    assert.deepEqual(kinds.raw_html, ['<img src="x">']);
    assert.equal(kinds.guideline_edit, undefined);
    const g = gateFlags({ path: 'AGENTS.md', content: '# rules\n\nnew rule\n' }, { current: '# rules\n', isGuideline: true });
    assert.match(g.flags.find((f) => f.kind === 'guideline_edit').detail, /\+new rule/);
    const v = gateFlags({ path: 'x', content: 'Reviewed by Anthropic models.\n' }, { current: '', isGuideline: false });
    assert.deepEqual(v.flags.find((f) => f.kind === 'vendor_names').detail, ['Anthropic']);
  });

  test('gate 5: tags inside code spans and fences are text, not HTML; URLs there are still flagged', () => {
    const content = '| `--greeting <word>` | x |\n\n````html\n<script src="https://cdn.example/a.js"></script>\n```\n<b>still fenced</b>\n````\n\nAfter <em>prose</em>.\n';
    const r = gateFlags({ path: 'docs/cli.md', content }, { current: '', isGuideline: false });
    const kinds = Object.fromEntries(r.flags.map((f) => [f.kind, f.detail]));
    assert.deepEqual(kinds.raw_html, ['<em>', '</em>']);
    assert.deepEqual(kinds.new_urls, ['https://cdn.example/a.js']);
  });

  test('gate 6: strict formatting replaces content or drops on failure; off is a no-op', () => {
    assert.equal(gateFormat({ content: 'x' }, { format: { mode: 'off' } }).content, 'x');
    assert.equal(gateFormat({ content: 'x' }, { format: { mode: 'strict', run: () => ({ ok: true, content: 'X' }) } }).content, 'X');
    assert.match(gateFormat({ content: 'x' }, { format: { mode: 'strict', run: () => ({ ok: false, error: 'parse' }) } }).reason, /prettier failed: parse/);
  });

  test('runGates end to end on a deliberately bad batch', () => {
    const root = tmpRepo(files);
    try {
      const { kept, dropped } = runGates(
        [
          { path: 'docs/api/architecture.md', action: 'update', content: OLD.replace('validates hCaptcha -- then posts.', 'posts \u2014 only.') },
          { path: 'docs/civi-crm/architecture.md', action: 'update', content: '# crm\n\n[broken](./nope.md)\n' },
          { path: 'README.md', action: 'update', content: '# r\n\nGenerated with love.\n' },
          { path: 'AGENTS.md', action: 'update', content: '# rules\n\nAlways run tests.\n' },
          { path: 'content/x.md', action: 'update', content: '# nope\n' },
        ],
        ctx(root)
      );
      assert.deepEqual(kept.map((k) => k.path), ['docs/api/architecture.md', 'AGENTS.md']);
      assert.ok(kept[0].content.includes('posts -- only.'));
      assert.equal(kept[0].dashesFixed, 1);
      assert.ok(kept[1].flags.some((f) => f.kind === 'guideline_edit'));
      assert.deepEqual(dropped.map((d) => [d.path, d.gate]), [['content/x.md', 0], ['docs/civi-crm/architecture.md', 2], ['README.md', 4]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a delete runs gate 0 and "exists", and flags a guideline file', () => {
    const root = tmpRepo(files);
    try {
      const { kept, dropped } = runGates(
        [
          { path: 'docs/civi-crm/architecture.md', action: 'delete', reason: 'gone' },
          { path: 'AGENTS.md', action: 'delete', reason: 'gone' },
          { path: 'docs/missing.md', action: 'delete', reason: 'gone' },
          { path: '.github/x.md', action: 'delete', reason: 'gone' },
        ],
        ctx(root)
      );
      assert.deepEqual(kept.map((k) => k.path), ['docs/civi-crm/architecture.md', 'AGENTS.md']);
      assert.deepEqual(kept[0].flags, []);
      assert.match(kept[1].flags.find((f) => f.kind === 'guideline_delete').detail, /^-# rules$/m);
      assert.deepEqual(dropped.map((d) => [d.path, d.gate, d.reason]), [['docs/missing.md', 1, 'nothing to delete'], ['.github/x.md', 0, 'path outside the editable allowlist']]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('gate 2: a link added to a doc deleted this run or carried as deleted fails', () => {
    const root = tmpRepo(files);
    try {
      const add = (link) => ({ path: 'docs/api/architecture.md', action: 'update', content: OLD.replace('posts.', `posts. See [x](${link}).`) });
      let r = runGates([add('../civi-crm/architecture.md'), { path: 'docs/civi-crm/architecture.md', action: 'delete', reason: 'gone' }], ctx(root));
      assert.deepEqual(r.kept.map((k) => k.path), ['docs/civi-crm/architecture.md']);
      assert.equal(r.dropped[0].gate, 2);
      r = runGates([add('../../README.md')], ctx(root, { carriedDeletes: new Set(['README.md']) }));
      assert.equal(r.dropped[0].gate, 2);
      r = runGates([add('../../README.md'), { path: 'README.md', action: 'update', content: '# r\n\nrestored\n' }], ctx(root, { carriedDeletes: new Set(['README.md']) }));
      assert.deepEqual(r.kept.map((k) => k.path), ['docs/api/architecture.md', 'README.md'], 'an un-delete this run puts it back in the tree');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fixpoint: a create dropped at gate 4 takes a link to it down at gate 2, and its dependents go too', () => {
    const root = tmpRepo(files);
    try {
      const { kept, dropped, orphaned } = runGates(
        [
          { path: 'docs/api/architecture.md', action: 'update', content: OLD.replace('posts.', 'posts. See [n](../new.md).') },
          { path: 'docs/new.md', action: 'create', content: '# new\n\nCo-Authored-By: x\n' },
          { path: 'docs/civi-crm/architecture.md', action: 'update', content: '# crm\n\nfixed\n', dependsOn: ['docs/gone.md'] },
          { path: 'README.md', action: 'update', content: '# r\n\nfine\n' },
        ],
        ctx(root)
      );
      assert.deepEqual(kept.map((k) => k.path), ['README.md']);
      assert.deepEqual(dropped.map((d) => [d.path, d.gate]), [['docs/new.md', 4], ['docs/api/architecture.md', 2]]);
      assert.deepEqual(orphaned, [{ path: 'docs/civi-crm/architecture.md', reason: 'depends on docs/gone.md, which was held back' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('gate 0 accepts only the exact canonical path', () => {
    assert.equal(gateAllowlist({ path: 'docs//x.md' }, { isEditableDoc: () => true }).ok, false);
    assert.equal(gateAllowlist({ path: 'docs/x.md' }, { isEditableDoc: () => true }).ok, true);
  });
});

describe('defuse', () => {
  test('mentions and closing keywords are neutralised and length is capped', () => {
    assert.equal(defuse('thanks @octocat, fixes #12 and Closes  #13'), 'thanks @\u200boctocat, fixes #\u200b12 and Closes #\u200b13');
    assert.equal(defuse('a'.repeat(500), 20).length, 20);
    assert.equal(defuse('a\n\nb  c'), 'a b c');
  });
});

// ------------------------------------------------------------------- phase 4 ---

describe('defusing for GitHub text', () => {
  test('every closing-keyword form and raw HTML is neutralised', () => {
    assert.equal(defuse('Fixes: #7'), 'Fixes: #​7');
    assert.equal(defuse('resolves acme/web#9'), 'resolves acme/web#​9');
    assert.equal(defuse('closed https://github.com/a/b/issues/3'), 'closed​ https://github.com/a/b/issues/3');
    assert.equal(defuse('see #12'), 'see #12', 'a plain reference is left alone');
    assert.equal(defuse('x <!-- hide --> <img src=y>'), 'x &lt;!-- hide --&gt; &lt;img src=y&gt;');
  });

  test('inline code and fenced blocks cannot be broken out of', () => {
    assert.equal(inlineCode('a`b'), '``a`b``');
    assert.equal(inlineCode('`x'), '`` `x ``');
    assert.equal(inlineCode('@octocat'), '`@​octocat`');
    const block = codeBlock('+ ```js\n+ fixes #4\n', 'diff');
    assert.ok(block.startsWith('````diff\n') && block.endsWith('\n````'));
    assert.match(block, /fixes #​4/);
    assert.equal(defuseRefs('line one\n@team'), 'line one\n@​team', 'multiline text keeps its newlines');
  });
});

describe('retries', () => {
  const res = (status, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), body: null, text: async () => String(status) });

  test('one retry on 5xx, 429 and 529, honouring Retry-After; 4xx is final', async () => {
    assert.ok(isRetryableStatus(500) && isRetryableStatus(529) && isRetryableStatus(429));
    assert.ok(!isRetryableStatus(401) && !isRetryableStatus(422));
    const waits = [];
    const sleep = async (ms) => waits.push(ms);
    let calls = 0;
    const flaky = async (url, init) => {
      assert.ok(init.signal instanceof AbortSignal, 'a timeout signal on every attempt');
      return ++calls === 1 ? res(529, { 'retry-after': '2' }) : res(200);
    };
    assert.equal((await fetchRetry(flaky, 'u', {}, { timeoutMs: 1000, sleep })).status, 200);
    assert.deepEqual(waits, [2000]);

    calls = 0;
    const down = async () => (calls++, res(503));
    assert.equal((await fetchRetry(down, 'u', {}, { timeoutMs: 1000, sleep })).status, 503, 'the second failure is returned, not retried again');
    assert.equal(calls, 2);

    calls = 0;
    const denied = async () => (calls++, res(401));
    assert.equal((await fetchRetry(denied, 'u', {}, { timeoutMs: 1000, sleep })).status, 401);
    assert.equal(calls, 1);
  });

  test('network errors retry once, timeouts never', async () => {
    const sleep = async () => {};
    let calls = 0;
    const reset = async () => {
      if (++calls === 1) throw new TypeError('fetch failed');
      return res(200);
    };
    assert.equal((await fetchRetry(reset, 'u', {}, { timeoutMs: 1000, sleep })).status, 200);
    calls = 0;
    const slow = async () => {
      calls++;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    };
    await assert.rejects(() => fetchRetry(slow, 'u', {}, { timeoutMs: 1000, sleep }), /timed out/);
    assert.equal(calls, 1);
  });

  test('model calls go through the retry', async () => {
    let calls = 0;
    const fetch = async () =>
      ++calls === 1
        ? res(529)
        : { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }) };
    const r = await anthropicCall({ fetch, apiKey: 'k', model: 'claude-sonnet-5', system: 'S', blocks: [{ text: 'x' }], maxTokens: 10, retry: { sleep: async () => {} } });
    assert.equal(r.text, 'hi');
    assert.equal(calls, 2);
  });
});

describe('publishing helpers', () => {
  test('commit scope, subject and body follow the fixed template', () => {
    assert.equal(commitScope('docs/web/sync'), 'web');
    assert.equal(commitScope('docs-sync'), 'repo');
    const msg = commitMessage({ scope: 'web', from: 'a'.repeat(40), to: 'b'.repeat(40), target: 'develop', files: ['docs/x.md'], deleted: ['docs/gone.md'], carried: ['README.md'], carriedDeleted: ['docs/old.md'], runUrl: 'https://r' });
    assert.match(msg, /^docs\(web\): sync with aaaaaaa\.\.bbbbbbb\n\nRange: a{40}\.\.b{40} on develop\n\nFiles:\n- docs\/x\.md\n- docs\/gone\.md \(deleted\)\n- README\.md \(carried forward\)\n- docs\/old\.md \(deleted, carried forward\)\n\nRun: https:\/\/r\n$/);
    assert.ok(!/co-authored|generated/i.test(msg));
    assert.equal(prTitle({ scope: 'web', target: 'develop', to: 'c'.repeat(40) }), 'docs(web): sync docs with develop (up to ccccccc)');
  });

  test('the push credential is an env-only extraheader that disables stored credentials', () => {
    const env = gitAuthEnv('tok');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
    assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper');
    assert.equal(env.GIT_CONFIG_VALUE_1, '');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  });

  test('marker round-trips, cannot be closed from inside, and ignores junk', () => {
    const runs = [{ at: '2026-09-23T00:00:00Z', from: 'abc', to: 'def', files: ['docs/a-->b.md'] }];
    const marker = renderMarker(runs);
    assert.equal(marker.indexOf('-->'), marker.length - 3, 'only the real terminator');
    assert.deepEqual(parseMarker(`text\n${marker}\n`), runs);
    assert.deepEqual(parseMarker('<!-- ai-docs-sync {"v":1,"runs":[{"from":"zz;rm","files":["../x.md","ok.md",3]}]} -->'), [{ at: '', from: '', to: '', files: ['ok.md'] }]);
    assert.deepEqual(parseMarker('no marker'), []);
    assert.deepEqual(parseMarker('<!-- ai-docs-sync {broken -->'), []);
    const many = Array.from({ length: 30 }, (_, i) => ({ at: '', from: String(i), to: '', files: [] }));
    assert.equal(renderMarker(many).match(/"from":/g).length, 20, 'keeps the last 20');
    const wide = [{ at: '', from: 'a', to: 'b', files: Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`) }];
    assert.equal(parseMarker(renderMarker(wide))[0].files.length, 300, 'no per-run file cap');
    const big = Array.from({ length: 10 }, (_, i) => ({ at: '', from: `${i}`, to: '', files: Array.from({ length: 200 }, (_, j) => `docs/run${i}/file-${j}.md`) }));
    const sized = renderMarker(big);
    assert.ok(sized.length <= MARKER_MAX_CHARS, `${sized.length}`);
    const left = parseMarker(sized);
    assert.ok(left.length < 10 && left.length >= 1);
    assert.equal(left.at(-1).from, '9', 'the oldest runs go first');
    assert.equal(parseMarker(renderMarker([big[0]], 100)).length, 1, 'the newest run always stays');
    const hist = [{ from: 'f1', to: '1', files: ['a.md'] }, { from: 'f2', to: '2', files: ['a.md', 'b.md'] }];
    assert.equal(lastRunFor(hist, 'a.md').to, '2');
    assert.equal(regenerateFrom(hist, 'a.md', 'base'), 'f1', 'the earliest run that touched it');
    assert.equal(regenerateFrom(hist, 'c.md', 'base'), 'base');
  });

  test('narrative outline has PR titles and subjects only', () => {
    const commits = [
      { sha: 's1', short: 's1', email: 'a@x', parents: ['p'], subject: 'feat: one', body: 'long body' },
      { sha: 's2', short: 's2', email: BOT_EMAIL, parents: ['p'], subject: 'docs: sync', body: '' },
      { sha: 's3', short: 's3', email: 'b@x', parents: ['p'], subject: 'fix: loose', body: '' },
    ];
    const outline = narrativeOutline({ commits, linked: new Map([['s1', 5]]), prs: new Map([[5, { title: 'PR five' }]]) });
    assert.deepEqual(outline, [
      { pr: { number: 5, title: 'PR five' }, commits: [{ short: 's1', subject: 'feat: one' }] },
      { pr: null, commits: [{ short: 's3', subject: 'fix: loose' }] },
    ]);
  });
});

describe('PR body', () => {
  const base = () => ({
    repo: 'o/r',
    target: 'develop',
    from: 'a'.repeat(40),
    to: 'b'.repeat(40),
    commitCount: 3,
    runUrl: 'https://github.com/o/r/actions/runs/1',
    kept: [
      {
        path: 'docs/api.md',
        action: 'update',
        reason: 'Endpoint moved; thanks @alice, fixes #12 <!--',
        check: { action: 'correct', issues: [{ severity: 'must', note: 'Claims hCaptcha <b>still</b> runs' }] },
        corrected: true,
        dashesFixed: 2,
        flags: [{ kind: 'new_urls', detail: ['https://evil.example/@x'] }],
      },
      {
        path: 'AGENTS.md',
        action: 'update',
        reason: 'Commands changed',
        check: { action: 'proceed', unchecked: true, issues: [] },
        flags: [{ kind: 'guideline_edit', detail: '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-old\n+new ``` closes #3\n' }],
      },
    ],
    deleted: [
      {
        path: 'docs/crm (old).md',
        action: 'delete',
        reason: 'CRM app removed',
        check: { action: 'proceed', issues: [] },
        flags: [{ kind: 'broken_inbound_links', detail: ['docs/specs/x.md'] }],
      },
      {
        path: 'apps/crm/CLAUDE.md',
        action: 'delete',
        reason: 'CRM app removed',
        check: { action: 'proceed', issues: [] },
        flags: [{ kind: 'guideline_delete', detail: '--- a/apps/crm/CLAUDE.md\n+++ b/apps/crm/CLAUDE.md\n@@ -1,1 +0,0 @@\n-rule\n' }],
      },
    ],
    carried: [{ path: 'README.md', run: { from: '1111111aaa', to: '2222222bbb' } }, { path: 'docs/was.md', deleted: true }],
    stale: [
      { path: 'docs/old.md', since: 'c'.repeat(40), redone: false },
      { path: 'docs/api.md', since: 'd'.repeat(40), redone: true },
      { path: 'docs/del.md', since: 'e'.repeat(40), redone: false, kind: 'delete' },
    ],
    dropped: [{ path: 'docs/bad.md', gate: 2, reason: 'broken relative link(s): ./@nope.md' }],
    heldBack: [{ path: 'docs/huge.md', reason: 'too large for a full rewrite in v1' }],
    suggestedDeletes: [{ path: 'docs/gone.md', reason: 'App removed', why: 'no cited source file is in the diff' }],
    omittedDiff: ['big/file.ts'],
    outline: [{ pr: { number: 153, title: 'refactor: move funnel, closes #99' }, commits: [{ short: 'abc1234', subject: 'refactor @bob' }] }],
    usage: { entries: [{ label: 'triage', model: 'claude-sonnet-5', input: 10, cacheRead: 0, output: 5, cost: 0.001 }], total: 0.001, unpriced: [] },
    runs: [{ at: 't', from: 'a', to: 'b', files: ['docs/api.md', 'AGENTS.md', 'docs/crm (old).md', 'apps/crm/CLAUDE.md'] }],
  });

  test('renders every section, bannered guideline diffs first, everything defused', () => {
    const body = renderPrBody(base());
    assert.ok(body.startsWith('> [!WARNING]\n> **Guideline file deleted: `apps/crm/CLAUDE.md`.**'), 'delete banner at the very top');
    assert.match(body, /> \*\*Guideline file edited: `AGENTS\.md`\.\*\*/);
    assert.match(body, /````diff\n[\s\S]*\+new ``` closes #​3\n````/, 'fence outlasts the backticks in the diff, keyword defused');
    const headings = ['Deleted this run', 'Edited this run', 'Carried forward', 'Earlier changes discarded because `develop` changed the file', 'Held back', 'New links, raw HTML and vendor names to check', 'Suggested deletions (not acted on)', 'Diff not shown', 'Commits and PRs in this range', 'API usage'];
    for (const h of headings) assert.ok(body.includes(`\n#### ${h}`), h);
    const at = headings.map((h) => body.indexOf(`\n#### ${h}`));
    assert.deepEqual([...at].sort((x, y) => x - y), at, 'sections in order: deletes before edits');
    assert.ok(!body.includes('Also likely affected') && !body.includes('Delete candidates'));
    assert.ok(!/^#{1,3} /m.test(body), 'no heading above level 4');
    assert.match(body, /thanks @​alice, fixes #​12 &lt;!--/);
    assert.match(body, /addressed in the correction pass:\n    - \[must\] Claims hCaptcha &lt;b&gt;still&lt;\/b&gt; runs/);
    assert.match(body, /Checker: \*\*unchecked\*\*/);
    assert.match(body, /2 line\(s\) had en\/em dashes replaced/);
    assert.match(body, /- `docs\/crm \(old\)\.md` -- CRM app removed\n  - Checker: ok\n  - Still linked from, not fixed here: `docs\/specs\/x\.md`\n  - To restore it: \[bbbbbbb copy\]\(https:\/\/github\.com\/o\/r\/blob\/b{40}\/docs\/crm%20%28old%29\.md\)/);
    assert.match(body, /`README\.md` \(from `1111111\.\.2222222`\)/);
    assert.match(body, /- `docs\/was\.md` \(deleted\)/);
    assert.match(body, /`docs\/old\.md`: triage was asked again and did not select it\. To force it, re-run with `since=c{40}`/);
    assert.match(body, /`docs\/del\.md` \(delete\): triage was asked again/);
    assert.match(body, /`docs\/api\.md`: redone this run on top of the new version/);
    assert.match(body, /gate 2: broken relative link\(s\): \.\/@​nope\.md/);
    assert.match(body, /new URLs: `https:\/\/evil\.example\/@​x`/);
    assert.match(body, /- `docs\/gone\.md` -- App removed \(no cited source file is in the diff\)/);
    assert.match(body, /- #153 refactor: move funnel, closes #​99\n  - `abc1234` refactor @​bob/);
    assert.match(body, /Total ~\$0\.0010/);
    assert.ok(!/<!--(?! ai-docs-sync )/.test(body), 'the only HTML comment is the marker');
    assert.equal(body.match(/-->/g).length, 1);
    assert.deepEqual(parseMarker(body), base().runs);
  });

  test('restore links escape characters that would end a Markdown link', () => {
    assert.equal(blobUrl('o/r', 'abc', 'docs/a (b)/c d.md'), 'https://github.com/o/r/blob/abc/docs/a%20%28b%29/c%20d.md');
  });

  test('over the cap the narrative is trimmed first and the marker survives', () => {
    const outline = [{ pr: null, commits: Array.from({ length: 3000 }, (_, i) => ({ short: `c${i}`, subject: `subject ${i} `.repeat(4) })) }];
    const body = renderPrBody({ ...base(), outline });
    assert.ok(body.length <= PR_BODY_MAX, `${body.length}`);
    assert.match(body, /more line\(s\) not shown/);
    assert.match(body, /#### API usage/, 'sections after the narrative are kept');
    assert.match(body, /\[must\] Claims hCaptcha/, 'no detail shed while the narrative alone is over');
    assert.deepEqual(parseMarker(body), base().runs);
  });

  test('a guideline banner diff is capped and points at the commit', () => {
    const huge = base();
    huge.kept[1].flags[0].detail = '+x\n'.repeat(40_000);
    const body = renderPrBody(huge);
    assert.ok(body.length <= PR_BODY_MAX);
    assert.match(body, /_Diff cut at 8000 characters; the full diff is in the commit\._/);
    assert.ok(!body.includes('(truncated)'));
    assert.deepEqual(parseMarker(body), base().runs);
  });

  test('200 edited and 50 deleted files: under the cap, every deleted path listed, marker intact', () => {
    const long = 'A reason that goes on for a while about what changed in the code. '.repeat(4);
    const issues = Array.from({ length: 5 }, (_, i) => ({ severity: 'should', note: `note ${i} `.repeat(30) }));
    const kept = Array.from({ length: 200 }, (_, i) => ({
      path: `docs/area-${i}/some-fairly-long-document-name-${i}.md`,
      action: 'update',
      reason: long,
      check: { action: 'proceed', issues },
      dashesFixed: 1,
      flags: [{ kind: 'new_urls', detail: [`https://example.com/${i}/${'x'.repeat(80)}`] }],
    }));
    const deleted = Array.from({ length: 50 }, (_, i) => ({
      path: `docs/removed-${i}/the-removed-feature-document-${i}.md`,
      action: 'delete',
      reason: long,
      check: { action: 'proceed', issues },
      flags: [{ kind: 'broken_inbound_links', detail: [`docs/specs/s${i}.md`] }],
    }));
    const runs = [{ at: 't', from: 'a', to: 'b', files: [...kept, ...deleted].map((f) => f.path) }];
    const outline = [{ pr: null, commits: Array.from({ length: 500 }, (_, i) => ({ short: `c${i}`, subject: `subject ${i}` })) }];
    const body = renderPrBody({ ...base(), kept, deleted, runs, outline });
    assert.ok(body.length <= PR_BODY_MAX, `${body.length}`);
    for (const d of deleted) assert.ok(body.includes(`\`${d.path}\``), d.path);
    assert.deepEqual(parseMarker(body), runs);
    assert.ok(!body.includes('(truncated)'));

    const thousands = Array.from({ length: 3000 }, (_, i) => ({ ...kept[0], path: `docs/many/doc-${i}.md` }));
    const cut = renderPrBody({ ...base(), kept: thousands, deleted, runs, outline });
    assert.ok(cut.length <= PR_BODY_MAX, `${cut.length}`);
    for (const d of deleted) assert.ok(cut.includes(`\`${d.path}\``), d.path);
    assert.match(cut, /more line\(s\) not shown; see the commit/);
    assert.deepEqual(parseMarker(cut), runs);
  });

  test('usage entries carry their cost', () => {
    assert.equal(costOf('claude-sonnet-5', { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }), 2);
    assert.equal(costOf('mystery', { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }), null);
    const u = makeUsageLog();
    u.log('triage', 'claude-sonnet-5', { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 });
    assert.equal(u.entries[0].cost, 2);
  });
});

describe('stale edits go back to triage', () => {
  const stale = () =>
    renderStaleBlock({
      docs: ['docs/api.md'],
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      commits: [{ short: 'c0ffee1', subject: 'feat(server): read PORT' }],
      diff: '--- FILE: src/server.js (M) ---\n+const PORT = 8080;',
      current: { 'docs/api.md': '# HTTP API\n\nListens on 3000.\n' },
    });

  test('the block names the docs, the earlier range, its commits and its diff', () => {
    const text = stale();
    assert.match(text, /^<stale_edits>\n.*discarded: docs\/api\.md\n/);
    assert.match(text, /\(aaaaaaa\.\.bbbbbbb, already on the target branch before this range\)/);
    assert.match(text, /Commits:\n- c0ffee1 feat\(server\): read PORT/);
    assert.match(text, /<earlier_diff>\n--- FILE: src\/server\.js \(M\) ---\n\+const PORT = 8080;\n<\/earlier_diff>\n/);
    assert.match(text, /<stale_doc path="docs\/api\.md">\n# HTTP API\n\nListens on 3000\.\n<\/stale_doc>\n<\/stale_edits>$/, 'triage sees the current text');
    assert.match(renderStaleBlock({ docs: ['docs/big.md'], current: { 'docs/big.md': null } }), /<stale_doc path="docs\/big\.md">\(too large to include\)<\/stale_doc>/);
    assert.match(renderStaleBlock({ docs: ['docs/api.md'] }), /inside <diff>/, 'no earlier diff when the range already covers it');
    assert.equal(renderStaleBlock({ docs: [] }), '');
  });

  test('triage, writer prefix and checker all carry it; nothing changes without it', () => {
    const base = { guidelines: 'g', narrative: 'n', diff: 'd', manifest: 'm' };
    assert.equal(triageUser(base), triageUser({ ...base, stale: '' }));
    assert.ok(!triageUser(base).includes('stale_edits'));
    assert.ok(triageUser({ ...base, stale: stale() }).endsWith(stale()), 'last, so the prefix up to the manifest is unchanged');
    assert.equal(writerPrefix({ ...base, stale: stale() }), triageUser({ ...base, stale: stale() }));
    assert.match(checkerUser({ narrative: 'n', diff: 'd', docs: [], stale: stale() }), /<earlier_diff>/);
    assert.match(TRIAGE_SYSTEM, /<stale_edits> block is present, re-evaluate every doc it lists/);
  });

  test('a discarded delete is named as a delete, next to discarded edits', () => {
    const text = renderStaleBlock({ docs: [{ path: 'docs/a.md', kind: 'edit' }, { path: 'docs/b.md', kind: 'delete' }], current: { 'docs/a.md': 'a', 'docs/b.md': 'b' } });
    assert.match(text, /edit was discarded: docs\/a\.md\n/);
    assert.match(text, /deleted these docs, but the target branch changed them before the delete merged, so the delete was discarded: docs\/b\.md\n/);
    assert.match(text, /<stale_doc path="docs\/b\.md">\nb\n<\/stale_doc>/, 'current text included so triage can re-nominate it');
  });
});

describe('writer prefix and deletes', () => {
  test('the prefix lists deletes after everything triage saw, and nothing when there are none', () => {
    const base = { guidelines: 'g', narrative: 'n', diff: 'd', manifest: 'm' };
    const prefix = writerPrefix({ ...base, deleted: [{ path: 'docs/gone.md', reason: 'app removed' }] });
    assert.ok(prefix.startsWith(triageUser(base)));
    assert.ok(prefix.endsWith('<deleted_this_run>\n- docs/gone.md: app removed\n</deleted_this_run>'));
    assert.equal(writerPrefix({ ...base, deleted: [] }), triageUser(base));
    assert.match(WRITER_SYSTEM, /Never link to a doc listed in <deleted_this_run>/);
  });
});

describe('creating docs', () => {
  const m = (path, bytes, linkDirs = []) => ({ path, heading: '', bytes, linkDirs });
  const manifest = [
    m('README.md', 1200, ['docs/', 'packages/a/', 'packages/b/']),
    m('AGENTS.md', 300, ['docs/']),
    m('docs/index.md', 500, ['docs/commands/']),
    m('docs/cli.md', 700),
    m('docs/commands/greet.md', 900),
    m('docs/commands/serve.md', 600),
    m('docs/commands/tiny.md', 100),
    m('packages/a/README.md', 800),
    m('packages/b/README.md', 1000),
    m('packages/b/docs/usage.md', 500),
  ];
  const paths = manifest.map((x) => x.path);

  test('placement: same directory, one new level under docs, sibling name; the root is not a docs area', () => {
    assert.deepEqual(createPlacement('docs/commands/new.md', paths), { ok: true });
    assert.deepEqual(createPlacement('CONTRIBUTING.md', paths), { ok: true });
    assert.deepEqual(createPlacement('docs/guides/x.md', paths), { ok: true });
    assert.deepEqual(createPlacement('docs/commands/deep/x.md', paths), { ok: true });
    assert.deepEqual(createPlacement('packages/c/README.md', paths), { ok: true });
    assert.deepEqual(createPlacement('docs/commands/deep/er/x.md', paths), { ok: false, reason: 'no docs live near docs/commands/deep/er/' });
    assert.deepEqual(createPlacement('packages/c/CHANGELOG.md', paths), { ok: false, reason: 'no docs live near packages/c/' });
    assert.deepEqual(createPlacement('misc/notes.md', paths), { ok: false, reason: 'no docs live near misc/' }, 'a root README does not admit a new top-level directory');
    assert.equal(createPlacement('newtop/index.md', paths).ok, false, 'nor does docs/index.md as a sibling at the root');
  });

  test('exemplar: sibling name first, then the same directory by median size, then the parent; none', () => {
    assert.equal(pickExemplar('packages/c/README.md', manifest).path, 'packages/a/README.md');
    assert.equal(pickExemplar('docs/commands/new.md', manifest).path, 'docs/commands/serve.md');
    assert.equal(pickExemplar('docs/commands/deep/x.md', manifest).path, 'docs/commands/serve.md');
    assert.equal(pickExemplar('docs/guides/x.md', manifest).path, 'docs/cli.md');
    assert.equal(pickExemplar('x/y/z.md', manifest), null);
  });

  test('index doc: README or index in the directory, then the parent, then a doc linking there; skips deleted and non-editable', () => {
    assert.equal(findIndexDoc('docs/new.md', manifest), 'docs/index.md');
    assert.equal(findIndexDoc('docs/new.md', [...manifest, m('docs/README.md', 10)]), 'docs/README.md', 'README.md before index.md');
    assert.equal(findIndexDoc('docs/commands/new.md', manifest), 'docs/index.md');
    assert.equal(findIndexDoc('packages/b/docs/new.md', manifest), 'packages/b/README.md');
    assert.equal(findIndexDoc('packages/c/README.md', manifest), 'README.md', 'a list of sibling directories counts; the new README is not its own index');
    const tie = [...manifest.filter((x) => x.path !== 'AGENTS.md'), m('AGENTS.md', 300, ['packages/a/'])];
    assert.equal(findIndexDoc('packages/c/README.md', tie, { guidelineFiles: new Set(['AGENTS.md']) }), 'README.md', 'a guideline file ranks last');
    assert.equal(findIndexDoc('docs/new.md', manifest, { deleted: new Set(['docs/index.md']) }), 'README.md');
    assert.equal(findIndexDoc('docs/new.md', manifest, { deleted: new Set(['docs/index.md']), isEditable: (p) => p !== 'README.md' }), 'AGENTS.md');
    assert.equal(findIndexDoc('x/y/z.md', manifest), null);
  });

  const affected = () => [
    { path: 'docs/commands/new.md', action: 'create', reason: 'Documents the new `wave` command.', source_files: ['src/wave.js'] },
    { path: 'packages/c/README.md', action: 'create', reason: 'New package c.', source_files: ['packages/c/index.js'] },
    { path: 'misc/notes.md', action: 'create', reason: 'Notes.', source_files: [] },
    { path: 'README.md', action: 'update', reason: 'Layout lists packages.', source_files: ['packages/c/index.js'] },
  ];

  test('plan: a refused create is held back before the writer; index updates are dependent tasks or reason notes', () => {
    const r = planCreates({ affected: affected(), manifest });
    assert.deepEqual(r.refused, [{ path: 'misc/notes.md', reason: 'placement: no docs live near misc/' }]);
    assert.deepEqual(r.affected.map((a) => a.path), ['docs/commands/new.md', 'packages/c/README.md', 'README.md'], 'no writer task for the refused create');
    const wave = r.affected.find((a) => a.path === 'docs/commands/new.md');
    assert.deepEqual([wave.exemplar, wave.index], [{ path: 'docs/commands/serve.md', bytes: 600 }, 'docs/index.md']);
    assert.equal(r.affected.find((a) => a.path === 'README.md').reason, 'Layout lists packages. Also link the new doc packages/c/README.md (new package c).');
    assert.equal(r.affected.find((a) => a.path === 'README.md').dependsOn, undefined);
    assert.deepEqual(r.indexTasks, [
      {
        path: 'docs/index.md',
        action: 'update',
        reason: '',
        source_files: ['src/wave.js'],
        dependsOn: ['docs/commands/new.md'],
        links: [{ path: 'docs/commands/new.md', why: 'documents the new `wave` command' }],
      },
    ]);
    assert.equal(affected()[3].reason, 'Layout lists packages.', 'input not mutated');
    assert.equal(planCreates({ affected: affected(), manifest, deleted: new Set(['docs/index.md']) }).affected[0].index, 'README.md');
  });

  test('wave 2: the index update carries the drafted title; a wave-1 create failure drops it', () => {
    const { indexTasks } = planCreates({ affected: affected(), manifest });
    const ok = finaliseIndexTasks(indexTasks, new Map([['docs/commands/new.md', '# wave\n\nWaves.\n']]));
    assert.deepEqual(ok.tasks, [
      {
        path: 'docs/index.md',
        action: 'update',
        reason: 'Link the new doc docs/commands/new.md, titled "wave" (documents the new `wave` command).',
        source_files: ['src/wave.js'],
        dependsOn: ['docs/commands/new.md'],
      },
    ]);
    assert.deepEqual(finaliseIndexTasks(indexTasks, new Map()), { tasks: [], orphaned: [{ path: 'docs/index.md', reason: 'depends on docs/commands/new.md, which was held back' }] });
    const two = [{ ...indexTasks[0], dependsOn: ['docs/commands/new.md', 'docs/commands/b.md'], links: [...indexTasks[0].links, { path: 'docs/commands/b.md', why: '' }] }];
    const partial = finaliseIndexTasks(two, new Map([['docs/commands/b.md', 'no heading\n']]));
    assert.deepEqual([partial.tasks[0].reason, partial.tasks[0].dependsOn], ['Link the new doc docs/commands/b.md.', ['docs/commands/b.md']]);
  });

  test('the writer sees an exemplar for creates only, cut to its budget', () => {
    const exemplar = { path: 'docs/commands/serve.md', content: 'line\n'.repeat(100) };
    const create = writerDocPart({ path: 'docs/commands/new.md', action: 'create', reason: 'r', current: '', exemplar, exemplarTokens: 10 });
    assert.ok(create.endsWith(`</current>\n\n<exemplar path="docs/commands/serve.md">\n${'line\n'.repeat(8)}[truncated]\n</exemplar>`), create);
    assert.ok(writerDocPart({ path: 'docs/commands/new.md', action: 'create', reason: 'r', current: '', exemplar: { ...exemplar, content: '# s\n' } }).endsWith('<exemplar path="docs/commands/serve.md">\n# s\n</exemplar>'));
    assert.ok(!writerDocPart({ path: 'docs/cli.md', action: 'update', reason: 'r', current: 'x', exemplar }).includes('<exemplar'));
    assert.ok(!writerDocPart({ path: 'docs/x.md', action: 'create', reason: 'r', current: '' }).includes('<exemplar'));
    assert.match(WRITER_SYSTEM, /<exemplar>/);
    assert.match(CHECKER_SYSTEM, /duplicates a doc already in the manifest/);
    assert.match(TRIAGE_SYSTEM, /which\s+existing doc should link to it/);
  });

  test('gate 3: a create is bounded at 3x an exemplar over 400 bytes, and not at all without one', () => {
    const ex = { path: 'docs/commands/serve.md', bytes: 500 };
    assert.deepEqual(gateSize({ action: 'create', content: 'x'.repeat(1700), exemplar: ex }, { target: null }), {
      ok: false,
      reason: 'grew 3.4x the size of docs/commands/serve.md (500 -> 1700 bytes)',
    });
    assert.equal(gateSize({ action: 'create', content: 'x'.repeat(1400), exemplar: ex }, { target: null }).ok, true);
    assert.equal(gateSize({ action: 'create', content: 'x'.repeat(5000), exemplar: { path: 'a.md', bytes: 300 } }, { target: null }).ok, true, 'floor');
    assert.equal(gateSize({ action: 'create', content: 'x'.repeat(5000), exemplar: null }, { target: null }).ok, true);
  });

  test('runGates: an index update whose create was held back is dropped with it', () => {
    const files = { 'README.md': '# r\n', 'docs/cli.md': '# cli\n' };
    const root = tmpRepo(files);
    try {
      const { kept, dropped, orphaned } = runGates(
        [
          { path: 'docs/new.md', action: 'create', content: '# new\n\n' + 'word '.repeat(400) + '\n', exemplar: { path: 'docs/cli.md', bytes: 500 } },
          { path: 'README.md', action: 'update', content: '# r\n\nSee [new](docs/new.md).\n', dependsOn: ['docs/new.md'] },
        ],
        {
          isEditableDoc: makeIsEditableDoc(cfg(), root),
          readCurrent: (p) => files[p] ?? null,
          readTarget: (p) => files[p] ?? null,
          existsInCheckout: (p) => p in files,
          guidelineFiles: new Set(),
          format: { mode: 'off' },
        }
      );
      assert.deepEqual(kept, []);
      assert.deepEqual(dropped.map((d) => [d.path, d.gate]), [['docs/new.md', 3]]);
      assert.deepEqual(orphaned, [{ path: 'README.md', reason: 'depends on docs/new.md, which was held back' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('link status comes from the final content, not the plan', () => {
    const kept = [
      { path: 'docs/new.md', action: 'create', content: '# n\n', index: 'docs/index.md', flags: [] },
      { path: 'docs/index.md', action: 'update', content: '# i\n\n- [new](new.md)\n', flags: [] },
      { path: 'docs/lonely.md', action: 'create', content: '# l\n', index: 'README.md', flags: [] },
      { path: 'docs/orphan.md', action: 'create', content: '# o\n', index: null, flags: [] },
      { path: 'docs/old.md', action: 'create', content: '# old\n', index: null, flags: [] },
    ];
    const r = markNewDocLinks(kept, [{ path: 'docs/cli.md', content: '[was broken](old.md)\n' }]);
    assert.deepEqual(r.map((k) => k.linkedFrom), [['docs/index.md'], undefined, [], [], ['docs/cli.md']]);
    assert.deepEqual(r.map((k) => k.flags), [[], [], [{ kind: 'unlinked_new_doc', detail: ['the planned link from README.md was not kept'] }], [{ kind: 'unlinked_new_doc', detail: ['no doc found to link it from'] }], []]);
  });

  test('PR body: New docs between deletes and edits, link status per doc, placement failures held back', () => {
    const k = (path, extra) => ({ path, action: 'create', reason: `Documents ${path}`, check: { action: 'proceed', issues: [] }, flags: [], ...extra });
    const body = renderPrBody({
      target: 'main',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      commitCount: 1,
      kept: [
        k('docs/commands/new.md', { linkedFrom: ['docs/index.md'] }),
        k('packages/c/README.md', { linkedFrom: [], flags: [{ kind: 'unlinked_new_doc', detail: ['no doc found to link it from'] }] }),
        { path: 'docs/index.md', action: 'update', reason: 'Link it', check: { action: 'proceed', issues: [] }, flags: [] },
      ],
      deleted: [{ path: 'docs/gone.md', action: 'delete', reason: 'gone', check: { action: 'proceed', issues: [] }, flags: [] }],
      heldBack: [{ path: 'misc/notes.md', reason: 'placement: no docs live near misc/' }],
      carried: [{ path: 'docs/commands/older.md', created: true }, { path: 'docs/cli.md' }],
    });
    const at = ['Deleted this run', 'New docs', 'Edited this run', 'Held back'].map((h) => body.indexOf(`\n#### ${h}\n`));
    assert.ok(at.every((i) => i > 0) && [...at].sort((x, y) => x - y).join() === at.join(), body);
    assert.match(body, /#### New docs\n- `docs\/commands\/new\.md` -- Documents docs\/commands\/new\.md\n  - Checker: ok\n  - Linked from `docs\/index\.md`\n/);
    assert.match(body, /- `packages\/c\/README\.md` -- Documents packages\/c\/README\.md\n  - Checker: ok\n  - \*\*Not linked from any doc\*\* \(no doc found to link it from\)\n/);
    const edited = body.slice(at[2], at[3]);
    assert.ok(edited.includes('`docs/index.md` (update)') && !edited.includes('(create)'), 'creates are not listed as edits');
    assert.match(body, /- `misc\/notes\.md` -- placement: no docs live near misc\//);
    assert.match(body, /- `docs\/commands\/older\.md` \(new\)\n- `docs\/cli\.md`\n/, 'a create carried from an earlier run stays marked as new');
  });
});

describe('reviewer decisions', () => {
  const web = 'noreply@github.com';
  const tool = (sha, extra = {}) => ({ sha, email: BOT_EMAIL, authorEmail: BOT_EMAIL, parents: ['p'], subject: 'docs(x): sync', body: '', ...extra });
  const human = (sha, extra = {}) => ({ sha, email: web, authorEmail: 'human@x', parents: ['p'], subject: 'review', body: '', ...extra });
  const editable = (p) => /^(docs\/.*|README)\.md$/.test(p);
  // `changes` maps a sha to its changes; `base` and `remote` are the paths present at each end.
  const classify = ({ commits, changes, base, remote, previous }) =>
    classifyReviewerChanges({
      commits,
      changesOf: (sha) => changes[sha] ?? [],
      baseHas: (p) => base.includes(p),
      remoteHas: (p) => remote.includes(p),
      isEditableDoc: editable,
      previous,
    });

  test('a rebased tool commit is still the tool: GitHub commits it, the tool stays the author', () => {
    assert.ok(isToolCommit(tool('t')));
    assert.ok(isToolCommit(tool('t', { email: web })));
    assert.ok(!isToolCommit(human('h')));
  });

  test('every row of the table', () => {
    const got = classify({
      commits: [tool('t'), human('h1'), human('h2')],
      changes: {
        t: [{ status: 'D', path: 'docs/tool-gone.md' }],
        h1: [
          { status: 'D', path: 'docs/a.md' },
          { status: 'D', path: 'docs/tool-new.md' },
          { status: 'A', path: 'docs/tool-gone.md' },
          { status: 'A', path: 'docs/mine.md' },
        ],
        h2: [
          { status: 'R', oldPath: 'docs/b.md', path: 'docs/c.md' },
          { status: 'R', oldPath: 'docs/other-new.md', path: 'docs/moved-new.md' },
          { status: 'M', path: 'docs/m.md' },
        ],
      },
      base: ['docs/a.md', 'docs/b.md', 'docs/tool-gone.md', 'docs/m.md'],
      remote: ['docs/tool-gone.md', 'docs/mine.md', 'docs/c.md', 'docs/moved-new.md', 'docs/m.md'],
    });
    assert.deepEqual(got, [
      { kind: 'deleted', path: 'docs/a.md' },
      { kind: 'renamed', path: 'docs/b.md', to: 'docs/c.md' },
      { kind: 'declined-create', path: 'docs/other-new.md' },
      { kind: 'declined-create', path: 'docs/tool-new.md' },
      { kind: 'declined-delete', path: 'docs/tool-gone.md' },
    ]);
  });

  test('several reviewer commits in order: the latest change on a path decides', () => {
    const base = ['docs/p.md', 'docs/q.md'];
    const d = (path) => ({ status: 'D', path });
    const a = (path) => ({ status: 'A', path });
    // Tool deleted q; the reviewer restored it, then deleted it again: a reviewer delete now.
    // The reviewer deleted p, then restored it: they do not want it deleted.
    // n was new: added, declined, re-added: nothing to remember.
    const got = classify({
      commits: [tool('t'), human('1'), human('2'), human('3')],
      changes: { t: [d('docs/q.md')], 1: [a('docs/q.md'), d('docs/p.md'), a('docs/n.md')], 2: [d('docs/q.md'), a('docs/p.md'), d('docs/n.md')], 3: [a('docs/n.md')] },
      base,
      remote: ['docs/p.md', 'docs/n.md'],
    });
    assert.deepEqual(got, [
      { kind: 'deleted', path: 'docs/q.md' },
      { kind: 'declined-delete', path: 'docs/p.md' },
    ]);
  });

  test('merges, tool commits and anything before the newest tool commit are skipped', () => {
    const got = classify({
      commits: [human('old'), tool('t1'), human('merge', { parents: ['a', 'b'] }), tool('t2', { email: web }), human('h')],
      changes: {
        old: [{ status: 'D', path: 'docs/folded.md' }],
        t2: [{ status: 'D', path: 'docs/tool.md' }],
        merge: [{ status: 'D', path: 'docs/merged.md' }],
        h: [{ status: 'D', path: 'docs/x.md' }],
      },
      base: ['docs/folded.md', 'docs/tool.md', 'docs/merged.md', 'docs/x.md'],
      remote: [],
    });
    assert.deepEqual(got, [{ kind: 'deleted', path: 'docs/x.md' }]);
  });

  test('previous decisions carry and are revalidated; contradicted ones disappear', () => {
    const previous = [
      { kind: 'deleted', path: 'docs/still.md' },
      { kind: 'deleted', path: 'docs/back.md' },
      { kind: 'declined-create', path: 'docs/created-anyway.md' },
      { kind: 'declined-create', path: 'docs/still-declined.md' },
      { kind: 'declined-delete', path: 'docs/deleted-anyway.md' },
      { kind: 'renamed', path: 'docs/r.md', to: 'docs/r2.md' },
      { kind: 'renamed', path: 'docs/s.md', to: 'docs/s2.md' },
      { kind: 'deleted', path: 'src/not-a-doc.md' },
    ];
    const got = classify({
      commits: [tool('t')],
      changes: {},
      base: ['docs/still.md', 'docs/back.md', 'docs/deleted-anyway.md', 'docs/r.md', 'docs/s.md', 'src/not-a-doc.md'],
      remote: ['docs/back.md', 'docs/created-anyway.md', 'docs/r2.md'],
      previous,
    });
    assert.deepEqual(got, [
      { kind: 'deleted', path: 'docs/s.md' },
      { kind: 'deleted', path: 'docs/still.md' },
      { kind: 'renamed', path: 'docs/r.md', to: 'docs/r2.md' },
      { kind: 'declined-create', path: 'docs/still-declined.md' },
    ], 'a rename whose new file is gone again is a delete');
  });

  test('commit message round trip; junk, non-canonical and non-editable lines are ignored; empty writes nothing', () => {
    const decisions = [
      { kind: 'declined-delete', path: 'docs/old.md' },
      { kind: 'deleted', path: 'docs/a.md' },
      { kind: 'renamed', path: 'docs/b.md', to: 'docs/c.md' },
      { kind: 'declined-create', path: 'docs/new.md' },
    ];
    const msg = commitMessage({ scope: 'x', from: 'a'.repeat(40), to: 'b'.repeat(40), target: 'main', files: [], reviewerDeleted: ['docs/a.md'], decisions, runUrl: 'https://r' });
    assert.match(msg, /- docs\/a\.md \(deleted by reviewer, carried forward\)\n\nReviewer decisions:\n- deleted docs\/a\.md\n- renamed docs\/b\.md -> docs\/c\.md\n- declined-create docs\/new\.md\n- declined-delete docs\/old\.md\n\nRun: https:\/\/r\n$/);
    const isPath = (p) => p.endsWith('.md') && p.startsWith('docs/');
    assert.deepEqual(renderReviewerDecisions([]), []);
    assert.deepEqual(parseReviewerDecisions(msg, isPath), [
      { kind: 'deleted', path: 'docs/a.md' },
      { kind: 'renamed', path: 'docs/b.md', to: 'docs/c.md' },
      { kind: 'declined-create', path: 'docs/new.md' },
      { kind: 'declined-delete', path: 'docs/old.md' },
    ]);
    const forged = ['Reviewer decisions:', '- deleted docs/../secret.md', '- deleted /docs/abs.md', '- deleted docs//x.md', '- deleted src/code.md', '- approved docs/a.md', '- renamed docs/a.md', '- renamed docs/a.md -> docs/a.md', '- deleted docs/ok.md', '', '- deleted docs/after-the-section.md'].join('\n');
    assert.deepEqual(parseReviewerDecisions(forged, isPath), [{ kind: 'deleted', path: 'docs/ok.md' }]);
    assert.deepEqual(parseReviewerDecisions('no section', isPath), []);
    const plain = commitMessage({ scope: 'x', from: 'a', to: 'b', target: 'main', files: ['docs/x.md'], decisions: [] });
    assert.ok(!plain.includes('Reviewer decisions'));
  });

  test('the drop step: the reviewer wins over triage, while a new nomination still undoes a tool delete', () => {
    const t = (path, action) => ({ path, action, reason: 'r', source_files: ['src/x.ts'] });
    const r = applyReviewerDecisions({
      affected: [t('docs/reviewer-gone.md', 'update'), t('docs/tool-gone.md', 'update'), t('docs/declined.md', 'create'), t('docs/restored.md', 'update'), t('docs/renamed.md', 'update')],
      deletes: [t('docs/restored.md', 'delete'), t('docs/other.md', 'delete')],
      decisions: [
        { kind: 'deleted', path: 'docs/reviewer-gone.md' },
        { kind: 'declined-create', path: 'docs/declined.md' },
        { kind: 'declined-delete', path: 'docs/restored.md' },
        { kind: 'renamed', path: 'docs/renamed.md', to: 'docs/new-name.md' },
      ],
    });
    assert.deepEqual(r.affected.map((a) => a.path), ['docs/tool-gone.md', 'docs/restored.md'], 'a declined delete still allows an update');
    assert.deepEqual(r.deletes.map((a) => a.path), ['docs/other.md']);
    assert.deepEqual(r.dropped.map((d) => `${d.action} ${d.path}: ${d.reason}`), [
      'update docs/reviewer-gone.md: deleted by a reviewer',
      'create docs/declined.md: new doc declined by a reviewer',
      'update docs/renamed.md: renamed by a reviewer to docs/new-name.md',
      'delete docs/restored.md: delete reverted by a reviewer',
    ]);
  });

  test('a declined create takes its index follow-up with it', () => {
    const manifest = buildManifest([
      { path: 'docs/index.md', content: '# Docs\n\n- [a](commands/a.md)\n' },
      { path: 'docs/commands/a.md', content: '# a\n' },
    ]);
    const create = { path: 'docs/commands/b.md', action: 'create', reason: 'New command b', source_files: ['src/b.js'] };
    assert.equal(planCreates({ affected: [create], manifest }).indexTasks.length, 1, 'without the decision there is a follow-up');
    const ruled = applyReviewerDecisions({ affected: [create], deletes: [], decisions: [{ kind: 'declined-create', path: 'docs/commands/b.md' }] });
    const plan = planCreates({ affected: ruled.affected, manifest });
    assert.deepEqual([plan.affected, plan.indexTasks], [[], []]);
  });

  test('link fix-ups for reviewer deletes depend on nothing; a rename names the new path', () => {
    const files = [
      { path: 'README.md', content: '[api](docs/api.md) and [cli](docs/cli.md) and [gone](docs/gone.md)\n' },
      { path: 'docs/index.md', content: '[cli](cli.md)\n' },
      { path: 'docs/specs/s.md', content: '[api](../api.md)\n' },
    ];
    const reviewer = [
      { kind: 'deleted', path: 'docs/api.md' },
      { kind: 'renamed', path: 'docs/cli.md', to: 'docs/client.md' },
    ];
    const toolDelete = { path: 'docs/gone.md', action: 'delete', reason: 'Gone', source_files: ['src/gone.ts'], flags: [] };
    const r = applyInboundLinks({
      affected: [],
      deletes: [toolDelete],
      reviewer,
      inbound: inboundLinks(files, ['docs/gone.md', 'docs/api.md', 'docs/cli.md']),
      isEditableDoc: (p) => !p.startsWith('docs/specs/'),
    });
    const byPath = new Map(r.affected.map((t) => [t.path, t]));
    assert.deepEqual(byPath.get('README.md').dependsOn, ['docs/gone.md'], 'a shared linker keeps the tool delete it depends on');
    assert.match(byPath.get('README.md').reason, /deleted by a reviewer/);
    assert.equal(byPath.get('docs/index.md').dependsOn, undefined);
    assert.equal(byPath.get('docs/index.md').reason, 'Retarget the link(s) to docs/cli.md to docs/client.md, renamed by a reviewer.');
    assert.deepEqual(Object.fromEntries(r.reviewerFixups), { 'docs/api.md': ['README.md'], 'docs/cli.md': ['README.md', 'docs/index.md'] });
    assert.deepEqual(r.deletes[0].flags, [], 'reviewer linkers never flag the tool delete');
    const survivors = dropOrphanedDependents(r.affected.filter((t) => t.path !== 'README.md'), new Set());
    assert.deepEqual(survivors.kept.map((t) => t.path), ['docs/index.md'], 'nothing to be orphaned by');
  });

  test('fix-ups of a reverted delete: a carried link removal goes back to triage, an unrelated edit stays', () => {
    const target = {
      'docs/index.md': '# Index\n\n- [v](commands/version.md)\n- [g](commands/greet.md)\n',
      'README.md': '# R\n\nSee [version](docs/commands/version.md).\n',
    };
    const carried = new Map([
      ['docs/index.md', { content: '# Index\n\n- [g](commands/greet.md)\n' }],
      ['README.md', { content: '# R\n\nSee [version](docs/commands/version.md). Now with more.\n' }],
      ['docs/new.md', { content: '# New\n' }],
    ]);
    assert.deepEqual(fixupsOfRevertedDelete('docs/commands/version.md', carried, (p) => target[p] ?? null), ['docs/index.md']);
  });

  test('a stale reviewer tombstone is discarded and reported, not sent to triage; an obsolete one just goes', () => {
    const r = reconcileReviewerCarry({
      decisions: [
        { kind: 'deleted', path: 'docs/changed.md' },
        { kind: 'renamed', path: 'docs/r.md', to: 'docs/r2.md' },
        { kind: 'deleted', path: 'docs/removed-on-target.md' },
        { kind: 'deleted', path: 'docs/live.md' },
        { kind: 'declined-delete', path: 'docs/kept.md' },
      ],
      stale: [
        { path: 'docs/changed.md', kind: 'delete' },
        { path: 'docs/r.md', kind: 'delete' },
        { path: 'docs/tool-delete.md', kind: 'delete' },
        { path: 'docs/edit.md', kind: 'edit' },
      ],
      obsolete: ['docs/removed-on-target.md', 'docs/other.md'],
    });
    assert.deepEqual(r.stale, [{ path: 'docs/tool-delete.md', kind: 'delete' }, { path: 'docs/edit.md', kind: 'edit' }]);
    assert.deepEqual(r.discarded.map((d) => d.path), ['docs/changed.md', 'docs/r.md']);
    assert.deepEqual(r.decisions, [{ kind: 'deleted', path: 'docs/live.md' }, { kind: 'declined-delete', path: 'docs/kept.md' }]);
  });

  test('triage sees the decisions; a requeued fix-up is named with its own reason', () => {
    const block = renderReviewerBlock([
      { kind: 'deleted', path: 'docs/a.md' },
      { kind: 'renamed', path: 'docs/b.md', to: 'docs/c.md' },
      { kind: 'declined-create', path: 'docs/n.md' },
      { kind: 'declined-delete', path: 'docs/o.md' },
    ]);
    assert.equal(block, '<reviewer_decisions>\nDeleted by a reviewer: docs/a.md\nRenamed by a reviewer: docs/b.md -> docs/c.md\nNew docs a reviewer declined: docs/n.md\nDeletes a reviewer reverted: docs/o.md\n</reviewer_decisions>');
    assert.equal(renderReviewerBlock([]), '');
    assert.ok(triageUser({ narrative: 'n', diff: 'd', manifest: 'm', reviewer: block }).endsWith(block));
    assert.match(TRIAGE_SYSTEM, /<reviewer_decisions>/);
    const stale = renderStaleBlock({ docs: [{ path: 'docs/index.md', kind: 'edit', reason: 'the delete they followed was reverted by a reviewer' }], from: 'a', to: 'b' });
    assert.match(stale, /the edit was discarded because the delete they followed was reverted by a reviewer: docs\/index\.md/);
    assert.ok(!stale.includes('target branch changed'));
  });

  test('PR body: reviewer section after the deletes, reviewer guideline banner, never cut by the size budget', () => {
    const reviewer = [
      { kind: 'deleted', path: 'docs/api.md', fixed: ['README.md'], linkers: ['docs/specs/s.md'] },
      { kind: 'deleted', path: 'CLAUDE.md', flags: [{ kind: 'guideline_delete', detail: '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,1 +0,0 @@\n-rule\n' }] },
      { kind: 'renamed', path: 'docs/cli.md', to: 'docs/client.md', fixed: ['docs/index.md'] },
      { kind: 'declined-create', path: 'docs/commands/wave.md' },
      { kind: 'declined-delete', path: 'docs/commands/version.md', requeued: [{ path: 'docs/index.md', redone: false }] },
      { kind: 'discarded', path: 'docs/was.md' },
    ];
    const body = renderPrBody({
      repo: 'o/r',
      target: 'main',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      commitCount: 1,
      deleted: [{ path: 'docs/gone.md', action: 'delete', reason: 'gone', check: { action: 'proceed', issues: [] }, flags: [] }],
      reviewer,
      kept: [{ path: 'docs/new.md', action: 'create', reason: 'n', check: { action: 'proceed', issues: [] }, flags: [], linkedFrom: [] }],
    });
    assert.ok(body.startsWith('> [!WARNING]\n> **Guideline file deleted by a reviewer: `CLAUDE.md`.**'), body.slice(0, 200));
    const at = ['Deleted this run', 'Reviewer changes on this branch', 'New docs'].map((h) => body.indexOf(`\n#### ${h}\n`));
    assert.ok(at.every((i) => i > 0) && [...at].sort((x, y) => x - y).join() === at.join());
    const section = body.slice(at[1], at[2]);
    assert.match(section, /- `docs\/api\.md` deleted by a reviewer\. To undo, restore the file on the branch \(\[bbbbbbb copy\]\(https:\/\/github\.com\/o\/r\/blob\/b{40}\/docs\/api\.md\)\)\.\n  - Links to it fixed this run in `README\.md`\n  - Still linked from `docs\/specs\/s\.md`\n/);
    assert.match(section, /- `docs\/cli\.md` renamed to `docs\/client\.md` by a reviewer\. To undo, rename it back on the branch\.\n  - Links to it fixed this run in `docs\/index\.md`/);
    assert.match(section, /- `docs\/commands\/wave\.md` new doc declined by a reviewer; not created again while this PR is open\. To undo, add the file back on the branch\./);
    assert.match(section, /- `docs\/commands\/version\.md` delete reverted by a reviewer; not deleted again while this PR is open\. To undo, delete it again on the branch\.\n  - The carried link fix-up in `docs\/index\.md` was discarded and sent back to triage: not selected again\./);
    assert.match(section, /- Reviewer delete of `docs\/was\.md` discarded because `main` changed the file; delete it again on the branch if still wanted\./);

    const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'deleted', path: `docs/reviewer-removed-${i}/a-long-document-name-${i}.md`, fixed: [], linkers: [] }));
    const thousands = Array.from({ length: 3000 }, (_, i) => ({ path: `docs/many/doc-${i}.md`, action: 'update', reason: 'x'.repeat(200), check: { action: 'proceed', issues: [] }, flags: [] }));
    const cut = renderPrBody({ target: 'main', from: 'a', to: 'b', commitCount: 1, kept: thousands, reviewer: many });
    assert.ok(cut.length <= PR_BODY_MAX);
    for (const r of many) assert.ok(cut.includes(`\`${r.path}\` deleted by a reviewer`), r.path);
  });
});
