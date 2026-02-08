# 打包脚本说明

本目录包含用于打包浏览器扩展的统一构建脚本。

## 文件说明

- `build.js` - 跨平台 Node.js 构建脚本，支持 Chrome/Firefox 打包、Firefox 签名、版本号同步

## 前置条件

- **Node.js** (>= 14)
- 首次使用前在项目根目录执行：`npm install`
- Firefox 签名还需要：`npm install -g web-ext`

## 使用方法

### npm scripts（推荐）

```bash
# 打包所有扩展（Firefox 自动签名）
npm run build

# 仅打包 Chrome 扩展
npm run build:chrome

# 打包并签名 Firefox 扩展（默认签名）
npm run build:firefox

# 打包 Firefox 扩展（不签名，仅开发调试用）
npm run build:firefox:dev

# 同步版本号到所有 manifest.json
npm run bump -- 1.4.0
```

### 直接调用

```bash
node releases/build.js chrome
node releases/build.js firefox
node releases/build.js firefox --no-sign   # 仅开发调试，跳过签名
node releases/build.js all
node releases/build.js bump 1.4.0
```

### 查看帮助

```bash
node releases/build.js --help
```

## 版本号管理

版本号的唯一来源是根目录 `package.json` 的 `version` 字段。

使用 `bump` 命令可以一次性同步版本号到以下 3 个文件：

- `package.json`（根目录）
- `chrome-extension/manifest.json`
- `firefox-extension/manifest.json`

```bash
# 示例：升级到 1.4.0
npm run bump -- 1.4.0
```

## 输出文件

打包完成后，所有文件输出到 `dist/` 目录：

- `dist/js-eyes-chrome-v{版本号}.zip` - Chrome/Edge 扩展打包文件
- `dist/js-eyes-firefox-v{版本号}.xpi` - Firefox 扩展签名后的文件

**注意**：
- 所有打包文件统一保存在 `dist/` 目录中，方便管理和分发
- Firefox 扩展的原始签名文件保存在 `signed-firefox-extensions/` 目录
- `dist/` 目录中的 Firefox 扩展文件是从 `signed-firefox-extensions/` 复制的最新版本

## 打包排除规则

打包时会自动排除以下内容：

- `.git` 目录
- `.DS_Store`、`Thumbs.db` 等系统文件
- 临时文件（`.swp`、`.swo`）
- Firefox 的 `.amo-upload-uuid` 文件
- `node_modules` 目录

## Firefox 扩展签名配置

Firefox 扩展需要 Mozilla 官方签名才能正常安装。签名功能使用 `web-ext` 工具和 AMO API。

### 获取 API 密钥

1. 访问 https://addons.mozilla.org/developers/addon/api/key/
2. 登录你的 Mozilla 账户
3. 创建新的 API 密钥对
4. 保存 `JWT Issuer` 和 `JWT Secret`

### 配置方式

有三种方式配置 API 密钥（按优先级排列）：

#### 方式一：环境变量（推荐）

```bash
# Linux / macOS
export AMO_API_KEY="your-jwt-issuer"
export AMO_API_SECRET="your-jwt-secret"

# Windows (PowerShell)
$env:AMO_API_KEY = "your-jwt-issuer"
$env:AMO_API_SECRET = "your-jwt-secret"

# Windows (CMD)
set AMO_API_KEY=your-jwt-issuer
set AMO_API_SECRET=your-jwt-secret
```

#### 方式二：.env 文件

在项目根目录创建 `.env` 文件：

```env
AMO_API_KEY=your-jwt-issuer
AMO_API_SECRET=your-jwt-secret
```

#### 方式三：配置文件

在项目根目录创建 `config.json`：

```json
{
  "amo": {
    "apiKey": "your-jwt-issuer",
    "apiSecret": "your-jwt-secret"
  }
}
```

**注意**：`.env` 和 `config.json` 包含敏感信息，已在 `.gitignore` 中排除，不会被提交到 Git 仓库。

## GitHub Releases 发布流程

1. 使用 `bump` 命令更新版本号
2. 运行 `npm run build:chrome` 和 `npm run build:firefox:sign` 生成打包文件
3. 在 GitHub 上创建新的 Release
4. 上传 `dist/` 目录下生成的 `.zip` 和 `.xpi` 文件
5. 在 Release 说明中添加更新日志
