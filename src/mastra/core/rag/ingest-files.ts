import fs from "fs-extra";
import csvParser from "csv-parser";

/**
 * Extracts plain text from PDF, TXT, CSV, DOCX, DOC, XLSX files.
 * @param originalName - The original filename (used to determine file type, since temp paths have no extension)
 */
export async function extractText(filePath: string, originalName?: string): Promise<string> {
  const nameForExt = originalName ?? filePath;
  const ext = nameForExt.split(".").pop()?.toLowerCase();

  if (ext === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const buffer = await fs.readFile(filePath);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return result.text;
  }

  if (ext === "txt") {
    return fs.readFile(filePath, "utf-8");
  }

  if (ext === "csv") {
    return new Promise((resolve, reject) => {
      let result = "";
      fs.createReadStream(filePath)
        .pipe(csvParser())
        .on("data", (row: Record<string, unknown>) => {
          result += Object.values(row).join(" ") + "\n";
        })
        .on("end", () => resolve(result))
        .on("error", reject);
    });
  }

  if (ext === "docx" || ext === "doc") {
    const mammoth = await import("mammoth");
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === "xlsx") {
    const excelMod = await import("exceljs");
    const ExcelJS = (excelMod as any).default ?? excelMod;
    const buffer = await fs.readFile(filePath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const lines: string[] = [];
    for (const sheet of workbook.worksheets) {
      sheet.eachRow({ includeEmpty: false }, (row: any) => {
        const values = Array.isArray(row?.values) ? row.values.slice(1) : [];
        const text = values.filter((value: unknown) => value != null && String(value).trim() !== "").join(" ");
        if (text) lines.push(text);
      });
    }
    return lines.join("\n");
  }

  throw new Error(`Unsupported file type: .${ext}. Allowed: pdf, txt, csv, docx, doc, xlsx`);
}
