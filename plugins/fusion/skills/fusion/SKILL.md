---
name: fusion
description: Run a change through the gate-first fusion harness — an acceptance gate written before any code exists, parallel builders against a frozen contract, and three independent models reviewing the diff. Use when a change is big enough to want planned, proven and cross-reviewed without babysitting, spans more than one repo or surface, or touches something expensive to get wrong (money, migrations, auth, tenant boundaries). Also use when asked to "fuse", "run the harness", or for a multi-model build or review.
---

# Fusion

Run the `fuse` workflow. This skill is the operator's guide; `fuse` itself is
the script. It is a script, not a set of instructions — the loop,
the gate check and the fan-out are real control flow, so no phase can be skipped
by forgetting it.

```
Workflow({ name: "fuse", args: { task: "<what to build>", repo: "." } })
```

## Arguments

| Arg | Default | What it does |
|---|---|---|
| `task` | **required** | What to build, in a sentence or a paragraph |
| `repo` | `.` | Repo root, or the workspace root for a multi-repo change |
| `maxRounds` | `3` | Gate-failure rounds before it stops and hands back |
| `houseRules` | `''` | Extra review lenses for this project, free text |
| `skipEvidence` | `false` | Skip the PR-evidence phase |

`houseRules` is where project-specific review knowledge goes — "resolve the
tenant timezone before comparing against a TIMESTAMPTZ", "every list endpoint
paginates", whatever this codebase keeps getting wrong. It is appended to the
local reviewer's checklist and weighted as highly as the built-in one.

## Before you invoke it

**Check the size honestly.** This spawns 10-18 agents across up to four model
families. A one-line fix does not need it, and running it on one is waste, not
thoroughness. Use it when the change is genuinely worth proving.

**It does not commit or push.** It builds, proves and reviews. Landing the work
stays a human decision.

## What to do with the result

It returns `status: "gate-passed"` or `"gate-failing"`, plus the plan, the frozen
contract, the gate path, per-slice build results, and the fusion verdict with
consensus / divergence / discarded.

- `gate-failing` → the gate is the source of truth, not the build summary. Read
  its output before believing anything was finished.
- `anchored: true` → one advisor dispatch was contaminated. Its *agreement* is
  worthless; its disagreement still counts.
- Report the fusion verdict as it came back. Do not quietly drop a finding it
  discarded, and do not promote one it did not raise.

## Related

`/pr-evidence` builds the evidence section for a PR body — crow's-foot before
and after ER diagrams for schema changes, before/after screenshots for UI. It
runs standalone or as the last phase of `fuse`.
