@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sakura
if not exist node_modules (
  echo 第一次运行，安装依赖…
  call npm install --omit=dev
)
echo 电脑: http://127.0.0.1:8290/    手机: http://本机局域网IP:8291/
start "" http://127.0.0.1:8290/
node server.js
pause
