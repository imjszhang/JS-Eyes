#!/usr/bin/env node

/**
 * js-search-x - X.com (Twitter) 搜索抓取统一入口
 *
 * 封装 x-search、x-profile、x-post、x-home 等功能，提供统一的 CLI 入口。
 *
 * 使用方法:
 *   node index.js <command> [args...] [options]
 *
 * 命令:
 *   search <keyword>      搜索 X 平台内容
 *   profile <username>    抓取指定用户的帖子
 *   post <url_or_id>...   抓取指定推文的完整内容
 *   home                  抓取首页推荐流
 *
 * 示例:
 *   node index.js search "AI agent" --max-pages 3
 *   node index.js profile elonmusk --max-pages 10
 *   node index.js post https://x.com/user/status/123 --with-thread
 *   node index.js home --feed following --max-pages 5
 *
 * 各命令的详细选项请使用 --help 查看（如: node index.js search --help）
 */

const path = require('path');

const COMMANDS = {
    search: { module: './scripts/x-search', description: '搜索 X 平台内容' },
    profile: { module: './scripts/x-profile', description: '抓取指定用户的帖子' },
    post: { module: './scripts/x-post', description: '抓取指定推文的完整内容' },
    home: { module: './scripts/x-home', description: '抓取首页推荐流' }
};

function printUsage() {
    console.log('\njs-search-x - X.com 搜索抓取工具');
    console.log('='.repeat(50));
    console.log('\n使用方法:');
    console.log('  node index.js <command> [args...] [options]\n');
    console.log('命令:');
    for (const [cmd, info] of Object.entries(COMMANDS)) {
        console.log(`  ${cmd.padEnd(12)} ${info.description}`);
    }
    console.log('\n示例:');
    console.log('  node index.js search "AI agent" --max-pages 3');
    console.log('  node index.js profile elonmusk --max-pages 10 --pretty');
    console.log('  node index.js post https://x.com/user/status/123 --with-thread');
    console.log('  node index.js home --feed following');
    console.log('\n注意事项:');
    console.log('  - 需要 JS-Eyes Server 运行中，且浏览器已安装 JS-Eyes 扩展并登录 X.com');
    console.log('  - JS-Eyes Server 地址: ws://localhost:18080（可通过 --browser-server 指定）');
    console.log('  - 输出目录: work_dir/scrape/x_com_*/');
    console.log('');
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === '--help' || command === '-h') {
        printUsage();
        process.exit(0);
    }

    const cmdInfo = COMMANDS[command];
    if (!cmdInfo) {
        console.error(`错误: 未知命令 "${command}"`);
        console.error('可用命令:', Object.keys(COMMANDS).join(', '));
        printUsage();
        process.exit(1);
    }

    // 将剩余参数传递给子命令（子命令的 parseArgs 从 process.argv.slice(2) 读取）
    const remainingArgs = args.slice(1);
    const originalArgv = [...process.argv];
    process.argv = [process.argv[0], path.join(__dirname, 'index.js'), ...remainingArgs];

    try {
        const scriptPath = path.join(__dirname, 'scripts', `x-${command}.js`);
        const scriptModule = require(scriptPath);
        if (typeof scriptModule.main === 'function') {
            await scriptModule.main();
        } else {
            console.error(`错误: 命令 ${command} 未导出 main 函数`);
            process.exit(1);
        }
    } catch (error) {
        console.error('执行失败:', error.message);
        if (error.stack) {
            console.error('\n堆栈跟踪:');
            console.error(error.stack);
        }
        process.exit(1);
    } finally {
        process.argv = originalArgv;
    }
}

main().catch(error => {
    console.error('未处理的错误:', error);
    process.exit(1);
});
