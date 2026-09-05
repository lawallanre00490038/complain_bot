import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Creates the `kb_docs` table if it does not already exist.
 * Called at server startup — safe to run multiple times.
 */
export async function createKbDocsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_docs (
      doc_id     UUID         PRIMARY KEY,
      title      TEXT,
      original_name TEXT      NOT NULL,
      file_path  TEXT         NOT NULL,
      size       BIGINT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export async function insertDoc(params: {
  docId: string;
  title?: string;
  originalName: string;
  filePath: string;
  size?: number;
}) {
  await pool.query(
    `INSERT INTO kb_docs (doc_id, title, original_name, file_path, size)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (doc_id) DO NOTHING`,
    [params.docId, params.title ?? null, params.originalName, params.filePath, params.size ?? null]
  );
}

export async function getAllDocs() {
  const { rows } = await pool.query(
    `SELECT doc_id, title, original_name, size, uploaded_at FROM kb_docs ORDER BY uploaded_at DESC`
  );
  return rows;
}

export async function getDocById(docId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM kb_docs WHERE doc_id = $1`,
    [docId]
  );
  return rows[0] ?? null;
}

export async function deleteDocRecord(docId: string) {
  await pool.query(`DELETE FROM kb_docs WHERE doc_id = $1`, [docId]);
}

export default pool;
