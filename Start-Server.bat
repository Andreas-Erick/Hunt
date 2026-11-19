@echo off
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
cd /d "%APP_DIR%"
if exist "%TEMP%\hunt-server.log" move /y "%TEMP%\hunt-server.log" "%TEMP%\hunt-server.prev.log" >nul 2>&1
if exist "%APP_DIR%\.next\BUILD_ID" (
  node "%APP_DIR%\node_modules\next\dist\bin\next" start -H 0.0.0.0 -p 3000 > "%TEMP%\hunt-server.log" 2>&1
) else (
  node "%APP_DIR%\node_modules\next\dist\bin\next" dev -H 0.0.0.0 -p 3000 > "%TEMP%\hunt-server.log" 2>&1
)
