import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Dónde se guardan los ficheros. Las claves las genera siempre el servidor. */
export interface StorageAdapter {
  readonly name: string;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Disco local (volumen de Docker). Opción por defecto. */
export class LocalDiskStorage implements StorageAdapter {
  readonly name = 'local';
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('Clave de almacenamiento no válida');
    return p;
  }

  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  get(key: string) {
    return readFile(this.path(key));
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

/** Amazon S3 o compatible (MinIO, Cloudflare R2, Scaleway…). Cifrado en reposo del proveedor. */
export class S3Storage implements StorageAdapter {
  readonly name = 's3';
  private readonly client: S3Client;

  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint || undefined,
      forcePathStyle: opts.forcePathStyle,
      // Sin claves, el SDK usa la cadena estándar (variables, rol de la instancia…).
      credentials: opts.accessKeyId && opts.secretAccessKey ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } : undefined,
    });
  }

  async put(key: string, data: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: data, ContentType: contentType }));
  }

  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
}

export interface AzureOptions {
  container: string;
  /** Cadena de conexión (Azurite o claves) o, si falta, cuenta + identidad gestionada. */
  connectionString?: string;
  account?: string;
}

/** Azure Blob Storage. En Azure se recomienda identidad gestionada (sin secretos). */
export class AzureBlobStorage implements StorageAdapter {
  readonly name = 'azure';
  private readonly container: ContainerClient;

  constructor(opts: AzureOptions) {
    const service = opts.connectionString
      ? BlobServiceClient.fromConnectionString(opts.connectionString)
      : new BlobServiceClient(`https://${opts.account}.blob.core.windows.net`, new DefaultAzureCredential());
    this.container = service.getContainerClient(opts.container);
  }

  async put(key: string, data: Buffer, contentType: string) {
    await this.container.getBlockBlobClient(key).uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  async get(key: string) {
    return this.container.getBlockBlobClient(key).downloadToBuffer();
  }

  async delete(key: string) {
    await this.container.getBlockBlobClient(key).deleteIfExists();
  }
}

export interface StorageConfig {
  driver: 'local' | 's3' | 'azure';
  localDir: string;
  s3: S3Options;
  azure: AzureOptions;
}

export function createStorageAdapter(c: StorageConfig): StorageAdapter {
  if (c.driver === 's3') {
    if (!c.s3.bucket) throw new Error('STORAGE_DRIVER=s3 necesita S3_BUCKET');
    return new S3Storage(c.s3);
  }
  if (c.driver === 'azure') {
    if (!c.azure.container || (!c.azure.connectionString && !c.azure.account)) {
      throw new Error('STORAGE_DRIVER=azure necesita AZURE_STORAGE_CONTAINER y AZURE_STORAGE_CONNECTION_STRING o AZURE_STORAGE_ACCOUNT');
    }
    return new AzureBlobStorage(c.azure);
  }
  return new LocalDiskStorage(c.localDir);
}
