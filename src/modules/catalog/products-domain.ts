import { AppError } from "../../shared/utils/errors";

export type ProductOrigin = "venda_express" | "sete";

export function productOrigin(source: unknown, id?: unknown): ProductOrigin {
  if (source === "sete" || source === "7sete" || source === "legacy") return "sete";
  if (typeof id === "string" && id.startsWith("sete-")) return "sete";
  return "venda_express";
}

export function legacyProductId(id: string): number | null {
  const match = /^sete-(\d+)$/.exec(id);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function productIdentityKey(source: ProductOrigin, id: unknown): string {
  return `${source}:${String(id)}`;
}

export function requireProductOrigin(id: string, source: ProductOrigin): void {
  const isLegacyId = legacyProductId(id) !== null;
  if (isLegacyId !== (source === "sete")) {
    throw new AppError("A origem do produto não corresponde ao identificador enviado.", 422, "PRODUCT_SOURCE_MISMATCH");
  }
}

export function mergeProductPatch<T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown>,
): T {
  return { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
}

export function toLegacyProductPayload(product: Record<string, any>) {
  return {
    name: product.name,
    description: product.description ?? "",
    price: product.price,
    compare_at_price: product.compareAtPrice ?? null,
    stock: product.productKind === "digital" ? 0 : product.stock,
    active: product.status === "published",
    product_kind: product.productKind ?? "fisico",
    return_policy: product.returnPolicy ?? "",
  };
}

export function supportsLegacyProductPatch(patch: Record<string, unknown>): boolean {
  const supported = new Set([
    "name", "description", "price", "compareAtPrice", "stock",
    "status", "productKind", "returnPolicy",
  ]);
  return Object.keys(patch).every((key) => supported.has(key));
}

export function statusFilter(value: string | undefined): "all" | "active" | "inactive" {
  if (!value || value === "all") return "all";
  if (value === "published" || value === "active") return "active";
  if (value === "archived" || value === "inactive") return "inactive";
  throw new AppError("O VendaExpress não distingue rascunho de produto inactivo.", 422, "PRODUCT_STATUS_UNSUPPORTED");
}

