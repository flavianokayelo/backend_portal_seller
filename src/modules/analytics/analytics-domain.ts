export type AnalyticsSource = "venda_express" | "sete";

export interface AnalyticsOrder {
  id: string;
  source: AnalyticsSource;
  status: string;
  total: number | null;
  createdAt: string;
  customerId: string | null;
  customerName: string | null;
  items: Array<{
    id: string;
    source: AnalyticsSource;
    name: string;
    quantity: number;
  }>;
}

export interface AnalyticsProduct {
  id: string;
  source: AnalyticsSource;
  name: string;
  stock: number;
  threshold: number | null;
  published: boolean;
}

export interface AnalyticsMetric {
  value: number | null;
  knownValue: number;
  complete: boolean;
}

export interface AnalyticsSourceStatus {
  source: AnalyticsSource;
  linked: boolean;
  ordersAvailable: boolean;
  ordersComplete: boolean;
  itemsComplete: boolean;
  productsAvailable: boolean;
  productsComplete: boolean;
}

export interface AnalyticsSnapshot {
  period: string;
  currency: "AOA";
  summary: {
    totalOrders: AnalyticsMetric;
    grossOrderValue: AnalyticsMetric;
    averageOrderValue: AnalyticsMetric;
  };
  series: Array<{ date: string; orders: AnalyticsMetric; grossOrderValue: AnalyticsMetric }>;
  topProducts: Array<{ id: string; source: AnalyticsSource; name: string; unitsOrdered: number; complete: boolean }>;
  lowStockProducts: Array<{ id: string; source: AnalyticsSource; name: string; stock: number; threshold: number | null }>;
  topCustomers: Array<{ id: string; source: AnalyticsSource; name: string; orderCount: number; complete: boolean }>;
  lowStockComplete: boolean;
  orderStatusBreakdown: Array<{ status: string; count: number; complete: boolean }>;
  sourceBreakdown: Array<{ source: AnalyticsSource; orders: AnalyticsMetric; grossOrderValue: AnalyticsMetric }>;
  sourceStatus: AnalyticsSourceStatus[];
  dataComplete: boolean;
  generatedAt: string;
}

