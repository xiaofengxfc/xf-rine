@echo off
setlocal
cd /d "%~dp0"

if not exist "web\dist\index.html" (
  echo Building web front end...
  call pnpm.cmd -F web build
  if errorlevel 1 goto :fail
)

echo.
echo Starting server on http://127.0.0.1:8787
start "" http://127.0.0.1:8787
call pnpm.cmd -F server start
goto :eof

:fail
echo.
echo Build failed. Read the output above.
pause
