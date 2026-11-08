import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { findNationalIds } from '../common/spanish-id';
import { extractPages, extractPageTexts } from './pdf';

describe('PDF', () => {
  it('extrae el texto por página y separa páginas', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText('NIF: 00000000T', { x: 50, y: 780, size: 12, font });
    doc.addPage([595, 842]).drawText('NIF 12.345.678-Z', { x: 50, y: 780, size: 12, font });
    const data = Buffer.from(await doc.save());
    const texts = await extractPageTexts(data);
    expect(texts.map(findNationalIds)).toEqual([['00000000T'], ['12345678Z']]);
    const one = await PDFDocument.load(await extractPages(data, [2]));
    expect(one.getPageCount()).toBe(1);
  });
});
