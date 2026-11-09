import axios, { AxiosInstance, AxiosError } from "axios";
import { BadGatewayError, structuredLog } from "../../shared/utils/errors";

/**
 * Adapter para o backend PHP do 7Sete.
 *
 * Base URL documentada: https://7sete.ao/api_mobile/
 *
 * Estado validado em 2026-11-05: a raiz /api_mobile/ responde HTML da
 * hospedagem e um GET sem autenticacao a /loja-pedidos.php responde HTTP 405
 * com JSON. Isso confirma o caminho, mas nao valida o POST de listagem nem a
 * identidade/ownership necessaria para consultar pedidos.
 *
 * Este adapter chama os endpoints existentes e nao mascara falhas como sucesso.
 */
export class SetePhpAdapter {
  private client: AxiosInstance;

  constructor(
    baseUrl: string =
      process.env.SEVEN_SETE_BASE_URL || "https://7sete.ao/api_mobile/",
  ) {
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 15_000,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    this.client.interceptors.response.use(
      (res) => res,
      (error: AxiosError) => {
        structuredLog({
          level: "error",
          message: "7Sete PHP adapter error",
          context: {
            url: error.config?.url,
            status: error.response?.status,
            code: error.code,
            message: error.message,
          },
        });
        throw new BadGatewayError("Sistema 7Sete indisponível.");
      },
    );
  }

  async post<T = unknown>(path: string, data?: unknown): Promise<T> {
    const res = await this.client.post<T>(path, data);
    return res.data;
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await this.client.get<T>(path);
    return res.data;
  }

  async patch<T = unknown>(path: string, data?: unknown): Promise<T> {
    const res = await this.client.patch<T>(path, data);
    return res.data;
  }

  async delete<T = unknown>(path: string): Promise<T> {
    const res = await this.client.delete<T>(path);
    return res.data;
  }
}

export const setePhpAdapter = new SetePhpAdapter();
