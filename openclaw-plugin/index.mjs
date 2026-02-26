import { createRequire } from "node:module";

/**
 * Patch child_process.spawn / execFile to default windowsHide: true on Windows.
 *
 * OpenClaw's runCommandWithTimeout (src/process/exec.ts) spawns git, npm, etc.
 * without windowsHide, causing visible CMD windows on every call.
 */
function patchWindowsHide() {
  if (process.platform !== "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const cp = require("node:child_process");

    const _spawn = cp.spawn;
    cp.spawn = function patchedSpawn(cmd, args, opts) {
      if (args && typeof args === "object" && !Array.isArray(args)) {
        if (args.windowsHide === undefined) args.windowsHide = true;
        return _spawn.call(this, cmd, args);
      }
      if (!opts || typeof opts !== "object") opts = {};
      if (opts.windowsHide === undefined) opts.windowsHide = true;
      return _spawn.call(this, cmd, args, opts);
    };

    const _execFile = cp.execFile;
    cp.execFile = function patchedExecFile(file, args, opts, cb) {
      if (typeof args === "function") return _execFile.call(this, file, args);
      if (typeof opts === "function") {
        if (Array.isArray(args)) return _execFile.call(this, file, args, opts);
        if (args && typeof args === "object") {
          if (args.windowsHide === undefined) args.windowsHide = true;
        }
        return _execFile.call(this, file, args, opts);
      }
      if (opts && typeof opts === "object") {
        if (opts.windowsHide === undefined) opts.windowsHide = true;
      }
      return _execFile.call(this, file, args, opts, cb);
    };
  } catch {
    // Best-effort; swallow silently.
  }
}

patchWindowsHide();

const require = createRequire(import.meta.url);
const { BrowserAutomation } = require("../clients/js-eyes-client.js");
const { createServer } = require("../server/index.js");

const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeOs = require("node:os");
const { execSync } = require("node:child_process");

