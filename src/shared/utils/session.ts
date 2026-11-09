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
