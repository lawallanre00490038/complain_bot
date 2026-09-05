import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { retrieveContext } from "../core/rag/retrieve.js";

/**
 * Knowledge base retrieval tool for the Engagement Agent.
 * Searches the FBNBank Senegal document index for relevant context
 * before answering customer queries.
 */
export const knowledgeBaseTool = createTool({
  id: "knowledge-base-search",
  description:
    "Search the FBNBank Senegal knowledge base for relevant information to answer a customer query. " +
    "Always call this tool BEFORE answering questions about products, services, procedures, fees, " +
    "branch details, or any banking topic. Use the customer's question as the query.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The customer's question or a refined version of it, used to search the knowledge base."
      ),
  }),
  outputSchema: z.object({
    found: z.boolean().describe("Whether relevant content was found"),
    topResult: z.string().describe("The most relevant passage, or empty string if nothing found"),
    allResults: z.array(z.string()).describe("All retrieved passages, ordered by relevance"),
  }),
  execute: async ({ query }: { query: string }) => {
    console.log(`[knowledgeBaseTool] Query: ${query}`);

    const results = await retrieveContext(query);

    const allResults = Array.isArray(results)
      ? results
          .map((r: any) => r.result?.metadata?.text ?? r.metadata?.text ?? r.text ?? "")
          .filter((t: string) => t.length > 0)
      : [];

    const topResult = allResults[0] ?? "";

    console.log(`[knowledgeBaseTool] Chunks found: ${allResults.length}`);
    console.log(`\n[knowledgeBaseTool] Top chunk: ${topResult}\n\n`);

    return {
      found: allResults.length > 0,
      topResult,
      allResults,
    };
  },
});
