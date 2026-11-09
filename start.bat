@echo off
rem ===============================================================
rem  xf-rine 一键启动
rem    start.bat        开发模式：前端热更新，后端改文件自动重启
rem    start.bat prod   生产模式：打包前端后由后端统一托管
rem
rem  这里直接用 node 调 tsx / vite / concurrently，不走 pnpm 脚本：
rem  pnpm 9 在 Windows 上会把脚本参数里的引号吃掉，root 的 pnpm dev 因此跑不起来。
rem ===============================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title xf-rine

if not exist "package.json" (
  echo [X] 当前目录不是项目根目录，找不到 package.json。
  pause
  exit /b 1
)

rem ---- 定位真正的 node.exe，并把它排到 PATH 最前面 ----
rem DSH 桌面版的 node.cmd 只是一层包装，被别的 node 进程再 spawn 时
rem 会多出一个假子进程，concurrently 的 -k 会因此把所有服务一起杀掉。
set "NODE_EXE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do (
  echo %%N | findstr /i "\desktop-bin\" >nul || if not defined NODE_EXE set "NODE_EXE=%%N"
)
if defined NODE_EXE (
  for %%I in ("!NODE_EXE!") do set "PATH=%%~dpI!PATH!"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [X] 找不到 node，请先装 Node.js，或把 node 加到 PATH。
    pause
    exit /b 1
  )
)

rem ---- 依赖缺了才装（装的时候需要 pnpm）----
set "DEPS_OK=1"
if not exist "node_modules\concurrently\dist\bin\concurrently.js" set "DEPS_OK="
if not exist "server\node_modules\tsx\dist\cli.mjs" set "DEPS_OK="
if not exist "web\node_modules\vite\bin\vite.js" set "DEPS_OK="
if not defined DEPS_OK (
  echo 缺依赖，正在安装…
  call :pnpm install
  if errorlevel 1 (
    echo [X] 依赖没装上，看上面的报错。
    pause
    exit /b 1
  )
)

if /i "%~1"=="prod" goto :prod

rem ======================= 开发模式 =======================
set "BUSY="
for %%P in (8787 5273) do (
  netstat -ano | findstr ":%%P " | findstr "LISTENING" >nul && set "BUSY=%%P"
)
if defined BUSY (
  echo [X] 端口 !BUSY! 已经被占用，先关掉占用它的进程：
  echo     查看占用：netstat -ano ^| findstr ":!BUSY! "
  pause
  exit /b 1
)

echo.
echo   开发模式：改文件马上生效
echo     后端  server 下的 .ts 改动自动重启
echo     前端  web 下的改动热更新，不用刷新页面
echo     密钥  设置页保存即写进 server\.env 并热加载，不用重启
echo   页面  http://localhost:5273
echo   接口  http://127.0.0.1:8787
echo   停    Ctrl+C，或者直接关掉这个窗口
echo.
call :open_when_ready localhost 5273

node "node_modules\concurrently\dist\bin\concurrently.js" -k -n api,web -c cyan,magenta "cd /d server && node node_modules\tsx\dist\cli.mjs watch --clear-screen=false src/index.ts" "cd /d web && node node_modules\vite\bin\vite.js"
set "CODE=!ERRORLEVEL!"
echo.
echo 开发服务已停止。
if not "!CODE!"=="0" (
  echo 退出码 !CODE!，看上面的报错。
  pause
)
exit /b !CODE!

rem ======================= 生产模式 =======================
:prod
set "BUSY="
netstat -ano | findstr ":8787 " | findstr "LISTENING" >nul && set "BUSY=1"
if defined BUSY (
  echo [X] 端口 8787 已经被占用，先关掉占用它的进程：
  echo     查看占用：netstat -ano ^| findstr ":8787 "
  pause
  exit /b 1
)

if not exist "web\dist\index.html" (
  echo 正在打包前端…
  call :build_web
  if errorlevel 1 (
    echo [X] 打包失败，看上面的报错。
    pause
    exit /b 1
  )
)

echo.
echo   生产模式：改文件不会自动生效
echo   页面  http://127.0.0.1:8787
echo   停    Ctrl+C
echo.
call :open_when_ready 127.0.0.1 8787

cd /d "%~dp0server"
node node_modules\tsx\dist\cli.mjs src/index.ts
set "CODE=!ERRORLEVEL!"
echo.
echo 服务已停止。
if not "!CODE!"=="0" (
  echo 退出码 !CODE!，看上面的报错。
  pause
)
exit /b !CODE!

rem ===============================================================
rem 子过程：调 pnpm（只在装依赖时用）
:pnpm
set "PNPM="
where pnpm.cmd >nul 2>nul && set "PNPM=pnpm.cmd"
if not defined PNPM if exist "%APPDATA%\dsh-desktop\harness\.desktop-bin\pnpm.cmd" (
  set "PATH=%APPDATA%\dsh-desktop\harness\.desktop-bin;!PATH!"
  set "PNPM=pnpm.cmd"
)
if not defined PNPM (
  echo [X] 找不到 pnpm.cmd，先装 pnpm：corepack enable 或 npm i -g pnpm
  exit /b 1
)
call !PNPM! %*
exit /b !ERRORLEVEL!

rem 子过程：打包前端
:build_web
cd /d "%~dp0web"
node node_modules\vite\bin\vite.js build
exit /b !ERRORLEVEL!

rem 子过程：等端口能连上再开浏览器  用法：call :open_when_ready 主机 端口
:open_when_ready
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "$end=(Get-Date).AddSeconds(90); while((Get-Date) -lt $end){ try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('%~1',%~2); $c.Close(); Start-Process 'http://%~1:%~2'; break } catch { Start-Sleep -Milliseconds 400 } }"
exit /b 0
