/**
 * MyLLMTring 协议适配层（shim）入口
 *
 * 背景：Coopanion 桌宠（Cortico 框架）只会说 OpenAI Responses 协议
 *       （POST <baseUrl>/responses，严格的 SSE 事件序列）；
 *       而本项目的大脑是 Dify智能体（POST /v1/chat-messages）。
 *       本服务把两种协议互相翻译，让桌宠经由 Dify 用上本地部署的 Ollama + Qwen3。
 *
 * 数据流：
 *   桌宠 ──/responses──► shim(本服务) ──/v1/chat-messages──► Dify ──► Ollama(Qwen3:8b)
 *
 * 本文件是**组装层**，不含任何协议逻辑：读配置 → 建 HTTP 服务 → 挂两条路由 → listen。
 * 职责分布见各文件顶部注释；调试时设 DEBUG=1 可打开 input 重诊断。
 *
 * 零第三方依赖：只用 Node 内置模块（http）与全局 fetch，Node >= 18 可直接运行。
 *
 * 用法：
 *   node shim/index.js
 *   然后在 Coopanion 控制台（localhost:17788）把模型供应商的 Base URL 指向
 *   http://127.0.0.1:8787 ，模型名填 qwen3:8b。
 */

const http = require('node:http');

const { HOST, PORT, DIFY_URL, MODEL } = require('./config');
const { createDifyClient } = require('./clients/dify');
const { handleModels } = require('./routes/models');
const { handleResponses } = require('./routes/responses');

// 整个进程一个 Dify 客户端：会话记忆（conversation_id）挂在它的实例上。
const dify = createDifyClient();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 模型清单（Cortico 的 ModelCatalog.list() 会调 GET /models）
  if (req.method === 'GET' && url.pathname === '/models') {
    return handleModels(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/responses') {
    console.log(`[shim] <- POST /responses (${req.headers['content-length'] ?? '?'} bytes)`);
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw.replace(/^\uFEFF/, '') || '{}'); // 容忍 UTF-8 BOM 头
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'bad_json', message: '请求体不是合法 JSON' } }));
      }
      handleResponses(res, body, dify).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'shim_error', message: String(err.message ?? err) } }));
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }));
});

server.listen(PORT, HOST, () => {
  console.log(`[shim] listening on http://${HOST}:${PORT}`);
  console.log(`[shim] /responses -> ${DIFY_URL} (model: ${MODEL})`);
  console.log(`[shim] Coopanion 控制台把模型 Base URL 指向 http://${HOST}:${PORT} 即可`);
});