@echo off
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
cd /d "%APP_DIR%"
if exist "%TEMP%\hunt-server.log" move /y "%TEMP%\hunt-server.log" "%TEMP%\hunt-server.prev.log" >nul 2>&1

set "NODE_BIN=node"
if exist "%APP_DIR%\node.exe" set "NODE_BIN=%APP_DIR%\node.exe"

if exist "%APP_DIR%\server.js" (
  set "HOSTNAME=0.0.0.0"
  set "PORT=3000"
  "%NODE_BIN%" "%APP_DIR%\server.js" > "%TEMP%\hunt-server.log" 2>&1
) else if exist "%APP_DIR%\.next\BUILD_ID" (
  "%NODE_BIN%" "%APP_DIR%\node_modules\next\dist\bin\next" start -H 0.0.0.0 -p 3000 > "%TEMP%\hunt-server.log" 2>&1
) else (
  "%NODE_BIN%" "%APP_DIR%\node_modules\next\dist\bin\next" dev -H 0.0.0.0 -p 3000 > "%TEMP%\hunt-server.log" 2>&1
)
