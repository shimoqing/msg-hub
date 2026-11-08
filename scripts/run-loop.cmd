@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

rem Local overrides (MSGHUB_HOST, MSGHUB_ALLOWED_CIDRS, MSGHUB_NODE, ...)
rem live in config.local.cmd — kept out of version control.
if exist "config.local.cmd" call "config.local.cmd"

if not exist "data" mkdir "data"
if not exist "data\logs" mkdir "data\logs"

if exist "data\console.log" for %%F in ("data\console.log") do if %%~zF GTR 1048576 move /y "data\console.log" "data\console-old.log" >nul

set "NODE_EXE=%MSGHUB_NODE%"
if "%NODE_EXE%"=="" set "NODE_EXE=node"

set "DELAY=3"

:loop
"%NODE_EXE%" server.js >> "data\console.log" 2>&1
set "RC=%ERRORLEVEL%"

ping -n %DELAY% 127.0.0.1 >nul

if "%RC%"=="2" (
  set "DELAY=30"
) else (
  set /a DELAY=DELAY*2
)
if %DELAY% GTR 60 set "DELAY=60"

goto loop
