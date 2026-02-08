#!/usr/bin/env node

/**
 * JS Eyes 统一构建脚本
 *
 * 使用方法:
 *   node releases/build.js <command> [options]
 *
 * 命令:
 *   chrome              打包 Chrome 扩展为 ZIP
 *   firefox [--sign]    打包/签名 Firefox 扩展
 *   all [--sign]        打包所有扩展
 *   bump <version>      同步版本号到所有 manifest.json
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================
// 路径常量
// ============================================================

const PROJECT_ROOT = path.join(__dirname, '..');
const CHROME_DIR = path.join(PROJECT_ROOT, 'chrome-extension');
const FIREFOX_DIR = path.join(PROJECT_ROOT, 'firefox-extension');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const SIGNED_DIR = path.join(PROJECT_ROOT, 'signed-firefox-extensions');
const PKG_PATH = path.join(PROJECT_ROOT, 'package.json');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const CHROME_MANIFEST = path.join(CHROME_DIR, 'manifest.json');
const FIREFOX_MANIFEST = path.join(FIREFOX_DIR, 'manifest.json');

// 需要排除的文件/目录模式
const EXCLUDE_PATTERNS = [
  '.git/**',
  '**/.git/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/*.swp',
  '**/*.swo',
  '.amo-upload-uuid',
  'node_modules/**',
];

// ============================================================
// 工具函数
// ============================================================

/**
 * 从根 package.json 读取版本号
 */
function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    return pkg.version || '1.0.0';
  } catch (error) {
    console.error('错误: 无法读取 package.json', error.message);
    process.exit(1);
  }
}

/**
 * 确保目录存在
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 格式化文件大小
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 加载 .env 文件到 process.env
 */
function loadEnvFile() {
  const envPaths = [
    path.join(PROJECT_ROOT, '.env'),
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env'),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      console.log('  找到 .env 文件:', envPath);
      const envContent = fs.readFileSync(envPath, 'utf8');
      const lines = envContent.split('\n');

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith('#')) {
          const [key, ...valueParts] = trimmedLine.split('=');
          if (key && valueParts.length > 0) {
            const value = valueParts.join('=').replace(/^["']|["']$/g, '');
            process.env[key.trim()] = value.trim();
          }
        }
      }
      return true;
    }
  }
  return false;
}

/**
 * 获取 AMO API 配置
 */
function getApiConfig() {
  console.log('  获取 AMO API 配置...');

  // 1. 从环境变量获取
  const apiKey = process.env.AMO_API_KEY;
  const apiSecret = process.env.AMO_API_SECRET;

  if (apiKey && apiSecret) {
    console.log('  ✓ 从环境变量获取 API 配置');
    return { apiKey, apiSecret };
  }

  // 2. 从配置文件获取
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (config.amo && config.amo.apiKey && config.amo.apiSecret) {
        console.log('  ✓ 从配置文件获取 API 配置');
        return {
          apiKey: config.amo.apiKey,
          apiSecret: config.amo.apiSecret,
        };
      }
    } catch (error) {
      console.log('  ⚠ 配置文件格式错误');
    }
  }

  console.error('  ✗ 未找到 API 配置');
  console.log('');
  console.log('请通过以下方式配置 AMO API 密钥:');
  console.log('');
  console.log('方式一 — 环境变量:');
  console.log('  set AMO_API_KEY=your-api-key');
  console.log('  set AMO_API_SECRET=your-api-secret');
  console.log('');
  console.log('方式二 — 项目根目录 config.json:');
  console.log('  {');
  console.log('    "amo": {');
  console.log('      "apiKey": "your-api-key",');
  console.log('      "apiSecret": "your-api-secret"');
  console.log('    }');
  console.log('  }');
  console.log('');
  console.log('API 密钥获取地址: https://addons.mozilla.org/developers/addon/api/key/');
  process.exit(1);
}

// ============================================================
// 构建命令
// ============================================================

/**
 * 打包 Chrome 扩展为 ZIP
 */
