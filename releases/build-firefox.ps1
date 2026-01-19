# Firefox Extension 打包脚本
# 使用方法: .\build-firefox.ps1 [版本号] [-Sign]
# 示例: .\build-firefox.ps1 1.0.0 -Sign
# 注意: Firefox 扩展需要签名，建议始终使用 -Sign 参数

param(
    [string]$Version = "1.0.0",
    [switch]$Sign = $false
)

$ErrorActionPreference = "Stop"

# 获取脚本所在目录的父目录（项目根目录）
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$FirefoxDir = Join-Path $ProjectRoot "firefox-extension"

# 检查 firefox-extension 目录是否存在
if (-not (Test-Path $FirefoxDir)) {
    Write-Host "错误: firefox-extension 目录不存在!" -ForegroundColor Red
    exit 1
}

# 如果未指定 -Sign 参数，提示用户
if (-not $Sign) {
    Write-Host "提示: Firefox 扩展需要签名才能正常安装" -ForegroundColor Yellow
    Write-Host "建议使用: .\build-firefox.ps1 $Version -Sign" -ForegroundColor Yellow
    Write-Host ""
}

try {
    # 如果需要签名，直接调用签名脚本（web-ext 会自动打包）
    if ($Sign) {
        Write-Host "开始打包并签名 Firefox Extension..." -ForegroundColor Green
        
        $SignScript = Join-Path $ScriptDir "sign-firefox.js"
        
        if (-not (Test-Path $SignScript)) {
            Write-Host "错误: 签名脚本不存在: $SignScript" -ForegroundColor Red
            exit 1
        }
        
        # 检查 Node.js 是否安装
        try {
            $nodeVersion = node --version 2>&1
            Write-Host "检测到 Node.js: $nodeVersion" -ForegroundColor Cyan
        } catch {
            Write-Host "错误: 未找到 Node.js，无法执行签名脚本" -ForegroundColor Red
            Write-Host "请安装 Node.js: https://nodejs.org/" -ForegroundColor Yellow
            exit 1
        }
        
        # 执行签名脚本（web-ext sign 会自动打包并签名）
        try {
            Push-Location $ScriptDir
            node sign-firefox.js
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "✓ 打包并签名完成!" -ForegroundColor Green
                
                # 查找签名后的文件并复制到 dist 目录
                $SignedDir = Join-Path $ProjectRoot "signed-firefox-extensions"
                $DistDir = Join-Path $ProjectRoot "dist"
                
                # 确保 dist 目录存在
                if (-not (Test-Path $DistDir)) {
                    New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
                }
                
                if (Test-Path $SignedDir) {
                    $SignedFiles = Get-ChildItem -Path $SignedDir -Filter "*.xpi" | Sort-Object LastWriteTime -Descending
                    if ($SignedFiles.Count -gt 0) {
                        $LatestSigned = $SignedFiles[0]
                        Write-Host "签名后的文件: $($LatestSigned.FullName)" -ForegroundColor Cyan
                        $SignedSize = ($LatestSigned.Length / 1MB)
                        Write-Host "文件大小: $([math]::Round($SignedSize, 2)) MB" -ForegroundColor Cyan
                        
                        # 复制到 dist 目录
                        $DistFile = Join-Path $DistDir "js-eyes-firefox-v$Version.xpi"
                        Copy-Item -Path $LatestSigned.FullName -Destination $DistFile -Force
                        Write-Host "已复制到 dist 目录: $DistFile" -ForegroundColor Green
                    }
                }
            } else {
                Write-Host "签名失败，退出码: $LASTEXITCODE" -ForegroundColor Red
                exit 1
            }
        } catch {
            Write-Host "签名过程出错: $_" -ForegroundColor Red
            exit 1
        } finally {
            Pop-Location
        }
    } else {
        # 如果不签名，提示用户使用签名功能
        Write-Host "Firefox 扩展已跳过打包（未签名版本不建议使用）" -ForegroundColor Yellow
        Write-Host "要生成已签名的扩展，请使用: .\build-firefox.ps1 $Version -Sign" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "错误: $_" -ForegroundColor Red
    Write-Host "错误详情: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
