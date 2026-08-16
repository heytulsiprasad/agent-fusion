#!/usr/bin/env bash
# Install the fusion workflows.
#
# Claude Code plugins have no "workflows" component type — `claude plugin
# details` lists Skills, Agents, Hooks, MCP servers and LSP servers, and nothing
# else. So the plugin gives you the skill and the push gate, and this script
# puts the workflow scripts where the Workflow tool will actually find them.
#
#   ./install.sh              → user scope, available in every project
#   ./install.sh /path/to/repo → project scope, that repo only
#   ./install.sh --link       → symlink instead of copy (edits track this repo)
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workflows"
LINK=0
TARGET_REPO=""

for arg in "$@"; do
  case "$arg" in
    --link) LINK=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) TARGET_REPO="$arg" ;;
  esac
done

if [ -n "$TARGET_REPO" ]; then
  [ -d "$TARGET_REPO" ] || { echo "not a directory: $TARGET_REPO" >&2; exit 1; }
  DEST="$TARGET_REPO/.claude/workflows"
  SCOPE="project ($TARGET_REPO)"
else
  DEST="$HOME/.claude/workflows"
  SCOPE="user (every project)"
fi

mkdir -p "$DEST"
for f in "$SRC"/*.js; do
  name="$(basename "$f")"
  # Never clobber a modified copy without saying so.
  if [ -e "$DEST/$name" ] && ! [ -L "$DEST/$name" ] && ! cmp -s "$f" "$DEST/$name"; then
    cp "$DEST/$name" "$DEST/$name.bak"
    echo "  backed up existing $name → $name.bak"
  fi
  if [ "$LINK" -eq 1 ]; then
    ln -sfn "$f" "$DEST/$name"
  else
    cp -f "$f" "$DEST/$name"
  fi
done

echo "installed to $DEST  [scope: $SCOPE]$([ "$LINK" -eq 1 ] && echo '  (symlinked)')"
ls -1 "$DEST"/*.js | sed 's|^|  |'
cat <<'EOS'

Next:
  /fuse           plan → gate → build → verify → review → fuse → evidence
  /pr-evidence    ER diagrams and before/after screenshots for a PR body

Optional, for the cross-model slots:
  Codex   — the `codex` plugin (provides codex-companion.mjs)
  Gemini  — an `antigravity` MCP server on an authenticated `agy` install
Neither is required. Missing advisors are reported as missing, never faked.
EOS
