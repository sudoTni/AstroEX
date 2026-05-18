$Raw = "`e[38;2;250;50;50mTest`e[0m"
$RawBytes = [System.Text.Encoding]::UTF8.GetBytes($Raw)
[System.IO.File]::WriteAllBytes("C:\Users\micha\Desktop\AstroEX\test_ansi.bin", $RawBytes)
