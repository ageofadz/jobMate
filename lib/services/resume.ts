import pdfParse from "pdf-parse";

export async function extractTextFromPdf(buffer: Buffer) {
  try {
    const parsed = await pdfParse(buffer);
    return parsed.text?.trim() || "";
  } catch {
    return "";
  }
}
