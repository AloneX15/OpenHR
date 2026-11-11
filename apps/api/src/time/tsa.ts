import { randomBytes } from 'node:crypto';

/**
 * Cliente mínimo de sellado de tiempo RFC 3161. Pide a una autoridad de sellado (TSA) que
 * firme «esta huella SHA-256 existía en este momento». La respuesta se guarda tal cual y se
 * comprueba fuera de OpenHR, por ejemplo:
 *
 *   openssl ts -verify -digest <huella> -in sello.tsr -CAfile cadena-de-la-tsa.pem
 *
 * Aquí solo se comprueba que la TSA aceptó la petición y que la respuesta habla de nuestra
 * huella y de nuestro nonce; la firma la valida quien audite, con la cadena de la TSA.
 */

const SHA256_OID = Buffer.from('0609608648016503040201', 'hex'); // 2.16.840.1.101.3.4.2.1
const MAX_RESPONSE_BYTES = 64 * 1024;

function der(tag: number, content: Buffer): Buffer {
  const n = content.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, content]);
}

/** TimeStampReq (DER) para una huella SHA-256 en hexadecimal, con nonce y pidiendo el certificado. */
export function buildTimestampRequest(digestHex: string, nonce: Buffer = randomBytes(8)): { request: Buffer; nonce: Buffer } {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new Error('La huella debe ser un SHA-256 en hexadecimal');
  // Entero positivo y sin ceros a la izquierda: primer byte entre 0x40 y 0x7f.
  const n = Buffer.from(nonce);
  n[0] = (n[0] & 0x3f) | 0x40;
  const algorithm = der(0x30, Buffer.concat([SHA256_OID, Buffer.from([0x05, 0x00])]));
  const imprint = der(0x30, Buffer.concat([algorithm, der(0x04, Buffer.from(digestHex, 'hex'))]));
  const request = der(0x30, Buffer.concat([Buffer.from([0x02, 0x01, 0x01]), imprint, der(0x02, n), Buffer.from([0x01, 0x01, 0xff])]));
  return { request, nonce: n };
}

/** Lee una pieza DER (etiqueta, contenido y dónde acaba) a partir de `offset`. */
function readTlv(buf: Buffer, offset: number): { tag: number; content: Buffer; end: number } {
  if (offset + 2 > buf.length) throw new Error('Respuesta de la TSA truncada');
  const tag = buf[offset];
  let len = buf[offset + 1];
  let start = offset + 2;
  if (len & 0x80) {
    const bytes = len & 0x7f;
    if (bytes === 0 || bytes > 3 || start + bytes > buf.length) throw new Error('Respuesta de la TSA no válida');
    len = buf.readUIntBE(start, bytes);
    start += bytes;
  }
  if (start + len > buf.length) throw new Error('Respuesta de la TSA truncada');
  return { tag, content: buf.subarray(start, start + len), end: start + len };
}

/**
 * Comprueba un TimeStampResp: estado «concedido» (0 o 1), con token, y que contiene la
 * huella y el nonce enviados. Lanza un error si no es así.
 */
export function checkTimestampResponse(response: Buffer, digestHex: string, nonce: Buffer): void {
  const outer = readTlv(response, 0);
  if (outer.tag !== 0x30) throw new Error('Respuesta de la TSA no válida');
  const statusInfo = readTlv(outer.content, 0);
  const status = statusInfo.tag === 0x30 ? readTlv(statusInfo.content, 0) : null;
  if (!status || status.tag !== 0x02 || status.content.length !== 1) throw new Error('Respuesta de la TSA no válida');
  if (status.content[0] > 1) throw new Error(`La TSA ha rechazado la petición (estado ${status.content[0]})`);
  if (statusInfo.end >= outer.content.length) throw new Error('La respuesta de la TSA no trae sello de tiempo');
  const token = outer.content.subarray(statusInfo.end);
  if (!token.includes(Buffer.from(digestHex, 'hex'))) throw new Error('El sello de tiempo no corresponde a la huella enviada');
  if (!token.includes(nonce)) throw new Error('El sello de tiempo no corresponde a esta petición (nonce)');
}

/** Pide el sello de tiempo de una huella. Devuelve el TimeStampResp completo (fichero .tsr). */
export async function requestTimestamp(url: string, digestHex: string, timeoutMs = 10_000): Promise<Buffer> {
  const { request, nonce } = buildTimestampRequest(digestHex);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' },
    body: new Uint8Array(request),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`La TSA ha respondido ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_RESPONSE_BYTES) throw new Error('Respuesta de la TSA demasiado grande');
  checkTimestampResponse(body, digestHex, nonce);
  return body;
}
