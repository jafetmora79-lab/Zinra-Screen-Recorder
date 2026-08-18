@echo off
setlocal
cd /d "%~dp0"
set CSC=
for %%P in (
  "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) do if exist %%~P set CSC=%%~P
if "%CSC%"=="" (
  echo Could not find the C# compiler. Use "Install Zinra.bat" in the folder above instead.
  pause
  exit /b 1
)
"%CSC%" /nologo /target:winexe /r:System.Windows.Forms.dll /out:"..\ZinraSetup.exe" ZinraSetup.cs
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
echo Built ..\ZinraSetup.exe
