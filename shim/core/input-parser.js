/**
 * 读取 Responses 请求的 input ——纯函数，无 IO，可直接单测。
 *
 * 三条来之不易的协议知识（都来自实测 Cortico 的 input尾部）：
 *
 * 1) 上游每轮发来的 input 是「全量上下文」，不是增量。历史里的
 *    function_call / function_call_output 会一直堆在数组里。所以任何
 *    「只要含有 X 就……」的判断，从第二轮起就会永久失效——必须看位置
 *    （最后一项）或看最后一个 function_call 的name。
 *
 * 2) 用户输入的真实位置是 external_event_frame 这个 function_call 的
 *    function_call_output 里，形如 `[1 new event] [打字] les:你好`；
 *    而 user message 只有一句干巴巴的「[system] N 条新事件。」。
 *    只拿 user message 去问模型，模型根本不知道用户说了什么。
 *
 * 3) 最后一个 function_call 后面必然跟一个 function_call_output（工具回执），
 *    所以「最后一项是不是 function_call_output」这个判断毫无信息量。
 */

/** 从 input 中取出最后一条 user message 的纯文本（注意它通常不含用户真实输入，见文件头第2 条）。 */
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

/** input 里最后一个工具调用（function_call）的名字，没有则null。 */
function lastToolCallName(input) {
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    if (it && it.type === 'function_call') return it.name ?? null;
  }
  return null;
}

/**
 * 取最新的事件正文：从后往前找第一个 function_call_output，剥掉
 * `[N new event(s)] ` 前缀，只留后面真正的事件描述。
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

module.exports = { lastUserText, lastToolCallName, lastEventText };