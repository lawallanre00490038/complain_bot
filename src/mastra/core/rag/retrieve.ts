import { embed } from 'ai';
import { MastraAgentRelevanceScorer, rerankWithScorer } from '@mastra/rag';

import { vectorStore, INDEX_NAME } from './vector-store.js';
import { getChatModel, getEmbeddingModel } from '../llm/provider.js';
import { bm25Score, fuseHybridScores, ScoredChunk } from './bm25.js';

export async function retrieveContext(query: string, topK = 10) {
  const { embedding } = await embed({ model: getEmbeddingModel(), value: query });

  const initialResults: any[] = await vectorStore.query({
    indexName: INDEX_NAME,
    queryVector: embedding,
    topK: 12,
  });

  if (!initialResults.length) return [];

  const docs = initialResults.map((r) => String(r.metadata?.text || r.text || ''));
  const scored: ScoredChunk[] = initialResults.map((r, i) => ({
    ...r,
    text: String(r.metadata?.text || r.text || ''),
    vectorScore: typeof r.score === 'number' ? r.score : (typeof r.similarity === 'number' ? r.similarity : 0),
    bm25Score: bm25Score(query, String(r.metadata?.text || r.text || ''), docs),
  }));

  const hybrid = fuseHybridScores(scored).slice(0, Math.max(topK * 2, topK));

  const relevanceScorer = new MastraAgentRelevanceScorer('kb-relevance-scorer', getChatModel() as any);
  const reranked = await rerankWithScorer({
    results: hybrid as any,
    query,
    scorer: relevanceScorer,
    options: {
      weights: { semantic: 0.5, vector: 0.3, position: 0.2 },
      topK,
    },
  });

  return reranked;
}
