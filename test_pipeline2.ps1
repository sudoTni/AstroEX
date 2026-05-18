& node test_ansi.js 2>&1 | ForEach-Object {
    $Raw = [string]$_
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Raw)
    Write-Host ($bytes -join ', ')
}
