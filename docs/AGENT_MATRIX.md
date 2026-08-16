# Agent Matrix

Every agent this harness spawns, what model runs it, and why.

Derived from the code. The authoritative source is the constant block at the top
of [`workflows/fuse.js`](../workflows/fuse.js) — if this table and that block
disagree, the code is right and this file is stale.

---

## The slots

Roles are slots, not model names. Change one line here and every agent that uses
that slot moves with it.

```js
const ARCHITECT = { model: 'fable',  effort: 'xhigh' }  // plans, gates, fuses
const BUILDER   = { model: 'opus',   effort: 'max'   }  // implements and fixes
const RUNNER    = { model: 'sonnet', effort: 'max'   }  // runs gates, wraps advisors

const SLICE_MODELS = {
  ui:           { model: 'fable',  effort: 'xhigh' },   // taste, not throughput
  architecture: { model: 'fable',  effort: 'xhigh' },
  mechanical:   { model: 'sonnet', effort: 'max'   },   // renames, moves, codegen
  default:      BUILDER,
}
```

### Effort policy

**Everything at `max`. Nothing below `high`, ever.** A slot that looks mechanical
still decides what to report, and a cheap decision there is the one nobody
re-checks.

Two deliberate exceptions:

| Exception | Why |
|---|---|
| `fable` → `xhigh` | Operator rule |
| codex family → `xhigh` | `--effort` accepts `none\|minimal\|low\|medium\|high\|xhigh`. A raw `codex exec -c model_reasoning_effort=<bogus>` is swallowed unvalidated, so `max` could never be *confirmed* to take effect. Prefer a value you can verify over one that merely sounds higher. |

---

## Every agent, in run order

`fuse.js` — 15 call sites:

| # | Agent | Phase | Slot | Model | Effort | Notes |
|---|---|---|---|---|---|---|
| 1 | `scout:repo` | Scout | BUILDER | fable→`opus` | `max` | The only scout that reads your code |
| 2 | `scout:codex` | Scout | RUNNER | `sonnet` | `max` | **Wrapper** → `gpt-5.6-sol` `xhigh` |
| 3 | `scout:gemini` | Scout | RUNNER | `sonnet` | `max` | **Wrapper** → `gemini-3.1-pro-high` |
| 4 | `gate:design` | Gate | ARCHITECT | `fable` | `xhigh` | Plan + contract + slices + gate |
| 5 | `gate:redesign` | Gate | ARCHITECT | `fable` | `xhigh` | Only if the baseline gate passed |
| 6 | `build:<slice>` | Build | slice hint | varies | varies | One per slice, in parallel |
| 7 | `gate:refreeze` | Build | ARCHITECT | `fable` | `xhigh` | Only on contract drift, once |
| 8 | `verify:round-N` | Verify | RUNNER | `sonnet` | `max` | Runs the gate, reports the exit code |
| 9 | `verify:triage` | Verify | ARCHITECT | `fable` | `xhigh` | Round 2 only — code wrong, or gate wrong? |
| 10 | `fix:round-N` | Verify | BUILDER | `opus` | `max` | Whole tree; checks the seam first |
| 11 | `review:codex` | Review | RUNNER | `sonnet` | `max` | **Wrapper** → `gpt-5.6-sol` ×2 passes |
| 12 | `review:gemini` | Review | RUNNER | `sonnet` | `max` | **Wrapper** → `gemini-3.1-pro-high` |
| 13 | `review:local` | Review | BUILDER | `opus` | `max` | Can actually run things |
| 14 | `fuse:merge` | Fuse | ARCHITECT | `fable` | `xhigh` | Fresh context — never saw the build |
| 15 | `fix:apply` | Fix | BUILDER | `opus` | `max` | CRITICAL + HIGH only |

`pr-evidence.js` — 3 call sites:

| # | Agent | Phase | Model | Effort | Notes |
|---|---|---|---|---|---|
| 16 | `classify` | Classify | `sonnet` | `max` | What evidence does this diff owe? |
| 17 | `evidence:er` | Derive | `opus` | `max` | **Wrapper** → `gpt-5.6-terra` `xhigh` |
| 18 | `evidence:ui` | Derive | `opus` | `max` | Drives Playwright for screenshots |

---

## Wrappers vs. real work

