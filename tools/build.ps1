# One-click release build. Output: src-tauri\target\release\eml-manager.exe
# Usage: powershell -ExecutionPolicy Bypass -File tools\build.ps1
$ErrorActionPreference = "Stop"
$mingw = Join-Path $env:USERPROFILE ".rustup\mingw64\bin"
if (-not (Test-Path (Join-Path $mingw "dlltool.exe"))) {
    Write-Error "MinGW binutils not found at $mingw"
}
$env:Path = "$mingw;" + $env:Path
Set-Location (Join-Path $PSScriptRoot "..")
npm run tauri build @args
