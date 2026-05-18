#!/usr/bin/env pwsh

param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $LogDirectory,

    [ValidateNotNullOrEmpty()]
    [string] $ProjectRoot = (Join-Path $HOME 'dev/AstroEX'),

    # Pipeline step skip switches.
    [switch] $SkipClean,
    [switch] $SkipScrapeSearch,
    [switch] $SkipProcess,
    [switch] $SkipJobCloth,
    [switch] $SkipScrapeJobs,
    [switch] $SkipJobJudge,
    [switch] $SkipMakeMaterials,
    [switch] $SkipDeploy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Ensure the log directory exists before starting the transcript.
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogDirectory = (Resolve-Path -LiteralPath $LogDirectory).ProviderPath

$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile = Join-Path $LogDirectory "AstroEX-run-$Timestamp-pid$PID.log"

# ---------------------------------------------------------------------------
# Enable ANSI/VT colour processing on the Windows console stdout handle.
# Without this the console host displays ESC literally (shown as ←) instead of
# rendering colour sequences.  This is a no-op on non-Windows or in terminals
# that already have VT processing enabled (e.g. Windows Terminal).
# ---------------------------------------------------------------------------
try {
    if (-not ('ConsoleVT' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleVT {
    const int  STD_OUTPUT_HANDLE = -11;
    const uint ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern bool   GetConsoleMode(IntPtr h, out uint m);
    [DllImport("kernel32.dll")] static extern bool   SetConsoleMode(IntPtr h, uint m);
    public static void Enable() {
        var h = GetStdHandle(STD_OUTPUT_HANDLE);
        uint m; if (GetConsoleMode(h, out m)) SetConsoleMode(h, m | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
    }
}
'@
    }
    [ConsoleVT]::Enable()
}
catch { }

# PowerShell 7.2+ may strip ANSI from Write-Host when the terminal does not
# advertise VT support.  Force 'Ansi' rendering so codes are never removed.
if ((Get-Variable -Name PSStyle -Scope Global -ErrorAction SilentlyContinue) -ne $null) {
    $PSStyle.OutputRendering = [System.Management.Automation.OutputRendering]::Ansi
}

# ---------------------------------------------------------------------------
# Fix encoding and set up a raw terminal writer.
#
# Problem 1 – Mojibake (Γûä, Γûê, etc.):
#   PowerShell decodes child-process stdout using Console.OutputEncoding, which
#   defaults to the OEM code page (CP437/CP850 on English Windows).  npm writes
#   UTF-8, so every multi-byte character is mis-decoded.  Setting UTF-8 here
#   fixes the decode step before any string reaches our pipeline.
#
# Problem 2 – ESC shows as ← (VT not rendering):
#   PowerShell replaces Console.Out with its own TextWriter that routes through
#   the PS host layer.  VT sequences written there are never seen by the kernel's
#   VT processor.  Console.OpenStandardOutput() returns a Stream backed by the
#   raw Win32 STD_OUTPUT_HANDLE – the same handle we already called
#   SetConsoleMode(ENABLE_VIRTUAL_TERMINAL_PROCESSING) on – so ANSI codes
#   written through it are rendered correctly by the terminal.
# ---------------------------------------------------------------------------
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Raw UTF-8 writer directly to the Win32 stdout handle.
$script:RawStdout = [System.IO.StreamWriter]::new(
    [Console]::OpenStandardOutput(),
    [System.Text.UTF8Encoding]::new($false)
)
$script:RawStdout.AutoFlush = $true

# Strips ANSI/VT escape sequences from a string.
# Covers: CSI sequences (ESC[...), OSC sequences (ESC]...BEL/ST), and
# simple two-byte escapes (ESC followed by a single character).
$script:AnsiRegex = [System.Text.RegularExpressions.Regex]::new(
    '\x1b(?:\[[0-9;?]*[ -/]*[A-Za-z@]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[^\[\]])',
    [System.Text.RegularExpressions.RegexOptions]::Compiled
)

function Remove-AnsiCodes {
    param([string] $Text)
    return $script:AnsiRegex.Replace($Text, '')
}

# Appends a plain-text line to the run log file (no ANSI, no color).
function Write-ToLog {
    param([string] $Line)
    Add-Content -LiteralPath $script:LogFile -Value $Line -Encoding UTF8
}

# Writes a timestamped message to the terminal (in color if desired) and to
# the log file with ANSI stripped.
function Write-Log {
    param(
        [Parameter(Mandatory)]
        [string] $Message
    )

    $Now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff zzz'
    $Tagged = "[$Now] $Message"
    Write-Host $Tagged
    Write-ToLog (Remove-AnsiCodes $Tagged)
}

function Format-ArgumentForLog {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Argument
    )

    if ($Argument -match '^[A-Za-z0-9_./:=@+\-]+$') {
        return $Argument
    }

    return "'" + ($Argument -replace "'", "''") + "'"
}

function Format-CommandForLog {
    param(
        [Parameter(Mandatory)]
        [string] $FilePath,

        [Parameter(Mandatory)]
        [string[]] $ArgumentList
    )

    $SafeArgs = [System.Collections.Generic.List[string]]::new()

    for ($i = 0; $i -lt $ArgumentList.Count; $i++) {
        if ($ArgumentList[$i] -eq '--api-key' -and ($i + 1) -lt $ArgumentList.Count) {
            $SafeArgs.Add('--api-key')
            $SafeArgs.Add('<redacted>')
            $i++
            continue
        }

        $SafeArgs.Add($ArgumentList[$i])
    }

    $FormattedArgs = $SafeArgs | ForEach-Object {
        Format-ArgumentForLog $_
    }

    return "$FilePath $($FormattedArgs -join ' ')"
}

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory)]
        [string] $FilePath,

        [Parameter(Mandatory)]
        [string[]] $ArgumentList
    )

    $DisplayCommand = Format-CommandForLog -FilePath $FilePath -ArgumentList $ArgumentList

    Write-Log "Starting command: $DisplayCommand"

    # -----------------------------------------------------------------------
    # Launch the child process via System.Diagnostics.Process so we can read
    # its raw UTF-8 byte stream.  PowerShell's pipeline (& cmd 2>&1 | ...)
    # decodes stdout through the PS host layer which strips/mangles ANSI
    # escape bytes before they reach ForEach-Object, destroying color output.
    #
    # By reading from the Process object directly we get the untouched string
    # (with ANSI codes intact) which we then:
    #   • push through $script:RawStdout  → terminal renders colors
    #   • push through Remove-AnsiCodes   → log file gets plain text
    # -----------------------------------------------------------------------

    # Resolve the executable to a full path so Process.Start works correctly.
    # Get-Command may resolve to a .ps1 shim (e.g. npm.ps1) or a .cmd/.bat
    # wrapper.  System.Diagnostics.Process can only launch real executables, so
    # we detect the extension and wrap with the appropriate interpreter.
    $ResolvedPath = (Get-Command $FilePath -ErrorAction Stop).Source
    $ResolvedExt = [System.IO.Path]::GetExtension($ResolvedPath).ToLowerInvariant()

    $ChildArgs = ($ArgumentList | ForEach-Object {
            if ($_ -match '[\s"&|<>^]') { '"' + ($_ -replace '"', '\"') + '"' }
            else { $_ }
        }) -join ' '

    $psi = [System.Diagnostics.ProcessStartInfo]::new()

    switch ($ResolvedExt) {
        '.ps1' {
            # PowerShell script shim – launch via pwsh.
            $psi.FileName = (Get-Command 'pwsh' -ErrorAction Stop).Source
            $psi.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$ResolvedPath`" $ChildArgs"
        }
        { $_ -in '.cmd', '.bat' } {
            # Batch wrapper – launch via cmd.exe.
            $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
            $psi.Arguments = "/c `"$ResolvedPath`" $ChildArgs"
        }
        default {
            # Native executable – use directly.
            $psi.FileName = $ResolvedPath
            $psi.Arguments = $ChildArgs
        }
    }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $psi.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    $psi.WorkingDirectory = (Get-Location).ProviderPath
    $psi.CreateNoWindow = $true

    # Set colour environment variables on the child process.
    $psi.Environment['FORCE_COLOR'] = '3'      # truecolor
    $psi.Environment.Remove('NO_COLOR') | Out-Null

    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi

    [void] $proc.Start()

    # Kick off an async read of stderr as a pure .NET Task<string>.
    # Using an event handler (BeginErrorReadLine + ErrorDataReceived) is not
    # viable because the handler is a PowerShell ScriptBlock that requires a
    # Runspace, but .NET fires it on a thread-pool thread that has none —
    # causing an unrecoverable PSInvalidOperationException.
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    # Read stdout synchronously, line by line.
    $reader = $proc.StandardOutput
    while ($null -ne ($line = $reader.ReadLine())) {
        $script:RawStdout.WriteLine($line)
        Write-ToLog (Remove-AnsiCodes $line)
    }

    # Drain the stderr task and write any captured lines.
    $stderrText = $stderrTask.GetAwaiter().GetResult()
    if (-not [string]::IsNullOrEmpty($stderrText)) {
        foreach ($errLine in $stderrText.Split(
                [char[]]@("`r", "`n"),
                [System.StringSplitOptions]::RemoveEmptyEntries)) {
            $script:RawStdout.WriteLine($errLine)
            Write-ToLog (Remove-AnsiCodes $errLine)
        }
    }

    $proc.WaitForExit()
    $ExitCode = $proc.ExitCode
    $proc.Dispose()

    Write-Log "Finished command with exit code ${ExitCode}: $DisplayCommand"

    if ($ExitCode -ne 0) {
        throw "Command failed with exit code ${ExitCode}: $DisplayCommand"
    }
}

