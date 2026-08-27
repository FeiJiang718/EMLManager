# One-click dev launcher. Prepends local MinGW binutils to PATH
# (required by the windows-gnu Rust toolchain: as/dlltool/windres).
# Usage: powershell -ExecutionPolicy Bypass -File tools\dev.ps1
$ErrorActionPreference = "Stop"
$mingw = Join-Path $env:USERPROFILE ".rustup\mingw64\bin"
if (-not (Test-Path (Join-Path $mingw "dlltool.exe"))) {
    Write-Error "MinGW binutils not found at $mingw"
}
$env:Path = "$mingw;" + $env:Path
Set-Location (Join-Path $PSScriptRoot "..")
npm run tauri dev
