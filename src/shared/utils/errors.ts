import crypto from "node:crypto";
import { idempotencyStore } from "./idempotency";

export { idempotencyStore };

export function generateRequestId(): string {
  return `req_${crypto.randomBytes(12).toString("hex")}`;
}

export interface StructuredLog {
  level: "info" | "warn" | "error";
  requestId?: string;
  message: string;
  context?: Record<string, unknown>;
}

export function structuredLog(entry: StructuredLog): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level: entry.level,
    requestId: entry.requestId,
    message: entry.message,
    context: entry.context,
  };

  // Never log secrets, tokens, passwords, or full IBANs.
  const sanitized = JSON.stringify(
    payload,
    (_key, value) => {
      if (
        typeof value === "string" &&
        (/_?token|password|secret|iban|authorization|cookie|session/i.test(_key as string))
      ) {
        return "[REDACTED]";
      }
      return value;
    },
    2,
  );

  if (entry.level === "error") {
    console.error(sanitized);
  } else {
    console.log(sanitized);
  }
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`O recurso "${resource}" não foi encontrado.`, 404, "RESOURCE_NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

export class ValidationError extends AppError {
  constructor(message: string, public readonly details?: unknown) {
    super(message, 422, "VALIDATION_FAILED");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Não autenticado.") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Sem permissão para este recurso.") {
    super(message, 403, "FORBIDDEN");
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Limite de pedidos excedido.") {
    super(message, 429, "TOO_MANY_REQUESTS");
  }
}

export class BadGatewayError extends AppError {
  constructor(message = "Sistema de origem indisponível.") {
    super(message, 502, "BAD_GATEWAY");
  }
}

export function idempotencyKey(): string {
  return `idk_${crypto.randomBytes(16).toString("hex")}`;
}
