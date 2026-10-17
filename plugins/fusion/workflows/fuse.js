export const meta = {
  name: 'fuse',
  description: 'Gate-first multi-model build: blind scout, plan + failing gate, build, verify loop, blind review, fusion merge, PR evidence',
  whenToUse: 'A change big enough that you want it planned, proven and cross-reviewed without babysitting. Pass args: {task, repo, maxRounds}.',
  phases: [
    { title: 'Scout', detail: 'three blind perspectives — repo read, codex research, gemini query' },
    { title: 'Gate', detail: 'architect writes the plan and an acceptance gate that MUST fail first' },
    { title: 'Build', detail: 'slices build in parallel against a frozen contract; drift re-freezes once' },
    { title: 'Verify', detail: 'run the gate, feed the fail lines back, bounded rounds' },
    { title: 'Review', detail: 'three blind reviewers on the diff' },
    { title: 'Fuse', detail: 'a fresh architect merges: consensus, divergence, discarded' },
    { title: 'Fix', detail: 'builder applies CRITICAL and HIGH, then the gate re-runs' },
    { title: 'Evidence', detail: 'terra builds the PR evidence section' },
  ],
}

// ─── Roster ────────────────────────────────────────────────────────────────
// Roles are slots, not model names. Swap a model here and nothing else moves.
// Cross-family slots are not listed here. Codex is selected per call via the
// codex plugin's `--model` / `--effort`; antigravity auto-picks the deepest
// Gemini Pro tier and REJECTS a caller-side model argument.
// EFFORT POLICY: everything runs at max. Nothing runs below high, ever — a slot
// that looks mechanical still decides what to report, and a cheap decision there
// is the one nobody re-checks. Two exceptions, both deliberate:
//   fable        → xhigh  (operator rule)
//   codex family → high   (gpt-6.1-sol, owner 2026-10-04; `--effort` accepts none|minimal|low|medium|high|
//                  xhigh; a raw `codex exec -c model_reasoning_effort=<bogus>`
//                  is swallowed unvalidated, so "max" is unverifiable there)
const ARCHITECT = { model: 'fable', effort: 'xhigh' } // plans, writes the gate, fuses
const BUILDER = { model: 'opus', effort: 'max' }      // implements and fixes
const RUNNER = { model: 'sonnet', effort: 'max' }     // runs the gate, wraps the advisors

// Build slices are heterogeneous. The architect tags each slice with a hint and
// this maps it to a slot, so a UI slice gets the taste model.
const SLICE_MODELS = {
  ui: { model: 'fable', effort: 'xhigh' },        // interface work — taste
  architecture: { model: 'fable', effort: 'xhigh' },
  mechanical: { model: 'sonnet', effort: 'max' }, // renames, moves, generated code
  default: BUILDER,
}
const sliceModel = (hint) => SLICE_MODELS[hint] || SLICE_MODELS.default

const TASK = typeof args === 'string' ? args : ((args && args.task) || '')
const REPO = (args && args.repo) || '.'
const MAX_ROUNDS = (args && args.maxRounds) || 3
const SKIP_EVIDENCE = !!(args && args.skipEvidence)
// Project-specific review lenses. Nothing here is hardcoded — a repo that cares
// about tenant timezones, RLS, or a house error-state contract passes them in.
// Empty by default so this workflow is not tied to any one codebase.
const HOUSE_RULES = (args && args.houseRules) || ''

if (!TASK) {
  throw new Error('fuse: pass the task, e.g. args: {task: "...", repo: "."}')
}

// ─── Shared prompt blocks ──────────────────────────────────────────────────

