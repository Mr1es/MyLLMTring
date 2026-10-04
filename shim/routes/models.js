/**
 * GET /models —— Cortico 的 ModelCatalog.list() 会先调它来确认可用模型。
 *
 * 独立成文件是因为它与对话链路无关：只回一个静态清单，不碰 Dify。
 */

const { MODEL } = require('../config');

function handleModels(req, res) {
  console.log('[shim] <- GET /models');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    object: 'list',
    data: [{ id: MODEL, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'dify-shim' }],
  }));
}

module.exports = { handleModels };