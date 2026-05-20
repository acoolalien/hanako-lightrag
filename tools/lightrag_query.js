/**
 * tools/lightrag_query.js — LightRAG 查询（local/global/hybrid/mix/naive/bypass）
 */
import { post, fail } from "./_client.js";

export const name = "lightrag_query";
export const description =
  "查询 LightRAG 知识库。支持多种检索模式：local（实体聚焦）、" +
  "global（关系推理）、hybrid（混合）、mix（默认，图谱+向量）、" +
  "naive（纯向量）、bypass（直调 LLM）。" +
  "设置 only_need_context=true 只返回检索到的上下文而不经 LLM 生成。" +
  "USE WHEN: 需要从索引文档中查找信息、验证设定一致性、追踪跨文档关系。";

export const parameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "查询文本，用自然语言描述你想查什么。" },
    mode: {
      type: "string",
      enum: ["local", "global", "hybrid", "mix", "naive", "bypass"],
      description: "检索模式。不传则用插件配置的默认模式。"
    },
    topK: { type: "number", default: 5, description: "返回条数，默认 5，最大 50。" },
    onlyNeedContext: { type: "boolean", default: false, description: "只返回检索到的上下文，不经 LLM 生成回答。" },
    workspace: { type: "string", default: "default", description: "知识库名称，逗号分隔可跨库查询。可用 lightrag_ws_list 查看所有知识库。" },
  },
  required: ["query"],
};

export async function execute(input, ctx) {
  const ws = input.workspace || "default";
  const isCross = ws.includes(",");
  const endpoint = input.onlyNeedContext ? "/query/context" : "/query";
  const topK = Math.min(Math.max(input.topK || 5, 1), 50);
  const mode = input.mode || (await ctx.config.get("defaultQueryMode")) || "mix";
  const body = {
    query: input.query,
    mode: mode,
    top_k: topK,
    only_need_context: input.onlyNeedContext || false,
  };

  try {
    let data;
    if (isCross) {
      data = await post(ctx, "/query/cross", body, { workspaces: ws }, { timeout: 180000 });
      if (data.error) return { content: [{ type: "text", text: `跨库查询失败：${data.error}` }] };
      // 合并跨库结果
      const parts = [];
      for (const r of data.results || []) {
        if (r.error) { parts.push(`### ${r.workspace}\n❌ ${r.error}`); continue; }
        const text = typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
        parts.push(`### ${r.workspace}\n${text}`);
      }
      return { content: [{ type: "text", text: parts.join("\n\n").slice(0, 12000) }] };
    } else {
      data = await post(ctx, endpoint, body, { workspace: ws }, { timeout: 120000 });
      if (data.error) return { content: [{ type: "text", text: `查询失败：${data.error}` }] };
      const text = typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2);
      return { content: [{ type: "text", text: text.slice(0, 8000) }] };
    }
  } catch (e) {
    return fail("查询", e);
  }
}
