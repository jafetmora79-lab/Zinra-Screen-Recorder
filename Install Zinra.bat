@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "manifest.json" (
  echo Run this from the Zinra folder that contains manifest.json.
  pause
  exit /b 1
)

set "DEST=%LOCALAPPDATA%\Zinra"
mkdir "%DEST%" 2>nul
robocopy "%CD%" "%DEST%" /E /XD .git installer /XF ZinraSetup.exe ZinraSetup.cs /NFL /NDL /NJH /NJS /nc /ns /np >nul
if errorlevel 8 (
  echo Copy failed.
  pause
  exit /b 1
)

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Zinra.lnk'); ^
   $s.TargetPath='%CHROME%'; $s.WorkingDirectory='%DEST%'; $s.Description='Zinra'; ^
   if (Test-Path '%DEST%\icons\icon128.png') { $s.IconLocation='%DEST%\icons\icon128.png' }; $s.Save()"

explorer "%DEST%"
if defined CHROME start "" "%CHROME%" chrome://extensions

echo.
echo Zinra is in %DEST%
echo In Chrome: Developer mode - Load unpacked - pick that folder.
echo.
pause
