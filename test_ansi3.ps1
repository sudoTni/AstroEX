$str = "`e[31mRed`e[0m"
Write-Host "String length: $($str.Length)"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($str)
Write-Host "Byte length: $($bytes.Length)"
