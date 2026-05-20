/**
 * tools/lightrag_entity_merge.js — 合并知识库中的两个实体
 */
import { post, fail } from "./_client.js";

export const name = "lightrag_entity_merge";
export const description =
  "合并知识库中的两个实体，source 实体的关系会迁移到 target 实体。" +
  "USE WHEN: LightRAG 提取了指向同一概念的不同实体名（如 "孙悟空" 和 "齐天大圣"），需要合并。";

export const parameters = {
  type: "object",
  properties: {
    source: { type: "string", description: "源实体名（合并后会被删除）。" },
    target: { type: "string", description: "目标实体名（保留）。" },
    workspace: { type: "string", default: "default", description: "目标知识库名称。" },
  },
  required: ["source", "target"],
};

export async function execute(input, ctx) {
  const ws = input.workspace || "default";
  const src = (input.source || "").trim();
  const tgt = (input.target || "").trim();
  if (!src || !tgt) return { content: [{ type: "text", text: "source 和 target 均不能为空。" }] };
  if (src === tgt) return { content: [{ type: "text", text: "source 和 target 不能相同。" }] };

  try {
    const data = await post(ctx, "/entities/merge", { source: src, target: tgt }, { workspace: ws }, { timeout: 15000 });
    if (data.error) return { content: [{ type: "text", text: `合并失败：${data.error}` }] };
    return { content: [{ type: "text", text: `已将 "${src}" 合并到 "${tgt}"（${ws}）。` }] };
  } catch (e) {
    return fail("合并实体", e);
  }
}
