export type StoreOrigin = "native" | "legacy";

export function legacyStoreId(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") {
    throw new Error("O backend devolveu um id_loja_antiga inválido.");
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("O backend devolveu um id_loja_antiga inválido.");
  }
  return parsed;
}

export function storeOrigin(value: unknown): StoreOrigin {
  return legacyStoreId(value) === null ? "native" : "legacy";
}

export function supportsStoreUpdate(origin: StoreOrigin, input: Record<string, unknown>): boolean {
  return origin === "native" || Object.keys(input).length === 0;
}

export function storeOwnedBy(ownerId: unknown, userId: unknown, storeId: unknown, sessionStoreId?: unknown): boolean {
  if (!ownerId || !userId || !storeId || String(ownerId) !== String(userId)) return false;
  return sessionStoreId == null || String(sessionStoreId) === String(storeId);
}

export function nativeStoreUpdate(input: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  if (input.name !== undefined) result.name = input.name;
  if (input.description !== undefined) result.description = input.description;
  if (input.whatsapp !== undefined) result.whatsapp = input.whatsapp;
  if (input.businessType !== undefined) result.business_type = input.businessType;
  if (input.avatarUrl !== undefined) result.logo_url = input.avatarUrl;
  if (input.coverUrl !== undefined) result.banner_urls = [input.coverUrl];

  const address: Record<string, unknown> = {};
  if (input.address !== undefined) address.street = input.address;
  if (input.city !== undefined) address.municipality = input.city;
  if (input.province !== undefined) address.province = input.province;
  if (Object.keys(address).length > 0) result.address = address;
  return result;
}

