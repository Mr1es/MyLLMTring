/**
 * POST /responses —— 本shim 的核心路由。
 *
 * 只做编排：解析请求 → 决策（说话还是闭嘴）→ 调 Dify → 合成 SSE/JSON → 写响应。
 * 具体的「协议长什么样」在 protocol/，「该不该说话」在 core/，
 * 这里不包含任何协议知识，只描述流程顺序。
 */

const { MODEL } = require('../config');
const { decide } = require('../core/decision');
const { lastUserText } = require('../core/input-parser');
const { finalResponse } = require('../protocol/responses');
const {
  functionCallSse, emptySse, failedSse, writeSse,
  STREAM_HEADERS, STREAM_HEADERS_NO_CACHE,
} = require('../protocol/sse');
const { logRequest, logDecision, logAnswer, debugInput } = require('../diagnostics');

/**
 * @param res       Node 原生 ServerResponse
 * @param body      已解析的请求体
 * @param dify      clients/dify.js 造出的客户端（持有会话记忆）
 */
async function handleResponses(res, body, dify) {
  const stamp = Date.now().toString(36);
  const id = `resp_${stamp}`;
  const itemId = `msg_${stamp}`;
  const callId = `call_${stamp}`;
  const model = body.model ?? MODEL;

  logRequest({ model, stream: body.stream, input: body.input, lastUser: lastUserText(body.input) });
  debugInput(body.input); // DEBUG=1 时才真正做事：尾部摘要 + last-input.json 落盘

  // 先决策再调 Dify：宠物刚说完话、或这一轮没有可回应的内容时，
  // 直接回空结束回合，省掉一次模型调用也避免它自言自语。
  const { speak, query, lastTool } = decide(body.input);
  logDecision({ speak, lastTool, query });

  if (!speak) {
    const events = emptySse(id, model);
    if (body.stream) return writeSse(res, 200, STREAM_HEADERS, events);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(events[1].response));
  }

  let answer;
  try {
    answer = await dify.ask(query);
    logAnswer({ query, answer });
  } catch (err) {
    const message = String(err.message ?? err);
    if (body.stream) return writeSse(res, 502, STREAM_HEADERS_NO_CACHE, failedSse(id, model, message));
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'dify_error', message } }));
  }

  if (body.stream) {
    // 不传 model：成功分支的流式 response 一直用固定的 MODEL，
    // 与重构前保持一致（Cortico 只校验 id/model/output/status 的存在性）。
    return writeSse(res, 200, STREAM_HEADERS, functionCallSse(id, itemId, callId, answer));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(finalResponse(id, model, answer, itemId, callId)));
}

module.exports = { handleResponses };