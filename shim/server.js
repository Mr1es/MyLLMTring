/**
 * MyLLMTring 协议适配层（shim）
 *
 * 背景：Coopanion 桌宠（Cortico 框架）只会说 OpenAI Responses 协议
 *       （POST <baseUrl>/responses，严格的 SSE 事件序列）；
 *       而本项目的大脑是 Dify 智能体（POST /v1/chat-messages）。
 *       本服务把两种协议互相翻译，让桌宠经由 Dify 用上本地部署的 Ollama + Qwen3。
 *
 * 数据流：
 *   桌宠 ──/responses──► shim(本服务) ──/v1/chat-messages──► Dify ──► Ollama(Qwen3:8b)
 *
 * 零第三方依赖：只用 Node 内置模块（http / fetch），Node >= 18 可直接运行。
 *
 * 用法：
 *   node shim/server.js
 *   然后在 Coopanion 控制台（localhost:17788）把模型供应商的 Base URL 指向
 *   http://127.0.0.1:8787 ，模型名填 qwen3:8b。
 */

const http = require('node:http');

const PORT = 8787;
const DIFY_URL = 'http://192.168.126.128/v1/chat-messages'; // VM 里的 Dify
const DIFY_KEY = 'app-cSiKz4lKqg9gHoxkyzHcbz1W';            // Dify 应用的 API Key
const DIFY_USER = 'coopanion-pet';
const MODEL = 'qwen3:8b';

/** Dify 会话记忆：桌宠是单一用户，用模块级变量记住 conversation_id 即可。 */
let conversationId = null;

/**
 * 过滤 Qwen3 思考型模型的内心独白泄漏。
 * 人设层（persona.md 的"输出规则"）负责源头禁止，这里是代码层兜底。
 */
function stripThinking(text) {
  if (typeof text !== 'string') return '';
  if (text.includes('<think>')) {
    const parts = text.split('</think>');
    if (parts.length > 1) return parts[parts.length - 1].trim();
    return text.replace(/<think>.*/s, '').trim();
  }
  return text.trim();
}

async function askDify(query) {
  const body = { inputs: {}, query, response_mode: 'blocking', user: DIFY_USER };
  if (conversationId) body.conversation_id = conversationId;
  const res = await fetch(DIFY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DIFY_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Dify HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (data.conversation_id) conversationId = data.conversation_id;
  return stripThinking(data.answer ?? '');
}

/** 从 Responses 请求的 input 中取出最后一条用户消息的纯文本。 */
function lastUserText(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    if (it && it.type === 'message' && it.role === 'user') {
      if (typeof it.content === 'string') return it.content;
      if (Array.isArray(it.content)) return it.content.map((p) => p.text ?? '').join('');
    }
  }
  return '';
}

/** ResponseResource 的最小必需字段集（Cortico 的 parseResponse 只校验 id/model/output/status）。 */
function baseResponse(id, model) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id, object: 'response', created_at: now, completed_at: null,
    status: 'in_progress', incomplete_details: null, model,
    previous_response_id: null, instructions: null, output: [], error: null,
    tools: [], tool_choice: 'auto', truncation: 'disabled', parallel_tool_calls: false,
    text: { format: { type: 'text' } }, top_p: 1, presence_penalty: 0, frequency_penalty: 0,
    top_logprobs: 0, temperature: 1, reasoning: null, usage: null,
    max_output_tokens: null, max_tool_calls: null, store: false, background: false,
    service_tier: 'auto', metadata: {}, safety_identifier: null, prompt_cache_key: null,
  };
}

