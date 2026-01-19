# Chrome Extension 打包脚本
# 使用方法: .\build-chrome.ps1 [版本号]
# 示例: .\build-chrome.ps1 1.0.0

param(
    [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"

Write-Host "开始打包 Chrome Extension..." -ForegroundColor Green

# 获取脚本所在目录的父目录（项目根目录）
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$ChromeDir = Join-Path $ProjectRoot "chrome-extension"
$DistDir = Join-Path $ProjectRoot "dist"

# 确保 dist 目录存在
if (-not (Test-Path $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
}

$OutputFile = Join-Path $DistDir "js-eyes-chrome-v$Version.zip"

# 检查 chrome-extension 目录是否存在
if (-not (Test-Path $ChromeDir)) {
    Write-Host "错误: chrome-extension 目录不存在!" -ForegroundColor Red
    exit 1
}

# 如果输出文件已存在，先删除
if (Test-Path $OutputFile) {
    Remove-Item $OutputFile -Force
    Write-Host "已删除旧的打包文件: $OutputFile" -ForegroundColor Yellow
}

try {
    # 创建 ZIP 文件
    Write-Host "正在创建 ZIP 文件..." -ForegroundColor Cyan
    
    # 创建临时目录用于打包
    $TempDir = Join-Path $env:TEMP "js-eyes-chrome-temp-$(Get-Random)"
    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
    
    try {
        # 复制所有文件到临时目录，排除不需要的文件
        Get-ChildItem -Path $ChromeDir -Recurse | ForEach-Object {
            $RelativePath = $_.FullName.Substring($ChromeDir.Length + 1)
            
            # 跳过不需要的文件和目录
            if ($RelativePath -match '\.git|\.DS_Store|Thumbs\.db|\.swp|\.swo') {
                return
            }
            
            $DestPath = Join-Path $TempDir $RelativePath
            
            if ($_.PSIsContainer) {
                # 创建目录
                New-Item -ItemType Directory -Path $DestPath -Force | Out-Null
            } else {
                # 复制文件
                $DestDir = Split-Path -Parent $DestPath
                if (-not (Test-Path $DestDir)) {
                    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
                }
                Copy-Item -Path $_.FullName -Destination $DestPath -Force
            }
        }
        
        # 使用 Compress-Archive 压缩临时目录
        $TempZip = Join-Path $env:TEMP "js-eyes-chrome-temp-$(Get-Random).zip"
        Compress-Archive -Path "$TempDir\*" -DestinationPath $TempZip -Force
        
        # 移动临时 ZIP 文件到最终位置
        Move-Item -Path $TempZip -Destination $OutputFile -Force
        
        Write-Host "✓ 打包完成!" -ForegroundColor Green
        Write-Host "输出文件: $OutputFile" -ForegroundColor Cyan
        
        # 显示文件大小
        $FileSize = (Get-Item $OutputFile).Length / 1MB
        Write-Host "文件大小: $([math]::Round($FileSize, 2)) MB" -ForegroundColor Cyan
    }
    finally {
        # 清理临时目录
        if (Test-Path $TempDir) {
            Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
catch {
    Write-Host "错误: $_" -ForegroundColor Red
    Write-Host "错误详情: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
