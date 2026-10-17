export const meta = {
  name: 'pr-evidence',
  description: 'Build the PR evidence section: crow\'s-foot before/after ER diagrams for schema changes, before/after screenshots for UI changes',
  whenToUse: 'Before gh pr create, or to add evidence to an existing PR. Pass args: {repo, base, task}. Runs standalone or as the last phase of /fuse.',
  phases: [
    { title: 'Classify', detail: 'what kind of evidence does this diff owe?' },
    { title: 'Derive', detail: 'terra derives the ER diagrams; playwright captures the UI' },
  ],
}

// The grunt slot. This work is mechanical — read two trees, diff the schema,
// emit mermaid — so it is pinned to a cheap model with an explicit --model and
// never costs frontier reasoning.
// Routed through the codex plugin's companion runtime, NOT a hand-rolled
// `codex exec`: the plugin owns its own flags and this gets job tracking
// (status/result/cancel) for free. Read-only — no --write, so it cannot edit
// the repo while deriving a diagram. The path globs the version so a plugin
// update does not break it.
// `--effort` accepts none|minimal|low|medium|high|xhigh — there is no `max`.
// A raw `codex exec -c model_reasoning_effort=<bogus>` is swallowed unvalidated,
// so only these six values can be confirmed to take effect.
// No --model: inherit `model` from ~/.codex/config.toml (gpt-6.1-sol), so the
// model moves in one place instead of N workflow files.
// high: owner standard for every Codex run (2026-10-04). Was low here to
// keep this mermaid-only slot cheap; revert to low if cost matters more.
const CODEX = 'node "$(ls -1d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1)"'
const TERRA = `${CODEX} task --effort high`
const SCOUT = { model: 'sonnet', effort: 'max' }

const REPO = (args && args.repo) || '.'
const BASE = (args && args.base) || ''  // empty = detect the repo's default branch
const TASK = (args && args.task) || ''

const CLASSIFY = {
  type: 'object',
  required: ['has_migration', 'has_ui'],
  properties: {
    has_migration: { type: 'boolean' },
    has_ui: { type: 'boolean' },
    migration_files: { type: 'array', items: { type: 'string' } },
    ui_files: { type: 'array', items: { type: 'string' } },
    merge_base: { type: 'string', description: 'The merge-base SHA against the base branch' },
    head: { type: 'string', description: 'Current HEAD SHA, or "working-tree" if uncommitted' },
    other: { type: 'string', description: 'What else changed that owes evidence — API shape, data, refactor' },
  },
}

