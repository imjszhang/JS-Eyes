# 打包脚本说明

本目录包含用于打包浏览器扩展的脚本。

## 文件说明

- `build-chrome.ps1` - Windows PowerShell 脚本，用于打包 Chrome/Edge 扩展
- `build-firefox.ps1` - Windows PowerShell 脚本，用于打包 Firefox 扩展（支持签名）
- `build-all.ps1` - Windows PowerShell 脚本，一键打包所有扩展（支持 Firefox 签名）
- `build-chrome.sh` - Bash 脚本，用于打包 Chrome/Edge 扩展（Linux/macOS）
- `build-firefox.sh` - Bash 脚本，用于打包 Firefox 扩展（Linux/macOS）
- `build-all.sh` - Bash 脚本，一键打包所有扩展（Linux/macOS）
- `sign-firefox.js` - Node.js 脚本，用于对 Firefox 扩展进行官方签名

## 使用方法

### Windows (PowerShell)

```powershell
# 打包单个扩展
.\build-chrome.ps1 1.0.0

# Firefox 扩展需要签名才能正常安装（推荐方式）
.\build-firefox.ps1 1.0.0 -Sign

# 打包所有扩展并签名 Firefox（推荐方式）
.\build-all.ps1 1.0.0 -SignFirefox

# 如果不指定版本号，默认使用 1.0.0
.\build-all.ps1 1.0.0 -SignFirefox
```

### Linux / macOS (Bash)

首先确保脚本有执行权限：

```bash
chmod +x build-*.sh
```

然后运行：

```bash
# 打包单个扩展
./build-chrome.sh 1.0.0

# Firefox 扩展需要签名才能正常安装（推荐方式）
./build-firefox.sh 1.0.0 -Sign

# 打包所有扩展并签名 Firefox（推荐方式）
./build-all.sh 1.0.0 -SignFirefox

# 如果不指定版本号，默认使用 1.0.0
./build-all.sh 1.0.0 -SignFirefox
```

## 输出文件

打包完成后，所有文件都会输出到 `dist/` 目录：

- `dist/js-eyes-chrome-v{版本号}.zip` - Chrome/Edge 扩展打包文件
- `dist/js-eyes-firefox-v{版本号}.xpi` - Firefox 扩展签名后的文件（最新版本）

**注意**：
- 所有打包文件统一保存在 `dist/` 目录中，方便管理和分发
- Firefox 扩展的原始签名文件保存在 `signed-firefox-extensions/` 目录
- `dist/` 目录中的 Firefox 扩展文件是从 `signed-firefox-extensions/` 复制的最新版本

## 注意事项

1. 打包文件会自动排除以下内容：
   - `.git` 目录
   - `.DS_Store`、`Thumbs.db` 等系统文件
   - 临时文件（`.swp`、`.swo`）
   - Firefox 的 `.amo-upload-uuid` 文件
   - `node_modules` 目录（Firefox）

2. 打包文件已配置在 `.gitignore` 中，不会被提交到 Git 仓库。

3. **Firefox 扩展签名**：
   - Firefox 扩展需要 Mozilla 官方签名才能在正式环境中安装
   - 未签名的扩展只能在开发模式下临时安装（`about:debugging`）
   - 使用 `-Sign` 参数可以自动签名扩展
   - 签名需要配置 AMO API 密钥（见下方"Firefox 扩展签名配置"）

4. 建议将打包文件上传到 [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) 供用户下载。

## Firefox 扩展签名配置

Firefox 扩展需要 Mozilla 官方签名才能正常安装。签名功能使用 `web-ext` 工具和 AMO API。

### 前置条件

1. **安装 web-ext 工具**：
   ```bash
   npm install -g web-ext
   ```

2. **获取 AMO API 密钥**：
   - 访问 https://addons.mozilla.org/developers/addon/api/key/
   - 登录你的 Mozilla 账户
   - 创建新的 API 密钥对
   - 保存 `JWT Issuer` 和 `JWT Secret`

### 配置方式

有两种方式配置 API 密钥：

#### 方式一：环境变量（推荐）

在 PowerShell 中设置：
```powershell
$env:AMO_API_KEY = "your-jwt-issuer"
$env:AMO_API_SECRET = "your-jwt-secret"
```

或在系统环境变量中设置：
- `AMO_API_KEY` = your-jwt-issuer
- `AMO_API_SECRET` = your-jwt-secret

#### 方式二：配置文件

在项目根目录创建 `config.json`：
```json
{
  "amo": {
    "apiKey": "your-jwt-issuer",
    "apiSecret": "your-jwt-secret"
  }
}
```

**注意**：`config.json` 文件包含敏感信息，请确保已添加到 `.gitignore` 中。

### 使用签名功能

**Windows (PowerShell):**
```powershell
# 单独签名 Firefox 扩展
node releases\sign-firefox.js

# 打包并签名 Firefox 扩展
.\releases\build-firefox.ps1 1.0.0 -Sign

# 打包所有扩展并签名 Firefox
.\releases\build-all.ps1 1.0.0 -SignFirefox
```

**Linux / macOS (Bash):**
```bash
# 单独签名 Firefox 扩展
node releases/sign-firefox.js

# 打包并签名 Firefox 扩展
./releases/build-firefox.sh 1.0.0 -Sign

# 打包所有扩展并签名 Firefox
./releases/build-all.sh 1.0.0 -SignFirefox
```

签名后的文件会保存在 `signed-firefox-extensions/` 目录中，可以直接分发给用户安装。

## GitHub Releases 发布流程

1. 运行打包脚本生成打包文件
2. 在 GitHub 上创建新的 Release
3. 上传生成的 `.zip` 和 `.xpi` 文件
4. 在 Release 说明中添加更新日志

示例 Release 说明：

```markdown
## v1.0.0

### 新增功能
- 初始版本发布

### 下载
- [Chrome Extension](js-eyes-chrome-v1.0.0.zip)
- [Firefox Extension](js-eyes-firefox-v1.0.0.xpi)
```
