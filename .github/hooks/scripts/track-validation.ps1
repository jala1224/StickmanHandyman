$root = Split-Path -Parent $PSScriptRoot
$flag = Join-Path $root ".validation-ran.flag"

$inputJson = [Console]::In.ReadToEnd()

if ([string]::IsNullOrWhiteSpace($inputJson)) {
  @{ continue = $true } | ConvertTo-Json -Compress
  exit 0
}

# Track only explicit command execution tool output payloads.
$looksLikeCommandTool = $inputJson -match 'run_in_terminal|create_and_run_task|execute'
$looksLikeValidationCmd = $inputJson -match '(npm\s+run\s+check|npm\s+test|npm\s+run\s+test|npm\s+run\s+lint|npm\s+run\s+build|node\s+--check|pytest|vitest|jest|eslint|tsc)'

if ($looksLikeCommandTool -and $looksLikeValidationCmd) {
  Set-Content -Path $flag -Value "validation-ran" -NoNewline
}

@{
  continue = $true
} | ConvertTo-Json -Compress
