import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { BlobServiceClient } from '@azure/storage-blob';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AzureBlobStorage, LocalDiskStorage, S3Storage, StorageAdapter } from './storage-adapters';

// Servicios de docker-compose.test.yml. Si no están levantados, esos tests se saltan.
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9100';
const AZURITE = 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

async function reachable(url: string) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function roundTrip(adapter: StorageAdapter) {
  const key = `tenant/2026/11/${Math.random().toString(36).slice(2)}`;
  const data = Buffer.from('%PDF-1.7 contenido de prueba ñ');
  await adapter.put(key, data, 'application/pdf');
  expect((await adapter.get(key)).equals(data)).toBe(true);
  await adapter.delete(key);
  await expect(adapter.get(key)).rejects.toBeTruthy();
}

describe('adaptadores de almacenamiento', () => {
  it('disco local, sin salir del directorio raíz', async () => {
    const local = new LocalDiskStorage(mkdtempSync(join(tmpdir(), 'openhr-')));
    await roundTrip(local);
    await expect(local.put('../fuera', Buffer.from('x'), 'text/plain')).rejects.toThrow(/no válida/);
  });

  it('S3 compatible (S3Mock)', async ({ skip }) => {
    if (!(await reachable(S3_ENDPOINT))) skip();
    const opts = { bucket: 'openhr-test', region: 'us-east-1', endpoint: S3_ENDPOINT, accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true };
    const client = new S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: true, credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } });
    await client.send(new CreateBucketCommand({ Bucket: opts.bucket })).catch(() => undefined);
    await roundTrip(new S3Storage(opts));
  });

  it('Azure Blob (Azurite)', async ({ skip }) => {
    if (!(await reachable('http://127.0.0.1:10000/devstoreaccount1?comp=list'))) skip();
    await BlobServiceClient.fromConnectionString(AZURITE).getContainerClient('openhr-test').createIfNotExists();
    await roundTrip(new AzureBlobStorage({ container: 'openhr-test', connectionString: AZURITE }));
  });
});
