# 打包所有扩展脚本
# 使用方法: .\build-all.ps1 [版本号] [-SignFirefox]
# 示例: .\build-all.ps1 1.0.0 -SignFirefox
# 注意: Firefox 扩展需要签名，建议始终使用 -SignFirefox 参数

param(
    [string]$Version = "1.0.0",
    [switch]$SignFirefox = $false
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   JS Eyes 扩展打包工具" -ForegroundColor Cyan
Write-Host "   版本: $Version" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 获取脚本所在目录
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 打包 Chrome Extension
Write-Host "[1/2] 打包 Chrome Extension..." -ForegroundColor Yellow
try {
    & "$ScriptDir\build-chrome.ps1" -Version $Version
    if (-not $?) {
        Write-Host "Chrome Extension 打包失败!" -ForegroundColor Red
        exit 1
    }
}
catch {
    Write-Host "Chrome Extension 打包失败: $_" -ForegroundColor Red
    exit 1
}
Write-Host ""

# 打包 Firefox Extension
Write-Host "[2/2] 打包 Firefox Extension..." -ForegroundColor Yellow
try {
    if ($SignFirefox) {
        & "$ScriptDir\build-firefox.ps1" -Version $Version -Sign
    } else {
        Write-Host "警告: Firefox 扩展未启用签名，将跳过打包" -ForegroundColor Yellow
        Write-Host "建议使用: .\build-all.ps1 $Version -SignFirefox" -ForegroundColor Yellow
    }
    if (-not $?) {
        Write-Host "Firefox Extension 打包失败!" -ForegroundColor Red
        exit 1
    }
}
catch {
    Write-Host "Firefox Extension 打包失败: $_" -ForegroundColor Red
    exit 1
}
Write-Host ""

Write-Host "========================================" -ForegroundColor Green
Write-Host "   所有扩展打包完成!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
