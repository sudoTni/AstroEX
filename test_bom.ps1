$stdout = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), [System.Text.Encoding]::UTF8)
$stdout.AutoFlush = $true
$stdout.WriteLine("`e[31mRed with BOM`e[0m")

$noBomEncoding = [System.Text.UTF8Encoding]::new($false)
$stdout2 = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $noBomEncoding)
$stdout2.AutoFlush = $true
$stdout2.WriteLine("`e[32mGreen without BOM`e[0m")