// Carried over from the agent-teams Independence Protocol. This is what decides
// whether a second opinion is worth anything: two models that were handed the
// same framing are one opinion wearing two hats.
const BLIND = `
INDEPENDENCE RULES — these decide whether the answer is worth anything.
- Send the EVIDENCE and the QUESTION. Never send your own diagnosis or your
  preferred design. A prompt that names your answer gets you a critique of your
  answer, never the better option nobody put on the table.
- Hold your own view back completely in round 1. If the tool offers a dedicated
  hypothesis channel — antigravity takes \`caller_hypothesis\` — use THAT and only
  that: it presents your view as a claim to REFUTE and returns an explicit
  CONFIRMED / REFUTED / UNPROVEN verdict. Codex through the plugin runtime has no
  such channel, so there you simply do not state it.
- Never smuggle a conclusion into a scoping field (\`context\`, \`focus\`, \`topic\`).
  Antigravity lint-checks these and prints an ANCHORING WARNING on a hit; the
  Codex path has no lint, so nothing will catch you but you.
- Every version, API, CVE, pricing or best-practice claim needs a live source
  URL. An uncited claim was answered from memory — re-ask, do not repeat it.
`

// Also from agent-teams. A missing method fails at lint time in seconds; a
// present-but-unsupported one fails in production on real customer data.
const RUNTIME_CAPABILITY = `
RUNTIME CAPABILITY CHECK — "present" is not "supported".
Type stubs describe the union of every backend a library supports, never the one
deployed. At every call crossing into a swappable backend (browser engine, DB
driver or dialect, storage/LLM/queue provider, cloud SDK against a compatible
endpoint, container-provided binary), ask which backend implements it and whether
that is the backend actually deployed. Flag any try/except that turns a capability
miss into a silent no-op without recording which failure occurred, and any
parameter accepted then ignored, clamped or silently downgraded.
`

// Codex runs through the codex plugin's companion runtime — no MCP server and no
// hand-rolled `codex exec`. The plugin owns its own flags, returns a documented
// JSON schema, and gives job tracking (status/result/cancel) for free.
// The path globs the version so a plugin update does not break this.
const CODEX = 'node "$(ls -1d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1)"'
const LOAD_GEMINI = 'FIRST call ToolSearch(query="antigravity", max_results: 12) to load the antigravity MCP tools. They are deferred and cannot be called before that. If they are unavailable in this environment, say so and return empty findings rather than substituting your own opinion.'

// ─── Schemas ───────────────────────────────────────────────────────────────

const SCOUT = {
  type: 'object',
  required: ['findings', 'files', 'risks'],
  properties: {
    findings: { type: 'string', description: 'What the change must touch and why' },
    files: { type: 'array', items: { type: 'string' }, description: 'Exact paths this change touches' },
    risks: { type: 'array', items: { type: 'string' }, description: 'Ranked, highest first' },
    sources: { type: 'array', items: { type: 'string' }, description: 'URLs for any external claim' },
  },
}

const PLAN = {
  type: 'object',
  required: ['plan', 'contract', 'slices', 'gate_path', 'baseline_exit', 'baseline_output'],
  properties: {
    plan: { type: 'string', description: 'The implementation plan, in enough detail to build from' },
    contract: {
      type: 'string',
      description: 'The FROZEN interface between slices: exact field names, types, endpoint paths, enum values, error shapes. Builders implement against this and never negotiate it.',
    },
    slices: {
      type: 'array',
      description: 'Disjoint units of build work. One per repo where possible. Two slices must never own the same file.',
      items: {
        type: 'object',
        required: ['name', 'repo', 'files', 'instruction'],
        properties: {
          name: { type: 'string' },
          repo: { type: 'string', description: 'Repo path relative to the workspace root' },
          files: { type: 'array', items: { type: 'string' }, description: 'Every file this slice owns' },
          instruction: { type: 'string', description: 'Self-contained. The builder sees this and the contract, nothing else.' },
          model_hint: { type: 'string', enum: ['ui', 'architecture', 'mechanical', 'default'] },
        },
      },
    },
    gate_path: { type: 'string', description: 'Absolute path to the gate script you wrote' },
    gate_summary: { type: 'string', description: 'What each check in the gate proves' },
    baseline_exit: { type: 'integer', description: 'Exit code of the gate run against the untouched tree' },
    baseline_output: { type: 'string', description: 'Verbatim output of that baseline run' },
  },
}

const BUILD = {
  type: 'object',
  required: ['summary', 'files_changed'],
  properties: {
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'Anything the reviewer cannot reconstruct from the diff' },
    drift: {
      type: 'string',
      description: 'EMPTY unless the frozen contract turned out to be wrong. If it is wrong, stop, describe exactly which part and what it must become, and do NOT implement your own version.',
    },
  },
}

