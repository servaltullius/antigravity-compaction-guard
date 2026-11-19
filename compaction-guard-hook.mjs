import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import path from "path";
import os from "os";

const GEMINI_DIR = path.join(os.homedir(), ".gemini");
const STATE_DIR =
  process.env.AGY_COMPACT_STATE_DIR ||
  path.join(GEMINI_DIR, "memory", "hook-state");
const SESSION_RECALL_SCRIPT =
  process.env.AGY_SESSION_RECALL_SCRIPT ||
  path.join(GEMINI_DIR, "memory-mcp", "session-recall-hook.mjs");

// Empirical Antigravity compaction tiers: ~256k and ~512k tokens.
const WARN_TOKENS_STAGE_1 = Number(process.env.AGY_COMPACT_WARN_1) || 200_000;
const WARN_TOKENS_STAGE_2 = Number(process.env.AGY_COMPACT_WARN_2) || 430_000;
const MAX_STATE_DOC_CHARS = 3000;
const MAX_BREADCRUMB_CHARS = 1800;
const BREADCRUMB_SCAN_LIMIT = 300;
const STDIN_TIMEOUT_MS = 150;
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function readStdin() {
  if (process.stdin.isTTY) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    let settled = false;
    let data = "";
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      if (typeof process.stdin.unref === "function") {
        process.stdin.unref();
      }
      resolve(data);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function safeId(id) {
  if (typeof id !== "string" || !id.trim()) return "";
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function loadState(stateFile) {
  if (!stateFile || !existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function saveState(stateFile, state) {
  if (!stateFile) return;
  try {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({ ...state, updatedAt: Date.now() }),
      "utf8"
    );
    // Opportunistic cleanup of stale state files (>30 days)
    try {
      const now = Date.now();
      for (const name of readdirSync(STATE_DIR)) {
        if (!name.endsWith(".json")) continue;
        const full = path.join(STATE_DIR, name);
        if (full === stateFile) continue;
        const st = statSync(full);
        if (now - st.mtimeMs > STATE_TTL_MS) {
          unlinkSync(full);
        }
      }
    } catch {
      // Ignore cleanup failures
    }
  } catch {
    // Never fail hook on state persistence errors
  }
}

function isBrowserCheckpoint(obj) {
  const content = typeof obj?.content === "string" ? obj.content : "";
  return content.startsWith("# Browser Session Checkpoint");
}

function unwrapJsonArg(val) {
  if (typeof val !== "string") return "";
  const trimmed = val.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to raw string
    }
  }
  return trimmed;
}

function extractUserRequestText(content) {
  if (typeof content !== "string") return "";
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  const raw = m ? m[1] : content;
  return raw.replace(/\s+/g, " ").trim();
}

function sanitizeCmd(cmd) {
  if (!cmd) return "";
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  const redacted = oneLine
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***")
    .replace(
      /((?:token|password|passwd|api[_-]?key|secret)\s*[=:]\s*)(\S+)/gi,
      "$1***"
    );
  return redacted.length > 110 ? redacted.slice(0, 107) + "..." : redacted;
}

function isInternalPath(p) {
  if (!p) return true;
  const norm = p.replace(/\\/g, "/").toLowerCase();
  if (norm.includes("/.system_generated/")) return true;
  if (norm.endsWith("/session_state.md")) return true;
  return false;
}

function inspectTranscript(transcriptPath) {
  const result = {
    isUserConversation: false,
    checkpointCount: 0,
    lastCheckpointStep: -1,
    lastCheckpointLineIdx: -1,
    lastCheckpointRawIdx: -1,
    totalLines: 0,
    lastPlannerTokens: 0,
    rawLines: null,
  };
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return result;
  }

  const raw = readFileSync(transcriptPath, "utf8");
  if (!raw) return result;
  const lines = raw.split(/\r?\n/);

  let nonEmptyCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    nonEmptyCount++;

    // Detect whether this is a user-facing main conversation (skip browser/research/swarm subagents)
    if (!result.isUserConversation && line.includes('"USER_EXPLICIT"')) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.type === "USER_INPUT" && obj.source === "USER_EXPLICIT") {
          result.isUserConversation = true;
        }
      } catch {
        // Ignore malformed lines
      }
    }

    // Count actual session compaction CHECKPOINT steps (parse-verified, excluding browser checkpoints)
    if (line.includes('"CHECKPOINT"')) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.type === "CHECKPOINT" && !isBrowserCheckpoint(obj)) {
          result.checkpointCount++;
          if (typeof obj.step_index === "number") {
            result.lastCheckpointStep = obj.step_index;
          }
          result.lastCheckpointLineIdx = nonEmptyCount - 1;
          result.lastCheckpointRawIdx = i;
        }
      } catch {
        // Ignore malformed lines
      }
    }
  }
  result.totalLines = nonEmptyCount;
  result.rawLines = lines;

  if (!result.isUserConversation) {
    return result;
  }

  // Scan backwards for the latest PLANNER_RESPONSE with >0 tokens after the last CHECKPOINT
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"PLANNER_RESPONSE"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.type === "PLANNER_RESPONSE") {
        if (
          typeof obj.step_index === "number" &&
          result.lastCheckpointStep >= 0 &&
          obj.step_index <= result.lastCheckpointStep
        ) {
          break;
        }
        const total =
          (Number(obj.input_tokens) || 0) + (Number(obj.cache_read_tokens) || 0);
        if (total > 0) {
          result.lastPlannerTokens = total;
          break;
        }
      }
    } catch {
      // Ignore malformed lines
    }
  }

  return result;
}

