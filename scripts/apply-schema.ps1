# Apply database schema without hardcoding credentials.
# Prompts for connection info and runs backend/apply-schema.js.

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$env:DB_HOST = Read-Host "DB host"
$env:DB_PORT = Read-Host "DB port (default 5432)"
if ([string]::IsNullOrWhiteSpace($env:DB_PORT)) { $env:DB_PORT = "5432" }
$env:DB_NAME = Read-Host "DB name"
$env:DB_USER = Read-Host "DB user"
$securePassword = Read-Host "DB password" -AsSecureString
$env:DB_SSL = Read-Host "DB SSL (true/false, default true)"
if ([string]::IsNullOrWhiteSpace($env:DB_SSL)) { $env:DB_SSL = "true" }

$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

node backend/apply-schema.js
