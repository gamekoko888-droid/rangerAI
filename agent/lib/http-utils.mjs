// lib/http-utils.mjs — HTTP 响应工具（迁移自 database.mjs，Iter-N v25.19）
//
// sendJson 原本定义在 database.mjs 中，与数据库功能无关。
// 迁移至此文件，成为独立的 HTTP 工具层，避免 import database.mjs 只为使用工具函数。
//
// 此文件不 import 任何业务模块，可被任何层安全引用。

/**
 * 统一 JSON 响应
 * @param {object} res    - Node.js HTTP ServerResponse 对象
 * @param {number} status - HTTP 状态码
 * @param {object} data   - 响应数据（将被 JSON.stringify）
 */
export function sendJson(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * 统一错误响应
 * @param {object} res
 * @param {number} status
 * @param {string} message
 * @param {object} [extra] - 附加字段
 */
export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: true, message, ...extra });
}

/**
 * 统一成功响应（200 OK）
 * @param {object} res
 * @param {object} [data]
 */
export function sendOk(res, data = {}) {
  sendJson(res, 200, { ok: true, ...data });
}
