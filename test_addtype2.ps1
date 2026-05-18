try {
    Write-Host "Calling Add-Type"
    Add-Type -TypeDefinition "public class TestType2 {}" -ErrorAction SilentlyContinue
    Write-Host "Called Add-Type successfully 1"
} catch {
    Write-Host "Caught error 1!"
}
try {
    Write-Host "Calling Add-Type 2"
    Add-Type -TypeDefinition "public class TestType2 {}" -ErrorAction SilentlyContinue
    Write-Host "Called Add-Type successfully 2"
} catch {
    Write-Host "Caught error 2!"
}
