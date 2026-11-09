export interface IdempotencyRecord {
  key: string;
  method: string;
  path: string;
  statusCode: number;
  body: string;
  createdAt: string;
}

export class IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  get(key: string): IdempotencyRecord | undefined {
    return this.records.get(key);
  }

  set(record: IdempotencyRecord): void {
    this.records.set(record.key, record);
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  size(): number {
    return this.records.size;
  }
}

export const idempotencyStore = new IdempotencyStore();
