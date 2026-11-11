import { connect } from 'node:net';

export type ScanResult = { clean: true } | { clean: false; signature: string };

const CHUNK = 64 * 1024;

/**
 * Analiza un fichero con ClamAV (protocolo INSTREAM de clamd por TCP): se envía en trozos
 * precedidos de su tamaño y clamd responde «stream: OK» o «stream: <firma> FOUND».
 * Lanza un error si clamd no responde, corta la conexión o devuelve un error (por ejemplo,
 * si el fichero supera su StreamMaxLength).
 */
export function scanBuffer(data: Buffer, opts: { host: string; port: number; timeoutMs: number }): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: opts.host, port: opts.port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null, result?: ScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(result!);
    };
    socket.setTimeout(opts.timeoutMs, () => finish(new Error('El antivirus no ha respondido a tiempo')));
    socket.on('error', (err) => finish(new Error(`No se ha podido conectar con el antivirus: ${err.message}`)));
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, i + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(part.length);
        socket.write(size);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4)); // tamaño 0: fin del fichero
    });
    socket.on('data', (d) => chunks.push(d));
    socket.on('close', () => {
      const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
      const found = /^stream: (.+) FOUND$/.exec(reply);
      if (reply === 'stream: OK') finish(null, { clean: true });
      else if (found) finish(null, { clean: false, signature: found[1] });
      else finish(new Error(`Respuesta inesperada del antivirus: ${reply.slice(0, 200) || '(vacía)'}`));
    });
  });
}
