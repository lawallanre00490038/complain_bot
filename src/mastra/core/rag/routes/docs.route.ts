import express from "express";
import fs from "fs-extra";
import { getAllDocs, getDocById, deleteDocRecord } from "../db.js";
import { safeDeleteByDocId } from "../process-and-store.js";

const router = express.Router();

/**
 * @swagger
 * /api/kb/docs:
 *   get:
 *     summary: List all documents in the knowledge base
 *     description: Returns metadata for all uploaded documents, ordered by upload date (newest first).
 *     tags:
 *       - Knowledge Base
 *     responses:
 *       200:
 *         description: List of documents
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               count: 2
 *               docs:
 *                 - doc_id: "550e8400-e29b-41d4-a716-446655440000"
 *                   title: "FAQ Document"
 *                   original_name: "faq.pdf"
 *                   size: 102400
 *                   uploaded_at: "2026-05-04T10:00:00.000Z"
 *                 - doc_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
 *                   title: null
 *                   original_name: "product-guide.txt"
 *                   size: 4096
 *                   uploaded_at: "2026-05-04T09:00:00.000Z"
 *       500:
 *         description: Server error
 */
router.get("/", async (_req, res) => {
  try {
    const docs = await getAllDocs();
    return res.json({ success: true, count: docs.length, docs });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @swagger
 * /api/kb/docs/{docId}:
 *   get:
 *     summary: Get metadata for a specific document
 *     tags:
 *       - Knowledge Base
 *     parameters:
 *       - in: path
 *         name: docId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The document ID returned at upload time
 *     responses:
 *       200:
 *         description: Document metadata
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               doc:
 *                 doc_id: "550e8400-e29b-41d4-a716-446655440000"
 *                 title: "FAQ Document"
 *                 original_name: "faq.pdf"
 *                 file_path: "uploads/abc123"
 *                 size: 102400
 *                 uploaded_at: "2026-05-04T10:00:00.000Z"
 *       404:
 *         description: Document not found
 *       500:
 *         description: Server error
 */
router.get("/:docId", async (req, res) => {
  try {
    const doc = await getDocById(req.params.docId);
    if (!doc) return res.status(404).json({ success: false, error: "Document not found" });
    return res.json({ success: true, doc });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @swagger
 * /api/kb/docs/{docId}:
 *   delete:
 *     summary: Delete a specific document from the knowledge base
 *     description: |
 *       Removes the document's vector chunks from the index AND its metadata record.
 *       The uploaded file on disk is also deleted if it still exists.
 *     tags:
 *       - Knowledge Base
 *     parameters:
 *       - in: path
 *         name: docId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The document ID to delete
 *     responses:
 *       200:
 *         description: Document deleted successfully
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Document 550e8400-e29b-41d4-a716-446655440000 deleted"
 *       404:
 *         description: Document not found
 *       500:
 *         description: Server error
 */
router.delete("/:docId", async (req, res) => {
  try {
    const { docId } = req.params;
    const doc = await getDocById(docId);
    if (!doc) return res.status(404).json({ success: false, error: "Document not found" });

    // 1. Remove vectors from index
    await safeDeleteByDocId(docId);

    // 2. Remove file from disk (best-effort)
    if (doc.file_path) {
      await fs.remove(doc.file_path).catch(() => {});
    }

    // 3. Remove metadata record
    await deleteDocRecord(docId);

    return res.json({ success: true, message: `Document ${docId} deleted` });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
