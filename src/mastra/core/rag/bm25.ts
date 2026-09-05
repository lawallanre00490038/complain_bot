import { embed, embedMany } from 'ai';

export type ScoredChunk = {
  id?: string;
  text: string;
  metadata?: Record<string, any>;
  vectorScore?: number;
  bm25Score?: number;
  hybridScore?: number;
};

function tokenize(text: string) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function bm25Score(query: string, document: string, docs: string[], k1 = 1.5, b = 0.75) {
  const queryTerms = tokenize(query);
  const docTerms = tokenize(document);
  if (!queryTerms.length || !docTerms.length) return 0;

  const avgdl = docs.reduce((sum, d) => sum + tokenize(d).length, 0) / Math.max(1, docs.length);
  const freqs = new Map<string, number>();
  for (const term of docTerms) freqs.set(term, (freqs.get(term) || 0) + 1);

  let score = 0;
  for (const term of new Set(queryTerms)) {
    const df = docs.reduce((count, d) => count + (tokenize(d).includes(term) ? 1 : 0), 0);
    if (df === 0) continue;
    const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
    const tf = freqs.get(term) || 0;
    const denom = tf + k1 * (1 - b + b * (docTerms.length / avgdl));
    score += idf * ((tf * (k1 + 1)) / denom);
  }

  return score;
}

export function fuseHybridScores(chunks: ScoredChunk[]) {
  const maxVector = Math.max(...chunks.map((c) => c.vectorScore ?? 0), 1e-9);
  const maxBm25 = Math.max(...chunks.map((c) => c.bm25Score ?? 0), 1e-9);

  return chunks.map((chunk) => ({
    ...chunk,
    hybridScore: 0.6 * ((chunk.vectorScore ?? 0) / maxVector) + 0.4 * ((chunk.bm25Score ?? 0) / maxBm25),
  })).sort((a, b) => (b.hybridScore ?? 0) - (a.hybridScore ?? 0));
}
