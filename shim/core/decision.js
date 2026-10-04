/**
 * 「该说话，还是该闭嘴」——纯决策，无 IO，可单测。
 *
 * 这是整个 shim 里唯一需要「看懂 Cortico 行为」的地方，所以把判断从
 * 路由里抽出来，避免协议细节和HTTP/SSE 代码纠缠在一起。
 */

const { lastEventText, lastToolCallName, lastUserText } = require('./input-parser');

/** 宠物是不是刚刚说完话：最后一个 function_call 是 pet_say / pet_ask。 */
function petJustSpoke(input) {
  const name = lastToolCallName(input);
  return name === 'pet_say' || name === 'pet_ask';
}

/**
 * 决定这一轮要不要问 Dify。
 *
 * 返回 { speak, query, lastTool }：
 *   speak=false → 回一个空completion 结束回合（省掉一次模型调用）；
 *   speak=true  → 用 query 去问 Dify。
 *
 * 为什么看「最后一个 function_call 的 name」而不是「最后一项是不是
 * function_call_output」：Cortico 的循环实测长这样
 *   function_call external_event_frame      ← 模型取新事件
 *   function_call_output [1 new event] [打字] les:你好
 *   function_call pet_say                   ← 模型说话
 *   function_call_output 已开始显示,这段约 3 秒。
 * 每个 function_call 后面都跟着它的回执，所以「最后一项是回执」恒真；
 * 紧跟在 external_event_frame 后面的那种回执，恰恰是该说话的那一轮。
 * 只有最后一个工具调用本身是 pet_say / pet_ask，才说明宠物刚说完话。
 */
function decide(input) {
  const lastTool = lastToolCallName(input);
  // 事件正文优先：user message 里只有「[system] N 条新事件。」，
  // 拿不到用户到底说了什么（见 input-parser 文件头第 2 条）。
  const query = lastEventText(input) || lastUserText(input);
  const speak = !petJustSpoke(input) && !!query;
  return { speak, query, lastTool };
}

module.exports = { decide, petJustSpoke };