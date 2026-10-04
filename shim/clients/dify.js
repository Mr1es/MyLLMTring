/**
 * Dify 客户端（唯一一处真正「对外说话」的地方）。
 *
 * 会话记忆 conversation_id 是**实例状态**而不是模块级全局变量：
 * shim 进程只有一个桌宠用户，做成单例实例（index.js 里 createDifyClient()）
 * 既保留了跨请求的记忆，又让测试可以随手造一个干净实例。
 */

const { DIFY_URL, DIFY_KEY, DIFY_USER } = require('../config');

/**
 * 过滤 Qwen3 思考型模型的内心独白泄漏。
 * 人设层（persona.md 的「输出规则」）负责源头禁止，这里是代码层兜底。
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

function createDifyClient() {
  let conversationId = null; // Dify 会话记忆：桌宠是单一用户，记住即可
  return {
    /** 问一句，收回一句已剥离思考段的答案。失败时抛错，由路由决定怎么告诉上游。 */
    async ask(query) {
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
    },
  };
}

module.exports = { createDifyClient, stripThinking };