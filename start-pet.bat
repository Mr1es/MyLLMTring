@echo off
REM ---------------------------------------------------------------
REM  MyLLMTring desktop pet launcher
REM  Chain: Ollama -> Dify (VMware VM) -> shim -> Coopanion
REM  Double-click this file. Keep the window open to keep the pet.
REM ---------------------------------------------------------------
setlocal
set ROOT=D:\aiu\MyLLMTring
set DIFY=http://192.168.126.128

echo [1/5] Checking Ollama (127.0.0.1:11434) ...
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:11434/api/tags) | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :no_ollama
echo       OK

echo [2/5] Checking Dify in the VMware VM (%DIFY%) ...
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 %DIFY%) | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :no_dify
echo       OK

echo [3/5] Checking shim (port 8787) ...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo       not running - starting shim now
  start "MyLLMTring shim" /min cmd /c "cd /d %ROOT% && node shim\server.js >> shim\run.log 2>&1"
  timeout /t 4 /nobreak >nul
) else (
  echo       already listening - reusing it
)

echo [4/5] Waiting for the pet console (port 17788) ...
set /a tries=0
:wait_console
timeout /t 2 /nobreak >nul
set /a tries+=1
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 17788 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto :console_up
if %tries% lss 15 goto :wait_console
echo       console not up yet - skipping auto-select
goto :start_pet

:console_up
echo       console is up - making sure the pet uses the LOCAL model
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Method POST -ContentType 'application/json' -Body '{}' http://127.0.0.1:17788/api/providers/qwen3-8b/activate | Out-Null; Write-Host '       provider set to qwen3-8b (local shim)' } catch { Write-Host '       could not set provider - set it by hand at http://127.0.0.1:17788' }"

:start_pet
echo [5/5] Starting the desktop pet ...
echo       Console: http://127.0.0.1:17788
echo       Close this window (or press Ctrl+C) to stop the pet.
echo.
cd /d "%ROOT%\coopanion"
pnpm dev
goto :eof

:no_ollama
echo.
echo [FAIL] Ollama is not running.
echo        Start it first: run "ollama serve" in a terminal, or launch Ollama
echo        from the system tray, then double-click this file again.
pause
exit /b 1

:no_dify
echo.
echo [FAIL] Dify is not reachable at %DIFY%
echo        Boot the VMware Ubuntu VM first and wait 1-2 minutes
echo        (docker and all 15 containers start by themselves),
echo        then double-click this file again.
pause
exit /b 1
