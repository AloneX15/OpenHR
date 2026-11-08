import { PDFDocument } from 'pdf-lib';


/** Texto de cada página de un PDF (vacío si la página es una imagen escaneada). */
export async function extractPageTexts(data: Buffer): Promise<string[]> {
  // pdfjs-dist solo se publica como ESM; con module=node16 el import() dinámico se conserva.
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const texts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      texts.push(content.items.map((it: any) => ('str' in it ? it.str : '')).join(' '));
      page.cleanup();
    }
    return texts;
  } finally {
    await doc.destroy();
  }
}

export async function pageCount(data: Buffer): Promise<number> {
  const doc = await PDFDocument.load(data, { ignoreEncryption: false });
  return doc.getPageCount();
}

/** Nuevo PDF con las páginas indicadas (numeradas desde 1) del original. */
export async function extractPages(data: Buffer, pages: number[]): Promise<Buffer> {
  const src = await PDFDocument.load(data);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pages.map((p) => p - 1));
  copied.forEach((p) => out.addPage(p));
  return Buffer.from(await out.save());
}
