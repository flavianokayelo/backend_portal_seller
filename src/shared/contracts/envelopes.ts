export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  requestId?: string;
  [key: string]: unknown;
}

export interface ApiEnvelope<T> {
  data: T;
  meta?: ApiMeta;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export function successEnvelope<T>(data: T, meta?: ApiMeta): ApiEnvelope<T> {
  return { data, meta };
}

export function listEnvelope<T>(
  items: T[],
  page: number,
  limit: number,
  total: number,
  requestId: string,
): ApiEnvelope<T[]> {
  return {
    data: items,
    meta: { page, limit, total, requestId },
  };
}

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  return {
    error: { code, message, details, requestId },
  };
}