const SECTION = {
  type: 'object',
  required: ['markdown'],
  properties: {
    markdown: { type: 'string', description: 'The finished markdown section, ready to paste into a PR body' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Anything that could not be verified, stated honestly' },
  },
}

// ─── Classify ──────────────────────────────────────────────────────────────

phase('Classify')

const kind = await agent(`Read-only. Work out what evidence this change owes.

REPO: ${REPO}
BASE BRANCH: ${BASE || 'NOT GIVEN — detect it first'}

${BASE ? '' : `Detect the base branch before anything else. Try in order:
  git -C ${REPO} symbolic-ref --short refs/remotes/origin/HEAD
  gh repo view --json defaultBranchRef --jq .defaultBranchRef.name
  then fall back to origin/main, then origin/master.
Report which one you used.

`}Then run:
  git -C ${REPO} fetch origin --quiet
  git -C ${REPO} merge-base <base> HEAD
  git -C ${REPO} diff --name-only $(git -C ${REPO} merge-base <base> HEAD)
  git -C ${REPO} status --short

Classify the changed paths:
- has_migration: true if anything under migrations/versions/ changed, or any
  other Alembic or DDL file.
- has_ui: true if any component, page, screen or style file changed — anything
  a user would see rendered.

Report the merge-base SHA and the head SHA. If the change is uncommitted, report
head as "working-tree". Do not write anything.`,
  { label: 'classify', phase: 'Classify', schema: CLASSIFY, ...SCOUT })

if (!kind) return { status: 'aborted', reason: 'could not classify the diff' }
if (!kind.has_migration && !kind.has_ui) {
  log('No schema and no UI change — evidence is the checks you ran, nothing to derive')
  return { status: 'none-owed', other: kind.other, markdown: '' }
}

// ─── Derive ────────────────────────────────────────────────────────────────
// Pipeline, not a barrier: the ER work and the screenshots are independent, and
// the assembler is happy to take whichever finishes first.

phase('Derive')

const jobs = []

if (kind.has_migration) {
  jobs.push(() => agent(`Derive the before/after ER diagrams for this schema change. Delegate the derivation itself to Terra — it is mechanical work and Terra is the cheap slot for it.

REPO: ${REPO}
MIGRATIONS: ${(kind.migration_files || []).join(', ')}
MERGE-BASE: ${kind.merge_base}
HEAD: ${kind.head}

Run Terra with a heredoc so the prompt survives quoting:

  cd ${REPO} && ${TERRA} "$(cat <<'PROMPT'
  <your prompt here>
  PROMPT
  )"

Tell Terra to produce a "## Schema changes (ER)" section containing:

1. A short **What changed** list — one line per DDL operation. New table, new
   column with its type, new foreign key, drop.

2. Two fenced mermaid erDiagram blocks titled **Before** and **After**. Mermaid
   erDiagram is crow's-foot notation natively — \`||--o{\` is one-to-many with the
   crow's foot on the many side. Use plain syntax only: \`TABLE ||--o{ OTHER : label\`
   and columns as \`type name PK\` or \`type name FK\`.

Scope and derivation rules Terra must follow:
- Include every table the migration creates, alters or drops, PLUS every table
  those reference by foreign key in either direction. Collapse an unchanged
  neighbour to its primary key and the linking FK column only.
- Derive **Before** from the ORM model or schema files as they existed at the
  merge-base: \`git -C ${REPO} show ${kind.merge_base}:<path/to/model>\`
  Derive **After** from the head. Then cross-check both against the migration's
  own operations, which are canonical for DDL. If the models and the migration
  disagree, SAY SO in the section rather than papering over it.
- Hub-table exception: if a touched table has 10 or more FK neighbours (jobs is
  one), drawing them all buries the change. Show only the relevant neighbours and
  name every omitted one in prose.
- Check the migration's down_revision against the base branch's current alembic
  head. A parent that already has a child there means two alembic heads on merge,
  and the deploy crash-loops at \`alembic upgrade head\`. This is the single most
  expensive thing this pass can catch — report it loudly if you find it.

Then verify Terra's output yourself before returning it:
- Every mermaid block must be syntactically valid. An unrenderable block is worse
  than no block.
- Every table and column Terra names must actually exist in the tree it claims to
  have read. Spot-check at least the changed ones.

Return the finished section as markdown.`,
    { label: 'evidence:er', phase: 'Derive', schema: SECTION, model: 'opus', effort: 'max' }))
}

if (kind.has_ui) {
  jobs.push(() => agent(`Capture before/after screenshots for this UI change.

REPO: ${REPO}
UI FILES: ${(kind.ui_files || []).join(', ')}
CHANGE: ${TASK}

If this environment has a PR-report or screenshot-evidence skill, invoke it and
follow it rather than reinventing its recipe. Otherwise apply these rules, which
are the parts that actually matter:

- The in-app Browser pane screenshot tool returns images to you only and CANNOT
  write files. Use Playwright MCP (\`browser_take_screenshot\` with a \`filename\`)
  for anything going into a PR body.
- Set a consistent viewport first (1440x900) so the set looks like one set.
- Changed surface needs a before/after pair: base branch, then head. New surface
  needs the new states only — default, plus filled, empty and error where they
  exist.
- Capture the CLAIM, not the page. If the change is "the button stays disabled",
  the shot must show that button in that state. Assert it programmatically
  alongside the image with \`browser_evaluate\` so the shot cannot be misread.
- Name files so the sequence reads alone: 01-before-<state>.png, 02-after-<state>.png.
- Write them to a throwaway dir (e.g. /tmp/pr-shots/) — never the repo root.
- Upload via GitHub's attachments endpoint, which prints <img> tags to paste.
  A repo-path image does NOT render in a private repo's PR body.

If capture is genuinely impossible — the surface needs production data or
hardware — say so explicitly in the section and show the closest verifiable state
instead. Never fabricate or predict a screenshot.

Return a "## Verification" markdown section with each image under a heading
naming what it proves.`,
    { label: 'evidence:ui', phase: 'Derive', schema: SECTION, model: 'opus', effort: 'max' }))
}

const sections = (await parallel(jobs)).filter(Boolean)

const markdown = sections.map(s => s.markdown).filter(Boolean).join('\n\n')
const warnings = sections.flatMap(s => s.warnings || [])
log(`Evidence: ${sections.length} section(s), ${warnings.length} warning(s)`)

return {
  status: 'ok',
  markdown,
  warnings,
  owed: { schema: !!kind.has_migration, ui: !!kind.has_ui, other: kind.other },
}
