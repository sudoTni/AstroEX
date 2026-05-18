$script:RawStdout = [System.IO.StreamWriter]::new(
    [Console]::OpenStandardOutput(),
    [System.Text.Encoding]::UTF8
)
$script:RawStdout.AutoFlush = $true

& node test_ansi.js 2>&1 | ForEach-Object {
    $script:RawStdout.WriteLine([string]$_)
}
