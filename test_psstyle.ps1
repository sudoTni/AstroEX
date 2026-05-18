if ((Get-Variable -Name PSStyle -Scope Global -ErrorAction SilentlyContinue) -ne $null) {
    $PSStyle.OutputRendering = [System.Management.Automation.OutputRendering]::Host
}
& node test_ansi.js 2>&1 | ForEach-Object {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($_)
    Write-Host "Host rendering bytes: $($bytes -join ',')"
}

if ((Get-Variable -Name PSStyle -Scope Global -ErrorAction SilentlyContinue) -ne $null) {
    $PSStyle.OutputRendering = [System.Management.Automation.OutputRendering]::Ansi
}
& node test_ansi.js 2>&1 | ForEach-Object {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($_)
    Write-Host "Ansi rendering bytes: $($bytes -join ',')"
}
