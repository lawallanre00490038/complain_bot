import "dotenv/config";
import { PgVector } from "@mastra/pg";

if (!process.env.VECTOR_STORE_ID) throw new Error("VECTOR_STORE_ID is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!process.env.VECTOR_INDEX_NAME) throw new Error("VECTOR_INDEX_NAME is required");


export const vectorStore = new PgVector({
  id: process.env.VECTOR_STORE_ID,
  connectionString: process.env.DATABASE_URL,
});

export const INDEX_NAME = process.env.VECTOR_INDEX_NAME;

/**
 * Creates the pgvector index if it does not already exist.
 * Safe to call multiple times (idempotent).
 */
export async function initVectorIndex() {
  try {
    await vectorStore.createIndex({
      indexName: INDEX_NAME,
      dimension: parseInt(process.env.PGVECTOR_EMBEDDING_DIM || "1536"),
    });
    console.log(`[RAG] Vector index "${INDEX_NAME}" ready.`);
  } catch (err: any) {
    // Ignore "already exists" errors
    if (!err.message?.includes("already exists")) throw err;
    console.log(`[RAG] Vector index "${INDEX_NAME}" already exists.`);
  }
}
