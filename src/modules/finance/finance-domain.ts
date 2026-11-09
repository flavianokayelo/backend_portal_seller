export type FinanceSource = "venda_express" | "sete";

export interface FinanceOrder {
  id: string;
  source: FinanceSource;
  reference: string;
  status: string;
  amount: number | null;
  paymentMethod: string | null;
  createdAt: string;
}

export interface FinanceMetric {
  value: number | null;
  knownValue: number;
  count: number;
  missingAmountCount: number;
  complete: boolean;
}

export interface FinanceSnapshot {
  orders: FinanceOrder[];
  summary: {
    currency: "AOA";
    period: string;
    orderCount: number;
    orderCountComplete: boolean;
    orderedValue: FinanceMetric;
    paidValue: FinanceMetric;
    pendingPaymentValue: FinanceMetric;
    pendingOrderValue: FinanceMetric;
    cancelledValue: FinanceMetric;
    refundedValue: FinanceMetric;
    netValue: FinanceMetric;
    commissionValue: FinanceMetric;
    availableBalance: FinanceMetric;
    legacyUnavailable: boolean;
    legacyHistoryMayBeTruncated: boolean;
    legacyPaymentStatusAvailable: boolean;
    salesPaymentConfirmationAvailable: boolean;
    generatedAt: string;
  };
}

function numericAmount(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (String(value).trim() === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function dateMillis(value: unknown): number {
  const parsed = Date.parse(String(value ?? "").replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function inPeriod(order: FinanceOrder, from: number | null, until: number | null): boolean {
  if (from === null && until === null) return true;
  const at = dateMillis(order.createdAt);
  if (!at) return false;
  return (from === null || at >= from) && (until === null || at <= until);
}

export function deduplicateFinanceOrders(orders: FinanceOrder[]): FinanceOrder[] {
  const unique = new Map<string, FinanceOrder>();
  for (const order of orders) {
    const key = `${order.source}:${order.id}`;
    const current = unique.get(key);
    if (!current || dateMillis(order.createdAt) > dateMillis(current.createdAt)) unique.set(key, order);
  }
  return [...unique.values()];
}

export function nativeFinanceOrder(row: Record<string, any>): FinanceOrder {
  return {
    id: String(row.id),
    source: "venda_express",
    reference: String(row.reference ?? row.order_ref ?? row.id),
    status: String(row.status ?? "unknown"),
    amount: numericAmount(row.total),
    paymentMethod: typeof row.payment_method === "string" ? row.payment_method : null,
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
  };
}

export function legacyFinanceOrder(row: Record<string, any>): FinanceOrder {
  return {
    id: String(row.id),
    source: "sete",
    reference: String(row.order_ref ?? row.reference ?? row.id),
    status: String(row.loja_status ?? "unknown"),
    amount: numericAmount(row.total),
    // The legacy orders contract exposes a method label, not a payment confirmation.
    paymentMethod: typeof row.method_payment === "string" ? row.method_payment : null,
    createdAt: String(row.created_at ?? ""),
  };
}

function metric(orders: FinanceOrder[], relevant: (order: FinanceOrder) => boolean, sourceDataComplete: boolean): FinanceMetric {
  const rows = orders.filter(relevant);
  const missingAmountCount = rows.filter((order) => order.amount === null).length;
  const complete = sourceDataComplete && missingAmountCount === 0;
  return {
    value: complete ? rows.reduce((sum, order) => sum + (order.amount ?? 0), 0) : null,
    knownValue: rows.reduce((sum, order) => sum + (order.amount ?? 0), 0),
    count: rows.length,
    missingAmountCount,
    complete,
  };
}

export function buildFinanceSnapshot(
  inputOrders: FinanceOrder[],
  options: {
    period: string;
    from: number | null;
    until: number | null;
    legacyLinked: boolean;
    legacyUnavailable: boolean;
    legacyHistoryMayBeTruncated: boolean;
    nativeHistoryComplete: boolean;
  },
): FinanceSnapshot {
  const orders = deduplicateFinanceOrders(inputOrders)
    .filter((order) => inPeriod(order, options.from, options.until))
    .sort((a, b) => dateMillis(b.createdAt) - dateMillis(a.createdAt));
  const sourceDataComplete = options.nativeHistoryComplete && !options.legacyUnavailable && !options.legacyHistoryMayBeTruncated;
  const isPendingOrder = (order: FinanceOrder) =>
    (order.source === "venda_express" && order.status === "pending") ||
    (order.source === "sete" && order.status === "pendente");
  const isCancelled = (order: FinanceOrder) =>
    (order.source === "venda_express" && order.status === "cancelled") ||
    (order.source === "sete" && order.status === "recusado");

  return {
    orders,
    summary: {
      currency: "AOA",
      period: options.period,
      orderCount: orders.length,
      orderCountComplete: sourceDataComplete,
      orderedValue: metric(orders, () => true, sourceDataComplete),
      // The order status is seller-controlled workflow state, not proof of a sale payment.
      paidValue: { value: null, knownValue: 0, count: 0, missingAmountCount: 0, complete: false },
      pendingPaymentValue: { value: null, knownValue: 0, count: 0, missingAmountCount: 0, complete: false },
      pendingOrderValue: metric(orders, isPendingOrder, sourceDataComplete),
      cancelledValue: metric(orders, isCancelled, sourceDataComplete),
      // No seller sales-refund, commission or payout contract exists in these adapters.
      refundedValue: { value: null, knownValue: 0, count: 0, missingAmountCount: 0, complete: false },
      netValue: { value: null, knownValue: 0, count: 0, missingAmountCount: 0, complete: false },
      commissionValue: { value: null, knownValue: 0, count: 0, missingAmountCount: 0, complete: false },
      availableBalance: { value: null, knownValue: 0, count: 0, missingAmountCount: 0, complete: false },
      legacyUnavailable: options.legacyUnavailable,
      legacyHistoryMayBeTruncated: options.legacyHistoryMayBeTruncated,
      legacyPaymentStatusAvailable: false,
      salesPaymentConfirmationAvailable: false,
      generatedAt: new Date().toISOString(),
    },
  };
}

export function periodBounds(period: string, now = new Date()): { from: number | null; until: number | null } {
  if (period === "all") return { from: null, until: null };
  const days = period === "7d" ? 7 : period === "30d" ? 30 : period === "90d" ? 90 : null;
  if (!days) throw new Error("Unsupported finance period");
  return { from: now.getTime() - days * 24 * 60 * 60 * 1000, until: now.getTime() };
}