const PLUGIN_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const SKILL_ROOT = nodePath.resolve(
  process.platform === "win32" ? PLUGIN_DIR.replace(/^\//, "") : PLUGIN_DIR,
  "..",
);
const DEFAULT_REGISTRY = "https://js-eyes.com/skills.json";

export default function register(api) {
  const pluginCfg = api.pluginConfig ?? {};

  const serverHost = pluginCfg.serverHost || "localhost";
  const serverPort = pluginCfg.serverPort || 18080;
  const autoStart = pluginCfg.autoStartServer ?? true;
  const requestTimeout = pluginCfg.requestTimeout || 60;
  const skillsRegistryUrl = pluginCfg.skillsRegistryUrl || DEFAULT_REGISTRY;
  const skillsDir = pluginCfg.skillsDir
    ? nodePath.resolve(pluginCfg.skillsDir)
    : nodePath.join(SKILL_ROOT, "skills");

  let bot = null;
  let server = null;

  function ensureBot() {
    if (!bot) {
      bot = new BrowserAutomation(`ws://${serverHost}:${serverPort}`, {
        defaultTimeout: requestTimeout,
        logger: {
          info: (msg) => api.logger.info(msg),
          warn: (msg) => api.logger.warn(msg),
          error: (msg) => api.logger.error(msg),
        },
      });
    }
    return bot;
  }

  function textResult(text) {
    return { content: [{ type: "text", text }] };
  }

  // ---------------------------------------------------------------------------
  // Service: js-eyes-server
  // ---------------------------------------------------------------------------

  api.registerService({
    id: "js-eyes-server",
    async start(ctx) {
      if (!autoStart) {
        ctx.logger.info("[js-eyes] autoStartServer=false, skipping server start");
        return;
      }
      try {
        server = createServer({
          port: serverPort,
          host: serverHost,
          logger: {
            info: (msg) => ctx.logger.info(msg),
            warn: (msg) => ctx.logger.warn(msg),
            error: (msg) => ctx.logger.error(msg),
          },
        });
        await server.start();
        ctx.logger.info(`[js-eyes] Server started on ws://${serverHost}:${serverPort}`);
      } catch (err) {
        ctx.logger.error(`[js-eyes] Failed to start server: ${err.message}`);
        server = null;
      }
    },
    async stop(ctx) {
      if (bot) {
        try { bot.disconnect(); } catch {}
        bot = null;
      }
      if (server) {
        try { await server.stop(); } catch {}
        server = null;
      }
      ctx.logger.info("[js-eyes] Service stopped");
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: js_eyes_get_tabs
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "js_eyes_get_tabs",
      label: "JS Eyes: Get Tabs",
      description:
        "获取浏览器中所有已打开的标签页列表，包含每个标签页的 ID、URL、标题等信息。",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "目标浏览器的 clientId 或名称（如 'firefox'、'chrome'）。省略则返回所有浏览器的标签页。",
          },
        },
      },
      async execute(_toolCallId, params) {
        const b = ensureBot();
        const result = await b.getTabs({ target: params.target });
        const lines = [];
        if (result.browsers && result.browsers.length > 0) {
          for (const browser of result.browsers) {
            lines.push(`## ${browser.browserName} (${browser.clientId})`);
            for (const tab of browser.tabs) {
              const active = tab.id === result.activeTabId ? " [ACTIVE]" : "";
              lines.push(`  - [${tab.id}] ${tab.title || "(untitled)"}${active}`);
              lines.push(`    ${tab.url}`);
            }
          }
        } else {
          lines.push("当前没有浏览器扩展连接。");
        }
        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // Tool: js_eyes_list_clients
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "js_eyes_list_clients",
      label: "JS Eyes: List Clients",
      description: "获取当前已连接到 JS-Eyes 服务器的浏览器扩展客户端列表。",
      parameters: { type: "object", properties: {} },
      async execute() {
        const b = ensureBot();
        const clients = await b.listClients();
        if (clients.length === 0) {
          return textResult("当前没有浏览器扩展连接到服务器。");
        }
        const lines = clients.map(
          (c) => `- ${c.browserName} (clientId: ${c.clientId}, tabs: ${c.tabCount})`,
        );
        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // Tool: js_eyes_open_url
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "js_eyes_open_url",
      label: "JS Eyes: Open URL",
      description:
        "在浏览器中打开指定 URL。可以打开新标签页，也可以在已有标签页中导航。返回标签页 ID。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要打开的 URL" },
          tabId: {
            type: "number",
            description: "已有标签页 ID（传入则在该标签页导航，省略则新开标签页）",
          },
          windowId: {
            type: "number",
            description: "窗口 ID（新开标签页时可指定窗口）",
          },
          target: { type: "string", description: "目标浏览器 clientId 或名称" },
        },
        required: ["url"],
      },
      async execute(_toolCallId, params) {
        const b = ensureBot();
        const tabId = await b.openUrl(
          params.url,
          params.tabId ?? null,
          params.windowId ?? null,
          { target: params.target },
        );
        return textResult(`已打开 ${params.url}，标签页 ID: ${tabId}`);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // Tool: js_eyes_close_tab
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "js_eyes_close_tab",
      label: "JS Eyes: Close Tab",
      description: "关闭浏览器中指定 ID 的标签页。",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "要关闭的标签页 ID" },
          target: { type: "string", description: "目标浏览器 clientId 或名称" },
        },
        required: ["tabId"],
      },
      async execute(_toolCallId, params) {
        const b = ensureBot();
        await b.closeTab(params.tabId, { target: params.target });
        return textResult(`已关闭标签页 ${params.tabId}`);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // Tool: js_eyes_get_html
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "js_eyes_get_html",
      label: "JS Eyes: Get HTML",
      description: "获取指定标签页的完整 HTML 内容。",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "标签页 ID" },
          target: { type: "string", description: "目标浏览器 clientId 或名称" },
        },
        required: ["tabId"],
      },
      async execute(_toolCallId, params) {
        const b = ensureBot();
        const html = await b.getTabHtml(params.tabId, { target: params.target });
        return textResult(html);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // Tool: js_eyes_execute_script
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "js_eyes_execute_script",
      label: "JS Eyes: Execute Script",
      description:
        "在指定标签页中执行 JavaScript 代码并返回执行结果。可用于提取页面数据、操作 DOM 等。",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "标签页 ID" },
          code: { type: "string", description: "要执行的 JavaScript 代码" },
          target: { type: "string", description: "目标浏览器 clientId 或名称" },
        },
        required: ["tabId", "code"],
      },
      async execute(_toolCallId, params) {
        const b = ensureBot();
        const result = await b.executeScript(params.tabId, params.code, {
          target: params.target,
        });
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return textResult(text);
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // Tool: js_eyes_get_cookies
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "js_eyes_get_cookies",
      label: "JS Eyes: Get Cookies",
      description: "获取指定标签页对应域名的所有 Cookie。",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "标签页 ID" },
          target: { type: "string", description: "目标浏览器 clientId 或名称" },
        },
        required: ["tabId"],
      },
      async execute(_toolCallId, params) {
        const b = ensureBot();
        const cookies = await b.getCookies(params.tabId, {
          target: params.target,
        });
        if (cookies.length === 0) {
          return textResult("该标签页没有 Cookie。");
        }
        return textResult(JSON.stringify(cookies, null, 2));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // Tool: js_eyes_discover_skills
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "js_eyes_discover_skills",
      label: "JS Eyes: Discover Skills",
      description:
        "查询 JS Eyes 扩展技能注册表，列出可安装的扩展技能（如 X.com 搜索等）。返回每个技能的 ID、名称、描述、版本、提供的 AI 工具列表和安装命令。",
      parameters: {
        type: "object",
        properties: {
          registryUrl: {
            type: "string",
            description:
              "自定义注册表 URL（默认使用 js-eyes.com/skills.json）",
          },
        },
      },
      async execute(_toolCallId, params) {
        const url = params.registryUrl || skillsRegistryUrl;
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const registry = await resp.json();

          if (!registry.skills || registry.skills.length === 0) {
            return textResult("当前没有可用的扩展技能。");
          }

          const lines = [
            `## JS Eyes 扩展技能 (${registry.skills.length} 个)`,
            `Parent: js-eyes v${registry.parentSkill?.version || "?"}`,
            "",
          ];

          for (const s of registry.skills) {
            const installed = nodeFs.existsSync(
              nodePath.join(skillsDir, s.id, "openclaw-plugin"),
            );
            const status = installed ? "✓ 已安装" : "○ 未安装";
            lines.push(`### ${s.emoji || ""} ${s.name} (${s.id}) — ${status}`);
            lines.push(`  ${s.description}`);
            lines.push(`  版本: ${s.version}`);
            if (s.tools && s.tools.length > 0) {
              lines.push(`  AI 工具: ${s.tools.join(", ")}`);
            }
            if (s.requires?.skills?.length > 0) {
              lines.push(`  依赖: ${s.requires.skills.join(", ")}`);
            }
            if (!installed) {
              lines.push(`  安装: 调用 js_eyes_install_skill 工具，参数 skillId="${s.id}"`);
              lines.push(`  或命令行: curl -fsSL https://js-eyes.com/install.sh | bash -s -- ${s.id}`);
            }
            lines.push("");
          }

          return textResult(lines.join("\n"));
        } catch (err) {
          return textResult(`获取技能注册表失败 (${url}): ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // Tool: js_eyes_install_skill
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "js_eyes_install_skill",
      label: "JS Eyes: Install Skill",
      description:
        "下载并安装一个 JS Eyes 扩展技能。自动下载技能包、解压、安装依赖，并将插件路径注册到 OpenClaw 配置中。安装完成后需要重启 OpenClaw 才能使用新工具。",
      parameters: {
        type: "object",
        properties: {
          skillId: {
            type: "string",
            description: "要安装的技能 ID（如 'js-search-x'）",
          },
          force: {
            type: "boolean",
            description: "强制覆盖已有安装（默认 false）",
          },
        },
        required: ["skillId"],
      },
      async execute(_toolCallId, params) {
        const { skillId, force } = params;
        try {
          const resp = await fetch(skillsRegistryUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const registry = await resp.json();

          const skill = registry.skills?.find((s) => s.id === skillId);
          if (!skill) {
            const ids = (registry.skills || []).map((s) => s.id).join(", ");
            return textResult(
              `技能 "${skillId}" 未在注册表中找到。\n可用技能: ${ids || "无"}`,
            );
          }

          const targetDir = nodePath.join(skillsDir, skillId);
          if (nodeFs.existsSync(targetDir) && !force) {
            return textResult(
              `技能 "${skillId}" 已安装在 ${targetDir}。\n如需重新安装，请设置 force=true。`,
            );
          }

          api.logger.info(`[js-eyes] Downloading skill: ${skillId}`);
          const urls = skill.downloadUrlFallback
            ? [skill.downloadUrl, skill.downloadUrlFallback]
            : [skill.downloadUrl];
          let zipBuffer = null;
          for (const url of urls) {
            const zipResp = await fetch(url);
            if (zipResp.ok) {
              zipBuffer = Buffer.from(await zipResp.arrayBuffer());
              break;
            }
            api.logger.warn(`[js-eyes] Download failed (${url}): HTTP ${zipResp.status}`);
          }
          if (!zipBuffer) throw new Error("Download failed for all URLs");

          const tmpDir = nodePath.join(
            nodeOs.tmpdir(),
            `js-eyes-skill-${Date.now()}`,
          );
          nodeFs.mkdirSync(tmpDir, { recursive: true });
          const zipPath = nodePath.join(tmpDir, `${skillId}.zip`);
          nodeFs.writeFileSync(zipPath, zipBuffer);

          if (nodeFs.existsSync(targetDir)) {
            nodeFs.rmSync(targetDir, { recursive: true, force: true });
          }
          nodeFs.mkdirSync(targetDir, { recursive: true });

          api.logger.info(`[js-eyes] Extracting to ${targetDir}`);
          if (process.platform === "win32") {
            execSync(
              `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force"`,
              { windowsHide: true },
            );
          } else {
            execSync(`unzip -qo "${zipPath}" -d "${targetDir}"`);
          }

          const pkgJson = nodePath.join(targetDir, "package.json");
          if (nodeFs.existsSync(pkgJson)) {
            api.logger.info(`[js-eyes] Installing dependencies for ${skillId}`);
            try {
              execSync("npm install --production", {
                cwd: targetDir,
                stdio: "pipe",
                windowsHide: true,
              });
            } catch {
              execSync("npm install", {
                cwd: targetDir,
                stdio: "pipe",
                windowsHide: true,
              });
            }
          }

          nodeFs.rmSync(tmpDir, { recursive: true, force: true });

          const pluginPath = nodePath
            .join(targetDir, "openclaw-plugin")
            .replace(/\\/g, "/");
          let configUpdated = false;

          const ocConfigPath = nodePath.join(
            nodeOs.homedir(),
            ".openclaw",
            "openclaw.json",
          );
          if (nodeFs.existsSync(ocConfigPath)) {
            try {
              const cfg = JSON.parse(
                nodeFs.readFileSync(ocConfigPath, "utf8"),
              );
              if (!cfg.plugins) cfg.plugins = {};
              if (!cfg.plugins.load) cfg.plugins.load = {};
              if (!Array.isArray(cfg.plugins.load.paths))
                cfg.plugins.load.paths = [];
              if (!cfg.plugins.entries) cfg.plugins.entries = {};

              if (!cfg.plugins.load.paths.includes(pluginPath)) {
                cfg.plugins.load.paths.push(pluginPath);
              }
              if (!cfg.plugins.entries[skillId]) {
                cfg.plugins.entries[skillId] = { enabled: true };
              }

              nodeFs.writeFileSync(
                ocConfigPath,
                JSON.stringify(cfg, null, 2) + "\n",
                "utf8",
              );
              configUpdated = true;
            } catch (e) {
              api.logger.warn(
                `[js-eyes] Could not update openclaw.json: ${e.message}`,
              );
            }
          }

          const lines = [
            `✓ 技能 "${skill.name}" (${skillId}) 安装成功！`,
            `  安装路径: ${targetDir}`,
            `  插件路径: ${pluginPath}`,
            `  提供工具: ${(skill.tools || []).join(", ")}`,
            "",
          ];

          if (configUpdated) {
            lines.push("✓ 已自动更新 ~/.openclaw/openclaw.json");
          } else {
            lines.push("⚠ 需要手动添加到 ~/.openclaw/openclaw.json:");
            lines.push(`  plugins.load.paths 添加: "${pluginPath}"`);
            lines.push(
              `  plugins.entries 添加: "${skillId}": { "enabled": true }`,
            );
          }
          lines.push("");
          lines.push("请重启 OpenClaw 以加载新技能。");

          return textResult(lines.join("\n"));
        } catch (err) {
          return textResult(`安装技能 "${skillId}" 失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // CLI: openclaw js-eyes {status|tabs|server}
  // ---------------------------------------------------------------------------

  api.registerCli(
    ({ program }) => {
      const jsEyes = program
        .command("js-eyes")
        .description("JS Eyes — 浏览器自动化工具");

      jsEyes
        .command("status")
        .description("查看 JS-Eyes 服务器连接状态")
        .action(async () => {
          try {
            const url = `http://${serverHost}:${serverPort}/api/browser/status`;
            const resp = await fetch(url);
            const data = await resp.json();
            const d = data.data;
            console.log("\n=== JS-Eyes Server Status ===");
            console.log(`  运行时间: ${d.uptime}s`);
            console.log(`  浏览器扩展: ${d.connections.extensions.length} 个`);
            for (const ext of d.connections.extensions) {
              console.log(`    - ${ext.browserName} (${ext.clientId}), ${ext.tabCount} 个标签页`);
            }
            console.log(`  自动化客户端: ${d.connections.automationClients} 个`);
            console.log(`  标签页总数: ${d.tabs}`);
            console.log(`  待处理请求: ${d.pendingRequests}\n`);
          } catch (err) {
            console.error(`无法连接到服务器 (${serverHost}:${serverPort}): ${err.message}`);
          }
        });

      jsEyes
        .command("tabs")
        .description("列出所有浏览器标签页")
        .action(async () => {
          try {
            const url = `http://${serverHost}:${serverPort}/api/browser/tabs`;
            const resp = await fetch(url);
            const data = await resp.json();
            if (!data.browsers || data.browsers.length === 0) {
              console.log("\n当前没有浏览器扩展连接。\n");
              return;
            }
            console.log("");
            for (const browser of data.browsers) {
              console.log(`=== ${browser.browserName} (${browser.clientId}) ===`);
              for (const tab of browser.tabs) {
                const active = tab.id === data.activeTabId ? " [ACTIVE]" : "";
                console.log(`  [${tab.id}] ${tab.title || "(untitled)"}${active}`);
                console.log(`       ${tab.url}`);
              }
            }
            console.log("");
          } catch (err) {
            console.error(`无法连接到服务器 (${serverHost}:${serverPort}): ${err.message}`);
          }
        });

      const serverCmd = jsEyes
        .command("server")
        .description("管理 JS-Eyes 内置服务器");

      serverCmd
        .command("start")
        .description("启动内置服务器")
        .action(async () => {
          if (server) {
            console.log("服务器已在运行中。");
            return;
          }
          try {
            server = createServer({
              port: serverPort,
              host: serverHost,
              logger: console,
            });
            await server.start();
            console.log(`服务器已启动: ws://${serverHost}:${serverPort}`);
          } catch (err) {
            console.error(`启动失败: ${err.message}`);
            server = null;
          }
        });

      serverCmd
        .command("stop")
        .description("停止内置服务器")
        .action(async () => {
          if (!server) {
            console.log("服务器未在运行。");
            return;
          }
          await server.stop();
          server = null;
          if (bot) {
            try { bot.disconnect(); } catch {}
            bot = null;
          }
          console.log("服务器已停止。");
        });
    },
    { commands: ["js-eyes"] },
  );
}
