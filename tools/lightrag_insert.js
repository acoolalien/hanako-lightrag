/**
 * tools/lightrag_insert.js — LightRAG 文档索引
 */
import { post, fail } from "./_client.js";

export const name = "lightrag_insert";
export const description =
  "向 LightRAG 知识库插入文档。支持纯文本输入和文件路径标记。" +
  "自动去重（内容 MD5），异步处理后可通过 lightrag_status 查看进度。" +
  "USE WHEN: 需要索引新的 Markdown 文件、文本片段、或批量导入文档。";

export const parameters = {
  type: "object",
  properties: {
    text: { type: "string", description: "要索引的文本内容。" },
    filePath: { type: "string", description: "文件路径（可选），用于溯源引用。" },
    workspace: { type: "string", default: "default", description: "目标知识库名称。" },
  },
  required: ["text"],
};

export async function execute(input, ctx) {
  const ws = input.workspace || "default";

  if (!input.text || input.text.trim().length === 0) {
    return { content: [{ type: "text", text: "文本内容为空，无需索引。" }] };
  }

  try {
    const data = await post(ctx, "/documents/text", {
      text: input.text,
      file_path: input.filePath || "",
    }, { workspace: ws }, { timeout: 300000 });

    if (data.error) return { content: [{ type: "text", text: `索引失败：${data.error}` }] };

    return {
      content: [{
        type: "text",
        text: `文档已提交索引（track_id: ${data.track_id}）。状态: ${data.status}。使用 lightrag_status 查看处理进度。`,
      }],
    };
  } catch (e) {
    return fail("索引", e);
  }
}
