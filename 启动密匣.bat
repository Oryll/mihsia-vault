@echo off
chcp 65001 >nul 2>&1
title 密匣 · 本地密码保险箱
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo.
    echo   没有找到 Python。
    echo   请先安装 Python 3.9 或更新的版本，安装时勾选 "Add Python to PATH"。
    echo.
    pause
    exit /b 1
)

echo.
echo   正在启动密匣，浏览器会自动打开……
echo   这个窗口不要关；关掉就等于锁上保险箱。
echo.

python vault_server.py
if errorlevel 1 pause
