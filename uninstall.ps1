param(
    [string]$InstallDir = (Join-Path $env:USERPROFILE ".gemini\hooks"),
    [string]$HooksPath  = (Join-Path $env:USERPROFILE ".gemini\config\hooks.json"),
    [string]$RulesPath  = (Join-Path $env:USERPROFILE ".gemini\GEMINI.md"),
    [string]$StateDir   = (Join-Path $env:USERPROFILE ".gemini\memory\hook-state")
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Write-Host "=== antigravity-compaction-guard Uninstaller ===" -ForegroundColor Cyan

# 1. Remove 'compaction-guard' entry from hooks.json
if (Test-Path -LiteralPath $HooksPath) {
    $rawJson = [System.IO.File]::ReadAllText($HooksPath, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    if (-not [string]::IsNullOrWhiteSpace($rawJson)) {
        $hooksObj = $rawJson | ConvertFrom-Json
        if ($hooksObj.PSObject.Properties.Name -contains "compaction-guard") {
            $backupPath = "$HooksPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Copy-Item -LiteralPath $HooksPath -Destination $backupPath -Force
            $hooksObj.PSObject.Properties.Remove("compaction-guard")
            $finalJson = $hooksObj | ConvertTo-Json -Depth 20
            [System.IO.File]::WriteAllText($HooksPath, $finalJson + "`r`n", $Utf8NoBom)
            Write-Host "[OK] Removed 'compaction-guard' from $HooksPath (backup: $backupPath)" -ForegroundColor Green
        } else {
            Write-Host "[INFO] 'compaction-guard' entry not found in $HooksPath" -ForegroundColor Gray
        }
    }
}

# 2. Remove managed rule block from GEMINI.md
if (Test-Path -LiteralPath $RulesPath) {
    $ruleText = [System.IO.File]::ReadAllText($RulesPath, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    $pattern = "(?s)\r?\n*<!-- compaction-guard:start -->.*?<!-- compaction-guard:end -->\r?\n*"
    if ($ruleText -match $pattern) {
        $cleaned = ([regex]::Replace($ruleText, $pattern, "`r`n")).Trim()
        $outText = if ([string]::IsNullOrEmpty($cleaned)) { "" } else { $cleaned + "`r`n" }
        [System.IO.File]::WriteAllText($RulesPath, $outText, $Utf8NoBom)
        Write-Host "[OK] Removed managed compaction-guard rule block from $RulesPath" -ForegroundColor Green
    }
}

# 3. Remove hook script & state directory
$TargetScript = Join-Path $InstallDir "compaction-guard-hook.mjs"
if (Test-Path -LiteralPath $TargetScript) {
    Remove-Item -LiteralPath $TargetScript -Force
    Write-Host "[OK] Removed script: $TargetScript" -ForegroundColor Green
}
if (Test-Path -LiteralPath $StateDir) {
    Remove-Item -LiteralPath $StateDir -Recurse -Force
    Write-Host "[OK] Removed state directory: $StateDir" -ForegroundColor Green
}

Write-Host "Done." -ForegroundColor Cyan
