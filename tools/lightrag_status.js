/**
 * tools/lightrag_status.js — LightRAG 知识库状态查看
 */
import { get, fail } from "./_client.js";

export const name = "lightrag_status";
export const description =
  "查看 LightRAG 知识库状态。返回已索引文档列表、处理进度、服务健康信息。" +
  "USE WHEN: 需要了解知识库中有哪些文档、索引是否完成、服务是否正常。";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["health", "documents", "all"],
      default: "all",
      description: "health=服务健康, documents=已索引文档列表, all=全部信息（默认）。",
    },
    workspace: { type: "string", default: "default", description: "知识库名称。" },
  },
  required: [],
};

export async function execute(input, ctx) {
  const ws = input.workspace || "default";
  const action = input.action || "all";
  const results = [];

  try {
    if (action === "health" || action === "all") {
      const health = await get(ctx, "/health", { workspace: ws }, { timeout: 5000 });
      results.push(
        `**服务状态**: ${health.status === "ok" ? "✅ 正常" : "❌ 异常"}`,
        `**工作目录**: ${health.working_dir}`,
        `**RAG 就绪**: ${health.rag_ready ? "是" : "否"}`,
      );
    }

    if (action === "documents" || action === "all") {
      const docs = await get(ctx, "/documents", { workspace: ws }, { timeout: 10000 });
      if (docs.error) {
        results.push(`\n**文档列表获取失败**: ${docs.error}`);
      } else {
        const docList = docs.documents || [];
        results.push(`\n**已索引文档**: ${docList.length} 篇`);

        const byStatus = {};
        for (const d of docList) {
          const s = d.status || "unknown";
          byStatus[s] = (byStatus[s] || 0) + 1;
        }
        results.push(`**状态分布**: ${Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join(", ")}`);

        const preview = docList.slice(0, 20);
        if (preview.length > 0) {
          const lines = preview.map(d => {
            const summary = (d.content_summary || "").slice(0, 80);
            const fpath = d.file_path || d.id || "unknown";
            return `  - [${d.status}] ${fpath} ${summary ? "| " + summary : ""}`;
          });
          results.push(`\n**文档预览** (前 ${preview.length} 篇):\n${lines.join("\n")}`);
          if (docList.length > 20) results.push(`  ... 共 ${docList.length} 篇`);
        }
      }
    }

    return { content: [{ type: "text", text: results.join("\n") }] };
  } catch (e) {
    return fail("状态查询", e);
  }
}
