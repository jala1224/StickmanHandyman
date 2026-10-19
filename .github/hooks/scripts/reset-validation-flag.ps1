$root = Split-Path -Parent $PSScriptRoot
$flag = Join-Path $root ".validation-ran.flag"
if (Test-Path $flag) {
  Remove-Item $flag -Force
}

# Always allow the session to continue.
@{
  continue = $true
} | ConvertTo-Json -Compress
