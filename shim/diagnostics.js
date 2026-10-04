/**
 * 日志与调试落盘。
 *
 * 默认只输出关键三行（收到请求 / 决策结果 / Dify 答案与 script），
 * 因为桌宠是长驻进程，刷屏会把 start-pet.bat 的 run.log 撑爆、也淹掉真正的报错。
 *
 * 设DEBUG=1 时才做重诊断：打印 input 尾部 10 项的结构，并把完整 input
 * 落盘到 shim/last-input.json。这是排查「这一轮到底该不该说话」的唯一手段——
 * 必须看清「用户说的话」和「工具回执」谁排在最后。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEBUG = process.env.DEBUG === '1';
const LAST_INPUT = path.join(__dirname, 'last-input.json');

/** 关键行1：这一轮请求的概览。 */
function logRequest({ model, stream, input, lastUser }) {
  const count = Array.isArray(input) ? input.length : 'string';
  console.log(`[shim] <- /responses model=${model} stream=${!!stream} inputItems=${count} lastUser="${String(lastUser).slice(0, 40)}"`);
}

/** 关键行 2：决策结果。闭嘴时说清为什么闭嘴（lastTool 是谁），说话时只报 query。 */
function logDecision({ speak, lastTool, query }) {
  if (speak) console.log(`[shim] -> decide: speak, query="${String(query).slice(0, 50)}"`);
  else console.log(`[shim] <- no reply needed (lastTool=${lastTool}), replying empty completion`);
}

/** 关键行 3：Dify 的答案与最终返回给宠物世界的 script。 */
function logAnswer({ query, answer }) {
  console.log(`[shim] -> Dify query="${String(query).slice(0, 50)}" answer ${answer.length} chars: "${answer.slice(0, 40)}..."`);
}

/** 重诊断 1：input 尾部 10 项的结构摘要（仅 DEBUG=1）。 */
function logInputTail(input) {
  if (!DEBUG || !Array.isArray(input)) return;
  const tail = input.slice(-10);
  const start = input.length - tail.length;
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

/** 重诊断 2：完整 input 落盘（仅 DEBUG=1；写失败不能影响主流程，静默忽略）。 */
function dumpInput(input) {
  if (!DEBUG) return;
  try {
    fs.writeFileSync(LAST_INPUT, JSON.stringify(Array.isArray(input) ? input : [], null, 1));
  } catch { /* 落盘失败无所谓，诊断手段而已 */ }
}

/** 一次请求的完整重诊断入口。 */
function debugInput(input) {
  if (!DEBUG) return;
  logInputTail(input);
  dumpInput(input);
}

module.exports = { DEBUG, logRequest, logDecision, logAnswer, debugInput };