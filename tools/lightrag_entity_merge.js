import { post, fail } from "./_client.js";

export const name = "lightrag_entity_merge";
export const description = "Merge two entities in a workspace.";

export const parameters = {
  type: "object",
  properties: {
    source: { type: "string", description: "Source entity name." },
    target: { type: "string", description: "Target entity name." },
    workspace: { type: "string", default: "default", description: "Workspace name." },
  },
  required: ["source", "target"],
};

export async function execute(input, ctx) {
  const ws = input.workspace || "default";
  try {
    const data = await post(ctx, "/entities/merge", { source: input.source, target: input.target }, { workspace: ws }, { timeout: 15000 });
    if (data.error) return { content: [{ type: "text", text: `Merge failed: ${data.error}` }] };
    return { content: [{ type: "text", text: `Merged "${input.source}" into "${input.target}" (${ws}).` }] };
  } catch (e) {
    return fail("merge", e);
  }
}
