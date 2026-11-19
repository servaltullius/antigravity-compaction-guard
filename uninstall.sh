#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${AGY_HOOKS_DIR:-$HOME/.gemini/hooks}"
HOOKS_PATH="${AGY_HOOKS_JSON:-$HOME/.gemini/config/hooks.json}"
RULES_PATH="${AGY_RULES_MD:-$HOME/.gemini/GEMINI.md}"
STATE_DIR="${AGY_COMPACT_STATE_DIR:-$HOME/.gemini/memory/hook-state}"

echo "=== antigravity-compaction-guard Uninstaller ==="

if [ -f "$HOOKS_PATH" ] && command -v node >/dev/null 2>&1; then
  HOOKS_PATH="$HOOKS_PATH" node -e '
  const fs = require("fs");
  const p = process.env.HOOKS_PATH;
  const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").trim();
  if (!raw) process.exit(0);
  const obj = JSON.parse(raw);
  if ("compaction-guard" in obj) {
    const ts = new Date().toISOString().replace(/[:T-]/g, "").slice(0, 14);
    fs.copyFileSync(p, `${p}.bak-${ts}`);
    delete obj["compaction-guard"];
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
    console.log(`[OK] Removed compaction-guard from ${p}`);
  }
  '
fi

if [ -f "$RULES_PATH" ] && command -v node >/dev/null 2>&1; then
  RULES_PATH="$RULES_PATH" node -e '
  const fs = require("fs");
  const p = process.env.RULES_PATH;
  const text = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  const re = /\r?\n*<!-- compaction-guard:start -->[\s\S]*?<!-- compaction-guard:end -->\r?\n*/;
  if (re.test(text)) {
    const cleaned = text.replace(re, "\n").trim();
    fs.writeFileSync(p, cleaned ? cleaned + "\n" : "", "utf8");
    console.log(`[OK] Removed managed rule block from ${p}`);
  }
  '
fi

rm -f "$INSTALL_DIR/compaction-guard-hook.mjs"
rm -rf "$STATE_DIR"
echo "Done."
