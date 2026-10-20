import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Minimal blob storage. Swap for S3/R2 by implementing the same interface. */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    // Write-then-rename so readers never see a half-written file.
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, target);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
}