function dateMillis(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  // The legacy database uses Angola local time for timestamps without an offset.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}+01:00`
    : /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+01:00` : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function luandaDateKey(value: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Luanda", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftDateKey(key: string, offset: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return date.toISOString().slice(0, 10);
}

function monthKey(key: string): string {
  return key.slice(0, 7);
}

function statusKey(order: AnalyticsOrder): string {
  const raw = order.status.trim().toLowerCase();
  if (order.source === "sete") {
    if (raw === "pendente") return "pending";
    if (raw === "atendido") return "confirmed";
    if (raw === "recusado") return "cancelled";
  } else {
    if (raw === "paid") return "confirmed";
    if (raw === "canceled") return "cancelled";
    if (["pending", "confirmed", "preparing", "ready", "shipped", "delivered", "cancelled"].includes(raw)) return raw;
  }
  return raw || "unknown";
}

function cancelled(order: AnalyticsOrder): boolean {
  return statusKey(order) === "cancelled";
}

function finiteAmount(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function metric(knownValue: number, complete: boolean): AnalyticsMetric {
  return { value: complete ? knownValue : null, knownValue, complete };
}

function deduplicateOrders(orders: AnalyticsOrder[]): AnalyticsOrder[] {
  const unique = new Map<string, AnalyticsOrder>();
  for (const order of orders) {
    const key = `${order.source}:${order.id}`;
    if (!unique.has(key)) unique.set(key, order);
  }
  return [...unique.values()];
}

export function buildAnalyticsSnapshot(input: {
  period: "7d" | "30d" | "90d" | "all";
  now?: Date;
  orders: AnalyticsOrder[];
  products: AnalyticsProduct[];
  sources: AnalyticsSourceStatus[];
}): AnalyticsSnapshot {
  const now = input.now ?? new Date();
  const nowMillis = now.getTime();
  const todayKey = luandaDateKey(nowMillis);
  const startKey = input.period === "all"
    ? null
    : shiftDateKey(todayKey, -(Number(input.period.slice(0, -1)) - 1));
  const daily = input.period !== "all";
  const groups = new Map<string, AnalyticsOrder[]>();
  const hasUnknownDates = input.orders.some((order) => dateMillis(order.createdAt) === null);
  const orders = deduplicateOrders(input.orders).filter((order) => {
    if (input.period === "all") return true;
    const at = dateMillis(order.createdAt);
    if (at === null) return false;
    const key = luandaDateKey(at);
    return at <= nowMillis && key >= (startKey ?? "0000-00-00") && key <= todayKey;
  });

  const sourceComplete = input.sources.every((source) => !source.linked || (source.ordersAvailable && source.ordersComplete));
  const membershipComplete = sourceComplete && (input.period === "all" || !hasUnknownDates);
  const amountComplete = membershipComplete && orders.every((order) => finiteAmount(order.total));
  const seriesComplete = sourceComplete && !hasUnknownDates;

  for (const order of orders) {
    const at = dateMillis(order.createdAt);
    if (at === null) continue;
    const dateKey = luandaDateKey(at);
    const key = daily ? dateKey : monthKey(dateKey);
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }

  let bucketKeys: string[];
  if (daily) {
    const days = Number(input.period.slice(0, -1));
    bucketKeys = Array.from({ length: days }, (_, index) => shiftDateKey(todayKey, index - days + 1));
  } else {
    const dated = [...groups.keys()].sort();
    const firstMonth = dated[0] ?? monthKey(todayKey);
    const [startYear, startMonth] = firstMonth.split("-").map(Number);
    const [endYear, endMonth] = todayKey.split("-").map(Number);
    const count = Math.max(1, (endYear - startYear) * 12 + endMonth - startMonth + 1);
    bucketKeys = Array.from({ length: count }, (_, index) => {
      const date = new Date(Date.UTC(startYear, startMonth - 1 + index, 1));
      return date.toISOString().slice(0, 7);
    });
  }

  const series = bucketKeys.map((date) => {
    const bucket = groups.get(date) ?? [];
    const complete = seriesComplete && bucket.every((order) => finiteAmount(order.total));
    return {
      date,
      orders: metric(bucket.length, seriesComplete),
      grossOrderValue: metric(bucket.reduce((sum, order) => sum + (finiteAmount(order.total) ? order.total : 0), 0), complete),
    };
  });

  const gross = orders.reduce((sum, order) => sum + (finiteAmount(order.total) ? order.total : 0), 0);
  const ordersMetric = metric(orders.length, membershipComplete);
  const grossMetric = metric(gross, amountComplete);
  const averageComplete = amountComplete && orders.length > 0;
  const average = orders.length ? gross / orders.length : 0;

  const itemsComplete = membershipComplete && input.sources.every((source) => !source.linked || (source.ordersAvailable && source.ordersComplete && source.itemsComplete));
  const productTotals = new Map<string, { id: string; source: AnalyticsSource; name: string; quantity: number }>();
  const customerTotals = new Map<string, { id: string; source: AnalyticsSource; name: string; count: number }>();
  for (const order of orders) {
    if (cancelled(order)) continue;
    for (const item of order.items) {
      const key = `${item.source}:${item.id}`;
      const record = productTotals.get(key) ?? { id: item.id, source: item.source, name: item.name || item.id, quantity: 0 };
      record.quantity += item.quantity;
      productTotals.set(key, record);
    }
    const customerKey = order.customerId
      ? `${order.source}:${order.customerId}`
      : `${order.source}:name:${order.customerName ?? "unknown"}`;
    const customer = customerTotals.get(customerKey) ?? {
      id: order.customerId ?? customerKey,
      source: order.source,
      name: order.customerName || "Cliente não identificado",
      count: 0,
    };
    customer.count += 1;
    customerTotals.set(customerKey, customer);
  }

  const statusCounts = new Map<string, number>();
  const sourceBreakdown = input.sources.filter((source) => source.linked).map((source) => {
    const sourceOrders = orders.filter((order) => order.source === source.source);
    const sourceAmount = sourceOrders.reduce((sum, order) => sum + (finiteAmount(order.total) ? order.total : 0), 0);
    return {
      source: source.source,
      orders: metric(sourceOrders.length, source.ordersAvailable && source.ordersComplete && (input.period === "all" || !hasUnknownDates)),
      grossOrderValue: metric(sourceAmount, source.ordersAvailable && source.ordersComplete && (input.period === "all" || !hasUnknownDates) && sourceOrders.every((order) => finiteAmount(order.total))),
    };
  });
  for (const order of orders) statusCounts.set(statusKey(order), (statusCounts.get(statusKey(order)) ?? 0) + 1);

  const lowStockProducts = input.products.filter((product) => product.published && (product.stock === 0 || (product.threshold !== null && product.threshold > 0 && product.stock <= product.threshold)))
    .map(({ id, source, name, stock, threshold }) => ({ id, source, name, stock, threshold }))
    .sort((a, b) => a.stock - b.stock);

  const productsComplete = input.sources.every((source) => !source.linked || (source.productsAvailable && source.productsComplete));
  return {
    period: input.period,
    currency: "AOA",
    summary: {
      totalOrders: ordersMetric,
      grossOrderValue: grossMetric,
      averageOrderValue: metric(average, averageComplete),
    },
    series,
    topProducts: [...productTotals.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10).map((product) => ({
      id: product.id, source: product.source, name: product.name, unitsOrdered: product.quantity, complete: itemsComplete,
    })),
    lowStockProducts,
    topCustomers: [...customerTotals.values()].sort((a, b) => b.count - a.count).slice(0, 10).map((customer) => ({
      id: customer.id, source: customer.source, name: customer.name, orderCount: customer.count, complete: membershipComplete,
    })),
    lowStockComplete: input.sources.every((source) => !source.linked || (source.productsAvailable && source.productsComplete)),
    orderStatusBreakdown: [...statusCounts.entries()].map(([status, count]) => ({ status, count, complete: membershipComplete })),
    sourceBreakdown,
    sourceStatus: input.sources,
    dataComplete: sourceComplete && amountComplete && itemsComplete && productsComplete,
    generatedAt: now.toISOString(),
  };
}

export function normalizeAnalyticsStatus(order: AnalyticsOrder): string {
  return statusKey(order);
}