const GATE_RUN = {
  type: 'object',
  required: ['exit_code', 'output'],
  properties: {
    exit_code: { type: 'integer' },
    fail_lines: { type: 'array', items: { type: 'string' }, description: 'Only the lines reporting a failure' },
    output: { type: 'string' },
  },
}

const TRIAGE = {
  type: 'object',
  required: ['culprit', 'reasoning'],
  properties: {
    culprit: { type: 'string', enum: ['code', 'gate'], description: 'Is the code wrong, or is the gate wrong?' },
    reasoning: { type: 'string' },
    instruction: { type: 'string', description: 'What the builder must do next, if culprit is code' },
    baseline_exit: { type: 'integer', description: 'If you repaired the gate, its exit code now' },
  },
}

const REVIEW = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'summary', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string' },
          evidence: { type: 'string', description: 'Concrete inputs or state that produce the wrong result' },
        },
      },
    },
    sources: { type: 'array', items: { type: 'string' } },
    anchoring_warning: { type: 'boolean', description: 'True if any advisor answer carried an ANCHORING WARNING banner' },
  },
}

const FUSION = {
  type: 'object',
  required: ['consensus', 'divergence', 'discarded', 'must_fix'],
  properties: {
    consensus: { type: 'array', items: { type: 'string' }, description: 'Findings more than one reviewer reached independently' },
    divergence: { type: 'array', items: { type: 'string' }, description: 'Where reviewers disagree, and which side you take and why' },
    discarded: { type: 'array', items: { type: 'string' }, description: 'Findings you rejected, with the reason' },
    must_fix: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'instruction'],
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH'] },
          file: { type: 'string' },
          instruction: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', description: 'One sentence: is this shippable?' },
  },
}

// ─── Phase 1: Scout — three blind perspectives ─────────────────────────────
// A barrier is correct here: the architect reads all three before planning.

phase('Scout')
log(`fuse: ${TASK}`)

const scouts = (await parallel([
  () => agent(`Read-only reconnaissance. Do NOT write or edit anything.

TASK: ${TASK}
REPO: ${REPO}

Trace the real flow end to end before you conclude anything. Map what this change
must touch: the files, every call site, the existing patterns it should match, the
data it reads and writes. Name the sibling callers a narrow fix would leave broken
— grep every caller of any function this change would touch. Name the constraints
that are real (schema, RLS, tenant timezone, existing API consumers, downstream
repos) and say where you read each one.

Report what is there. Do not propose a design.`,
    { label: 'scout:repo', phase: 'Scout', schema: SCOUT, ...BUILDER }),

  () => agent(`Get an independent technical read on this problem from Codex (gpt-6.1-sol, high).

TASK: ${TASK}
REPO: ${REPO}

Run this ONE Bash command from ${REPO}, read-only (no --write, so Codex cannot
edit anything), and wait for it:

  ${CODEX} task --effort high "<your prompt>"

Pose the OPEN question — how should this class of problem be solved, what have
others reported going wrong, what are the current versions and limits of anything
involved. Do NOT describe a solution and ask whether it is good.
${BLIND}
Return what Codex found, with its source URLs. If a load-bearing external claim
came back with no URL, re-ask once before reporting it. If the command fails or
Codex was never invoked, say so and return empty findings — do NOT substitute
your own answer for the one Codex did not give.`,
    { label: 'scout:codex', phase: 'Scout', schema: SCOUT, ...RUNNER }),

  () => agent(`${LOAD_GEMINI}

Get an independent read on this problem from Gemini.

TASK: ${TASK}
REPO: ${REPO}

Use \`antigravity_query\` (or \`antigravity_brainstorm\` if the task is a design
question). Do not pass a model argument — the server picks the deepest Pro tier
itself and rejects the parameter.
${BLIND}
Gemini is the SECONDARY advisor here. Report its findings as corroboration, and
flag anything it raised that the others may not — that is the whole reason it is
in the run.`,
    { label: 'scout:gemini', phase: 'Scout', schema: SCOUT, ...RUNNER }),
])).filter(Boolean)

