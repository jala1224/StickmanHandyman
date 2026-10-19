$root = Split-Path -Parent $PSScriptRoot
$flag = Join-Path $root ".validation-ran.flag"
$inputJson = [Console]::In.ReadToEnd()

# Scope enforcement to plan/execution flows only.
$inStrictFlow = $false
if (-not [string]::IsNullOrWhiteSpace($inputJson)) {
  $inStrictFlow = $inputJson -match 'Plan To Implementation|planning|todo|implementation follow-through'
}

if (-not $inStrictFlow) {
  @{ continue = $true } | ConvertTo-Json -Compress
  exit 0
}

if (Test-Path $flag) {
  @{ continue = $true } | ConvertTo-Json -Compress
  exit 0
}

@{
  continue = $false
  stopReason = "Validation command required before completion"
  systemMessage = "Run a relevant validation command (for this repo, at least npm run check in backend/ for backend changes) before final completion."
} | ConvertTo-Json -Compress

exit 2
