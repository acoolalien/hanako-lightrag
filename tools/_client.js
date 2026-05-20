/**
 * tools/_client.js — LightRAG HTTP 公共客户端
 * 统一 baseUrl 获取、GET/POST 请求、错误处理，避免 3 个 tool 文件重复样板。
 */

let _port = null;

/**
 * 获取 LightRAG Python server 的 base URL
 * 端口在插件生命周期内不变，首次获取后缓存。
 */
export async function getBaseUrl(ctx) {
  if (_port === null) {
    _port = (await ctx.config.get("lightragPort")) || 9621;
  }
  return `http://127.0.0.1:${_port}`;
}

/**
 * GET 请求到 LightRAG server
 * @param {object} ctx - 插件上下文
 * @param {string} path - 路径，如 "/graph"
 * @param {object} [params] - 查询参数
 * @param {object} [opts] - { timeout }
 */
export async function get(ctx, path, params = {}, { timeout = 10000 } = {}) {
  const base = await getBaseUrl(ctx);
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${base}${path}?${qs}` : `${base}${path}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  return resp.json();
}

/**
 * POST JSON 请求到 LightRAG server
 * @param {object} ctx - 插件上下文
 * @param {string} path - 路径，如 "/query"
 * @param {object} body - 请求体
 * @param {object} [params] - 查询参数
 * @param {object} [opts] - { timeout }
 */
export async function post(ctx, path, body, params = {}, { timeout = 30000 } = {}) {
  const base = await getBaseUrl(ctx);
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${base}${path}?${qs}` : `${base}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  return resp.json();
}

/**
 * DELETE 请求到 LightRAG server
 */
export async function del(ctx, path, params = {}, { timeout = 10000 } = {}) {
  const base = await getBaseUrl(ctx);
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${base}${path}?${qs}` : `${base}${path}`;
  const resp = await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(timeout) });
  return resp.json();
}

/**
 * 统一错误返回格式
 * @param {string} operation - 操作名称（如 "查询"、"索引"）
 * @param {Error} e - 捕获的异常
 */
export function fail(operation, e) {
  return {
    content: [{ type: "text", text: `LightRAG ${operation}出错：${e.message}。请确认 LightRAG 服务正在运行。` }],
  };
}
