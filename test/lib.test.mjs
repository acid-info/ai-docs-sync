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
  renderPrBody,
  PR_BODY_MAX,
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

  test('applies defaults and appends extra_ignore to the built-in list', () => {
    const c = cfg();
    assert.equal(c.branch, 'docs/repo/sync');
    assert.equal(c.max_docs_per_run, 8);
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
  test('ownership: tool commits, merges and doc additions or edits by others are fine; anything else is foreign', () => {
    const m = (path) => ({ status: 'M', path });
    const changes = {
      tool: [m('docs/a.md')],
      merge: [m('src/x.ts')],
      suggestion: [m('docs/a.md'), { status: 'A', path: 'docs/new.md' }],
      code: [m('docs/a.md'), m('src/x.ts')],
      removal: [{ status: 'D', path: 'docs/a.md' }],
      rename: [{ status: 'R', path: 'docs/b.md', oldPath: 'docs/a.md' }],
    };
    const opts = { changesOf: (sha) => changes[sha], isEditableDoc: (f) => f.startsWith('docs/') };
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
    const rebased = { ...tool, email: web };
    assert.equal(foreignBranchCommit([rebased], opts), null, '"Update with rebase" keeps the tool as author');
    for (const sha of ['removal', 'rename']) {
      const c = { ...suggestion, sha };
      assert.equal(foreignBranchCommit([c, tool], opts), c, `carry-forward cannot carry a ${sha}`);
    }
  });

  test('restore/stale plan', () => {
    const plan = planCarryForward({
      branchFiles: ['docs/a.md', 'docs/b.md', 'src/x.ts'],
      targetChangedSinceBase: (f) => f === 'docs/b.md',
      isEditableDoc: (f) => f.endsWith('.md'),
    });
    assert.deepEqual(plan, { restore: ['docs/a.md'], stale: ['docs/b.md'], ignored: ['src/x.ts'] });
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
  const opts = { isEditableDocPath: makeIsEditableDocPath(cfg()), exists: (p) => p === 'docs/api/architecture.md', maxDocs: 2 };
  test('accepts a good answer, decides the action from existence, drops disallowed paths, caps', () => {
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify({
      affected: [
        { path: 'docs/api/architecture.md', action: 'create', reason: 'moved', source_files: ['apps/api/x.ts', '../../evil'] },
        { path: 'content/blog/x.md', action: 'update', reason: 'no' },
        { path: 'docs/../../x.md', action: 'update', reason: 'no' },
        { path: 'apps/api/README.md', action: 'update', reason: 'new app' },
        { path: 'docs/api/architecture.md', action: 'update', reason: 'dupe' },
        { path: 'docs/extra.md', action: 'create', reason: 'overflow' },
      ],
      delete_candidates: [{ path: 'docs/civi-crm/architecture.md', reason: 'removed' }],
      unaffected_reason: '',
    })}\n\`\`\``;
    const r = parseTriage(text, opts);
    assert.deepEqual(r.affected.map((a) => [a.path, a.action]), [['docs/api/architecture.md', 'update'], ['apps/api/README.md', 'create']]);
    assert.deepEqual(r.affected[0].source_files, ['apps/api/x.ts']);
    assert.deepEqual(r.overflow.map((a) => a.path), ['docs/extra.md']);
    assert.deepEqual(r.dropped.map((d) => d.path), ['content/blog/x.md', 'docs/../../x.md']);
    assert.equal(r.deleteCandidates[0].path, 'docs/civi-crm/architecture.md');
  });
  test('returns null on unparseable or schema-less output', () => {
    assert.equal(parseTriage('not json', opts), null);
    assert.equal(parseTriage('{"foo": 1}', opts), null);
  });
  test('empty affected is a valid, complete answer', () => {
    const r = parseTriage('{"affected": [], "delete_candidates": [], "unaffected_reason": "deps only"}', opts);
    assert.equal(r.affected.length, 0);
    assert.equal(r.unaffectedReason, 'deps only');
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
    const msg = commitMessage({ scope: 'web', from: 'a'.repeat(40), to: 'b'.repeat(40), target: 'develop', files: ['docs/x.md'], carried: ['README.md'], runUrl: 'https://r' });
    assert.match(msg, /^docs\(web\): sync with aaaaaaa\.\.bbbbbbb\n\nRange: a{40}\.\.b{40} on develop\n\nFiles:\n- docs\/x\.md\n- README\.md \(carried forward\)\n\nRun: https:\/\/r\n$/);
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
    carried: [{ path: 'README.md', run: { from: '1111111aaa', to: '2222222bbb' } }],
    stale: [
      { path: 'docs/old.md', since: 'c'.repeat(40), redone: false },
      { path: 'docs/api.md', since: 'd'.repeat(40), redone: true },
    ],
    dropped: [{ path: 'docs/bad.md', gate: 2, reason: 'broken relative link(s): ./@nope.md' }],
    heldBack: [{ path: 'docs/huge.md', reason: 'too large for a full rewrite in v1' }],
    deleteCandidates: [{ path: 'docs/gone.md', reason: 'App removed' }],
    overflow: [{ path: 'docs/later.md', reason: 'also stale' }],
    omittedDiff: ['big/file.ts'],
    outline: [{ pr: { number: 153, title: 'refactor: move funnel, closes #99' }, commits: [{ short: 'abc1234', subject: 'refactor @bob' }] }],
    usage: { entries: [{ label: 'triage', model: 'claude-sonnet-5', input: 10, cacheRead: 0, output: 5, cost: 0.001 }], total: 0.001, unpriced: [] },
    runs: [{ at: 't', from: 'a', to: 'b', files: ['docs/api.md', 'AGENTS.md'] }],
  });

  test('renders every section, bannered guideline diff first, everything defused', () => {
    const body = renderPrBody(base());
    assert.ok(body.startsWith('> [!WARNING]\n> **Guideline file edited: `AGENTS.md`.**'), 'banner at the very top');
    assert.match(body, /````diff\n[\s\S]*\+new ``` closes #​3\n````/, 'fence outlasts the backticks in the diff, keyword defused');
    for (const h of ['Edited this run', 'Carried forward', 'Earlier edits discarded because `develop` changed the file', 'Held back', 'New links, raw HTML and vendor names to check', 'Delete candidates', 'Also likely affected', 'Diff not shown', 'Commits and PRs in this range', 'API usage'])
      assert.ok(body.includes(`\n#### ${h}`), h);
    assert.ok(!/^#{1,3} /m.test(body), 'no heading above level 4');
    assert.ok(!body.includes('Nothing merges without a human'));
    assert.match(body, /thanks @​alice, fixes #​12 &lt;!--/);
    assert.match(body, /addressed in the correction pass:\n    - \[must\] Claims hCaptcha &lt;b&gt;still&lt;\/b&gt; runs/);
    assert.match(body, /Checker: \*\*unchecked\*\*/);
    assert.match(body, /2 line\(s\) had en\/em dashes replaced/);
    assert.match(body, /`README\.md` \(from `1111111\.\.2222222`\)/);
    assert.match(body, /`docs\/old\.md`: triage was asked again and did not select it\. To force it, re-run with `since=c{40}`/);
    assert.match(body, /`docs\/api\.md`: redone this run on top of the new version/);
    assert.match(body, /gate 2: broken relative link\(s\): \.\/@​nope\.md/);
    assert.match(body, /new URLs: `https:\/\/evil\.example\/@​x`/);
    assert.match(body, /- #153 refactor: move funnel, closes #​99\n  - `abc1234` refactor @​bob/);
    assert.match(body, /Total ~\$0\.0010/);
    assert.ok(!/<!--(?! ai-docs-sync )/.test(body), 'the only HTML comment is the marker');
    assert.equal(body.match(/-->/g).length, 1);
    assert.deepEqual(parseMarker(body), base().runs);
  });

  test('over the cap the narrative is trimmed first and the marker survives', () => {
    const outline = [{ pr: null, commits: Array.from({ length: 3000 }, (_, i) => ({ short: `c${i}`, subject: `subject ${i} `.repeat(4) })) }];
    const body = renderPrBody({ ...base(), outline });
    assert.ok(body.length <= PR_BODY_MAX, `${body.length}`);
    assert.match(body, /more line\(s\) not shown/);
    assert.match(body, /#### API usage/, 'sections after the narrative are kept');
    assert.deepEqual(parseMarker(body), base().runs);

    const huge = base();
    huge.kept[1].flags[0].detail = '+x\n'.repeat(40_000);
    const cut = renderPrBody(huge);
    assert.ok(cut.length <= PR_BODY_MAX);
    assert.match(cut, /\(truncated\)/);
    assert.deepEqual(parseMarker(cut), base().runs);
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
});
