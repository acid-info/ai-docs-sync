# ai-docs-sync

Shared automation that keeps a repo's documentation in step with its code. On every push to a
repo's target branch it reads the code diff together with the commit messages and any linked
PRs, decides which docs are affected, rewrites them with one model, has a second model check the
rewrite, runs mechanical gates, and maintains a single rolling pull request with the result.
Humans merge it.

Consumers call this repo as a **reusable workflow** pinned to `@v1`. Upgrading the tool or
swapping a model is one edit here, not one per consumer.

> **Status: scaffold.** The workflow, entry point and test harness exist; none of the stages
> below are implemented yet. Do not add this to a repo until `v1` is tagged.

## How it works

1. A push lands on the target branch: `develop` when the repo has one, otherwise the default
   branch, or whatever `target_branch` names.
2. The job checks out the **target branch** -- never a PR head -- for config, guideline files
   and docs, and checks out this repo for the tool.
3. The diff range runs from a cursor ref (`refs/ai-docs-sync/cursor`) to the checked-out head,
   so collapsed or queued runs never skip a commit and every commit is triaged exactly once.
4. A change narrative is built from local `git log`: each commit's title and body, plus the title
   and body of any PR those commits came from. Every model pass sees *why* the code changed, not
   just what.
5. Free exits first: a push that touches only docs (including merging the rolling PR) stops
   before any API call.
6. Triage picks the affected docs. A writer model rewrites each one, a checker model reviews
   the rewrite and can demand at most one correction pass.
7. Mechanical gates run on every edit: the path allowlist, link resolution, dash and attribution
   scans, size sanity, a banner for guideline-file edits, optional prettier.
8. The result is pushed to one rolling branch and one rolling PR per repo, updated in place.
   Edits not yet merged survive the next run. The cursor advances whatever the outcome.

The tool has **zero npm dependencies** and runs on Node 22's global `fetch`. Keep it that way:
no build step, no `package.json`.

## Adding it to a repo

Create `.github/workflows/docs-sync.yml` on your **default branch**:

```yaml
# AI docs sync. The tool lives in acid-info/ai-docs-sync -- edit it there.
# Runs on every push to the target branch and maintains one rolling docs PR.
name: AI Docs Sync

on:
  push:
    # List every branch that could be the target. The shared workflow resolves the real one at
    # run time and exits for the others, so over-listing is harmless.
    branches: [develop, main, master]
  workflow_dispatch:
    inputs:
      since:
        description: 'Commit SHA to diff from (backfill / re-run). Defaults to the cursor.'
        required: false
      dry_run:
        description: 'Print the would-be PR instead of pushing it'
        type: boolean
        default: false

permissions:
  contents: write
  pull-requests: write
  statuses: write

jobs:
  sync:
    uses: acid-info/ai-docs-sync/.github/workflows/docs-sync.yml@v1
    with:
      # Optional. Forces the target branch. Omitted: `develop` if it exists, else the default
      # branch. Lives here rather than in .github/docs-sync.yml because the config file is read
      # from the target branch, so it cannot also choose it.
      target_branch: ''
      since: ${{ inputs.since }}
      dry_run: ${{ inputs.dry_run == true }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      # Optional. A fine-grained PAT from a shared bot account. Only needed when the default
      # branch requires status checks on every PR; see "Secrets".
      DOCS_SYNC_TOKEN: ${{ secrets.DOCS_SYNC_TOKEN }}
```

`push` workflows run from the workflow file at the pushed commit, so the tool can be tested end
to end by temporarily listing a feature branch under `branches:`.

Pass the secrets explicitly. Do **not** use `secrets: inherit`: the tool has no business seeing
an `NPM_TOKEN` or a database URL.

`@v1` is a moving tag. A consumer that wants immutability pins the commit SHA instead; the
reusable workflow checks itself out at `github.job_workflow_sha` either way.

### Secrets

| Secret | Required |
| --- | --- |
| `ANTHROPIC_API_KEY` | At least one of the two |
| `OPENAI_API_KEY` | At least one of the two |
| `DOCS_SYNC_TOKEN` | No. Escape hatch, see below |

With both keys set, the checker runs on a different provider from the writer. With one, both
passes use that provider.

`GITHUB_TOKEN` is supplied by Actions and is enough for the default path, with **one repo
setting**: a repo admin enables "Allow GitHub Actions to create and approve pull requests"
(Settings -> Actions -> General -> Workflow permissions). While it is off, creating a PR with
`GITHUB_TOKEN` fails with a 403 regardless of the `permissions:` block, and the tool fails fast
saying so.

A PR pushed with `GITHUB_TOKEN` does not trigger other workflows, so the rolling PR gets no CI
run. The PR is Markdown-only by construction and the tool reports its own gates as a
`docs-sync/gates` commit status.

Escape hatch, for a repo where that toggle is org-locked or the default branch requires a status
check on every PR: set `DOCS_SYNC_TOKEN` to a fine-grained PAT from a shared bot account with
`contents: write`, `pull-requests: write` and `statuses: write` on that repo only. The tool then
pushes and opens the PR as that account, which also triggers CI on the rolling branch.

## Per-repo configuration

At `.github/docs-sync.yml`, read from the **target branch**. `doc_paths` is the only required
key.

