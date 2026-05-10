import { Document, Packer, Paragraph, TextRun } from "docx";

export async function buildCoverLetterDocx(params: {
  candidateName: string;
  company: string;
  roleTitle: string;
  body: string;
}) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: params.candidateName, bold: true })]
          }),
          new Paragraph({
            children: [new TextRun(`${params.roleTitle} application for ${params.company}`)]
          }),
          new Paragraph({
            children: [new TextRun(params.body)]
          })
        ]
      }
    ]
  });

  return Packer.toBuffer(doc);
}
