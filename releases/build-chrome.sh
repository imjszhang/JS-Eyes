#!/bin/bash
# Chrome Extension 打包脚本
# 使用方法: ./build-chrome.sh [版本号]
# 示例: ./build-chrome.sh 1.0.0

set -e

VERSION=${1:-"1.0.0"}

echo "开始打包 Chrome Extension..."

# 获取脚本所在目录的父目录（项目根目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CHROME_DIR="$PROJECT_ROOT/chrome-extension"
DIST_DIR="$PROJECT_ROOT/dist"

# 确保 dist 目录存在
mkdir -p "$DIST_DIR"

OUTPUT_FILE="$DIST_DIR/js-eyes-chrome-v$VERSION.zip"

# 检查 chrome-extension 目录是否存在
if [ ! -d "$CHROME_DIR" ]; then
    echo "错误: chrome-extension 目录不存在!"
    exit 1
fi

# 如果输出文件已存在，先删除
if [ -f "$OUTPUT_FILE" ]; then
    rm -f "$OUTPUT_FILE"
    echo "已删除旧的打包文件: $OUTPUT_FILE"
fi

# 切换到 chrome-extension 目录
cd "$CHROME_DIR"

# 创建 ZIP 文件，排除不需要的文件
zip -r "$OUTPUT_FILE" . \
    -x "*.git*" \
    -x "*.DS_Store" \
    -x "Thumbs.db" \
    -x "*.swp" \
    -x "*.swo" \
    > /dev/null

echo "✓ 打包完成!"
echo "输出文件: $OUTPUT_FILE"

# 显示文件大小
if command -v stat > /dev/null 2>&1; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        SIZE=$(stat -f%z "$OUTPUT_FILE")
    else
        SIZE=$(stat -c%s "$OUTPUT_FILE")
    fi
    SIZE_MB=$(echo "scale=2; $SIZE / 1024 / 1024" | bc)
    echo "文件大小: ${SIZE_MB} MB"
fi
