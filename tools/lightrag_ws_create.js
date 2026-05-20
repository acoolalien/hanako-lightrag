/**
 * tools/lightrag_ws_create.js — 创建知识库
 */
import { post, fail } from "./_client.js";

export const name = "lightrag_ws_create";
export const description =
  "创建新的 LightRAG 知识库（workspace）。创建后会自动初始化存储，" +
  "可通过 lightrag_insert 索引文档。" +
  "USE WHEN: 需要为新的项目或文档集创建独立的知识库。";

export const parameters = {
  type: "object",
  properties: {
    name: { type: "string", description: "知识库名称（英文/中文均可）。用作 API 中的 workspace 参数。" },
    displayName: { type: "string", description: "显示名称（可选）。会出现在图谱页面的下拉菜单中。不填则用 name。" },
  },
  required: ["name"],
};

export async function execute(input, ctx) {
  const name = input.name.trim();
  if (!name) return { content: [{ type: "text", text: "知识库名不能为空。" }] };
  if (name === "default") return { content: [{ type: "text", text: "不能创建名为 default 的知识库（系统保留）。" }] };

  try {
    const data = await post(ctx, `/workspaces/${name}`, {}, {}, { timeout: 30000 });

    if (data.error) return { content: [{ type: "text", text: `创建失败：${data.error}` }] };

    // 更新 config.json 中的 workspaces 映射
    const workspaces = (await ctx.config.get("workspaces")) || {};
    workspaces[data.created] = input.displayName || name;
    await ctx.config.set("workspaces", workspaces);

    return {
      content: [{
        type: "text",
        text: `知识库 "${input.displayName || name}" 创建成功。\n` +
          `- workspace key: \`${data.created}\`\n` +
          `- 存储路径: ${data.path}\n\n` +
          `使用 lightrag_insert 索引文档，使用 lightrag_query 查询。`,
      }],
    };
  } catch (e) {
    return fail("创建", e);
  }
}
