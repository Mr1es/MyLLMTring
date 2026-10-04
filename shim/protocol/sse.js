/**
 * SSE 事件序列合成 + 写回响应。
 *
 * Cortico 的流式解析器是**按顺序、逐事件校验**的：事件类型、sequence_number
 * 必须连续，function_call 的 arguments 由 delta 累加而来并与 done 比对。
 * 所以这里的数组顺序和字段名都是协议的一部分，不要随手调整。
 */

const { MODEL } = require('../config');
const { baseResponse, petSayCall, petSayItemAdded } = require('./responses');

/** 成功说话：六事件序列（含 arguments 的 delta/done 配对）。 */
function functionCallSse(id, itemId, callId, script, model) {
  // 注意这里用的是固定 MODEL 而不是请求里的 model：与重构前的行为保持一致，
  // Cortico 侧只校验 id/model/output/status 的存在性，不参与业务判断。
  const m = model || MODEL;
  const args = JSON.stringify({ script });
  const final = {
    ...baseResponse(id, m),
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
    { type: 'response.created', sequence_number: 0, response: { ...baseResponse(id, m), status: 'in_progress' } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: petSayItemAdded(itemId, callId) },
    { type: 'response.function_call_arguments.delta', sequence_number: 2, item_id: itemId, output_index: 0, delta: args },
    { type: 'response.function_call_arguments.done', sequence_number: 3, item_id: itemId, output_index: 0, arguments: args },
    { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: petSayCall(itemId, callId, script, 'completed') },
    { type: 'response.completed', sequence_number: 5, response: final },
  ];
}

/** 无需说话：created + completed 两个事件，output 为空，结束回合。 */
function emptySse(id, model) {
  const empty = { ...baseResponse(id, model), status: 'completed', completed_at: Math.floor(Date.now() / 1000) };
  return [
    // created 事件必须用 baseResponse：它的 completed_at 是 null。
    // 若展开上面那个 completed 对象，完成时间会泄漏进 created 事件，不合规范。
    { type: 'response.created', sequence_number: 0, response: { ...baseResponse(id, model), status: 'in_progress' } },
    { type: 'response.completed', sequence_number: 1, response: empty },
  ];
}

/** Dify 挂了就立刻失败，别让桌宠等一个永远不会来的气泡。 */
function failedSse(id, model, message) {
  const failed = {
    ...baseResponse(id, model), status: 'failed',
    completed_at: Math.floor(Date.now() / 1000), error: { code: 'dify_error', message },
  };
  return [
    // 同 emptySse：created 必须用 baseResponse，completed_at 要是 null。
    { type: 'response.created', sequence_number: 0, response: { ...baseResponse(id, model), status: 'in_progress' } },
    { type: 'response.failed', sequence_number: 1, response: failed },
  ];
}

/** 把事件数组按SSE 线格式写回res。 */
function writeSse(res, status, headers, events) {
  res.writeHead(status, headers);
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

const STREAM_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' };
const STREAM_HEADERS_NO_CACHE = { 'Content-Type': 'text/event-stream; charset=utf-8' };

module.exports = {
  functionCallSse, emptySse, failedSse, writeSse,
  STREAM_HEADERS, STREAM_HEADERS_NO_CACHE,
};