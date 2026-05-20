/**
 * tools/lightrag_entity_delete.js — 删除知识库中的实体
 */
import { del, fail } from "./_client.js";

export const name = "lightrag_entity_delete";
export const description =
  "删除知识库中的指定实体及其关联关系（不可恢复）。" +
  "USE WHEN: LightRAG 提取了错误或重复的实体，需要清理。";

export const parameters = {
  type: "object",
  properties: {
    entity_name: { type: "string", description: "要删除的实体名称。" },
    workspace: { type: "string", default: "default", description: "目标知识库名称。" },
  },
  required: ["entity_name"],
};

export async function execute(input, ctx) {
  const ws = input.workspace || "default";
  const name = (input.entity_name || "").trim();
  if (!name) return { content: [{ type: "text", text: "实体名称不能为空。" }] };

  try {
    const data = await del(ctx, `/entities/${encodeURIComponent(name)}`, { workspace: ws }, { timeout: 10000 });
    if (data.error) return { content: [{ type: "text", text: `删除失败：${data.error}` }] };
    return { content: [{ type: "text", text: `实体 "${name}" 已从 "${ws}" 中删除。` }] };
  } catch (e) {
    return fail("删除实体", e);
  }
}