| Key | Effect |
| --- | --- |
| `doc_paths` | Globs the tool may create or edit. Markdown only; anything else is refused in code. |
| `never_touch` | Subtracted from `doc_paths`. Everything under `.github/` is subtracted whether or not it is listed. |
| `extra_ignore` | Diff-side ignores, appended to the built-in list. Same semantics as ai-review. |
| `guidelines_files` | Priority list; the first that exists is loaded. `AGENTS.md` is special-cased as in ai-review. |
| `branch` | Rolling branch name. Default `docs/repo/sync`. Refused if it names the target or default branch. |
| `narrative_max_tokens` | Budget for commit and PR messages fed to the models. Default `6000`. |
| `label` | Label on the rolling PR. Default `docs-sync`. |
| `max_docs_per_run` | Writer calls per run; the rest are listed in the PR body. Default `8`. |
| `format_check` | `off` (default) or `strict`. `strict` needs `setup_command`. |
| `setup_command` | Shell run before prettier, e.g. `corepack enable && pnpm install --frozen-lockfile`. |

```yaml
doc_paths:
  - README.md
  - AGENTS.md
  - docs/**/*.md
  - apps/*/AGENTS.md
  - apps/*/README.md
  - apps/*/docs/**/*.md
  - packages/*/README.md

never_touch:
  - docs/superpowers/specs/**      # dated design records, not maintained docs

extra_ignore:
  - flake.lock
  - packages/types/src/payload.ts

guidelines_files:
  - AGENTS.md
  - CLAUDE.md
```

Models, effort, token budgets and severity thresholds are **owned centrally** in `DEFAULTS` in
`lib.mjs`. Setting one in a repo config logs a warning and is ignored: a repo that could pin its
own model would put the tool back in N places.

Built-in ignores cover lockfiles, `*.min.js`, `*.map`, `dist/`, `vendor/`, `__snapshots__/` and
`*.generated.*`.

Guideline files (`AGENTS.md`, `CLAUDE.md`, anything in `guidelines_files`) are editable like any
other doc when `doc_paths` covers them. An edit to one gets a banner at the top of the PR body
with the full diff inline. A repo that wants them hand-maintained lists them in `never_touch`.

## Changing a model

Edit `DEFAULTS` in `lib.mjs`, then check **two** other places in the same file:

1. **`PRICES`**: add the new model, or the cost line reports it as unpriced and excludes it from
   the total.
2. **`EFFORT_MODELS`**: a model-family regex gating `output_config.effort`. A model string that
   does not match silently loses the effort config rather than erroring.

Then tag: `git tag -f v1 && git push -f origin v1`. Every consumer picks it up on its next run.

## Running it locally

```bash
node --check docs-sync.mjs && node --check lib.mjs && node --test 'test/**/*.test.mjs'
```

That is what CI runs. `test/` imports `lib.mjs` only; `lib.mjs` has no side effects at import
time and never reads `process.env` or touches the network. `docs-sync.mjs` is the only file that
does.

Once the stages exist: `DRY_RUN=1` prints the would-be PR instead of pushing it (the model calls
still run and are paid for); `TRIAGE_ONLY=1` stops after triage; a junk API key proves config and
diff handling for free, since everything before the first model call runs and then the run dies
at a 401.

The reusable workflow itself has no runnable form without a caller: `workflow_call` cannot be
dispatched directly. End-to-end changes have to be proved on a real push in a consumer repo.

## Security model

- The job checks out the consumer's **target branch**, never a PR head. Config, guidelines, docs
  and the tool are trusted code. The diff, commit messages and PR bodies arrive as data and are
  only ever placed in user turns.
- The tool can only write `.md` files inside `doc_paths` minus `never_touch` minus a built-in
  denylist, checked on the canonicalised path (no `..`, no absolute, no symlink component) after
  every model call. A prompt-injected diff can, at worst, produce a bad doc edit in the rolling
  PR, which a human reviews.
- The tool may edit its own instruction source (`AGENTS.md`, `CLAUDE.md`, `guidelines_files`)
  when `doc_paths` covers it. Such an edit is bannered at the top of the PR body with its full
  diff, and the writer loads the target branch's copy of the guidelines, never a draft from the
  same run.
- The cursor is a git ref, movable only with `contents: write`. Nothing read from a PR body
  drives control flow; the rolling PR is located by head and base, not by marker.
- The force-push target is validated (not the target or default branch, safe charset) and the
  existing branch must consist solely of the tool's own commits.
- No write credential is persisted in the checkout. `setup_command` and prettier run in a tree
  whose `.git/config` holds no token; only the push and cursor-update child processes receive
  it, via environment.
- `permissions:` is bounded by the consumer's workflow file. Never `secrets: inherit`.
- Nothing from the event payload is interpolated into shell text; the resolve step reads it from
  `env`.
- No network fetch of code at run time: the tool has no dependencies and `strict` formatting
  uses the consumer's own installed prettier.
- `@mentions` and issue-closing keywords in anything model- or narrative-derived are defused
  before posting.

**Whoever can push the `v1` tag executes code with `contents: write` in every consumer repo.**
This is a separate repo from `ai-review` for that reason: sharing a tag between a reader and a
writer would let whoever can push it turn a reviewer into a writer everywhere. Restrict tag
pushes here to the same group that controls `ai-review`; consumers that want more pin a SHA.

## License

MIT.