async function buildChrome() {
  console.log('');
  console.log('──── 打包 Chrome 扩展 ────');
  console.log('');

  const version = getVersion();

  // 检查源目录
  if (!fs.existsSync(CHROME_DIR)) {
    console.error('  ✗ chrome-extension 目录不存在!');
    process.exit(1);
  }

  ensureDir(DIST_DIR);

  const outputFile = path.join(DIST_DIR, `js-eyes-chrome-v${version}.zip`);

  // 如果输出文件已存在，先删除
  if (fs.existsSync(outputFile)) {
    fs.unlinkSync(outputFile);
    console.log('  已删除旧的打包文件');
  }

  // 使用 archiver 创建 ZIP
  const archiver = require('archiver');
  const output = fs.createWriteStream(outputFile);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      const stats = fs.statSync(outputFile);
      console.log(`  ✓ 打包完成!`);
      console.log(`  输出文件: ${outputFile}`);
      console.log(`  文件大小: ${formatSize(stats.size)}`);
      resolve();
    });

    archive.on('error', (err) => {
      console.error('  ✗ 打包失败:', err.message);
      reject(err);
    });

    archive.pipe(output);

    // 添加 chrome-extension 目录内容，排除不需要的文件
    archive.glob('**/*', {
      cwd: CHROME_DIR,
      dot: false,
      ignore: EXCLUDE_PATTERNS,
    });

    archive.finalize();
  });
}

/**
 * 打包/签名 Firefox 扩展
 */
async function buildFirefox(sign = false) {
  console.log('');
  console.log('──── 打包 Firefox 扩展 ────');
  console.log('');

  const version = getVersion();

  // 检查源目录
  if (!fs.existsSync(FIREFOX_DIR)) {
    console.error('  ✗ firefox-extension 目录不存在!');
    process.exit(1);
  }

  // 检查 manifest.json
  if (!fs.existsSync(FIREFOX_MANIFEST)) {
    console.error('  ✗ firefox-extension/manifest.json 不存在!');
    process.exit(1);
  }

  if (!sign) {
    console.log('  提示: Firefox 扩展需要签名才能正常安装');
    console.log('  建议使用: node releases/build.js firefox --sign');
    console.log('  或: npm run build:firefox:sign');
    console.log('');
    console.log('  ⚠ 未签名，跳过 Firefox 打包');
    return;
  }

  // 加载环境变量
  loadEnvFile();

  // 检查 web-ext
  console.log('  检查签名前置条件...');
  try {
    execSync('web-ext --version', { stdio: 'pipe' });
    console.log('  ✓ web-ext 工具已安装');
  } catch (error) {
    console.error('  ✗ web-ext 工具未安装');
    console.log('  请运行: npm install -g web-ext');
    process.exit(1);
  }

  // 获取 API 配置
  const { apiKey, apiSecret } = getApiConfig();

  ensureDir(SIGNED_DIR);
  ensureDir(DIST_DIR);

  // 执行签名
  console.log('  开始签名 Firefox 扩展...');
  try {
    const command = `web-ext sign --api-key="${apiKey}" --api-secret="${apiSecret}" --artifacts-dir="${SIGNED_DIR}" --channel=unlisted`;

    console.log('  执行命令:', command.replace(apiKey, '***').replace(apiSecret, '***'));

    execSync(command, {
      cwd: FIREFOX_DIR,
      stdio: 'inherit',
    });

    console.log('  ✓ 扩展签名成功!');

    // 查找签名后的文件
    const files = fs.readdirSync(SIGNED_DIR);
    const xpiFiles = files.filter((f) => f.endsWith('.xpi'));

    if (xpiFiles.length > 0) {
      console.log('  签名后的文件:');
      xpiFiles.forEach((file) => {
        const filePath = path.join(SIGNED_DIR, file);
        const stats = fs.statSync(filePath);
        console.log(`    - ${file} (${formatSize(stats.size)})`);
      });

      // 复制最新的文件到 dist 目录
      const latestFile = xpiFiles.sort().reverse()[0];
      const sourcePath = path.join(SIGNED_DIR, latestFile);
      const distFileName = `js-eyes-firefox-v${version}.xpi`;
      const distPath = path.join(DIST_DIR, distFileName);

      fs.copyFileSync(sourcePath, distPath);
      console.log(`  已复制到 dist 目录: ${distFileName}`);

      const stats = fs.statSync(distPath);
      console.log(`  输出文件: ${distPath}`);
      console.log(`  文件大小: ${formatSize(stats.size)}`);
    }
  } catch (error) {
    console.error('  ✗ 扩展签名失败:', error.message);
    process.exit(1);
  }
}

