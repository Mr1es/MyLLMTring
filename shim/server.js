/**
 * 兼容入口（已废弃，请改用 shim/index.js）
 *
 * 保留这个文件只为兼容「习惯性敲 node shim\server.js」和可能存在的旧脚本/文档链接；
 * start-pet.bat 已改用正式入口 shim\index.js。全部实现已拆分到
 * index.js / config.js / routes / core / protocol / clients / diagnostics。
 */
require('./index');