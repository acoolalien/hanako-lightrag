/**
 * tools/lightrag_doc_delete.js — 删除知识库中的单篇文档（不可恢复）
 */
import { del, fail } from "./_client.js";

export const name = "lightrag_doc_delete";
export const description =
  "删除知识库中的单篇文档及其索引数据（不可恢复）。" +
  "删除前会请求确认。" +
  "USE WHEN: 文档内容过时需要移除、索引了错误文件需要清理、或需要精简知识库。";

export const parameters = {
  type: "object",
  properties: {
    doc_id: { type: "string", description: "要删除的文档 ID（可通过 lightrag_status 查看文档列表获取）。" },
    workspace: { type: "string", default: "default", description: "目标知识库名称。" },
    confirm: { type: "boolean", description: "确认删除。必须为 true 才会执行。" },
  },
  required: ["doc_id", "confirm"],
};

export async function execute(input, ctx) {
  const ws = input.workspace || "default";
  const docId = (input.doc_id || "").trim();

  if (!docId) return { content: [{ type: "text", text: "文档 ID 不能为空。请先用 lightrag_status 查看文档列表获取 ID。" }] };
  if (!input.confirm) {
    return {
      content: [{
        type: "text",
        text: `即将从 "${ws}" 中删除文档 ${docId}（不可恢复）。确认请传 confirm: true。`,
      }],
    };
  }

  try {
    const data = await del(ctx, `/documents/${encodeURIComponent(docId)}`, { workspace: ws }, { timeout: 15000 });

    if (data.error) return { content: [{ type: "text", text: `删除失败：${data.error}` }] };

    return {
      content: [{ type: "text", text: `文档 ${docId} 已从 "${ws}" 中删除。` }],
    };
  } catch (e) {
    return fail("删除文档", e);
  }
}
