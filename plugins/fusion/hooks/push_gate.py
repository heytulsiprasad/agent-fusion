#!/usr/bin/env python3
"""PreToolUse gate on `git push` / `git commit`.

Injects a reminder when a push is about to happen without a cross-model review
behind it. Fail-open by design: a malformed payload or an unreadable transcript
must never block the tool call. This nudges; it does not deny.

Adapted from the codex-oracle push gate. Repointed at the codex plugin's
companion runtime (there is no codex-oracle MCP server here) and taught to
recognise a completed `fuse` run as a review in its own right.
"""
import json
import re
import sys
from pathlib import Path

GATE_CONTEXT = (
    "PUSH GATE: you are about to git push/commit without a cross-model review.\n"
    "Run Codex on the diff first:\n"
    "  codex-companion.mjs review --wait --scope working-tree\n"
    "DISPATCH BLIND. Send the DIFF and let Codex find the defects. Do NOT write "
    '"I fixed X by doing Y, confirm that is right" — that buys agreement, not '
    "review. The Codex path has no channel for a belief of your own, so simply "
    "do not state it.\n"
    "A completed `fuse` run whose gate PASSED already satisfies this — its "
    "Review phase does exactly the above.\n"
    "If the user explicitly said skip review, proceed. Otherwise STOP."
)

CODEX_PENDING_CONTEXT = (
    "PUSH GATE: Codex was dispatched but has NOT returned — the transcript "
    "shows the call and no result. Codex runs at high (gpt-6.1-sol), so long "
    "runs are normal and are NOT a reason to proceed. Wait for Codex (check "
    "`codex-companion.mjs status`), do other work meanwhile, then fold its "
    "findings in — or have the user explicitly say skip review."
)

# A dispatch only proves the call was made. These prove an answer came back.
CODEX_DISPATCH = ("codex-companion.mjs review", "codex-companion.mjs adversarial-review")
CODEX_ANSWERED = ('"verdict"', "needs-attention", "[codex] Turn completed", "Codex run failed")
# A fuse run that reached a passing gate has already done the review phase.
FUSE_SATISFIED = ('"status": "gate-passed"', "'status': 'gate-passed'")
# Hook output is written to the transcript too, this gate's own reminder
# included. Its example command would otherwise read as a Codex dispatch.
HOOK_RECORD = '"type":"hook_'


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0

    command = (data.get("tool_input") or {}).get("command") or ""
    if not re.search(r"^\s*git\s+(push|commit)\b", command, re.MULTILINE):
        return 0

    context = GATE_CONTEXT
    transcript = data.get("transcript_path") or ""
    if transcript:
        try:
            text = Path(transcript).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            text = ""
        lines = [l for l in text.splitlines() if HOOK_RECORD not in l]
        if any(m in l for l in lines for m in FUSE_SATISFIED):
            return 0  # a fuse run already proved and reviewed this change
        # Only an answer AFTER the latest review dispatch is that review's. An
        # earlier Codex task, or a marker word in a prompt, does not count.
        sent = max((i for i, l in enumerate(lines) if any(m in l for m in CODEX_DISPATCH)), default=-1)
        if sent >= 0:
            if any(m in l for l in lines[sent + 1:] for m in CODEX_ANSWERED):
                return 0  # complete review: Codex dispatched and answered
            # Dispatched with no answer yet. A long Codex run is not a pass.
            context = CODEX_PENDING_CONTEXT

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": context,
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
