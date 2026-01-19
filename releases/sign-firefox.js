#!/usr/bin/env node

/**
 * Firefox扩展签名脚本
 * 
 * 使用Mozilla的web-ext工具对Firefox扩展进行官方签名
 * 需要先在AMO获取API密钥
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 加载.env文件
function loadEnvFile() {
  const envPaths = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env')
  ];
  
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      console.log('📄 找到.env文件:', envPath);
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

// 加载环境变量
loadEnvFile();

class FirefoxExtensionSigner {
  constructor() {
    this.extensionDir = path.join(__dirname, '..', 'firefox-extension');
    this.configFile = path.join(__dirname, '..', 'config.json');
    this.artifactsDir = path.join(__dirname, '..', 'signed-firefox-extensions');
    this.distDir = path.join(__dirname, '..', 'dist');
    
    // 确保 dist 目录存在
    if (!fs.existsSync(this.distDir)) {
      fs.mkdirSync(this.distDir, { recursive: true });
    }
    
    // 读取版本号
    this.version = this.getVersion();
  }
  
  /**
   * 从 manifest.json 获取版本号
   */
  getVersion() {
    const manifestPath = path.join(this.extensionDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return manifest.version || '1.0.0';
      } catch (error) {
        console.log('⚠️ 无法读取版本号，使用默认版本 1.0.0');
        return '1.0.0';
      }
    }
    return '1.0.0';
  }

  /**
   * 检查必要的工具和配置
   */
  checkPrerequisites() {
    console.log('🔍 检查签名前置条件...');
    
    // 检查web-ext是否安装
    try {
      execSync('web-ext --version', { stdio: 'pipe' });
      console.log('✅ web-ext工具已安装');
    } catch (error) {
      console.log('❌ web-ext工具未安装');
      console.log('请运行: npm install -g web-ext');
      process.exit(1);
    }

    // 检查扩展目录
    if (!fs.existsSync(this.extensionDir)) {
      console.log('❌ Firefox扩展目录不存在:', this.extensionDir);
      process.exit(1);
    }
    console.log('✅ 扩展目录存在');

    // 检查manifest.json
    const manifestPath = path.join(this.extensionDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.log('❌ manifest.json文件不存在');
      process.exit(1);
    }
    console.log('✅ manifest.json文件存在');
  }

  /**
   * 获取API配置
   */
  getApiConfig() {
    console.log('🔑 获取API配置...');
    
    // 从环境变量获取
    const apiKey = process.env.AMO_API_KEY;
    const apiSecret = process.env.AMO_API_SECRET;
    
    if (apiKey && apiSecret) {
      console.log('✅ 从环境变量获取API配置');
      return { apiKey, apiSecret };
    }

    // 从配置文件获取
    if (fs.existsSync(this.configFile)) {
      try {
        const config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        if (config.amo && config.amo.apiKey && config.amo.apiSecret) {
          console.log('✅ 从配置文件获取API配置');
          return {
            apiKey: config.amo.apiKey,
            apiSecret: config.amo.apiSecret
          };
        }
      } catch (error) {
        console.log('⚠️ 配置文件格式错误');
      }
    }

    console.log('❌ 未找到API配置');
    console.log('请设置环境变量或在config.json中添加AMO API配置:');
    console.log('环境变量方式:');
    console.log('  set AMO_API_KEY=your-api-key');
    console.log('  set AMO_API_SECRET=your-api-secret');
    console.log('');
    console.log('配置文件方式 (config.json):');
    console.log('  {');
    console.log('    "amo": {');
    console.log('      "apiKey": "your-api-key",');
    console.log('      "apiSecret": "your-api-secret"');
    console.log('    }');
    console.log('  }');
    console.log('');
    console.log('API密钥获取地址: https://addons.mozilla.org/developers/addon/api/key/');
    process.exit(1);
  }

  /**
   * 执行签名
   */
  async signExtension() {
    console.log('🔐 开始签名Firefox扩展...');
    
    const { apiKey, apiSecret } = this.getApiConfig();
    
    // 确保输出目录存在
    if (!fs.existsSync(this.artifactsDir)) {
      fs.mkdirSync(this.artifactsDir, { recursive: true });
    }
    
    try {
      const command = `web-ext sign --api-key="${apiKey}" --api-secret="${apiSecret}" --artifacts-dir="${this.artifactsDir}" --channel=unlisted`;
      
      console.log('执行命令:', command.replace(apiKey, '***').replace(apiSecret, '***'));
      
      const result = execSync(command, {
        cwd: this.extensionDir,
        stdio: 'inherit'
      });
      
      console.log('✅ 扩展签名成功!');
      console.log('📁 签名后的文件保存在:', this.artifactsDir);
      
      // 查找签名后的文件
      const files = fs.readdirSync(this.artifactsDir);
      const xpiFiles = files.filter(f => f.endsWith('.xpi'));
      if (xpiFiles.length > 0) {
        console.log('📦 签名后的文件:');
        xpiFiles.forEach(file => {
          const filePath = path.join(this.artifactsDir, file);
          const stats = fs.statSync(filePath);
          const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
          console.log(`   - ${file} (${sizeMB} MB)`);
        });
        
        // 复制最新的文件到 dist 目录
        const latestFile = xpiFiles.sort().reverse()[0]; // 按文件名排序，取最新的
        const sourcePath = path.join(this.artifactsDir, latestFile);
        const distFileName = `js-eyes-firefox-v${this.version}.xpi`;
        const distPath = path.join(this.distDir, distFileName);
        
        fs.copyFileSync(sourcePath, distPath);
        console.log(`📋 已复制到 dist 目录: ${distFileName}`);
      }
      
      return xpiFiles.length > 0 ? path.join(this.artifactsDir, xpiFiles[0]) : null;
      
    } catch (error) {
      console.log('❌ 扩展签名失败:', error.message);
      process.exit(1);
    }
  }

  /**
   * 显示使用说明
   */
  showUsage() {
    console.log('Firefox扩展签名工具');
    console.log('');
    console.log('使用方法:');
    console.log('  node sign-firefox.js');
    console.log('');
    console.log('前置条件:');
    console.log('1. 安装web-ext工具: npm install -g web-ext');
    console.log('2. 在AMO获取API密钥: https://addons.mozilla.org/developers/addon/api/key/');
    console.log('3. 设置API密钥环境变量或配置文件');
    console.log('');
    console.log('环境变量设置:');
    console.log('  set AMO_API_KEY=your-api-key');
    console.log('  set AMO_API_SECRET=your-api-secret');
  }

  /**
   * 主执行函数
   */
  async run() {
    try {
      console.log('🚀 Firefox扩展签名工具启动');
      console.log('');
      
      this.checkPrerequisites();
      const signedFile = await this.signExtension();
      
      console.log('');
      console.log('🎉 签名完成! 现在可以正常安装扩展，不会遇到403错误。');
      
      return signedFile;
      
    } catch (error) {
      console.error('💥 签名过程出错:', error.message);
      process.exit(1);
    }
  }
}

// 命令行参数处理
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  const signer = new FirefoxExtensionSigner();
  signer.showUsage();
  process.exit(0);
}

// 执行签名
const signer = new FirefoxExtensionSigner();
signer.run().then(signedFile => {
  if (signedFile) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});
