param(
    [string]$InstallDir = (Join-Path $env:USERPROFILE ".gemini\hooks"),
    [string]$HooksPath  = (Join-Path $env:USERPROFILE ".gemini\config\hooks.json"),
    [string]$RulesPath  = (Join-Path $env:USERPROFILE ".gemini\GEMINI.md"),
    [switch]$SkipRule
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$RepoBase  = "https://raw.githubusercontent.com/servaltullius/antigravity-compaction-guard/main"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Write-Host ""
Write-Host "=== antigravity-compaction-guard One-Touch Installer ===" -ForegroundColor Cyan

# 1. Verify Node.js is available
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "Node.js ('node') was not found in PATH. Please install Node.js 18+ first: https://nodejs.org/"
}
$nodeVer = (& node --version 2>&1).Trim()
Write-Host "[1/4] Node.js detected: $nodeVer" -ForegroundColor Gray

# 2. Install compaction-guard-hook.mjs
if (-not (Test-Path -LiteralPath $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
$InstallDir   = (Resolve-Path -LiteralPath $InstallDir).Path
$TargetScript = Join-Path $InstallDir "compaction-guard-hook.mjs"
$ScriptDir    = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
$LocalScript  = if ($ScriptDir) { Join-Path $ScriptDir "compaction-guard-hook.mjs" } else { "" }

if ($LocalScript -and (Test-Path -LiteralPath $LocalScript)) {
    if (-not $LocalScript.Equals($TargetScript, [System.StringComparison]::OrdinalIgnoreCase)) {
        Copy-Item -LiteralPath $LocalScript -Destination $TargetScript -Force
    }
    Write-Host "[2/4] Installed local hook script: $TargetScript" -ForegroundColor Green
} else {
    Write-Host "[2/4] Downloading compaction-guard-hook.mjs..." -ForegroundColor Gray
    Invoke-WebRequest -Uri "$RepoBase/compaction-guard-hook.mjs" -OutFile $TargetScript -UseBasicParsing
    Write-Host "      Installed: $TargetScript" -ForegroundColor Green
}

# Smoke test hook script with empty JSON payload
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $nodeCmd.Source
$psi.Arguments = "`"$TargetScript`""
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = $Utf8NoBom
$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
[void]$proc.Start()
$proc.StandardInput.WriteLine('{}')
$proc.StandardInput.Close()
$outTask = $proc.StandardOutput.ReadToEndAsync()
$smokeOut = if ($outTask.Wait(5000)) { $outTask.Result.Trim() } else { "" }
if (-not $proc.WaitForExit(5000)) { try { $proc.Kill() } catch {} }
if ($smokeOut -ne "{}") {
    throw "Hook smoke test failed. Expected '{}', got: '$smokeOut'"
}
Write-Host "      Smoke test OK" -ForegroundColor Green

# 3. Safely merge PreInvocation hook into hooks.json (with backup, UTF-8 no BOM)
Write-Host "[3/4] Registering PreInvocation hook in $HooksPath..." -ForegroundColor Gray
$HooksDir = Split-Path -Parent $HooksPath
if (-not (Test-Path -LiteralPath $HooksDir)) {
    New-Item -ItemType Directory -Path $HooksDir -Force | Out-Null
}

$hooksObj = $null
if (Test-Path -LiteralPath $HooksPath) {
    $rawJson = [System.IO.File]::ReadAllText($HooksPath, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    if (-not [string]::IsNullOrWhiteSpace($rawJson)) {
        $backupPath = "$HooksPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $HooksPath -Destination $backupPath -Force
        Write-Host "      Backup created: $backupPath" -ForegroundColor DarkGray
        $hooksObj = $rawJson | ConvertFrom-Json
    }
}
if ($null -eq $hooksObj) {
    $hooksObj = New-Object PSObject
}

$cmdStr = if ($TargetScript -match '\s') { "node `"$TargetScript`"" } else { "node $TargetScript" }
$handler = [PSCustomObject][ordered]@{
    type    = "command"
    command = $cmdStr
    timeout = 5
}
$hookEntry = [PSCustomObject][ordered]@{
    PreInvocation = @($handler)
}
$hooksObj | Add-Member -NotePropertyName "compaction-guard" -NotePropertyValue $hookEntry -Force

$finalJson = $hooksObj | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($HooksPath, $finalJson + "`r`n", $Utf8NoBom)
Write-Host "      Updated: $HooksPath" -ForegroundColor Green

# 4. Add 3-tier context discipline rule block to GEMINI.md (idempotent, marker-bounded)
if (-not $SkipRule) {
    Write-Host "[4/4] Checking global rules ($RulesPath)..." -ForegroundColor Gray
    $ruleDir = Split-Path -Parent $RulesPath
    if (-not (Test-Path -LiteralPath $ruleDir)) {
        New-Item -ItemType Directory -Path $ruleDir -Force | Out-Null
    }
    $existingRule = if (Test-Path -LiteralPath $RulesPath) {
        [System.IO.File]::ReadAllText($RulesPath, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    } else { "" }

    $startMarker = "<!-- compaction-guard:start -->"
    $endMarker   = "<!-- compaction-guard:end -->"
    $ruleBlock = @(
        $startMarker,
        '# Context & Compaction Discipline',
        '- **3-Tier State Separation**: (1) Keep `GEMINI.md` (global/workspace) concise (<4 KB) with only invariant rules, prohibitions, and build commands - replace outdated lines instead of appending. (2) Overwrite active session progress, edited files, confirmed values, and remaining tasks in artifact `session_state.md` (1-2 KB). (3) Store cross-session durable facts in memory MCP if available.',
        '- **Offload Wide Exploration**: Delegate multi-file searches (5+ files), large log analysis, and broad codebase surveys to the `research` subagent so only concise summaries enter the main context.',
        '- **Pre-Compaction Backup**: When the compaction-guard hook warns at 200k/430k tokens or after a major milestone, overwrite `session_state.md` with current state (`ArtifactMetadata: UserFacing=false, RequestFeedback=false`).',
        $endMarker
    ) -join "`r`n"

    if ($existingRule -match [regex]::Escape($startMarker) -or $existingRule -match "# Context & Compaction Discipline") {
        Write-Host "      Rule already present in $RulesPath (skipped)" -ForegroundColor DarkGray
    } else {
        $sep = if ([string]::IsNullOrWhiteSpace($existingRule)) { "" } else { "`r`n`r`n" }
        $newContent = $existingRule.TrimEnd() + $sep + $ruleBlock + "`r`n"
        [System.IO.File]::WriteAllText($RulesPath, $newContent, $Utf8NoBom)
        Write-Host "      Added 3-tier compaction discipline rule to $RulesPath" -ForegroundColor Green
    }
} else {
    Write-Host "[4/4] Skipped global rule update (-SkipRule)." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "[DONE] antigravity-compaction-guard installed!" -ForegroundColor Green
Write-Host "  Hook   : $TargetScript"
Write-Host "  Config : $HooksPath"
if (-not $SkipRule) { Write-Host "  Rules  : $RulesPath" }
Write-Host ""
Write-Host "Antigravity hot-reloads hooks.json automatically - no restart required!" -ForegroundColor Cyan
Write-Host ""
