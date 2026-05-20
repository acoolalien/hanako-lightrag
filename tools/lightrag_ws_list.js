/**
 * tools/lightrag_ws_list.js — 列出所有知识库
 */
import { get, fail } from "./_client.js";

export const name = "lightrag_ws_list";
export const description =
  "列出所有 LightRAG 知识库（workspace）。返回名称、是否有数据、显示名。" +
  "USE WHEN: 需要了解有哪些知识库可用、确认索引状态。";

export const parameters = {
  type: "object",
  properties: {},
  required: [],
};

export async function execute(input, ctx) {
  try {
    const data = await get(ctx, "/workspaces", {}, { timeout: 5000 });
    if (data.error) return { content: [{ type: "text", text: `获取知识库列表失败：${data.error}` }] };

    const workspaces = (await ctx.config.get("workspaces")) || {};
    const lines = [`**知识库列表**（工作目录: ${data.working_dir}）`, ""];

    for (const ws of data.workspaces || []) {
      const display = workspaces[ws.name] || ws.name;
      const status = ws.has_data ? "✅ 有数据" : "📭 空";
      lines.push(`- **${display}** \`${ws.name}\` ${status}`);
    }

    if (!data.workspaces?.length) {
      lines.push("（暂无知识库）");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e) {
    return fail("列表获取", e);
  }
}