if (!scouts.length) return { status: 'aborted', reason: 'every scout failed' }
log(`Scout: ${scouts.length}/3 returned`)

const brief = scouts.map((s, i) => `--- scout ${i + 1} ---\n${s.findings}\nFILES: ${(s.files || []).join(', ')}\nRISKS:\n${(s.risks || []).map(r => '- ' + r).join('\n')}`).join('\n\n')

// ─── Phase 2: Gate — the plan, and an acceptance gate that must fail ───────
// This is the inversion. The proof of done is written before the work exists.
// A gate that passes against an untouched tree proves nothing, so a passing
// baseline is treated as a defect in the gate, not as success.

phase('Gate')

const GATE_BRIEF = `You are the ARCHITECT. You plan and you write the acceptance gate. You do NOT write the implementation.

TASK: ${TASK}
REPO: ${REPO}

RECONNAISSANCE FROM THREE INDEPENDENT SCOUTS:
${brief}

Do four things.

1. Write the implementation plan. Enough detail to build from: which files, which
   functions, in what order, and the non-obvious constraint that shapes each
   decision. Match the patterns the scouts found — do not invent a new one where
   the repo already has one. Prefer the smallest change that fixes the cause at
   the point every caller routes through, not a guard per call site.

2. Freeze the CONTRACT. Several builders will work in parallel and they will
   NEVER talk to each other. Everything they would otherwise have to agree on
   must be decided by you, now, and written down exactly:
   - every field name and its type, spelled the way each side will spell it
     (snake_case on the API, camelCase in the client — write BOTH)
   - endpoint paths, methods, status codes, and the error body shape
   - enum values and their exact strings
   - any migration's table and column names
   Ambiguity you leave here becomes a seam defect that every slice passes
   individually. Be exhaustive and be boring.

3. Cut the work into SLICES. One slice per repo where possible. Two slices must
   never own the same file. Each slice's instruction must be self-contained —
   its builder sees that instruction and the contract, nothing else, and has no
   access to this conversation. Tag each with a model_hint:
   - "ui" for user-facing interface work (web, mobile, desktop)
   - "architecture" for a slice whose design is still genuinely hard
   - "mechanical" for renames, moves, and generated code
   - "default" for ordinary implementation
   If the task is genuinely one repo and one concern, return ONE slice. Do not
   manufacture parallelism.

4. Write an executable acceptance gate to ${REPO}/.fuse/gate.sh (create the
   directory). It exits 0 only when the task is genuinely done, and non-zero
   otherwise. Rules:
   - Every check prints a line naming what it proves, and a FAIL line naming what
     is wrong. Those FAIL lines are the only feedback the builder gets — write
     them as instructions, not as complaints.
   - Check BEHAVIOUR, not the presence of text. Run the tests, hit the endpoint,
     query the database, parse the response. A grep for a function name proves
     nothing and is the most common way a gate goes weak.
   - TEST THE SEAM. With more than one slice, the expensive defect is not inside
     a slice — it is between them. The backend ships assigned_at, the client
     reads assignedAt, both slices pass their own checks, the feature is broken.
     At least one check must exercise the contract end to end, across slices.
   - Use ONLY what the repo already has. The scouts reported its test runner,
     linter and type-checker — invoke those. Never add a test framework, and
     never assume one: a gate that shells out to a tool this repo does not have
     fails for the wrong reason and teaches the builder nothing.
   - It must be re-runnable and must not depend on state left by a previous run.

5. Run the gate once against the untouched tree and report the exit code
   verbatim. It MUST fail. A gate that passes before any work exists is a weak
   gate and this run will be aborted.

Return the plan, the frozen contract, the slices, the absolute gate path, what
each check proves, and the baseline exit code and output.`

let plan = await agent(GATE_BRIEF, { label: 'gate:design', phase: 'Gate', schema: PLAN, ...ARCHITECT })

