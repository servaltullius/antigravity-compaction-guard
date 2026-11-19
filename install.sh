#!/usr/bin/env bash
set -euo pipefail

REPO_BASE="https://raw.githubusercontent.com/servaltullius/antigravity-compaction-guard/main"
INSTALL_DIR="${AGY_HOOKS_DIR:-$HOME/.gemini/hooks}"
HOOKS_PATH="${AGY_HOOKS_JSON:-$HOME/.gemini/config/hooks.json}"
RULES_PATH="${AGY_RULES_MD:-$HOME/.gemini/GEMINI.md}"
SKIP_RULE="${AGY_SKIP_RULE:-0}"

echo ""
echo "=== antigravity-compaction-guard One-Touch Installer (macOS/Linux) ==="

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js ('node') not found in PATH. Install Node.js 18+ first." >&2
  exit 1
fi
echo "[1/4] Node.js detected: $(node --version)"

mkdir -p "$INSTALL_DIR"
TARGET_SCRIPT="$INSTALL_DIR/compaction-guard-hook.mjs"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/compaction-guard-hook.mjs" ]; then
  if [ "$SCRIPT_DIR/compaction-guard-hook.mjs" != "$TARGET_SCRIPT" ]; then
    cp "$SCRIPT_DIR/compaction-guard-hook.mjs" "$TARGET_SCRIPT"
  fi
  echo "[2/4] Installed local hook script: $TARGET_SCRIPT"
else
  echo "[2/4] Downloading compaction-guard-hook.mjs..."
  curl -fsSL "$REPO_BASE/compaction-guard-hook.mjs" -o "$TARGET_SCRIPT"
  echo "      Installed: $TARGET_SCRIPT"
fi

SMOKE="$(printf '{}\n' | node "$TARGET_SCRIPT")"
if [ "$SMOKE" != "{}" ]; then
  echo "[ERROR] Smoke test failed. Got: $SMOKE" >&2
  exit 1
fi
echo "      Smoke test OK"

echo "[3/4] Registering PreInvocation hook in $HOOKS_PATH..."
TARGET_SCRIPT="$TARGET_SCRIPT" HOOKS_PATH="$HOOKS_PATH" node -e '
const fs = require("fs");
const path = require("path");
const target = process.env.TARGET_SCRIPT;
const hooksPath = process.env.HOOKS_PATH;
fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
let obj = {};
if (fs.existsSync(hooksPath)) {
  const raw = fs.readFileSync(hooksPath, "utf8").replace(/^\uFEFF/, "").trim();
  if (raw) {
    const ts = new Date().toISOString().replace(/[:T-]/g, "").slice(0, 14);
    fs.copyFileSync(hooksPath, `${hooksPath}.bak-${ts}`);
    obj = JSON.parse(raw);
  }
}
const cmd = /\s/.test(target) ? `node "${target}"` : `node ${target}`;
obj["compaction-guard"] = { PreInvocation: [{ type: "command", command: cmd, timeout: 5 }] };
fs.writeFileSync(hooksPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
'
echo "      Updated: $HOOKS_PATH"

if [ "$SKIP_RULE" != "1" ]; then
  echo "[4/4] Checking global rules ($RULES_PATH)..."
  RULES_PATH="$RULES_PATH" node -e '
  const fs = require("fs");
  const path = require("path");
  const rulesPath = process.env.RULES_PATH;
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  const existing = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, "utf8").replace(/^\uFEFF/, "") : "";
  const start = "<!-- compaction-guard:start -->";
  const end = "<!-- compaction-guard:end -->";
  if (existing.includes(start) || existing.includes("# Context & Compaction Discipline")) {
    console.log("      Rule already present (skipped)");
    process.exit(0);
  }
  const block = [
    start,
    "# Context & Compaction Discipline",
    "- **3-Tier State Separation**: (1) Keep `GEMINI.md` (global/workspace) concise (<4 KB) with only invariant rules, prohibitions, and build commands — replace outdated lines instead of appending. (2) Overwrite active session progress, edited files, confirmed values, and remaining tasks in artifact `session_state.md` (1-2 KB). (3) Store cross-session durable facts in memory MCP if available.",
    "- **Offload Wide Exploration**: Delegate multi-file searches (5+ files), large log analysis, and broad codebase surveys to the `research` subagent so only concise summaries enter the main context.",
    "- **Pre-Compaction Backup**: When the compaction-guard hook warns at 200k/430k tokens or after a major milestone, overwrite `session_state.md` with current state (`ArtifactMetadata: UserFacing=false, RequestFeedback=false`).",
    end
  ].join("\n");
  const sep = existing.trim() ? "\n\n" : "";
  fs.writeFileSync(rulesPath, existing.trimEnd() + sep + block + "\n", "utf8");
  console.log("      Added 3-tier compaction discipline rule");
  '
fi

echo ""
echo "[DONE] antigravity-compaction-guard installed!"
echo "  Hook   : $TARGET_SCRIPT"
echo "  Config : $HOOKS_PATH"
echo "Antigravity hot-reloads hooks.json automatically — no restart required!"
