declare module "pdf-parse" {
  function pdfParse(
    data: Buffer,
    options?: { max?: number; version?: string }
  ): Promise<{ numpages: number; text: string }>;
  export = pdfParse;
}
