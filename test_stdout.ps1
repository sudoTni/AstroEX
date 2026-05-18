$str = "`e[31mThis should be red`e[0m"
Write-Host "With Write-Host: $str"
$stdout = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), [System.Text.Encoding]::UTF8)
$stdout.AutoFlush = $true
$stdout.WriteLine("With RawStdout: $str")
