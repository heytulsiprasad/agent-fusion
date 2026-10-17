"""Pipe PreToolUse payloads into push_gate.py the way Claude Code does.

    python3 -m unittest discover -s tests -v
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

GATE = Path(__file__).resolve().parents[1] / "plugins/fusion/hooks/push_gate.py"
COMPANION = "/u/.claude/plugins/cache/openai-codex/codex/1.0.5/scripts/codex-companion.mjs"
ANSWER = "[codex] Turn completed.\n# Codex Review\n\nTarget: working tree diff\n\nNo material findings."


def entry(kind, **fields):
    # Claude Code writes the transcript as compact JSONL.
    return json.dumps({"type": kind, **fields}, separators=(",", ":"))


def bash(command):
    return entry("assistant", message={"role": "assistant", "content": [
        {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": command}}]})


def result(text):
    return entry("user", message={"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": text}]})


def hook_note(context):
    # An earlier run of this gate, as Claude Code records it.
    stdout = json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": context}})
    return "\n".join([
        entry("attachment", attachment={"type": "hook_success", "hookName": "PreToolUse:Bash",
                                        "hookEvent": "PreToolUse", "stdout": stdout, "exitCode": 0}),
        entry("attachment", attachment={"type": "hook_additional_context", "content": [context],
                                        "hookName": "PreToolUse:Bash", "hookEvent": "PreToolUse"}),
    ])


def gate(*lines, command="git push origin HEAD", raw=None):
    with tempfile.TemporaryDirectory() as tmp:
        transcript = Path(tmp) / "transcript.jsonl"
        transcript.write_text("\n".join(lines) + "\n")
        payload = raw if raw is not None else json.dumps({
            "hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": command}, "transcript_path": str(transcript)})
        out = subprocess.run([sys.executable, str(GATE)], input=payload,
                             capture_output=True, text=True, check=True).stdout
    return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""


class PushGate(unittest.TestCase):
    def test_codex_dispatched_and_answered_is_silent(self):
        self.assertEqual(gate(bash(f"node {COMPANION} review --wait --scope working-tree"), result(ANSWER)), "")

    def test_adversarial_review_counts_too(self):
        self.assertEqual(gate(bash(f"node {COMPANION} adversarial-review --wait"),
                              result("Verdict: needs-attention")), "")

    def test_dispatched_without_answer_says_pending(self):
        self.assertIn("has NOT returned", gate(bash(f"node {COMPANION} review --wait")))

    def test_no_review_gets_the_full_reminder(self):
        self.assertIn("without a cross-model review", gate(result("edited a file")))

    def test_own_reminder_is_not_a_dispatch(self):
        # The reminder names the review command. Seen again, it must not count
        # as one, even after an unrelated Codex task has answered.
        first = gate()
        second = gate(hook_note(first), bash(f"node {COMPANION} task 'research X'"), result(ANSWER))
        self.assertIn("without a cross-model review", second)

    def test_fail_open(self):
        self.assertEqual(gate(command="git status"), "")
        self.assertEqual(gate(raw="not json"), "")


if __name__ == "__main__":
    unittest.main()
