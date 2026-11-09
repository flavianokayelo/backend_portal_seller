import { signSessionCookie, SessionPayload } from "../shared/utils/session";

export function testSessionCookie(
  overrides: Partial<SessionPayload> = {},
): string {
  const token = signSessionCookie({
    id: "seller-1",
    name: "Seller Test",
    email: "seller@example.test",
    role: "seller",
    supplierId: "supplier-1",
    storeId: "store-1",
    vendaExpressToken: "test-token",
    accountKind: "loja",
    ...overrides,
  });
  return `${process.env.SESSION_COOKIE_NAME || "sid"}=${token}`;
}