if (plan && plan.baseline_exit === 0) {
  log('Gate passed against an untouched tree — that is a weak gate. Regenerating once.')
  plan = await agent(`${GATE_BRIEF}

YOUR PREVIOUS GATE WAS REJECTED. It exited 0 before any work existed, which means
it proves nothing. Its output was:

${plan.baseline_output}

The usual cause is checking for the presence of a file or a string rather than
running the behaviour. Rewrite it so it exercises the actual code path and fails
because the behaviour is absent.`,
    { label: 'gate:redesign', phase: 'Gate', schema: PLAN, ...ARCHITECT })
}

if (!plan) return { status: 'aborted', reason: 'the architect returned nothing' }
if (plan.baseline_exit === 0) {
  return { status: 'aborted', reason: 'the gate still passes before any work exists — it cannot prove anything', plan }
}
log(`Gate armed at ${plan.gate_path} (baseline exit ${plan.baseline_exit})`)

// ─── Phase 3: Build — coordinated fan-out against a frozen contract ────────
// Builders never message each other. Everything they would have to agree on was
// decided by the architect and frozen. A builder that finds the contract wrong
// STOPS and reports drift rather than inventing its own version — two slices
// each solving an ambiguity differently is the seam defect this prevents.

phase('Build')

const contractBlock = () => `
THE FROZEN CONTRACT — every builder implements against this and none of them may
change it. It is the only thing keeping the slices compatible:

${plan.contract}
`

const sliceBrief = (s) => `You are the builder for slice "${s.name}". Other builders are working other slices of this same change RIGHT NOW, in parallel. You cannot talk to them and you must not try.

TASK: ${TASK}
REPO: ${s.repo}
YOU OWN THESE FILES, AND ONLY THESE:
${(s.files || []).map(f => '  ' + f).join('\n')}

YOUR INSTRUCTION:
${s.instruction}
${contractBlock()}
THE GATE: ${plan.gate_path}
${plan.gate_summary || ''}
The gate is the definition of done and it is READ-ONLY. Do not edit, weaken or
work around it. Editing the gate invalidates the run.

Rules:
- Touch ONLY the files you own. Another builder owns the rest, and it is editing
  them right now. Writing outside your list overwrites live work.
- Spell every shared name exactly as the contract spells it. Not nearly. Exactly.
- Build the smallest change that satisfies your instruction. No abstractions,
  config or scaffolding the plan did not ask for. Match the surrounding idiom.
${s.model_hint === 'ui' ? '- This is interface work. If this project has a design-system skill or a system.md, load it BEFORE you build and align with it. Never invent a new visual style alongside an existing one.\n' : ''}
IF THE CONTRACT IS WRONG — it does not fit the code, or it is missing something
you need — STOP. Do not invent your own version and do not work around it. Return
whatever partial work is safe and describe the problem in \`drift\`: which part is
wrong, and what it must become. A wrong contract implemented twice, differently,
is exactly the defect this structure exists to prevent.`

const runSlices = (list) => parallel(list.map(s => () =>
  agent(sliceBrief(s), { label: `build:${s.name}`, phase: 'Build', schema: BUILD, ...sliceModel(s.model_hint) })))

const slices = (plan.slices || []).filter(Boolean)
if (!slices.length) return { status: 'aborted', reason: 'the architect returned no slices', plan }
log(`Build: ${slices.length} slice(s) — ${slices.map(s => s.name).join(', ')}`)

let results = await runSlices(slices) // index-aligned with slices; null where a slice died

// One re-freeze allowed. Contract drift is a planning defect, so it goes back to
// the architect — never to a negotiation between builders.
const drifted = slices
  .map((s, i) => ({ slice: s, index: i, drift: results[i] && (results[i].drift || '').trim() }))
  .filter(d => d.drift)

