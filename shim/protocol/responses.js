/**
 * Responses 协议的数据构造（纯函数，无 IO）。
 *
 * 只负责「造出符合 OpenAI Responses 协议的对象」；事件顺序与 SSE 封装
 * 在 protocol/sse.js。之所以分开：数据形状是协议契约的一部分，要能被
 * 单独审阅；SSE 序列化是传输细节，会随上游框架的解析器变动。
 */

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

/**
 * 合成 pet_say 工具调用（function_call）。
 * 桌宠世界只通过 pet_say / pet_ask 工具「说话」——模型直接回文本宠物是看不见的，
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

/** 非流式分支的最终 response（output 里直接带完整 arguments）。 */
function finalResponse(id, model, script, itemId, callId) {
  return {
    ...baseResponse(id, model),
    status: 'completed',
    completed_at: Math.floor(Date.now() / 1000),
    output: [petSayCall(itemId, callId, script, 'completed')],
  };
}

module.exports = { baseResponse, petSayCall, petSayItemAdded, finalResponse };