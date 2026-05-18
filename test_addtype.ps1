try {
    Write-Host "Calling Add-Type"
    Add-Type -TypeDefinition "public class TestType {}"
    Write-Host "Called Add-Type successfully"
} catch {
    Write-Host "Caught error!"
}