$LocationPushed = $false

try {
    # Write the log file header manually (Start-Transcript is not used because
    # it cannot capture raw ANSI color from child processes, which we need to
    # preserve in the terminal while logging plain text to the file).
    $InvocationHeader = @"
**********************
Windows PowerShell transcript start
Start time: $(Get-Date -Format 'yyyyMMddHHmmss')
Username: $env:USERDOMAIN\$env:USERNAME
RunAs User: $env:USERDOMAIN\$env:USERNAME
Configuration Name:
Machine: $env:COMPUTERNAME ($(if ($IsWindows -or $PSVersionTable.PSVersion.Major -le 5) {'Microsoft Windows'} else {[System.Runtime.InteropServices.RuntimeInformation]::OSDescription}))
Host Application: $($Host.Name)
Process ID: $PID
PSVersion: $($PSVersionTable.PSVersion)
Script: $($MyInvocation.ScriptName)
**********************
"@
    Add-Content -LiteralPath $LogFile -Value $InvocationHeader -Encoding UTF8

    Write-Log "Log file: $LogFile"
    Write-Log "Project root: $ProjectRoot"

    if ([string]::IsNullOrWhiteSpace($env:ASTROEX_API_KEY)) {
        Write-Log "ASTROEX_API_KEY environment variable not set, using default key."
        $ApiKey = 'sk-poe-RC8TBr0CK9kPpgy1QwwUuKmCjOAweMHiearkoTULvg0'
    }
    else {
        $ApiKey = $env:ASTROEX_API_KEY
    }

    $DataDir = Join-Path $ProjectRoot 'data'
    $LogsDir = Join-Path $ProjectRoot 'logs'
    $MaterialsDir = Join-Path $ProjectRoot 'materials'
    $MaterialsDeployedDir = Join-Path $ProjectRoot 'materials-deployed'

    Push-Location -LiteralPath $ProjectRoot
    $LocationPushed = $true

    Write-Log "Changed directory to project root."

    # --------------- Step: Clean ---------------
    if (-not $SkipClean) {
        # Bash:
        #   find data/ -mindepth 1 -maxdepth 1 ! -name 'jobDB.json' -exec rm -rfv {} \;
        #
        # Meaning:
        #   Remove every direct child of data/, including hidden entries,
        #   except an entry named exactly jobDB.json.
        Write-Log "Cleaning data directory while preserving jobDB.json."

        Get-ChildItem -LiteralPath $DataDir -Force |
        Where-Object { $_.Name -ne 'jobDB.json' } |
        Where-Object { -not ($SkipScrapeSearch -and $_.Name -like 'scraped_search_*.json') } |
        ForEach-Object {
            Write-Log "Removing data item: $($_.FullName)"
            Remove-Item -LiteralPath $_.FullName -Recurse -Force -Verbose
        }

        # Bash:
        #   rm -rfv logs/* materials/*
        #
        # Meaning:
        #   Remove non-hidden direct children of logs/ and materials/.
        #   Matched directories are removed recursively.
        #
        # Important:
        #   Bash * does not match dotfiles by default, so this intentionally
        #   does not use -Force on Get-ChildItem.
        Write-Log "Cleaning non-hidden contents of logs and materials directories."

        foreach ($dir in @($LogsDir, $MaterialsDir)) {
            if (Test-Path -LiteralPath $dir) {
                Get-ChildItem -LiteralPath $dir |
                Where-Object { $_.FullName -ne $LogFile } |
                ForEach-Object {
                    Write-Log "Removing item: $($_.FullName)"
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force -Verbose -ErrorAction SilentlyContinue
                }
            }
            else {
                Write-Log "Directory does not exist; skipping: $dir"
            }
        }
    }
    else {
        Write-Log "Skipping clean step as requested (-SkipClean)."
    }

    # --------------- Step: ScrapeSearch ---------------
    if (-not $SkipScrapeSearch) {
        # Bash:
        #   npm run scrape:search -- -s3
        Invoke-NativeChecked 'npm' @(
            'run',
            'scrape:search',
            '--',
            '-s3'
        )
    }
    else {
        Write-Log "Skipping scrape:search step as requested (-SkipScrapeSearch)."
    }

    # --------------- Step: Process ---------------
    if (-not $SkipProcess) {
        # Bash:
        #   npm run process
        Invoke-NativeChecked 'npm' @(
            'run',
            'process'
        )
    }
    else {
        Write-Log "Skipping process step as requested (-SkipProcess)."
    }

    # --------------- Step: JobCloth ---------------
    if (-not $SkipJobCloth) {
        # Bash:
        #   npm run job:cloth -- --verbose --log-payload --preset "jc_gf25_poe" --api-key "..." -s5 --batch 50
        Invoke-NativeChecked 'npm' @(
            'run',
            'job:cloth',
            '--',
            '--verbose',
            '--log-payload',
            '--preset',
            'jc_gf3_poe',
            '--api-key',
            $ApiKey,
            '-s5',
            '--batch',
            '50'
        )
    }
    else {
        Write-Log "Skipping job:cloth step as requested (-SkipJobCloth)."
    }

    # --------------- Step: ScrapeJobs ---------------
    if (-not $SkipScrapeJobs) {
        # Bash:
        #   npm run scrape:jobs -- -s3
        Invoke-NativeChecked 'npm' @(
            'run',
            'scrape:jobs',
            '--',
            '-s3'
        )
    }
    else {
        Write-Log "Skipping scrape:jobs step as requested (-SkipScrapeJobs)."
    }

    # --------------- Step: JobJudge ---------------
    if (-not $SkipJobJudge) {
        # Bash:
        #   npm run job:judge -- --verbose --log-payload --preset "jep_gf25_poe" --api-key "..." -s5
        Invoke-NativeChecked 'npm' @(
            'run',
            'job:judge',
            '--',
            '--verbose',
            '--log-payload',
            '--preset',
            'jep_gf3_poe',
            '--api-key',
            $ApiKey,
            '-s5'
        )
    }
    else {
        Write-Log "Skipping job:judge step as requested (-SkipJobJudge)."
    }

    # --------------- Step: MakeMaterials ---------------
    if (-not $SkipMakeMaterials) {
        # Bash:
        #   npm run makeMaterials -- --verbose --log-payload --preset "rop_gf3_poe" --api-key "..." -s5
        Invoke-NativeChecked 'npm' @(
            'run',
            'makeMaterials',
            '--',
            '--verbose',
            '--log-payload',
            '--preset',
            'rop_gf3_poe',
            '--api-key',
            $ApiKey,
            '-s5'
        )
    }
    else {
        Write-Log "Skipping makeMaterials step as requested (-SkipMakeMaterials)."
    }

    # --------------- Step: Deploy ---------------
    if (-not $SkipDeploy) {
        # Bash:
        #   mkdir -p ~/dev/AstroEX/materials-deployed/
        Write-Log "Ensuring materials-deployed directory exists: $MaterialsDeployedDir"
        New-Item -ItemType Directory -Path $MaterialsDeployedDir -Force | Out-Null

        # Bash:
        #   find ~/dev/AstroEX/materials/ -name "*.txt" -exec rclone -v --fast-list copy {} GoogleDrive:/autoJobGen-src/ \;
        #
        # Meaning:
        #   Recursively find entries named *.txt under materials/.
        #   Bash find includes hidden files and hidden directories, so -Force is used here.
        Write-Log "Copying generated .txt materials to GoogleDrive:/autoJobGen-src/."

        Get-ChildItem -LiteralPath $MaterialsDir -Recurse -Force -Filter '*.txt' |
        ForEach-Object {
            Write-Log "Copying material file with rclone: $($_.FullName)"

            Invoke-NativeChecked 'rclone' @(
                '-v',
                '--fast-list',
                'copy',
                $_.FullName,
                'GoogleDrive:/autoJobGen-src/'
            )
        }

        # Bash:
        #   mv -v ~/dev/AstroEX/materials/* ~/dev/AstroEX/materials-deployed/
        #
        # Meaning:
        #   Move non-hidden direct children of materials/ into materials-deployed/.
        #
        # Bash behavior note:
        #   If materials/* matches nothing, Bash normally passes the literal pattern
        #   to mv, and mv fails. This version fails explicitly with a clearer message.
        Write-Log "Moving non-hidden materials into materials-deployed."

        $ItemsToDeploy = @(Get-ChildItem -LiteralPath $MaterialsDir)

        if ($ItemsToDeploy.Count -eq 0) {
            throw "No non-hidden items found in materials/. Bash 'mv materials/* materials-deployed/' would fail here."
        }

        foreach ($item in $ItemsToDeploy) {
            Write-Log "Moving material item: $($item.FullName) -> $MaterialsDeployedDir"
            Move-Item -LiteralPath $item.FullName -Destination $MaterialsDeployedDir -Force -Verbose
        }
    }
    else {
        Write-Log "Skipping deploy step as requested (-SkipDeploy)."
    }

    Write-Log "AstroEX run completed successfully."
}
catch {
    Write-Log "AstroEX run failed: $($_.Exception.Message)"

    if ($_.ScriptStackTrace) {
        Write-Log "Script stack trace:"
        Write-Log $_.ScriptStackTrace
    }

    throw
}
finally {
    if ($LocationPushed) {
        Pop-Location
        Write-Log "Restored previous directory."
    }

    Write-Log "Run finished. Log written to: $LogFile"
    # Append a transcript-style footer so the log file format stays consistent.
    Add-Content -LiteralPath $LogFile -Value "**********************`nWindows PowerShell transcript end`nEnd time: $(Get-Date -Format 'yyyyMMddHHmmss')`n**********************" -Encoding UTF8
}