import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { sha256 } from '../common/crypto';
import { Tx } from '../db/db.service';
import { createStorageAdapter, StorageAdapter } from './storage-adapters';

export interface StoredFile {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: string;
  sha256: string;
  storage_key: string;
}

@Injectable()
export class StorageService {
  /** Disco local, S3 (o compatible) o Azure Blob según STORAGE_DRIVER. */
  private readonly adapter: StorageAdapter = createStorageAdapter(config.storage);

  async store(tx: Tx, data: Buffer, filename: string, contentType: string): Promise<StoredFile> {
    const now = new Date();
    const key = `${tx.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    await this.adapter.put(key, data, contentType);
    return tx.one<StoredFile>(
      `INSERT INTO stored_file (tenant_id, storage_key, filename, content_type, size_bytes, sha256, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, filename, content_type, size_bytes, sha256, storage_key`,
      [tx.tenantId, key, filename, contentType, data.length, sha256(data), tx.userId],
    );
  }

  /** Borra el fichero y su fila (la fila no debe estar referenciada). */
  async remove(tx: Tx, fileId: string) {
    const file = await tx.maybeOne<StoredFile>('SELECT * FROM stored_file WHERE id = $1', [fileId]);
    if (!file) return;
    await tx.query('DELETE FROM stored_file WHERE id = $1', [fileId]);
    await this.adapter.delete(file.storage_key);
  }

  async read(tx: Tx, fileId: string): Promise<{ file: StoredFile; data: Buffer }> {
    const file = await tx.one<StoredFile>('SELECT * FROM stored_file WHERE id = $1', [fileId]);
    const data = await this.adapter.get(file.storage_key);
    if (sha256(data) !== file.sha256) throw new Error(`El fichero ${fileId} no coincide con su huella`);
    return { file, data };
  }
}
