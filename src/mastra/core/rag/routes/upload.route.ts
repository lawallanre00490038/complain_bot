import express from "express";
import multer from "multer";
import fs from "fs-extra";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { processAndStore } from "../process-and-store.js";
import { insertDoc } from "../db.js";

const router = express.Router();

const ALLOWED_EXTENSIONS = ["pdf", "txt", "csv", "docx", "doc", "xlsx"] as const;
const ALLOWED_MIME_BY_EXT: Record<string, string[]> = {
  pdf: ["application/pdf"],
  txt: ["text/plain"],
  csv: ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  doc: ["application/msword"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
};

function getNormalizedFilename(name: string): string {
  return path.basename(name).trim().replace(/\s+/g, " ");
}

function hasMultipleExtensions(name: string): boolean {
  const filename = getNormalizedFilename(name);
  const parts = filename.split(".").filter(Boolean);
  return parts.length > 2;
}

function getExtension(name: string): string | null {
  const filename = getNormalizedFilename(name);
  const parts = filename.split(".").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : null;
}

function hasZipMagic(buffer: Buffer): boolean {
  return (
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x07 && buffer[3] === 0x08)
  );
}

function hasOleMagic(buffer: Buffer): boolean {
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return ole.every((byte, idx) => buffer[idx] === byte);
}

function isLikelyTextBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length === 0) {
    return false;
  }

  let printableCount = 0;
  for (const byte of sample) {
    const isPrintableAscii = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    if (byte === 0) {
      return false;
    }
    if (isPrintableAscii) {
      printableCount += 1;
    }
  }

  return printableCount / sample.length > 0.85;
}

async function validateUploadedFileSignature(file: Express.Multer.File): Promise<string | null> {
  const ext = getExtension(file.originalname);
  if (!ext || !ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
    return `Unsupported file type: .${ext ?? "unknown"}. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`;
  }

  if (hasMultipleExtensions(file.originalname)) {
    return "Multiple file extensions are not allowed.";
  }

  const allowedMimes = ALLOWED_MIME_BY_EXT[ext] ?? [];
  const isOctetStream = file.mimetype === "application/octet-stream";
  if (!allowedMimes.includes(file.mimetype) && !isOctetStream) {
    return `MIME type mismatch for .${ext}. Received ${file.mimetype}.`;
  }

  const content = await fs.readFile(file.path);
  if (content.length < 4) {
    return "Uploaded file is too small or invalid.";
  }

  if (ext === "pdf") {
    const pdfSignature = content[0] === 0x25 && content[1] === 0x50 && content[2] === 0x44 && content[3] === 0x46;
    if (!pdfSignature) {
      return "Invalid PDF signature.";
    }
  }

  if (ext === "doc" && !hasOleMagic(content)) {
    return "Invalid DOC signature.";
  }

  if ((ext === "docx" || ext === "xlsx") && !hasZipMagic(content)) {
    return `Invalid ${ext.toUpperCase()} signature.`;
  }

  if ((ext === "txt" || ext === "csv") && !isLikelyTextBuffer(content)) {
    return `Invalid ${ext.toUpperCase()} content. Only plain text data is allowed.`;
  }

  return null;
}

async function cleanupTempFiles(files?: Express.Multer.File[]) {
  if (!files?.length) {
    return;
  }

  await Promise.all(files.map(async (file) => {
    if (file?.path) {
      await fs.remove(file.path).catch(() => undefined);
    }
  }));
}

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const ext = getExtension(file.originalname);

    if (hasMultipleExtensions(file.originalname)) {
      return cb(new Error("Multiple file extensions are not allowed."));
    }

    if (!ext || !ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
      return cb(new Error(`Unsupported file type: .${ext ?? "unknown"}. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`));
    }

    const allowedMimes = ALLOWED_MIME_BY_EXT[ext] ?? [];
    const isOctetStream = file.mimetype === "application/octet-stream";
    if (!allowedMimes.includes(file.mimetype) && !isOctetStream) {
      return cb(new Error(`MIME type mismatch for .${ext}. Received ${file.mimetype}.`));
    }

    cb(null, true);
  },
});

/**
 * @swagger
 * /api/kb/upload:
 *   post:
 *     summary: Upload one or more documents to the knowledge base
 *     description: |
 *       Upload one or more files **or** supply raw text.
 *       Supported formats: **PDF, TXT, CSV, DOCX, DOC, XLSX**.
 *       Each document is chunked, embedded, and added to the vector index.
 *       Existing documents are NOT affected — new documents are appended.
 *       
 *       ⚠️ You cannot send both files and text in the same request.
 *     tags:
 *       - Knowledge Base
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: One or more files (PDF, TXT, CSV, DOCX, DOC, XLSX)
 *               text:
 *                 type: string
 *                 description: Plain text content (alternative to file upload)
 *               title:
 *                 type: string
 *                 description: Optional human-readable title for the document
 *     responses:
 *       200:
 *         description: All documents indexed successfully
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               count: 2
 *               results:
 *                 - docId: "550e8400-e29b-41d4-a716-446655440000"
 *                   filename: "faq.pdf"
 *                   totalChunks: 12
 *                 - docId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
 *                   filename: "product-guide.txt"
 *                   totalChunks: 8
 *       400:
 *         description: Invalid input
 *       500:
 *         description: Server error
 */
router.post("/", (req, res) => {
  upload.array("files")(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(400).json({ success: false, error: uploadError.message || "Invalid upload request" });
    }

    const files = (req.files as Express.Multer.File[]) ?? [];
    const { text, title } = req.body as { text?: string; title?: string };

    try {
      if ((!files || files.length === 0) && !text) {
        return res.status(400).json({ success: false, error: "Provide either files or text" });
      }

      if (files.length > 0 && text) {
        await cleanupTempFiles(files);
        return res.status(400).json({ success: false, error: "Provide either files OR text, not both" });
      }

      for (const file of files) {
        const validationError = await validateUploadedFileSignature(file);
        if (validationError) {
          await cleanupTempFiles(files);
          return res.status(400).json({ success: false, error: validationError });
        }
      }

      const inputs: Array<{ filePath: string; originalName: string; size?: number; isTemp: boolean }> = [];

      if (text) {
        const tmpPath = `uploads/text_${Date.now()}.txt`;
        await fs.outputFile(tmpPath, text);
        inputs.push({ filePath: tmpPath, originalName: `text_${Date.now()}.txt`, isTemp: true });
      } else {
        for (const file of files) {
          inputs.push({
            filePath: file.path,
            originalName: file.originalname,
            size: file.size,
            isTemp: false,
          });
        }
      }

      const results = [];
      for (const inp of inputs) {
        const docId = uuidv4();
        const result = await processAndStore({
          filePath: inp.filePath,
          docId,
          originalName: inp.originalName,
        });
        await insertDoc({
          docId,
          title: title ?? undefined,
          originalName: inp.originalName,
          filePath: inp.filePath,
          size: inp.size,
        });
        if (inp.isTemp) {
          await fs.remove(inp.filePath).catch(() => undefined);
        }
        results.push(result);
      }

      return res.json({ success: true, count: results.length, results });
    } catch (err: any) {
      console.error("[upload] Error:", err);
      await cleanupTempFiles(files);
      return res.status(500).json({ success: false, error: "Upload processing failed" });
    }
  });
});

export default router;
