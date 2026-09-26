<#
.SYNOPSIS
    AstroOM Windows PowerShell launcher.

.DESCRIPTION
    Sources a private .env for credentials and optional directory redirection,
    wipes the previous run's logs, then executes the release binary with a
    fixed policy argv. Any arguments passed to this script are appended LAST, so
    they override the policy defaults (same last-wins semantics as the Linux
    bash launcher and the Node predecessor's yargs parsing).

.EXAMPLE
    .\astro_launcher.ps1                       # use the policy defaults
    .\astro_launcher.ps1 --batch 50 --clean    # override selected flags
#>

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ForwardedArgs
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
Set-Location -LiteralPath $ScriptDir

Write-Host ":: astroom launcher"
Write-Host ""

$EnvFile = Join-Path $ScriptDir ".env"
if (Test-Path -LiteralPath $EnvFile) {
    Write-Host ":: Sourcing $EnvFile..."
    Get-Content -LiteralPath $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#')) {
            if ($line -match '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
                $key = $matches[1]
                $val = $matches[2].Trim()
                if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
                    $val = $val.Substring(1, $val.Length - 2)
                }
                [System.Environment]::SetEnvironmentVariable($key, $val, 'Process')
            }
        }
    }
    Write-Host ":: ...sourced $EnvFile"
} else {
    Write-Host ":: No .env found; using defaults and CLI flags only."
    Write-Host "::   copy .env.example .env   # then set AOM_OR_API_KEY"
}
Write-Host ""

$LogsDir = Join-Path $ScriptDir "logs"
Write-Host ":: Cleaning $LogsDir\..."
if (-not (Test-Path -LiteralPath $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
} else {
    Get-ChildItem -LiteralPath $LogsDir -Force | ForEach-Object {
        Write-Host "removed '$($_.FullName)'"
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
}
Write-Host ":: ...cleaned $LogsDir\"
Write-Host ""

if (-not $env:AOM_OR_API_KEY) {
    Write-Error "Set AOM_OR_API_KEY in .env (see .env.example), or pass --api-key directly to astroom."
    exit 1
}

# Candidate profile directory. Copy the shipped template once with:
#   Copy-Item -Recurse profile.example profile
if ($env:AOM_PROFILE_DIR) {
    $ProfileDir = $env:AOM_PROFILE_DIR
} else {
    $ProfileDir = Join-Path $ScriptDir "profile"
}

$SearchTermsFile = Join-Path $ProfileDir "search_terms.txt"

[System.Collections.Generic.List[string]]$Arguments = @(
    "run-pipeline",
    "--job-provider", "indeed,linkedin",
    "--search-terms-file", $SearchTermsFile,
    "--api-key", $env:AOM_OR_API_KEY,
    "--jobcloth-preset", "jc_glm-5.3-flash",
    "--remoteeval-preset", "re_glm-5.3-flash",
    "--jobjudge-preset", "jep_glm-5.3-flash",
    "--makematerials-preset", "rop_glm-5.3-flash",
    "--batch", "10",
    "--sleep", "2",
    "--results-wanted", "200",
    "--hours-old", "24",
    "--jc-provider", "astro_auto_provider",
    "--jc-provider-quant", "fp8",
    "--jc-reasoning-effort", "low",
    "--re-provider", "astro_auto_provider",
    "--re-provider-quant", "fp8",
    "--re-reasoning-level", "high",
    "--jj-provider", "astro_auto_provider",
    "--j-provider-quant", "fp8",
    "--jj-reasoning-effort", "high",
    "--mm-provider", "astro_auto_provider",
    "--mm-provider-quant", "fp8",
    "--mm-reasoning-effort", "high",
    "--astro_auto_provider-top", "3",
    "--remote-only", "true",
    "--track-or-costs",
    "--internet-watchdog",
    "--log-cool-offs"
)

if ($env:AOM_DATA_DIR) {
    $Arguments.Add("--data-dir")
    $Arguments.Add($env:AOM_DATA_DIR)
}
if ($env:AOM_LOG_DIR) {
    $Arguments.Add("--log-dir")
    $Arguments.Add($env:AOM_LOG_DIR)
}
if ($env:AOM_MATERIALS_DIR) {
    $Arguments.Add("--materials-dir")
    $Arguments.Add($env:AOM_MATERIALS_DIR)
}
if ($env:AOM_PROFILE_DIR) {
    $Arguments.Add("--profile-dir")
    $Arguments.Add($env:AOM_PROFILE_DIR)
}
if ($env:AOM_INDEED_API_KEY) {
    $Arguments.Add("--indeed-api-key")
    $Arguments.Add($env:AOM_INDEED_API_KEY)
}

if ($env:AOM_CLEAN -eq "1") {
    $Arguments.Add("--clean")
}

if ($env:AOM_DEPLOY -eq "1") {
    if (-not $env:AOM_DEPLOY_DESTINATION) {
        Write-Error "Set AOM_DEPLOY_DESTINATION, e.g. GoogleDrive:/my-astroom-output"
        exit 1
    }
    $Arguments.Add("--deploy")
    $Arguments.Add("--deploy-destination")
    $Arguments.Add($env:AOM_DEPLOY_DESTINATION)
}

# Append caller-provided overrides last (last-wins semantics)
if ($ForwardedArgs) {
    foreach ($arg in $ForwardedArgs) {
        $Arguments.Add($arg)
    }
}

$CandidatePaths = @(
    (Join-Path $ScriptDir "target\x86_64-pc-windows-gnu\release\astroom.exe"),
    (Join-Path $ScriptDir "target\release\astroom.exe"),
    (Join-Path $ScriptDir "target\x86_64-pc-windows-gnu\debug\astroom.exe"),
    (Join-Path $ScriptDir "target\debug\astroom.exe")
)

$Binary = $null
foreach ($Path in $CandidatePaths) {
    if (Test-Path -LiteralPath $Path) {
        $Binary = $Path
        break
    }
}

if (-not $Binary) {
    Write-Error "Cannot find astroom executable in 'target\x86_64-pc-windows-gnu\release\astroom.exe' or 'target\release\astroom.exe'. Please run 'cargo build --release' first."
    exit 1
}

& $Binary @Arguments
exit $LASTEXITCODE
