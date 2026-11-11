import { describe, expect, it } from 'vitest';
import { buildTimestampRequest, checkTimestampResponse } from './tsa';

const digest = 'a'.repeat(64);
const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag, content.length]), content]);
const response = (status: number, token: Buffer | null) =>
  tlv(0x30, Buffer.concat([tlv(0x30, Buffer.from([0x02, 0x01, status])), token ?? Buffer.alloc(0)]));

describe('sello de tiempo RFC 3161', () => {
  it('construye la petición DER con SHA-256, la huella, el nonce y certReq', () => {
    const { request, nonce } = buildTimestampRequest(digest, Buffer.alloc(8, 0xff));
    expect(nonce.toString('hex')).toBe('7fffffffffffffff');
    expect(request.toString('hex')).toBe(
      '3043' + // TimeStampReq
        '020101' + // versión 1
        '3031' + '300d' + '0609608648016503040201' + '0500' + // messageImprint: SHA-256
        '0420' + digest +
        '0208' + '7fffffffffffffff' + // nonce
        '0101ff', // certReq
    );
    expect(() => buildTimestampRequest('no-es-una-huella')).toThrow();
  });

  it('acepta una respuesta concedida con nuestra huella y nonce', () => {
    const { nonce } = buildTimestampRequest(digest);
    const token = tlv(0x30, Buffer.concat([tlv(0x04, Buffer.from(digest, 'hex')), tlv(0x02, nonce)]));
    expect(() => checkTimestampResponse(response(0, token), digest, nonce)).not.toThrow();
    expect(() => checkTimestampResponse(response(1, token), digest, nonce)).not.toThrow();
  });

  it('rechaza respuestas denegadas, sin token, de otra huella, de otro nonce o corruptas', () => {
    const { nonce } = buildTimestampRequest(digest);
    const token = tlv(0x30, Buffer.concat([tlv(0x04, Buffer.from(digest, 'hex')), tlv(0x02, nonce)]));
    expect(() => checkTimestampResponse(response(2, null), digest, nonce)).toThrow(/rechazado/);
    expect(() => checkTimestampResponse(response(0, null), digest, nonce)).toThrow(/no trae/);
    expect(() => checkTimestampResponse(response(0, token), 'b'.repeat(64), nonce)).toThrow(/huella/);
    expect(() => checkTimestampResponse(response(0, token), digest, Buffer.alloc(8, 1))).toThrow(/nonce/);
    expect(() => checkTimestampResponse(Buffer.from('<html>error</html>'), digest, nonce)).toThrow();
    expect(() => checkTimestampResponse(response(0, token).subarray(0, 20), digest, nonce)).toThrow();
  });
});