if (drifted.length) {
  log(`Contract drift from ${drifted.length} slice(s) — re-freezing once`)
  const revised = await agent(`You are the ARCHITECT. You froze this contract. Builders report it does not hold.

DRIFT REPORTS:
${drifted.map(d => `--- slice ${d.slice.name} ---\n${d.drift}`).join('\n\n')}

CURRENT CONTRACT:
${plan.contract}

CURRENT GATE: ${plan.gate_path}

Decide whether each report is a real defect in the contract or a builder that did
not read it. Then re-freeze: return the corrected contract, the same slice list
with any instruction that needs correcting, and update the gate in place so it
tests the corrected seam. Re-run the gate and report its exit code.

Keep the contract's unaffected parts BYTE-IDENTICAL. Slices that already built
successfully against them are not going to be re-run, and a silent change there
breaks work that is already correct.`,
    { label: 'gate:refreeze', phase: 'Build', schema: PLAN, ...ARCHITECT })

  if (revised && revised.contract) {
    plan = Object.assign({}, plan, { contract: revised.contract, gate_summary: revised.gate_summary || plan.gate_summary })
    const redone = await runSlices(drifted.map(d => d.slice))
    drifted.forEach((d, k) => { results[d.index] = redone[k] })
    log('Re-freeze complete, drifted slices rebuilt')
  }
}

const builds = results.filter(Boolean)
if (!builds.length) return { status: 'aborted', reason: 'every build slice failed', plan }
if (builds.length < slices.length) log(`WARNING: ${slices.length - builds.length} slice(s) returned nothing — the seam is probably incomplete`)
log(`Build touched ${builds.flatMap(b => b.files_changed || []).length} files across ${builds.length} slice(s)`)

// ─── Phase 4: Verify — bounded loop, one gate repair allowed ───────────────

phase('Verify')

const runGate = (round) => agent(`Run exactly this command and report what happened. Do not fix anything, do not edit any file, do not interpret.

  bash ${plan.gate_path}

Report the exit code, the full output, and every line reporting a failure.`,
  { label: `verify:round-${round}`, phase: 'Verify', schema: GATE_RUN, ...RUNNER })

let verdict = await runGate(1)
let round = 1
let repaired = false

while (verdict && verdict.exit_code !== 0 && round < MAX_ROUNDS) {
  const fails = (verdict.fail_lines || []).join('\n') || verdict.output

  // Escalation: after two failed rounds, decide whether the gate is the problem.
  // Without this an unsatisfiable gate burns every round on correct code.
  if (round === 2 && !repaired) {
    const triage = await agent(`You are the ARCHITECT. You wrote this gate. Two build rounds have failed it.

GATE: ${plan.gate_path}
FAILING OUTPUT:
${fails}

Decide honestly which is wrong: the code, or your gate. Read both.

If the CODE is wrong, return culprit "code" with a specific instruction for the
builder. Do not touch the gate.

If the GATE is wrong — a check that is unsatisfiable, that tests something the
task never asked for, or that is simply incorrect — return culprit "gate", repair
it in place (keep a copy at ${plan.gate_path}.r1), re-run it against the current
tree and report the new exit code. Weakening a gate to make it pass is a
falsified result. Repair only what is genuinely wrong.`,
      { label: 'verify:triage', phase: 'Verify', schema: TRIAGE, ...ARCHITECT })

    repaired = true
    if (triage && triage.culprit === 'gate') {
      log(`Gate repaired: ${triage.reasoning}`)
      if (triage.baseline_exit === 0) { verdict = { exit_code: 0, output: 'gate passed after repair' }; break }
    }
  }

  round++
  // Every slice has finished by now, so one fixer with the whole tree is safe —
  // and it is the only agent that can see across the seam.
  await agent(`You are the FIXER. A multi-slice change was built in parallel and the gate is failing.

TASK: ${TASK}
REPO: ${REPO}
ROUND ${round}.
${contractBlock()}
THESE ARE THE GATE'S FAILURE LINES. They are instructions, not opinions:

${fails}

You may touch any file. Fix the cause of each failure.

Check the SEAM FIRST. This change was built by ${slices.length} builder(s) working
in parallel who never spoke to each other. The most likely cause of a failure here
is not a bug inside a slice — it is two slices disagreeing about a name, a type, a
casing, or a status code. Compare each side against the contract above before you
go looking for anything cleverer.

The gate at ${plan.gate_path} stays READ-ONLY.`,
    { label: `fix:round-${round}`, phase: 'Verify', schema: BUILD, ...BUILDER })

  verdict = await runGate(round)
}

const gatePassed = !!(verdict && verdict.exit_code === 0)
log(gatePassed ? `Gate PASSED after ${round} round(s)` : `Gate still FAILING after ${round} round(s) — review runs anyway`)