function messageItem(id, text, status) {
  return {
    id, type: 'message', status, role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

/**
 * 合成 pet_say 工具调用（function_call）。
 * 桌宠世界只通过 pet_say/pet_ask 工具"说话"——模型回文本宠物是看不见的，
 * 所以适配层把 Dify 的文本答案包成 function_call，由 Core 派发给宠物世界执行。
 */
function petSayCall(id, callId, script, status) {
  return {
    id, type: 'function_call', call_id: callId, name: 'pet_say',
    arguments: JSON.stringify({ script }), status,
  };
}

/**
 * output_item.added 用的 item：arguments 必须是真正的空字符串。
 *
 * 踩过的坑：这里如果复用 petSayCall(..., '', ...) 发出的是 '{"script":""}'，
 * Cortico 会把它当作已有参数，再把 delta 累加上去变成
 * '{"script":""}{"script":"你好"}'，与 done 里的干净 arguments 不相等，
 * 校验器直接抛 'Final function arguments disagree with deltas'，
 * 整条流被判为 aborted，工具永远不执行（表现为「没有气泡」）。
 */
function petSayItemAdded(id, callId) {
  return {
    id, type: 'function_call', call_id: callId, name: 'pet_say',
    arguments: '', status: 'in_progress',
  };
}

function functionCallSse(id, itemId, callId, script) {
  const args = JSON.stringify({ script });
  const final = {
    ...baseResponse(id, MODEL),
    status: 'completed',
    completed_at: Math.floor(Date.now() / 1000),
    usage: {
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    output: [petSayCall(itemId, callId, script, 'completed')],
  };
  return [
    { type: 'response.created', sequence_number: 0, response: { ...baseResponse(id, MODEL), status: 'in_progress' } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: petSayItemAdded(itemId, callId) },
    { type: 'response.function_call_arguments.delta', sequence_number: 2, item_id: itemId, output_index: 0, delta: args },
    { type: 'response.function_call_arguments.done', sequence_number: 3, item_id: itemId, output_index: 0, arguments: args },
    { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: petSayCall(itemId, callId, script, 'completed') },
    { type: 'response.completed', sequence_number: 5, response: final },
  ];
}

/**
 * input 里最后一个工具调用的名字。
 *
 * Cortico 的循环实际长这样（实测 input 尾部）：
 *   function_call external_event_frame      ← 模型取新事件
 *   function_call_output [1 new event] [打字] les:你好
 *   function_call pet_say                   ← 模型说话
 *   function_call_output 已开始显示,这段约 3 秒。
 *
 * 所以不能只看「最后一项是不是 function_call_output」来决定回不回空：
 * 紧跟在 external_event_frame 后面的那种，恰恰是该说话的那一轮。
 * 只有最后一个工具调用本身是 pet_say / pet_ask 时，才说明宠物刚说完。
 */
function lastToolCallName(input) {
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    if (it && it.type === 'function_call') return it.name ?? null;
  }
  return null;
}

/**
 * 取最新的事件正文。
 *
 * 用户打的字不在 user message 里——user message 只有一句「[system] N 条新事件。」，
 * 真正的「[打字] les:你好」躺在 external_event_frame 的 function_call_output 里。
 * 只拿 user message 去问模型，模型根本不知道用户说了什么。
 */
function lastEventText(input) {
  if (!Array.isArray(input)) return '';
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    if (it && it.type === 'function_call_output') {
      const out = String(it.output ?? '');
      const m = out.match(/^\[\d+ new events?\]\s*/);
      if (m) return out.slice(m[0].length).trim();
    }
  }
  return '';
}

/** 宠物是不是刚刚说完话（最后一个工具调用是说话类）。 */
function petJustSpoke(input) {
  const name = lastToolCallName(input);
  return name === 'pet_say' || name === 'pet_ask';
}

async function handleResponses(res, body) {
  const id = `resp_${Date.now().toString(36)}`;
  const itemId = `msg_${Date.now().toString(36)}`;
  const callId = `call_${Date.now().toString(36)}`;
  const model = body.model ?? MODEL;
  const lastUser = lastUserText(body.input);
  console.log(`[shim] <- /responses model=${model} stream=${!!body.stream} inputItems=${Array.isArray(body.input) ? body.input.length : 'string'} lastUser="${lastUser.slice(0, 40)}"`);

  // 诊断用：把这一轮 input 存盘，并打印尾部 10 项的结构
  // （看清「用户说的话」和「工具回执」谁排在最后，才能判对这一轮该不该说话）
  try {
    require('node:fs').writeFileSync(
      require('node:path').join(__dirname, 'last-input.json'),
      JSON.stringify(Array.isArray(body.input) ? body.input : [], null, 1),
    );
  } catch {}
  if (Array.isArray(body.input)) {
    const tail = body.input.slice(-10);
    const start = body.input.length - tail.length;
    tail.forEach((it, i) => {
      let brief = it && it.type ? String(it.type) : '?';
      if (it && it.type === 'message') {
        const txt = typeof it.content === 'string' ? it.content : (it.content || []).map((p) => p && p.text).join('');
        brief += `(${it.role}) ${String(txt).slice(0, 60)}`;
      } else if (it && it.type === 'function_call') brief += ` ${it.name}`;
      else if (it && it.type === 'function_call_output') brief += ` ${String(it.output).slice(0, 60)}`;
      console.log(`[shim]   input[${start + i}] ${brief.replace(/\n/g, ' ')}`);
    });
  }

  // 宠物刚说完话（最后一个工具调用是 pet_say/pet_ask），或这一轮没有可回应的内容
  // ——回空结束回合，别让它自言自语。必须放在问 Dify 之前，省一次模型调用。
  const query = lastEventText(body.input) || lastUser;
  if (petJustSpoke(body.input) || !query) {
    console.log(`[shim] <- no reply needed (lastTool=${lastToolCallName(body.input)}), replying empty completion`);
    const empty = { ...baseResponse(id, model), status: 'completed', completed_at: Math.floor(Date.now() / 1000) };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: { ...empty, status: 'in_progress' } })}\n\n`);
      res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 1, response: empty })}\n\n`);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(empty));
  }

  let answer;
  try {
    answer = await askDify(query);
    console.log(`[shim] -> Dify query="${query.slice(0, 50)}" answer ${answer.length} chars: "${answer.slice(0, 40)}..."`);
  } catch (err) {
    const message = String(err.message ?? err);
    if (body.stream) {
      const failed = { ...baseResponse(id, model), status: 'failed', completed_at: Math.floor(Date.now() / 1000), error: { code: 'dify_error', message } };
      const events = [
        { type: 'response.created', sequence_number: 0, response: { ...failed, status: 'in_progress', error: null } },
        { type: 'response.failed', sequence_number: 1, response: failed },
      ];
      res.writeHead(502, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      return res.end();
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'dify_error', message } }));
  }

  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    for (const e of functionCallSse(id, itemId, callId, answer)) {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    }
    return res.end();
  }

  const final = {
    ...baseResponse(id, model),
    status: 'completed',
    completed_at: Math.floor(Date.now() / 1000),
    output: [petSayCall(itemId, callId, answer, 'completed')],
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(final));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 模型清单（Cortico 的 ModelCatalog.list() 会调 GET /models）
  if (req.method === 'GET' && url.pathname === '/models') {
    console.log('[shim] <- GET /models');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: [{ id: MODEL, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'dify-shim' }],
    }));
  }

  if (req.method === 'POST' && url.pathname === '/responses') {
    console.log(`[shim] <- POST /responses (${req.headers['content-length'] ?? '?'} bytes)`);
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw.replace(/^\uFEFF/, '') || '{}'); // 容忍 BOM 头
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'bad_json', message: '请求体不是合法 JSON' } }));
      }
      handleResponses(res, body).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'shim_error', message: String(err.message ?? err) } }));
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[shim] listening on http://127.0.0.1:${PORT}`);
  console.log(`[shim] /responses -> ${DIFY_URL} (model: ${MODEL})`);
  console.log('[shim] Coopanion 控制台把模型 Base URL 指向 http://127.0.0.1:8787 即可');
});
