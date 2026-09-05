import path from "path";
import crypto from "crypto";
import { MDocument } from "@mastra/rag";
import { embedMany } from "ai";

import { vectorStore, INDEX_NAME } from "./vector-store.js";
import { extractText } from "./ingest-files.js";
import { getEmbeddingModel } from "../llm/provider.js";

type ProcessInput = {
  filePath: string;
  docId: string;
  originalName: string;
};

/**
 * Chunks, embeds, and upserts a document into the vector store.
 * Always appends — existing chunks for the same docId are removed first
 * to avoid duplicates on re-upload, but all other documents are untouched.
 */
export async function processAndStore(input: ProcessInput) {
  const { filePath, docId, originalName } = input;

  // 1. Extract text
  const text = await extractText(filePath, originalName);
  if (!text?.trim()) throw new Error("Empty document: nothing to index");

  // 2. Build base metadata
  const metadataBase = {
    filename: originalName,
    createdAt: new Date().toISOString(),
    hash: crypto.createHash("sha256").update(text).digest("hex"),
    docId,
    source: "upload",
  };

  // 3. Remove previous vectors for this docId (idempotent re-index)
  await safeDeleteByDocId(docId);


  console.log("[RAG] Generating chunks...");
  console.time("chunking");

  // 4. Chunk
  const doc = MDocument.fromText(text);
  const chunks = await doc.chunk({
    strategy: "recursive",
    maxSize: 512,
    overlap: 50,
  });
  if (!chunks.length) throw new Error("Chunking failed: no content generated");

  console.timeEnd("chunking");
  console.log(`[RAG] chunks generated: ${chunks.length}`);

  const BATCH_SIZE = 50;
  const allEmbeddings: number[][] = [];
  console.log(`[RAG] embedding ${chunks.length} chunks in batches of ${BATCH_SIZE}`);
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE).map((c) => c.text);
    console.log(`[RAG] embedding batch ${i}-${i + batch.length - 1}`);
    console.time(`embed-batch-${i}`);
    const { embeddings } = await embedMany({
      model: getEmbeddingModel(),
      values: batch,
    });
    console.timeEnd(`embed-batch-${i}`);
    if (!embeddings || embeddings.length !== batch.length) {
      console.warn(`[RAG] Unexpected embeddings length: got ${embeddings?.length}, expected ${batch.length}`);
    }
    allEmbeddings.push(...embeddings);
  }

  // 6. Upsert
  console.time("upsert");
  await vectorStore.upsert({
    indexName: INDEX_NAME,
    vectors: allEmbeddings,
    metadata: chunks.map((chunk, i) => ({
      ...metadataBase,
      text: chunk.text,
      chunkIndex: i,
      chunkId: chunk.id_,
    })),
  });

  console.timeEnd("upsert");
  console.log("[RAG] Upsert complete");


  return {
    success: true,
    docId,
    filename: originalName,
    totalChunks: chunks.length,
  };
}




/**
 * Removes all vector chunks belonging to a specific docId.
 * Silently skips if the index does not exist yet.
 */
export async function safeDeleteByDocId(docId: string) {
  try {
    await vectorStore.deleteVectors({
      indexName: INDEX_NAME,
      filter: { docId },
    });
  } catch (err: any) {
    if (!err.message?.includes("does not exist")) throw err;
    console.log(`[RAG] Skipping delete: index not yet created.`);
  }
}
