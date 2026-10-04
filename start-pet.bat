@echo off
REM ---------------------------------------------------------------
REM  MyLLMTring desktop pet launcher
REM  Chain: Dify key check -> Ollama -> Dify (VMware VM) -> shim -> Coopanion
REM  Double-click this file. Keep the window open to keep the pet.
REM
REM  内部调用：start-pet.bat --watch-console
REM    不跑主流程，只在后台等控制台就绪后把provider 切成本地 shim。
REM    由主流程用 start /min 另开一个实例调用，不要手动跑。
REM ---------------------------------------------------------------
setlocal
set ROOT=D:\aiu\MyLLMTring
set DIFY=http://192.168.126.128

if "%~1"=="--watch-console" goto :watch_console

echo [1/5] Checking Dify API key ...
if defined DIFY_KEY goto :key_ok
if not exist "%ROOT%\shim\.env" goto :no_key
findstr /C:"KEY-HERE" "%ROOT%\shim\.env" >nul
if not errorlevel 1 goto :no_key
findstr /C:"DIFY_KEY=app-" "%ROOT%\shim\.env" >nul
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

REM 控制台 17788 是 pnpm dev 起来后才开的，所以不能先等它再启动——
REM 那会白等满 30 秒。改为后台并行探测：桌宠一边起，控制台一就绪就切provider。
start "MyLLMTring provider" /min cmd /c "call \"%ROOT%\start-pet.bat\" --watch-console"

cd /d "%ROOT%\coopanion"
pnpm dev
goto :eof

REM ---------------------------------------------------------------
REM  后台任务（由上面 start 调用）：等控制台就绪后自动切到本地 shim
REM  单独开一个 bat 实例，用 --watch-console 参数进入，不影响主流程
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
echo        The key cannot live in the repo, so it goes in one of two places:
echo          1) %ROOT%\shim\.env   -- a line like   DIFY_KEY=app-xxxxxxxx
echo          2) a Windows env var named DIFY_KEY (env var wins)
echo        The old key was revoked because it had been committed to GitHub.
echo        Get a new one: Dify console -^> your app -^> API access -^> API keys.
echo        Then double-click this file again.
pause
exit /b 1

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
