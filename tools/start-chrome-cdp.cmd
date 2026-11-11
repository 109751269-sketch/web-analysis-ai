@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  一键启动「带调试端口的主 Chrome」——供抓取引擎 CDP 挂载复用登录态
REM  v2：自动处理 Chrome 后台残留进程（one-click，无需手动任务管理器）
REM  你双击本脚本 = 同意重启 Chrome（用 --restore-last-session 恢复标签页）。
REM ============================================================

set PORT=9222
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"

REM 1) 端口已就绪？直接结束
curl -s --noproxy 127.0.0.1 http://127.0.0.1:%PORT%/json/version > "%TEMP%\cdp_probe.txt" 2>nul
findstr /I "webSocketDebuggerUrl" "%TEMP%\cdp_probe.txt" >nul 2>&1
if not errorlevel 1 (
  echo [√] 调试端口 %PORT% 已就绪，无需重启。
  goto :done
)

if not exist %CHROME% (
  echo [x] 未找到 Chrome: %CHROME%
  goto :done
)

REM 2) 关闭所有 Chrome（含后台进程）——双击本脚本即视为同意
echo [i] 正在关闭所有 Chrome 进程...
taskkill /F /IM chrome.exe >nul 2>&1
ping -n 4 127.0.0.1 >nul

REM 3) 带调试端口重启
echo [i] 启动 Chrome（调试端口 %PORT%）...
start "" %CHROME% --remote-debugging-port=%PORT% --remote-allow-origins=* --restore-last-session

REM 4) 等待并验证（最多 10 秒）
set OK=
for /L %%i in (1,1,10) do (
  ping -n 2 127.0.0.1 >nul
  curl -s --noproxy 127.0.0.1 http://127.0.0.1:%PORT%/json/version > "%TEMP%\cdp_probe.txt" 2>nul
  findstr /I "webSocketDebuggerUrl" "%TEMP%\cdp_probe.txt" >nul 2>&1
  if not errorlevel 1 (
    set OK=1
    goto :verified
  )
)

:verified
if defined OK (
  echo [√] 端口就绪！可以开始抓取。
  type "%TEMP%\cdp_probe.txt"
) else (
  echo [x] 端口未生效。请重试，或让安全软件放行。
  echo     自检：浏览器打开 http://127.0.0.1:%PORT%/json/version 应返回 JSON。
)

:done
del "%TEMP%\cdp_probe.txt" >nul 2>&1
echo.
pause
