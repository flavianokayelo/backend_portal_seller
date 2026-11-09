import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SessionPayload {
  id: string;
  name?: string;
  email: string;
  role: string;
  supplierId?: string;
  storeId?: string;
  vendaExpressToken?: string;
  accountKind?: "loja" | "fornecedor";
  businessType?: "store" | "restaurant";
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET não está configurado.");
  if (
    process.env.NODE_ENV === "production" &&
    (value.length < 32 || value === "change-me-in-production")
  ) {
    throw new Error("SESSION_SECRET de produção é inválido ou demasiado curto.");
  }
  return value;
}

function signature(encodedPayload: string, key: string): Buffer {
  return createHmac("sha256", key).update(encodedPayload).digest();
}

export function signSessionCookie(
  payload: Omit<SessionPayload, "iat" | "exp">,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      ...payload,
      // ADICIONADO: o backend PHP/PDO pode devolver o id como número.
      // O verifySessionCookie exige id do tipo string, por isso converto aqui.
      ...(payload.id !== undefined && payload.id !== null
        ? { id: String(payload.id) }
        : {}),
      iat: nowSeconds,
      exp: nowSeconds + SESSION_TTL_SECONDS,
    }),
  ).toString("base64url");
  return `${encodedPayload}.${signature(encodedPayload, secret()).toString("base64url")}`;
}

export function verifySessionCookie(
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  const [encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra.length) return null;

  let expected: Buffer;
  let received: Buffer;
  try {
    const key = secret();
    expected = signature(encodedPayload, key);
    received = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as SessionPayload;
    if (
      typeof payload.id !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.iat > nowSeconds + 60 ||
      payload.exp <= nowSeconds ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > SESSION_TTL_SECONDS
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * ADICIONADO: diagnóstico. Faz as mesmas verificações do verifySessionCookie,
 * mas devolve o MOTIVO exato da falha (para ir parar aos logs).
 * Nunca devolve o segredo nem o conteúdo do cookie, só tipos e tamanhos.
 */
export function diagnoseSessionCookie(
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { reason: string; details: Record<string, unknown> } {
  const details: Record<string, unknown> = { cookieLength: token.length };

  const [encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra.length) {
    return { reason: "formato_invalido", details };
  }

  let expected: Buffer;
  let received: Buffer;
  try {
    expected = signature(encodedPayload, secret());
    received = Buffer.from(encodedSignature, "base64url");
  } catch (error) {
    details.error = error instanceof Error ? error.message : String(error);
    return { reason: "secret_invalido_ou_em_falta", details };
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { reason: "assinatura_nao_confere", details };
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as SessionPayload;

    details.types = {
      id: typeof payload.id,
      email: typeof payload.email,
      role: typeof payload.role,
      iat: typeof payload.iat,
      exp: typeof payload.exp,
    };

    if (typeof payload.id !== "string") return { reason: "id_nao_e_string", details };
    if (typeof payload.email !== "string") return { reason: "email_em_falta", details };
    if (typeof payload.role !== "string") return { reason: "role_em_falta", details };
    if (typeof payload.iat !== "number") return { reason: "iat_em_falta", details };
    if (typeof payload.exp !== "number") return { reason: "exp_em_falta", details };

    details.segundosAteExpirar = payload.exp - nowSeconds;
    if (payload.iat > nowSeconds + 60) return { reason: "iat_no_futuro", details };
    if (payload.exp <= nowSeconds) return { reason: "expirado", details };
    if (payload.exp <= payload.iat) return { reason: "exp_menor_que_iat", details };
    if (payload.exp - payload.iat > SESSION_TTL_SECONDS) {
      return { reason: "ttl_excedido", details };
    }
  } catch {
    return { reason: "payload_ilegivel", details };
  }

  return { reason: "valido", details };
}