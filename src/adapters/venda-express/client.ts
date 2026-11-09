import axios, { AxiosError, AxiosInstance } from "axios";
import { AsyncLocalStorage } from "node:async_hooks";
import { structuredLog } from "../../shared/utils/errors";

export class VendaExpressError extends Error {
  constructor(
    message: string,
    readonly upstreamStatus?: number,
    readonly upstreamResponse?: unknown,
    readonly code?: string,
  ) {
    super(message);
    this.name = "VendaExpressError";
  }
}

export function isVendaExpressError(
  error: unknown,
): error is VendaExpressError {
  return error instanceof VendaExpressError;
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return "";
  const parsed = new URL(normalized);
  return parsed.pathname === "" || parsed.pathname === "/"
    ? `${normalized}/api`
    : normalized;
}

function finalUrl(config: {
  baseURL?: string;
  url?: string;
}): string | undefined {
  if (!config.url) return config.baseURL;
  try {
    const base = (config.baseURL ?? "").replace(/\/+$/, "");
    const path = config.url.replace(/^\/+/, "");
    return new URL(`${base}/${path}`).toString();
  } catch {
    return config.url;
  }
}

export class VendaExpressAdapter {
  private client: AxiosInstance;
  private token: string | null = null;
  private readonly requestToken = new AsyncLocalStorage<string | undefined>();

  constructor(
    baseUrl: string = process.env.VENDA_EXPRESS_BASE_URL ||
      "https://vendaexpress.ao/api",
  ) {
    this.client = axios.create({
      baseURL: normalizeBaseUrl(baseUrl),
      timeout: 15_000,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    this.client.interceptors.request.use((config) => {
      const token = this.requestToken.getStore() ?? this.token;
      if (token) config.headers.Authorization = `Bearer ${token}`;
      return config;
    });

    this.client.interceptors.response.use(
      (res) => res,
      (error: AxiosError) => {
        structuredLog({
          level: "error",
          message: "VendaExpress adapter error",
          context: {
            url: finalUrl(error.config ?? {}),
            status: error.response?.status,
            code: error.code,
            message: error.message,
            response: error.response?.data,
          },
        });
        throw new VendaExpressError(
          "VendaExpress request failed",
          error.response?.status,
          error.response?.data,
          error.code,
        );
      },
    );
  }

  setToken(token: string): void {
    this.token = token;
  }
  clearToken(): void {
    this.token = null;
  }
  runWithToken<T>(token: string | undefined, callback: () => T): T {
    return this.requestToken.run(token, callback);
  }

  async post<T = unknown>(path: string, data?: unknown): Promise<T> {
    return (await this.client.post<T>(path, data)).data;
  }
  async postStream<T = unknown>(
    path: string,
    body: NodeJS.ReadableStream,
    headers: Record<string, string>,
  ): Promise<T> {
    return (await this.client.post<T>(path, body, { headers })).data;
  }
  async get<T = unknown>(path: string): Promise<T> {
    return (await this.client.get<T>(path)).data;
  }
  async patch<T = unknown>(path: string, data?: unknown): Promise<T> {
    return (await this.client.patch<T>(path, data)).data;
  }
  async put<T = unknown>(path: string, data?: unknown): Promise<T> {
    return (await this.client.put<T>(path, data)).data;
  }
  async delete<T = unknown>(path: string): Promise<T> {
    return (await this.client.delete<T>(path)).data;
  }
}

export const vendaExpressAdapter = new VendaExpressAdapter();
