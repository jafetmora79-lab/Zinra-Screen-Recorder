@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

if not exist "manifest.json" (
  echo Run this from the Zinra folder that contains manifest.json.
  pause
  exit /b 1
)

for /f "usebackq tokens=2 delims=:," %%V in (`findstr /r "\"version\"" manifest.json`) do (
  set "VERSION=%%~V"
)
set "VERSION=%VERSION: =%"
set "VERSION=%VERSION:"=%"
if "%VERSION%"=="" (
  echo Could not read version from manifest.json.
  pause
  exit /b 1
)

set "STAGE=dist\zinra-package"
set "ZIP=dist\zinra-%VERSION%.zip"

if exist "dist" rmdir /s /q "dist"
mkdir "%STAGE%"

rem Runtime-only files: the store package should contain what the extension
rem actually loads, not the sideload installer, docs, or unused brand assets.
robocopy "%CD%" "%STAGE%" /E ^
  /XD .git installer dist ^
  /XF "Install Zinra.bat" ZinraSetup.exe ZinraSetup.cs README.md BRAND.md STORE.md zinra-mark.svg privacy.html index.html demo.html ^
  /NFL /NDL /NJH /NJS /nc /ns /np >nul
if errorlevel 8 (
  echo Copy failed.
  pause
  exit /b 1
)

if exist "%ZIP%" del "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%ZIP%' -Force"
if errorlevel 1 (
  echo Zip failed.
  pause
  exit /b 1
)

echo.
echo Built %ZIP%
echo Upload that file directly to the Chrome Web Store developer dashboard.
echo.
pause
