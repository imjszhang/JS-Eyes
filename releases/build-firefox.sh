#!/bin/bash
# Firefox Extension 打包脚本
# 使用方法: ./build-firefox.sh [版本号] [-Sign]
# 示例: ./build-firefox.sh 1.0.0 -Sign
# 注意: Firefox 扩展需要签名，建议始终使用 -Sign 参数

set -e

VERSION=${1:-"1.0.0"}
SIGN=false

# 解析参数
if [ "$2" = "-Sign" ] || [ "$2" = "--sign" ]; then
    SIGN=true
fi

# 获取脚本所在目录的父目录（项目根目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FIREFOX_DIR="$PROJECT_ROOT/firefox-extension"

# 检查 firefox-extension 目录是否存在
if [ ! -d "$FIREFOX_DIR" ]; then
    echo "错误: firefox-extension 目录不存在!"
    exit 1
fi

# 如果未指定 -Sign 参数，提示用户
if [ "$SIGN" = false ]; then
    echo "提示: Firefox 扩展需要签名才能正常安装"
    echo "建议使用: ./build-firefox.sh $VERSION -Sign"
    echo ""
fi

# 如果需要签名，直接调用签名脚本（web-ext 会自动打包）
if [ "$SIGN" = true ]; then
    echo "开始打包并签名 Firefox Extension..."
    
    SIGN_SCRIPT="$SCRIPT_DIR/sign-firefox.js"
    
    if [ ! -f "$SIGN_SCRIPT" ]; then
        echo "错误: 签名脚本不存在: $SIGN_SCRIPT"
        exit 1
    fi
    
    # 检查 Node.js 是否安装
    if ! command -v node > /dev/null 2>&1; then
        echo "错误: 未找到 Node.js，无法执行签名脚本"
        echo "请安装 Node.js: https://nodejs.org/"
        exit 1
    fi
    
    NODE_VERSION=$(node --version)
    echo "检测到 Node.js: $NODE_VERSION"
    
    # 执行签名脚本（web-ext sign 会自动打包并签名）
    cd "$SCRIPT_DIR"
    if node sign-firefox.js; then
        echo "✓ 打包并签名完成!"
        
        # 查找签名后的文件并复制到 dist 目录
        SIGNED_DIR="$PROJECT_ROOT/signed-firefox-extensions"
        DIST_DIR="$PROJECT_ROOT/dist"
        
        # 确保 dist 目录存在
        mkdir -p "$DIST_DIR"
        
        if [ -d "$SIGNED_DIR" ]; then
            # 兼容不同平台的 find 命令
            if [[ "$OSTYPE" == "darwin"* ]]; then
                # macOS: 使用 -f 和 stat 命令
                LATEST_SIGNED=$(find "$SIGNED_DIR" -name "*.xpi" -type f -exec stat -f "%m %N" {} \; | sort -n | tail -1 | cut -d' ' -f2-)
            else
                # Linux: 使用 -printf
                LATEST_SIGNED=$(find "$SIGNED_DIR" -name "*.xpi" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)
                # 如果 -printf 不支持，使用备用方法
                if [ -z "$LATEST_SIGNED" ]; then
                    LATEST_SIGNED=$(ls -t "$SIGNED_DIR"/*.xpi 2>/dev/null | head -1)
                fi
            fi
            
            if [ -n "$LATEST_SIGNED" ] && [ -f "$LATEST_SIGNED" ]; then
                echo "签名后的文件: $LATEST_SIGNED"
                if command -v stat > /dev/null 2>&1; then
                    if [[ "$OSTYPE" == "darwin"* ]]; then
                        SIZE=$(stat -f%z "$LATEST_SIGNED" 2>/dev/null)
                    else
                        SIZE=$(stat -c%s "$LATEST_SIGNED" 2>/dev/null)
                    fi
                    if [ -n "$SIZE" ] && command -v bc > /dev/null 2>&1; then
                        SIZE_MB=$(echo "scale=2; $SIZE / 1024 / 1024" | bc)
                        echo "文件大小: ${SIZE_MB} MB"
                    fi
                fi
                
                # 复制到 dist 目录
                DIST_FILE="$DIST_DIR/js-eyes-firefox-v$VERSION.xpi"
                cp "$LATEST_SIGNED" "$DIST_FILE"
                echo "已复制到 dist 目录: $DIST_FILE"
            fi
        fi
    else
        echo "签名失败，退出码: $?"
        exit 1
    fi
else
    # 如果不签名，提示用户使用签名功能
    echo "Firefox 扩展已跳过打包（未签名版本不建议使用）"
    echo "要生成已签名的扩展，请使用: ./build-firefox.sh $VERSION -Sign"
fi
