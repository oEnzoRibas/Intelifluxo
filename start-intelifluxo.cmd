@echo off
rem This double-click launcher ignores arguments. Use start-intelifluxo.ps1 for development options.
setlocal
set "NODE_OPTIONS="
where node >nul 2>&1 || (echo Node.js 24 is required. 1>&2 & exit /b 1)
set "NODE_MAJOR="
for /f "delims=" %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if not "%NODE_MAJOR%"=="24" (echo Node.js 24 is required. 1>&2 & exit /b 1)
if not exist "%~dp0backend\node_modules\tsx" (echo Backend dependencies are required. 1>&2 & exit /b 1)
if not exist "%~dp0frontend\node_modules\vite\bin\vite.js" (echo Frontend dependencies are required. 1>&2 & exit /b 1)
pushd "%~dp0backend" || exit /b 1
powershell.exe -NoProfile -File "%~dp0start-intelifluxo.ps1"
set "result=%errorlevel%"
popd
exit /b %result%