// ─── Phase 5: Review — three blind reviewers on the diff ───────────────────
// The diff goes out. The story does not. Nobody is told what the fix was for.

phase('Review')

const DIFF_BRIEF = `THE CHANGE UNDER REVIEW is the working-tree diff in ${REPO}. Get it with \`git -C ${REPO} diff HEAD\` (include untracked files with \`git -C ${REPO} status --short\`).

Factual scope only: this repo implements ${TASK.slice(0, 200)}.

Do NOT be told what the change fixes and do not assume it works. Find the defects.`

const reviews = (await parallel([
  () => agent(`${DIFF_BRIEF}

Codex (gpt-6.1-sol, high) is the PRIMARY reviewer — its verdict governs unless
measurement of the running system disproves it.

Run BOTH of these from ${REPO} and wait for each. \`--wait\` keeps the run in the
foreground; it often takes many minutes, and that is normal:

  ${CODEX} review --wait --scope working-tree
  ${CODEX} adversarial-review --wait --scope working-tree "correctness, concurrency, security, and whether this approach is right at all"

The first is the defect pass. The second challenges the approach itself, which is
where a design mistake surfaces that a defect pass will never name.

Both return the plugin's review schema — verdict, summary, and findings carrying
severity, file, line_start, line_end, confidence and recommendation. Preserve
those fields, especially confidence. Do NOT fix anything you find.
${BLIND}
${RUNTIME_CAPABILITY}
If either command fails or Codex was never invoked, say so and return what you
did get. Never invent findings to fill the gap left by a run that did not happen.`,
    { label: 'review:codex', phase: 'Review', schema: REVIEW, ...RUNNER }),

  () => agent(`${LOAD_GEMINI}

${DIFF_BRIEF}

Run \`antigravity_review_pr\` on the diff with strictness "strict", then
\`antigravity_analyze_code\` on the riskiest section with focus "security" and
again with focus "performance". Do not pass a model argument.
${BLIND}
${RUNTIME_CAPABILITY}
Gemini is SECONDARY — corroboration, not authority. But a finding only it raised
is still real: verify it on its merits. "The others did not say it" is not a
refutation.`,
    { label: 'review:gemini', phase: 'Review', schema: REVIEW, ...RUNNER }),

  () => agent(`${DIFF_BRIEF}

Review it yourself, in this repository, with full context. You are the reviewer
who can actually run things — so run them. Read the surrounding code. Check the
sibling callers. Check the tests.

Hunt specifically for what a reader of the diff alone cannot see:
- a fix applied at one call site while sibling callers stay broken
- a sort or paginated query with no stable tiebreaker, or no explicit NULL ordering
- a date or time compared without resolving the timezone the data is stored in
- an error or empty state that says only "could not load X" — no cause, no retry
- input reaching business logic without validation at the trust boundary
- a successful fetch of zero rows rendered as an error, or as a blank panel
${HOUSE_RULES ? '\nHOUSE RULES for this project — weight these as highly as the list above:\n' + HOUSE_RULES + '\n' : ''}
THEN CHECK THE SEAM, and weight it highest. This change was built by
${slices.length} independent builder(s) who never spoke to each other. Each one
could be correct alone while the change as a whole is broken. Walk every value
that crosses between them and confirm both sides spell it, type it and case it
identically — field names, enum strings, status codes, date formats, null
handling. A seam defect passes every per-slice check, which is precisely why it
reaches production.
${RUNTIME_CAPABILITY}
Report findings with severity, file, line and the concrete failing input.`,
    { label: 'review:local', phase: 'Review', schema: REVIEW, ...BUILDER }),
])).filter(Boolean)

const allFindings = reviews.flatMap(r => r.findings || [])
const contaminated = reviews.some(r => r.anchoring_warning)
log(`Review: ${allFindings.length} findings from ${reviews.length}/3 reviewers${contaminated ? ' (one dispatch was ANCHORED)' : ''}`)

// ─── Phase 6: Fuse — a fresh architect merges the three reads ──────────────
// Fresh matters. An architect carrying the build context would defend the build.

