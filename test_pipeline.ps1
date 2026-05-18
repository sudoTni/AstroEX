$script:RawStdout = [System.IO.StreamWriter]::new(
    [Console]::OpenStandardOutput(),
    [System.Text.Encoding]::UTF8
)
$script:RawStdout.AutoFlush = $true

& node test_ansi.js 2>&1 | ForEach-Object {
    $Raw = if ($_ -is [System.Management.Automation.ErrorRecord]) {
        $_.Exception.Message
    } else {
        [string]$_
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Raw)
    $script:RawStdout.WriteLine("Raw string length: $($Raw.Length), bytes: $($bytes.length)")
    $script:RawStdout.WriteLine("Raw content: $Raw")
}