/**
 * 打包所有扩展
 */
async function buildAll(sign = false) {
  console.log('========================================');
  console.log('   JS Eyes 扩展打包工具');
  console.log(`   版本: ${getVersion()}`);
  console.log('========================================');

  console.log('');
  console.log('[1/2] Chrome 扩展');
  await buildChrome();

  console.log('');
  console.log('[2/2] Firefox 扩展');
  await buildFirefox(sign);

  console.log('');
  console.log('========================================');
  console.log('   所有扩展打包完成!');
  console.log('========================================');
}

/**
 * 同步版本号到所有 manifest.json
 */
function bump(newVersion) {
  if (!newVersion) {
    console.error('错误: 请指定新版本号');
    console.log('用法: node releases/build.js bump <version>');
    console.log('示例: node releases/build.js bump 1.4.0');
    process.exit(1);
  }

  // 简单校验版本号格式
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.error(`错误: 版本号格式不正确: "${newVersion}"`);
    console.log('期望格式: major.minor.patch (例如: 1.4.0)');
    process.exit(1);
  }

  const currentVersion = getVersion();

  console.log('');
  console.log('──── 同步版本号 ────');
  console.log('');
  console.log(`  当前版本: ${currentVersion}`);
  console.log(`  新版本:   ${newVersion}`);
  console.log('');

  const files = [
    { path: PKG_PATH, name: 'package.json' },
    { path: CHROME_MANIFEST, name: 'chrome-extension/manifest.json' },
    { path: FIREFOX_MANIFEST, name: 'firefox-extension/manifest.json' },
  ];

  for (const file of files) {
    if (!fs.existsSync(file.path)) {
      console.error(`  ✗ 文件不存在: ${file.name}`);
      process.exit(1);
    }

    try {
      const content = JSON.parse(fs.readFileSync(file.path, 'utf8'));
      const oldVersion = content.version;
      content.version = newVersion;
      fs.writeFileSync(file.path, JSON.stringify(content, null, 2) + '\n', 'utf8');
      console.log(`  ✓ ${file.name}: ${oldVersion} -> ${newVersion}`);
    } catch (error) {
      console.error(`  ✗ 更新 ${file.name} 失败:`, error.message);
      process.exit(1);
    }
  }

  console.log('');
  console.log('  版本号同步完成!');
}

// ============================================================
// 命令行入口
// ============================================================

function showHelp() {
  console.log('JS Eyes 扩展构建工具');
  console.log('');
  console.log('用法: node releases/build.js <command> [options]');
  console.log('');
  console.log('命令:');
  console.log('  chrome              打包 Chrome 扩展为 ZIP');
  console.log('  firefox [--sign]    打包/签名 Firefox 扩展');
  console.log('  all [--sign]        打包所有扩展');
  console.log('  bump <version>      同步版本号到所有 manifest.json');
  console.log('');
  console.log('快捷方式 (npm scripts):');
  console.log('  npm run build              打包所有扩展');
  console.log('  npm run build:chrome       打包 Chrome 扩展');
  console.log('  npm run build:firefox      打包 Firefox 扩展 (不签名)');
  console.log('  npm run build:firefox:sign 打包并签名 Firefox 扩展');
  console.log('  npm run bump -- 1.4.0      同步版本号');
  console.log('');
  console.log('示例:');
  console.log('  node releases/build.js chrome');
  console.log('  node releases/build.js firefox --sign');
  console.log('  node releases/build.js all --sign');
  console.log('  node releases/build.js bump 1.4.0');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const hasSign = args.includes('--sign');

  switch (command) {
    case 'chrome':
      await buildChrome();
      break;

    case 'firefox':
      await buildFirefox(hasSign);
      break;

    case 'all':
      await buildAll(hasSign);
      break;

    case 'bump':
      bump(args[1]);
      break;

    case '--help':
    case '-h':
      showHelp();
      break;

    default:
      if (command) {
        console.error(`未知命令: ${command}`);
        console.log('');
      }
      showHelp();
      process.exit(command ? 1 : 0);
  }
}

main().catch((error) => {
  console.error('构建过程出错:', error.message);
  process.exit(1);
});