function extractBreadcrumbs(rawLines, checkpointRawIdx) {
  if (!Array.isArray(rawLines) || checkpointRawIdx <= 0) return "";

  const recentUsers = [];
  const editedFiles = [];
  const editedSet = new Set();
  const readFiles = [];
  const readSet = new Set();
  const recentOps = [];
  const opSet = new Set();

  const stopIdx = Math.max(0, checkpointRawIdx - BREADCRUMB_SCAN_LIMIT);

  for (let i = checkpointRawIdx - 1; i >= stopIdx; i--) {
    const line = rawLines[i];
    if (!line || !line.trim()) continue;

    // Stop at previous real compaction checkpoint so breadcrumbs stay scoped to the compacted segment
    if (line.includes('"CHECKPOINT"')) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.type === "CHECKPOINT" && !isBrowserCheckpoint(obj)) {
          break;
        }
      } catch {
        // Ignore
      }
    }

    if (recentUsers.length < 3 && line.includes('"USER_EXPLICIT"')) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.type === "USER_INPUT" && obj.source === "USER_EXPLICIT") {
          const text = extractUserRequestText(obj.content);
          if (text) {
            const clipped = text.length > 220 ? text.slice(0, 217) + "..." : text;
            recentUsers.push(clipped);
          }
        }
      } catch {
        // Ignore
      }
      continue;
    }

    if (line.includes('"tool_calls"')) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.type === "PLANNER_RESPONSE" && Array.isArray(obj.tool_calls)) {
          for (let j = obj.tool_calls.length - 1; j >= 0; j--) {
            const tc = obj.tool_calls[j];
            if (!tc || !tc.name) continue;
            const args = tc.args || {};

            if (tc.name === "write_file" || tc.name === "edit_file") {
              const p = unwrapJsonArg(args.Path);
              if (p && !isInternalPath(p)) {
                const key = p.replace(/\\/g, "/").toLowerCase();
                if (!editedSet.has(key) && editedFiles.length < 10) {
                  editedSet.add(key);
                  editedFiles.push(p);
                }
              }
            } else if (tc.name === "read_file") {
              const p = unwrapJsonArg(args.Path);
              if (p && !isInternalPath(p)) {
                const key = p.replace(/\\/g, "/").toLowerCase();
                if (!readSet.has(key) && readFiles.length < 8) {
                  readSet.add(key);
                  readFiles.push(p);
                }
              }
            } else if (tc.name === "run_command") {
              const summary = unwrapJsonArg(args.toolSummary);
              const cmd = sanitizeCmd(unwrapJsonArg(args.CommandLine));
              const entry = summary && cmd ? `[${summary}] ${cmd}` : summary || cmd;
              if (entry && !opSet.has(entry) && recentOps.length < 8) {
                opSet.add(entry);
                recentOps.push(entry);
              }
            } else if (tc.name === "call_mcp_tool") {
              const srv = unwrapJsonArg(args.ServerName);
              const tool = unwrapJsonArg(args.ToolName);
              if (srv && tool) {
                const entry = `mcp:${srv}/${tool}`;
                if (!opSet.has(entry) && recentOps.length < 8) {
                  opSet.add(entry);
                  recentOps.push(entry);
                }
              }
            }
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  const filteredReads = readFiles.filter(
    (p) => !editedSet.has(p.replace(/\\/g, "/").toLowerCase())
  );

  const out = [];
  if (recentUsers.length > 0) {
    out.push("- Recent user requests (chronological):");
    for (const u of [...recentUsers].reverse()) {
      out.push(`  * ${u}`);
    }
  }
  if (editedFiles.length > 0) {
    out.push("- Files edited/created before compaction:");
    for (const f of editedFiles) {
      out.push(`  * ${f}`);
    }
  }
  if (filteredReads.length > 0) {
    out.push("- Key files read before compaction:");
    for (const f of filteredReads.slice(0, 6)) {
      out.push(`  * ${f}`);
    }
  }
  if (recentOps.length > 0) {
    out.push("- Recent commands / MCP calls:");
    for (const op of recentOps) {
      out.push(`  * ${op}`);
    }
  }

  if (out.length === 0) return "";
  const joined = out.join("\n");
  return joined.length > MAX_BREADCRUMB_CHARS
    ? joined.slice(0, MAX_BREADCRUMB_CHARS) + "\n  * ... (truncated)"
    : joined;
}

function resolveArtifactDir(payload) {
  if (
    payload &&
    typeof payload.artifactDirectoryPath === "string" &&
    payload.artifactDirectoryPath.trim()
  ) {
    return payload.artifactDirectoryPath.trim();
  }
  if (
    payload &&
    typeof payload.transcriptPath === "string" &&
    payload.transcriptPath.trim()
  ) {
    const norm = payload.transcriptPath.replace(/\\/g, "/");
    if (norm.endsWith("/.system_generated/logs/transcript.jsonl")) {
      return path.resolve(path.dirname(payload.transcriptPath), "..", "..");
    }
  }
  return "";
}

function getMemorySnapshot(rawStdin) {
  if (!existsSync(SESSION_RECALL_SCRIPT)) return "";
  try {
    const out = execFileSync(process.execPath, [SESSION_RECALL_SCRIPT], {
      input: rawStdin,
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    if (!out || !out.trim()) return "";
    const parsed = JSON.parse(out);
    const step = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
    return typeof step === "string" ? step.trim() : "";
  } catch {
    return "";
  }
}

function readSessionStateDoc(artifactDir) {
  if (!artifactDir) return null;
  const candidates = [
    { name: "session_state.md", maxChars: MAX_STATE_DOC_CHARS },
    { name: "task.md", maxChars: 2000 },
  ];
  for (const c of candidates) {
    const full = path.join(artifactDir, c.name);
    if (!existsSync(full)) continue;
    try {
      const raw = readFileSync(full, "utf8").replace(/^\uFEFF/, "").trim();
      if (!raw) continue;
      const truncated =
        raw.length > c.maxChars
          ? raw.slice(0, c.maxChars) +
            "\n... (truncated; read full file if needed)"
          : raw;
      return { name: c.name, path: full, content: truncated };
    } catch {
      // Continue to next candidate
    }
  }
  return null;
}

function formatK(tokens) {
  return `${Math.round(tokens / 1000)}k`;
}

async function main() {
  try {
    const rawStdin = await readStdin();
    if (!rawStdin || !rawStdin.trim()) {
      process.stdout.write("{}");
      return;
    }

    const payload = JSON.parse(rawStdin);
    const convId = safeId(payload.conversationId);
    const transcriptPath =
      typeof payload.transcriptPath === "string" ? payload.transcriptPath : "";

    if (!convId || !transcriptPath || !existsSync(transcriptPath)) {
      process.stdout.write("{}");
      return;
    }

    const stats = inspectTranscript(transcriptPath);

    // Skip subagent conversations (browser / research / swarm workers without USER_EXPLICIT)
    if (!stats.isUserConversation) {
      process.stdout.write("{}");
      return;
    }

    const stateFile = path.join(STATE_DIR, `${convId}.json`);
    const prevState = loadState(stateFile);
    const artifactDir = resolveArtifactDir(payload);

    let compactionJustHappened = false;
    let warnStage = 0;

    if (!prevState) {
      if (
        stats.checkpointCount > 0 &&
        stats.totalLines - 1 - stats.lastCheckpointLineIdx <= 3
      ) {
        compactionJustHappened = true;
      }
      warnStage = 0;
    } else if (stats.checkpointCount > (prevState.lastCheckpointCount || 0)) {
      compactionJustHappened = true;
      warnStage = 0;
    } else {
      warnStage = Number(prevState.warnStage) || 0;
    }

    // 1. Post-Compaction Re-injection (fires once immediately after a new CHECKPOINT)
    if (compactionJustHappened) {
      const memSnapshot = getMemorySnapshot(rawStdin);
      const stateDoc = readSessionStateDoc(artifactDir);
      const breadcrumbs = extractBreadcrumbs(
        stats.rawLines,
        stats.lastCheckpointRawIdx
      );

      const sections = [
        `[Compaction Guard — Post-Compaction Re-injection (CHECKPOINT #${stats.checkpointCount})]`,
        "Session compaction just completed. Use the disk-restored context, session state, and pre-compaction breadcrumbs below to preserve all prior constraints and decisions without unnecessarily re-reading already-settled files.",
      ];

      if (memSnapshot) {
        sections.push("", memSnapshot);
      }

      if (stateDoc) {
        sections.push(
          "",
          `[Restored Session State — ${stateDoc.name} (${stateDoc.path})]`,
          stateDoc.content
        );
      } else if (artifactDir) {
        sections.push(
          "",
          `(Note: ${path.join(artifactDir, "session_state.md")} does not exist yet. For long tasks, keep active progress and constraints overwritten concisely in that file.)`
        );
      }

      if (breadcrumbs) {
        sections.push(
          "",
          "[Deterministic Pre-Compaction Breadcrumbs — extracted from transcript.jsonl]",
          breadcrumbs
        );
      }

      // Note: omit metadata.user_markdown — Antigravity's utils.scrubMessage panics on string map values in metadata.
      const injectSteps = [
        {
          systemMessage: {
            systemMessage: sections.join("\n"),
          },
        },
      ];

      saveState(stateFile, {
        lastCheckpointCount: stats.checkpointCount,
        lastCheckpointStep: stats.lastCheckpointStep,
        warnStage: 0,
      });

      process.stdout.write(JSON.stringify({ injectSteps }));
      return;
    }

    // 2. Pre-Compaction Backup & Warning (fires at most once at Stage 1 and once at Stage 2 per cycle)
    let nextWarnStage = warnStage;
    if (stats.lastPlannerTokens >= WARN_TOKENS_STAGE_2 && warnStage < 2) {
      nextWarnStage = 2;
    } else if (stats.lastPlannerTokens >= WARN_TOKENS_STAGE_1 && warnStage < 1) {
      nextWarnStage = 1;
    }

    if (nextWarnStage > warnStage) {
      const targetStatePath = artifactDir
        ? path.join(artifactDir, "session_state.md")
        : "session_state.md";
      const approxK = formatK(stats.lastPlannerTokens);
      const tierLabel =
        nextWarnStage === 1
          ? "Stage 1 (~256k compaction tier approaching)"
          : "Stage 2 (~512k compaction tier approaching)";

      const agentPrompt = [
        `[Compaction Guard — Pre-Compaction Backup (${approxK} tokens, ${tierLabel})]`,
        `Current session context has reached ~${approxK} tokens and auto-compaction is approaching.`,
        "Before finishing this turn, concisely perform the following:",
        `1. Overwrite \`${targetStatePath}\` (Overwrite=true, keep concise at 1-2 KB, do not append) with: current goal, critical negative constraints, modified file paths, key confirmed values, and remaining tasks. (Set ArtifactMetadata: \`UserFacing: false, RequestFeedback: false\`.)`,
        "2. If a memory MCP server is available and new cross-session facts were established, update it. (Do NOT dump ephemeral task progress into `GEMINI.md`.)",
        `3. Add a brief 1-line note at the end of your reply informing the user that context reached ~${approxK} tokens, \`session_state.md\` was backed up, and \`/compact\` is optional at the next task boundary.`,
      ].join("\n");

      const injectSteps = [
        {
          systemMessage: {
            systemMessage: agentPrompt,
          },
        },
      ];

      saveState(stateFile, {
        lastCheckpointCount: stats.checkpointCount,
        lastCheckpointStep: stats.lastCheckpointStep,
        warnStage: nextWarnStage,
      });

      process.stdout.write(JSON.stringify({ injectSteps }));
      return;
    }

    // Normal turn: persist baseline if not saved yet, inject nothing (0 tokens)
    if (!prevState) {
      saveState(stateFile, {
        lastCheckpointCount: stats.checkpointCount,
        lastCheckpointStep: stats.lastCheckpointStep,
        warnStage: 0,
      });
    }

    process.stdout.write("{}");
  } catch {
    // Never block or fail a conversation turn on hook errors
    process.stdout.write("{}");
  }
}

main();
