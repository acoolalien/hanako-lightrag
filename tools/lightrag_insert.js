/**
 * tools/lightrag_insert.js — LightRAG 文档索引
 */
import fs from "node:fs";
import { post, fail } from "./_client.js";

export const name = "lightrag_insert";
export const description =
  "向 LightRAG 知识库插入文档。支持纯文本输入和文件路径标记。" +
  "自动去重（内容 MD5），异步处理后可通过 lightrag_status 查看进度。" +
  "USE WHEN: 需要索引新的 Markdown 文件、文本片段、或批量导入文档。";

export const parameters = {
  type: "object",
  properties: {
    text: { type: "string", description: "要索引的文本内容。与 sourceFile 二选一。" },
    sourceFile: { type: "string", description: "源文件绝对路径。与 text 二选一，提供后自动读取文件内容索引。" },
    filePath: { type: "string", description: "文件路径（可选），用于溯源引用。不传时默认使用 sourceFile 值。" },
    workspace: { type: "string", default: "default", description: "目标知识库名称。" },
  },
};

export async function execute(input, ctx) {
  // ── 文件路径 → 文本 ──
  if (input.sourceFile) {
    try { input.text = fs.readFileSync(input.sourceFile, "utf-8"); }
    catch (e) { return { content: [{ type: "text", text: `读取文件失败：${e.message}` }] }; }
    if (!input.filePath) input.filePath = input.sourceFile;
  }

  const ws = input.workspace || "default";

  if (!input.text || input.text.trim().length === 0) {
    return { content: [{ type: "text", text: "请提供 text（文本内容）或 sourceFile（文件路径）。" }] };
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
