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
    "Run BOTH on the diff first, dispatched in the SAME message so neither sees "
    "the other's answer:\n"
    "  1. Codex (PRIMARY): codex-companion.mjs review --wait --scope working-tree\n"
    "  2. Antigravity (SECONDARY): antigravity_review_pr, strictness 'strict'\n"
    "DISPATCH BLIND. Send the DIFF and let them find the defects. Do NOT write "
    '"I fixed X by doing Y, confirm that is right" — that buys agreement, not '
    "review, and two models handed the same claim agree for reasons that have "
    "nothing to do with the code. Antigravity takes a caller_hypothesis "
    "parameter for any belief of your own; the Codex path has no such channel, "
    "so there you simply do not state it.\n"
    "A completed `fuse` run whose gate PASSED already satisfies this — its "
    "Review phase does exactly the above.\n"
    "If the user explicitly said skip review, proceed. Otherwise STOP."
)

CODEX_PENDING_CONTEXT = (
    "PUSH GATE: Codex was dispatched but has NOT returned — the transcript "
    "shows the call and no result. Codex is the PRIMARY reviewer and runs at "
    "high (gpt-6.1-sol), so long runs are normal and are NOT a reason to proceed. "
    "Antigravity answering first is not the review being done; it is the "
    "SECONDARY advisor, corroboration only. Do NOT push on it alone. Wait for "
    "Codex (check `codex-companion.mjs status`), do other work meanwhile, then "
    "fold its findings in — or have the user explicitly say skip review."
)

# A dispatch only proves the call was made. These prove an answer came back.
CODEX_DISPATCH = ("codex-companion.mjs review", "codex-companion.mjs adversarial-review")
CODEX_ANSWERED = ('"verdict"', "needs-attention", "[codex] Turn completed", "Codex run failed")
# A fuse run that reached a passing gate has already done the review phase.
FUSE_SATISFIED = ('"status": "gate-passed"', "'status': 'gate-passed'")


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
        if text:
            if any(m in text for m in FUSE_SATISFIED):
                return 0  # a fuse run already proved and reviewed this change
            codex_sent = any(m in text for m in CODEX_DISPATCH)
            codex_back = any(m in text for m in CODEX_ANSWERED)
            gemini_sent = "antigravity_review_pr" in text
            if codex_sent and codex_back and gemini_sent:
                return 0  # complete review: primary answered, secondary dispatched
            if codex_sent and gemini_sent and not codex_back:
                # The exact case where a fast Antigravity answer looks finished.
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
