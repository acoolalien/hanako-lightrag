/**
 * tools/lightrag_ws_delete.js — 删除知识库（不可恢复）
 */
import { del, fail } from "./_client.js";

export const name = "lightrag_ws_delete";
export const description =
  "删除 LightRAG 知识库及其所有索引数据（不可恢复）。" +
  "删除前会请求确认。" +
  "USE WHEN: 不再需要某个知识库，或需要清理测试数据。";

export const parameters = {
  type: "object",
  properties: {
    name: { type: "string", description: "要删除的知识库名称（workspace key）。" },
    confirm: { type: "boolean", description: "确认删除。必须为 true 才会执行。" },
  },
  required: ["name", "confirm"],
};

export async function execute(input, ctx) {
  const name = input.name.trim();
  if (!name) return { content: [{ type: "text", text: "知识库名不能为空。" }] };
  if (name === "default") return { content: [{ type: "text", text: "不能删除 default 知识库（系统保留）。" }] };
  if (!input.confirm) {
    return {
      content: [{
        type: "text",
        text: `即将删除知识库 "${name}" 及其所有索引数据（不可恢复）。确认请传 confirm: true。`,
      }],
    };
  }

  try {
    const data = await del(ctx, `/workspaces/${encodeURIComponent(name)}`, {}, { timeout: 10000 });

    if (data.error) return { content: [{ type: "text", text: `删除失败：${data.error}` }] };

    // 从 config 中移除
    const workspaces = (await ctx.config.get("workspaces")) || {};
    delete workspaces[data.deleted];
    await ctx.config.set("workspaces", workspaces);

    return {
      content: [{ type: "text", text: `知识库 "${name}" 已删除（数据不可恢复）。` }],
    };
  } catch (e) {
    return fail("删除", e);
  }
}
