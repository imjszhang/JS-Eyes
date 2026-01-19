#!/bin/bash
# 打包所有扩展脚本
# 使用方法: ./build-all.sh [版本号] [-SignFirefox]
# 示例: ./build-all.sh 1.0.0 -SignFirefox
# 注意: Firefox 扩展需要签名，建议始终使用 -SignFirefox 参数

set -e

VERSION=${1:-"1.0.0"}
SIGN_FIREFOX=false

# 解析参数
if [ "$2" = "-SignFirefox" ] || [ "$2" = "--sign-firefox" ]; then
    SIGN_FIREFOX=true
fi

echo "========================================"
echo "   JS Eyes 扩展打包工具"
echo "   版本: $VERSION"
echo "========================================"
echo ""

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 打包 Chrome Extension
echo "[1/2] 打包 Chrome Extension..."
if "$SCRIPT_DIR/build-chrome.sh" "$VERSION"; then
    echo ""
else
    echo "Chrome Extension 打包失败!"
    exit 1
fi

# 打包 Firefox Extension
echo "[2/2] 打包 Firefox Extension..."
if [ "$SIGN_FIREFOX" = true ]; then
    if "$SCRIPT_DIR/build-firefox.sh" "$VERSION" -Sign; then
        echo ""
    else
        echo "Firefox Extension 打包失败!"
        exit 1
    fi
else
    echo "警告: Firefox 扩展未启用签名，将跳过打包"
    echo "建议使用: ./build-all.sh $VERSION -SignFirefox"
fi
echo ""

echo "========================================"
echo "   所有扩展打包完成!"
echo "========================================"
