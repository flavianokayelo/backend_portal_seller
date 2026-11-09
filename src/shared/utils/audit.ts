export interface AuditEntry {
  actorId: string;
  actorRole: string;
  action: string;
  resource: string;
  resourceId: string;
  source: "sete" | "venda_express" | "integration";
  outcome: "success" | "failure";
  timestamp: string;
  details?: Record<string, unknown>;
}

export class AuditLogger {
  private entries: AuditEntry[] = [];

  log(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  getAll(): AuditEntry[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }
}

export const auditLogger = new AuditLogger();
