import { AddressInfo, createServer, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { scanBuffer } from './antivirus';

let server: Server | null = null;

/** clamd de mentira: lee el protocolo INSTREAM y responde con `reply(fichero recibido)`. */
function fakeClamd(reply: (file: Buffer) => string | null): Promise<number> {
  server = createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (d) => {
      data = Buffer.concat([data, d]);
      if (!data.subarray(-4).equals(Buffer.alloc(4))) return;
      const command = data.subarray(0, 10).toString();
      const parts: Buffer[] = [];
      for (let i = 10; ; ) {
        const size = data.readUInt32BE(i);
        if (size === 0) break;
        parts.push(data.subarray(i + 4, i + 4 + size));
        i += 4 + size;
      }
      const answer = command === 'zINSTREAM\0' ? reply(Buffer.concat(parts)) : 'UNKNOWN COMMAND\0';
      if (answer !== null) socket.end(answer);
    });
  });
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port)));
}

afterEach(() => {
  server?.close();
  server = null;
});

describe('antivirus (clamd INSTREAM)', () => {
  const opts = (port: number) => ({ host: '127.0.0.1', port, timeoutMs: 300 });

  it('envía el fichero completo en trozos y entiende «limpio»', async () => {
    const file = Buffer.alloc(200_000, 7); // más de un trozo de 64 KiB
    let received = Buffer.alloc(0);
    const port = await fakeClamd((f) => ((received = f), 'stream: OK\0'));
    expect(await scanBuffer(file, opts(port))).toEqual({ clean: true });
    expect(received.equals(file)).toBe(true);
  });

  it('devuelve la firma cuando clamd encuentra algo', async () => {
    const port = await fakeClamd(() => 'stream: Win.Test.EICAR_HDB-1 FOUND\0');
    expect(await scanBuffer(Buffer.from('x'), opts(port))).toEqual({ clean: false, signature: 'Win.Test.EICAR_HDB-1' });
  });

  it('falla si clamd da un error, no responde o no está', async () => {
    let port = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR\0');
    await expect(scanBuffer(Buffer.from('x'), opts(port))).rejects.toThrow(/inesperada/);
    server!.close();
    port = await fakeClamd(() => null);
    await expect(scanBuffer(Buffer.from('x'), opts(port))).rejects.toThrow(/a tiempo/);
    await expect(scanBuffer(Buffer.from('x'), opts(1))).rejects.toThrow(/conectar/);
  });
});