Four agents are **wrappers**. A cheap Claude agent shells out and the real
reasoning happens on another model's bill, outside your context window.

```
review:codex   sonnet ──shell──> codex-companion.mjs review + adversarial-review
                                   └─> gpt-5.6-sol @ xhigh
review:gemini  sonnet ──MCP────> antigravity_review_pr + analyze_code
                                   └─> gemini-3.1-pro-high
```

This is why "three reviewers" does not cost three times one reviewer. Only
`review:local` spends real Claude reasoning on the diff.

**Both cross-family slots are optional.** If Codex or Antigravity is unavailable,
that agent reports the gap and returns empty findings. It never substitutes its
own opinion for the answer the other model did not give.

---

## Why each slot got the model it got

| Slot | Reasoning |
|---|---|
| ARCHITECT = `fable` | Planning and synthesis are the highest-leverage decisions in the run. The gate, the contract and the fusion merge all fail *silently* when done badly — a weak gate passes, a loose contract produces a seam. |
| BUILDER = `opus` | Day-to-day implementation workhorse. Long context for reading a repo, strong at matching existing idiom. |
| RUNNER = `sonnet` | Runs a script and reports an exit code, or forwards a prompt to another model. At `max` because even "just report the failures" is a judgment that nothing downstream re-checks. |
| slice `ui` = `fable` | Interface work is taste, not throughput. The cost of an ugly-but-working screen is paid by every user, forever. |
| slice `mechanical` = `sonnet` | Renames, moves, generated code. Genuinely mechanical, and `max` keeps it honest. |
| Codex = `gpt-5.6-sol` | **Primary** cross-family reviewer. A different lineage catches what the Claude family will not. |
| Gemini = `gemini-3.1-pro-high` | **Secondary**. Corroboration, and a third independent lineage. Its value is the miss it catches that the other two shared. |
| Grunt = `gpt-5.6-terra` | Diagram derivation is mechanical. Frontier reasoning on an ER diagram is waste. |

**Codex is primary, Gemini is secondary.** Where the two contradict each other,
Codex carries — unless the local reviewer *measured* the running system and
disproved it. Measurement outranks both models. But a Gemini-only finding is
never refuted by the others' silence; the secondary exists precisely to catch
what the primary missed.

---

## How many agents a run actually spawns

For a two-slice change:

| Path | Agents | Where they go |
|---|---|---|
| Happy | **~13** | 3 scout + 1 gate + 2 build + 1 verify + 3 review + 1 fuse + 2 evidence |
| Typical | ~16 | plus one fix round and its re-verify |
| Worst | ~22 | plus gate redesign, refreeze, triage, and `maxRounds` fix rounds |

Duplication exists in exactly two phases — **Scout** and **Review** — and never
in Build. The phase that writes code has no redundancy at all. The redundancy
sits on judgment, which is cheap next to implementation.

**The Scout triple is the weakest link in this design.** Two external advisors
answer the same open question before any code exists, while the repo scout does
the load-bearing work. If you trim anything, trim `scout:gemini` first and keep
the Review triple, where the evidence for a second opinion is actual.

---

## Changing it

One line each, in `workflows/fuse.js`:

```js
const BUILDER = { model: 'sonnet', effort: 'max' }   // cheaper builds everywhere
SLICE_MODELS.ui = { model: 'opus', effort: 'max' }   // no fable available
```

Valid Claude models: `fable`, `opus`, `sonnet`, `haiku`.
Valid efforts: `low`, `medium`, `high`, `xhigh`, `max`.

To change a Codex model, edit the `--model` flag on the relevant
`codex-companion.mjs` call. Antigravity takes **no** model argument — it
auto-selects the deepest Gemini Pro tier and rejects one if you pass it.

---

## Measure this, do not trust it

This matrix is asserted, not measured. Nobody has proved that `sonnet` at `max`
is the right runner, or that `terra` is enough for ER diagrams.

The honest way to settle it is Gas Town's `gt-model-eval` approach: a promptfoo
suite that runs the same task across model tiers and scores them, split into
*directive* tests (the prompt hints at the answer) and *reasoning* tests (neutral
context, no hints). Only the second tells you anything — it is the same
blind-versus-anchored distinction this harness applies to review, turned on model
selection itself.

Until that exists, treat every row above as a considered guess.
