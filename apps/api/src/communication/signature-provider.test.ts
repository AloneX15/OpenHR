import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createSignatureProvider } from './signature-provider';
import { CONSENT_TEXT, SignatureEvidence } from './signatures.service';

const evidence: SignatureEvidence = {
  signer: { personId: 'p', userId: 'u', name: 'Luis Empleado', nationalId: '00000000T', email: 'luis@demo.test' },
  document: { title: 'Anexo', filename: 'anexo.pdf', sha256: 'a'.repeat(64) },
  signedAt: '2026-11-11T10:00:00.000Z',
  ip: '127.0.0.1',
  userAgent: null,
  method: 'session+email_otp',
  consent: CONSENT_TEXT,
};

describe('adaptador de firma', () => {
  it('el proveedor por defecto es la firma simple y añade la hoja de evidencias', async () => {
    const provider = createSignatureProvider('simple');
    expect(provider).toMatchObject({ id: 'simple', level: 'simple' });
    const original = await PDFDocument.create();
    original.addPage();
    const { pdf, providerEvidence } = await provider.sign(Buffer.from(await original.save()), evidence);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(2);
    expect(providerEvidence).toBeUndefined();
  });

  it('un proveedor desconocido impide arrancar', () => {
    expect(() => createSignatureProvider('inventado')).toThrow(/SIGNATURE_PROVIDER desconocido/);
  });
});