phase('Fuse')

const fused = await agent(`You are the FUSER. You did not plan this change and you did not build it. Merge three independent reviews into one verdict.

TASK: ${TASK}
REPO: ${REPO}
GATE RESULT: ${gatePassed ? 'PASSED' : 'STILL FAILING — ' + ((verdict && verdict.output) || 'no output').slice(0, 800)}

REVIEW 1 — Codex (gpt-6.1-sol high, PRIMARY):
${JSON.stringify(reviews[0] && reviews[0].findings || [], null, 1)}

REVIEW 2 — Gemini (gemini-3.1-pro-high, SECONDARY):
${JSON.stringify(reviews[1] && reviews[1].findings || [], null, 1)}

REVIEW 3 — local repo review (opus-5, full context):
${JSON.stringify(reviews[2] && reviews[2].findings || [], null, 1)}

${contaminated ? 'WARNING: at least one dispatch came back ANCHORED. Treat its AGREEMENT as worthless; its disagreement is still trustworthy.\n' : ''}
How to weigh them:
- These three were dispatched blind and in parallel. None saw another's answer.
  So agreement between them is strong evidence — act on it.
- Disagreement is ALWAYS strong signal. Investigate before dismissing.
- Where Codex and Gemini contradict each other, Codex carries — unless the local
  reviewer measured the running system and disproved it. Measurement outranks
  both models.
- A finding only Gemini raised is not refuted by the others' silence. The
  secondary exists precisely to catch what the primary missed.
- Verify file:line citations against this repo before you promote a finding.
  A confident citation can point at the wrong tree.

Produce: what they agreed on, where they diverged and which side you take and why,
what you discarded and the reason, and the CRITICAL/HIGH list that must be fixed
before this ships. Be ruthless about what is real and ruthless about what is
noise. Do not promote a MEDIUM to buy thoroughness.`,
  { label: 'fuse:merge', phase: 'Fuse', schema: FUSION, ...ARCHITECT })

const mustFix = (fused && fused.must_fix) || []
log(`Fusion: ${mustFix.length} must-fix, ${((fused && fused.consensus) || []).length} consensus, ${((fused && fused.divergence) || []).length} divergence`)

// ─── Phase 7: Fix — apply CRITICAL and HIGH, then re-prove ─────────────────

phase('Fix')

let finalGate = verdict
if (mustFix.length) {
  await agent(`You are the FIXER. Three independent reviewers found defects in this change. Fix them.

REPO: ${REPO}
${contractBlock()}
${mustFix.map((f, i) => `${i + 1}. [${f.severity}] ${f.file}\n   ${f.instruction}`).join('\n\n')}

Fix the cause of each, at the point all callers route through. The gate at
${plan.gate_path} stays READ-ONLY. Re-run it when you are done — it must still
pass, and your fixes must not weaken it.

If you believe a finding is wrong, say so with evidence rather than ignoring it.`,
    { label: 'fix:apply', phase: 'Fix', schema: BUILD, ...BUILDER })

  finalGate = await runGate(round + 1)
  log(finalGate && finalGate.exit_code === 0 ? 'Gate still passes after fixes' : 'Gate BROKE after fixes — needs a human')
}

// ─── Phase 8: Evidence — terra builds the PR section ──────────────────────

phase('Evidence')

let evidence = null
if (!SKIP_EVIDENCE) {
  try {
    evidence = await workflow('fusion:pr-evidence', { repo: REPO, task: TASK })
  } catch (e) {
    log(`pr-evidence unavailable (${e.message}) — skipping the evidence section`)
  }
}

return {
  status: (finalGate && finalGate.exit_code === 0) ? 'gate-passed' : 'gate-failing',
  task: TASK,
  repo: REPO,
  plan: plan.plan,
  contract: plan.contract,
  gate: { path: plan.gate_path, summary: plan.gate_summary, rounds: round, passed: !!(finalGate && finalGate.exit_code === 0) },
  build: { slices: slices.map(s => ({ name: s.name, repo: s.repo, model: sliceModel(s.model_hint).model })), results: builds },
  fusion: fused,
  evidence: evidence,
  anchored: contaminated,
}
