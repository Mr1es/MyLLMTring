@echo off
REM ---------------------------------------------------------------
REM  MyLLMTring desktop pet launcher
REM  Chain: Dify key -> Ollama -> Dify (VMware VM) -> shim -> Coopanion
REM  Double-click to start. Keep this window open to keep the pet.
REM
REM  NOTE: keep this file ASCII-only. cmd.exe reads .bat using the
REM  system code page (936/GBK on Chinese Windows). A UTF-8 file with
REM  Chinese characters gets decoded as mojibake, which splits
REM  "REM ..." into bogus commands and breaks every PowerShell line.
REM
REM  Internal call: start-pet.bat --watch-console
REM    Skips the main flow; only waits for the console then switches
REM    the provider to the local shim. Invoked via "start /min".
REM    Do not run it by hand.
REM ---------------------------------------------------------------
setlocal
set ROOT=D:\aiu\MyLLMTring
set DIFY=http://192.168.126.128

if "%~1"=="--watch-console" goto :watch_console

echo [1/5] Checking Dify API key ...
if defined DIFY_KEY goto :key_ok
REM Do NOT use findstr on .env here. .env is UTF-8 (it has Chinese
REM comments) but findstr reads with the system code page (936/GBK),
REM so the mojibake breaks the match and a valid key looks missing.
REM Node reads .env as UTF-8, so ask Node instead.
node -e "try{const k=require('./shim/config').DIFY_KEY||'';process.exit(k&&k.startsWith('app-')&&!k.includes('KEY-HERE')?0:1)}catch(e){process.exit(1)}"
if errorlevel 1 goto :no_key
:key_ok
echo       OK

echo [2/5] Checking Ollama (127.0.0.1:11434) ...
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:11434/api/tags) | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :no_ollama
echo       OK

echo [3/5] Checking Dify in the VMware VM (%DIFY%) ...
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 %DIFY%) | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :no_dify
echo       OK

echo [4/5] Checking shim (port 8787) ...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 goto :start_shim
echo       already listening - reusing it
goto :shim_ready

:start_shim
echo       not running - starting shim now
start "MyLLMTring shim" /min cmd /c "cd /d %ROOT% && node shim\index.js >> shim\run.log 2>&1"
timeout /t 4 /nobreak >nul

:shim_ready

:start_pet
echo [5/5] Starting the desktop pet ...
echo       Console: http://127.0.0.1:17788
echo       Close this window (or press Ctrl+C) to stop the pet.
echo.

REM Port 17788 only opens AFTER "pnpm dev" starts, so waiting for it
REM before starting the pet means waiting for a service that is not up
REM yet - that deadlocked the launcher for a fixed 30 seconds.
REM Now: start the pet immediately, and probe 17788 in a background
REM instance; switch provider the moment the console is ready.
start "MyLLMTring provider" /min cmd /c "call \"%ROOT%\start-pet.bat\" --watch-console"

cd /d "%ROOT%\coopanion"
pnpm dev
goto :eof

REM ---------------------------------------------------------------
REM  Background task (launched above): wait for the console, then
REM  switch the provider to the local shim. Runs in its own bat
REM  instance via --watch-console; does not affect the main flow.
REM ---------------------------------------------------------------
:watch_console
set /a tries=0
:wait_console2
timeout /t 1 /nobreak >nul
set /a tries+=1
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 17788 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto :activate_provider
if %tries% lss 60 goto :wait_console2
exit /b 0

:activate_provider
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Method POST -ContentType 'application/json' -Body '{}' http://127.0.0.1:17788/api/providers/qwen3-8b/activate | Out-Null } catch { exit /b 1 }"
exit /b 0

:no_key
echo.
echo [FAIL] No usable Dify API key.
echo        The key cannot live in the repo, so put it in ONE of these:
echo          1) %ROOT%\shim\.env   with a line   DIFY_KEY=app-xxxxxxxx
echo          2) a Windows env var named DIFY_KEY  (env var wins over file)
echo        The old key was revoked because it had been committed to GitHub.
echo        Get a new one from the Dify console: your app -^> API access -^> API keys.
echo        Then double-click this file again.
echo.
pause
exit /b 1

:no_ollama
echo.
echo [FAIL] Ollama is not running.
echo        Start it first: run "ollama serve" in a terminal, or launch Ollama
echo        from the system tray, then double-click this file again.
echo.
pause
exit /b 1

:no_dify
echo.
echo [FAIL] Dify is not reachable at %DIFY%
echo        Boot the VMware Ubuntu VM first and wait 1-2 minutes
echo        (docker and all 15 containers start by themselves),
echo        then double-click this file again.
echo.
pause
exit /b 1
