@echo off
REM Chrome-CDP.cmd — 用带 9222 调试端口的 Chrome 打开浏览器（不杀进程）
REM 用途：Chrome 未运行时，双击本文件启动「可被抓取引擎 CDP 挂载」的主 Chrome。
REM 若 Chrome 已在运行，请先完全退出（否则调试端口不生效）；或直接用 start-chrome-cdp.cmd（会自动重启）。
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-allow-origins=* --restore-last-session
