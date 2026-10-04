/**
 * shim 的全部配置集中在此，其他模块一律从这里取，不再各自读 process.env。
 *
 * 单独成文件是为了让「换 Dify 地址 / 换模型 / 换端口」只改一处，
 * 也让 core/ 与 protocol/ 里的纯函数不会偷偷依赖环境变量（保持可单测）。
 *
 * 所有项都支持环境变量覆盖，便于在不改代码的情况下切VM / 切模型。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 极简 .env 读取（零依赖，只用 node:fs）。
 *
 * 为什么需要：Dify 的应用 API Key 不能提交进仓库，但 Windows 上配系统环境变量
 * 要用 setx、且必须重开终端才生效——对「双击 bat 启动桌宠」这种场景太不友好。
 * 于是约定：真 key 放 shim/.env（已被 .gitignore 忽略），不再依赖 setx。
 *
 * 只认 KEY=VALUE，# 开头是注释；已存在的系统环境变量优先，不被文件覆盖。
 */
function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    const raw = m[2];
    const value = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const HOST = '127.0.0.1'; // 只监听回环：这是本机桌宠的适配层，不对外网暴露
const PORT = Number(process.env.SHIM_PORT || 8787);

// VM 里的 Dify。默认地址写死在这，用 DIFY_URL 覆盖即可切环境。
const DIFY_URL = process.env.DIFY_URL || 'http://192.168.126.128/v1/chat-messages';

// Dify 应用的 API Key：优先系统环境变量，其次 shim/.env，最后兜底占位符。
// 兜底值不是真 key——Dify 会返回 401，start-pet.bat 会在启动前检查并拦下来。
const DIFY_KEY = process.env.DIFY_KEY || 'app-YOUR-KEY-HERE';

// Dify 侧的用户标识。桌宠是单一用户，固定值即可（Dify 用它做会话隔离）。
const DIFY_USER = process.env.DIFY_USER || 'coopanion-pet';

// 对外声称的模型名。Cortico 控制台里填的模型名必须与之一致。
const MODEL = process.env.MODEL || 'qwen3:8b';

module.exports = { HOST, PORT, DIFY_URL, DIFY_KEY, DIFY_USER, MODEL };