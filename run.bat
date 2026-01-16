@echo off
chcp 65001 >nul
title Node.js Launcher

echo Проверка установки Node.js...

:: Проверка наличия Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Ошибка: Node.js не установлен!
    echo Установите Node.js с официального сайта: https://nodejs.org/
    echo После установки перезапустите этот скрипт.
    pause
    exit /b 1
)

:: Проверка версии Node.js
node --version
if %errorlevel% neq 0 (
    echo Ошибка при проверке версии Node.js!
    pause
    exit /b 1
)

echo Node.js обнаружен!

:: Проверка наличия package.json
if not exist "package.json" (
    echo Ошибка: Файл package.json не найден в текущей директории!
    echo Убедитесь, что вы находитесь в правильной папке проекта.
    pause
    exit /b 1
)

echo Установка зависимостей...
call npm install
if %errorlevel% neq 0 (
    echo Ошибка при установке зависимостей!
    pause
    exit /b 1
)

echo Запуск приложения...
echo ========================================
node .
if %errorlevel% neq 0 (
    echo ========================================
    echo Ошибка при запуске приложения!
    pause
    exit /b 1
)

pause