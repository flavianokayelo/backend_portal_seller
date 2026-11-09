import { AppError, BadGatewayError } from "../../shared/utils/errors";

export type OrderSource = "venda_express" | "sete";
export type LegacyAction = "accept" | "refuse" | "preparar" | "a_caminho" | "entregue";
export type NativeOrder = Record<string, any> & { id: string | number; items?: unknown[] };
export type LegacyOrder = Record<string, any> & { id: string | number; items?: unknown[] };

export function isNativeSource(value: string): boolean {
  return value === "vendaexpress" || value === "venda_express";
}

export function isLegacySource(value: string): boolean {
  return value === "7sete" || value === "sete";
}

export function normalizeNativeStatus(value: unknown): string {
  if (value === "paid") return "confirmed";
  if (value === "canceled") return "cancelled";
  if (value === "processing" || value === "preparing") return "preparing";
  if (value === "ready") return "ready";
  if (["pending", "confirmed", "preparing", "ready", "shipped", "delivered", "cancelled"].includes(String(value))) {
    return String(value);
  }
  throw new BadGatewayError("O backend VendaExpress devolveu um estado de pedido não suportado.");
}

export function normalizeLegacyStatus(value: unknown): string {
  if (value === "pendente") return "pending";
  if (value === "atendido") return "confirmed";
  if (value === "em_preparacao") return "preparing";
  if (value === "a_caminho") return "shipped";
  if (value === "entregue") return "delivered";
  if (value === "recusado") return "cancelled";
  throw new BadGatewayError("A API legada devolveu um estado de pedido não suportado.");
}

export function canTransitionNativeStatus(current: string, next: string): boolean {
  const allowed: Record<string, string[]> = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["preparing", "shipped", "cancelled"],
    preparing: ["shipped", "cancelled"],
    ready: ["shipped", "cancelled"],
    shipped: ["delivered", "cancelled"],
    delivered: [],
    cancelled: [],
  };
  return current === next || (allowed[current] ?? []).includes(next);
}

export function toNativeStatus(action: Extract<LegacyAction, "accept" | "refuse">): "paid" | "cancelled" {
  return action === "accept" ? "paid" : "cancelled";
}

export function toLegacyAction(action: Extract<LegacyAction, "accept" | "refuse">): "atender" | "recusar" {
  return action === "accept" ? "atender" : "recusar";
}

/** Mapeia estado do portal → action PHP em loja-pedidos.php */
export function portalStatusToLegacyAction(
  status: string,
): "atender" | "recusar" | "preparar" | "a_caminho" | "entregue" | null {
  if (status === "confirmed") return "atender";
  if (status === "cancelled") return "recusar";
  if (status === "preparing") return "preparar";
  if (status === "shipped") return "a_caminho";
  if (status === "delivered") return "entregue";
  return null;
}

function numeric(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

export function nativeOrderDto(order: NativeOrder) {
  const total = numeric(order.total);
  return {
    id: String(order.id),
    reference: String(order.reference ?? order.order_ref ?? order.id),
    source: "venda_express",
    customerId: String(order.customer_id ?? order.customerId ?? ""),
    customerName: String(order.customer_name ?? ""),
    customerPhone: String(order.customer_phone ?? ""),
    createdAt: order.created_at ?? order.createdAt ?? "",
    status: normalizeNativeStatus(order.status),
    items: (Array.isArray(order.items) ? order.items : []).map((item: any) => ({
      productId: String(item.product_id ?? item.productId ?? ""),
      source: "vendaexpress",
      name: String(item.product_name ?? item.name ?? ""),
      sku: String(item.sku ?? ""),
      quantity: numeric(item.quantity),
      unitPrice: numeric(item.unit_price ?? item.price),
    })),
    subtotal: numeric(order.subtotal, total),
    shipping: numeric(order.shipping ?? order.delivery_fee),
    discount: numeric(order.discount),
    total,
    paymentMethod: order.payment_method ?? "outro",
    deliveryMethod: order.delivery_method ?? "outro",
    deliveryCity: order.delivery_city ?? order.city ?? "",
    deliveryAddress: order.customer_address ?? order.delivery_address ?? "",
    note: order.note ?? null,
    statusHistory: Array.isArray(order.status_history) ? order.status_history : [],
  };
}

export function legacyOrderDto(order: LegacyOrder) {
  const total = numeric(order.total);
  const status = normalizeLegacyStatus(order.loja_status);
  return {
    id: String(order.id),
    reference: String(order.order_ref ?? order.reference ?? order.id),
    source: "sete",
    customerId: String(order.customer_id ?? ""),
    customerName: String(order.customer_name ?? ""),
    customerPhone: String(order.customer_phone ?? ""),
    createdAt: order.created_at ?? "",
    status,
    sourceStatus: String(order.loja_status ?? ""),
    canAccept: order.loja_status === "pendente" && order.can_atender !== false,
    canRefuse: order.loja_status === "pendente",
    items: (Array.isArray(order.items) ? order.items : []).map((item: any) => ({
      productId: String(item.id ?? item.product_id ?? ""),
      source: item.item_type === "product" ? "vendaexpress" : "7sete",
      name: String(item.name ?? item.product_name ?? ""),
      sku: String(item.sku ?? ""),
      quantity: numeric(item.quantity),
      unitPrice: numeric(item.price ?? item.unit_price),
      photo: item.photo ?? null,
    })),
    subtotal: numeric(order.subtotal, total),
    shipping: numeric(order.custo_entrega ?? order.shipping),
    discount: numeric(order.discount),
    total,
    paymentMethod: order.method_payment ?? "outro",
    deliveryMethod: "entrega",
    deliveryCity: [order.municipio, order.provincia].filter(Boolean).join(", "),
    deliveryAddress: order.morada ?? order.detalhe_rua ?? "",
    note: order.note ?? null,
    statusHistory: [],
  };
}

export function normalizeLegacyEnvelope(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadGatewayError("A API legada devolveu uma resposta inválida.");
  }
  const response = value as Record<string, any>;
  if (response.success === true) return response;
  const status = Number(response.status ?? response.statusCode);
  if ([400, 404, 409, 422].includes(status)) {
    throw new AppError(String(response.message ?? response.error ?? "A operação no 7Sete foi recusada."), status, "LEGACY_ORDER_REJECTED");
  }
  throw new BadGatewayError(String(response.message ?? response.error ?? "A API legada não confirmou a operação."));
}

export function normalizeLegacyActionResponse(
  response: Record<string, any>,
  current: LegacyOrder,
  action: Extract<LegacyAction, "accept" | "refuse">,
): LegacyOrder {
  const resultId = response.pedido_id;
  if (resultId != null && String(resultId) !== String(current.id)) {
    throw new BadGatewayError("A API legada devolveu um identificador de pedido diferente.");
  }
  const expectedStatus = action === "accept" ? "atendido" : "recusado";
  if (response.loja_status !== expectedStatus) {
    throw new BadGatewayError("A API legada não confirmou a alteração do pedido.");
  }
  return { ...current, loja_status: response.loja_status, can_atender: false };
}
