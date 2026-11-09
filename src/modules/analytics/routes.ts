import { Router, type Request } from "express";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  AppError,
  BadGatewayError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  generateRequestId,
} from "../../shared/utils/errors";
import { authMiddleware } from "../../middleware/auth";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { setePhpAdapter } from "../../adapters/sete-php/client";
import { normalizeLegacyEnvelope } from "../orders/orders-domain";
import {
  buildAnalyticsSnapshot,
  type AnalyticsOrder,
  type AnalyticsProduct,
  type AnalyticsSource,
  type AnalyticsSourceStatus,
} from "./analytics-domain";

const router = Router();
const PAGE_SIZE = 100;
type Row = Record<string, any>;
type Period = "7d" | "30d" | "90d" | "all";

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
}

function selectedPeriod(req: Request): Period {
  const period = queryString(req, "period") ?? "30d";
  if (period !== "7d" && period !== "30d" && period !== "90d" && period !== "all") {
    throw new ValidationError("Período inválido. Use 7d, 30d, 90d ou all.");
  }
  return period;
}

async function upstream<T>(operation: () => Promise<T>, resource: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new BadGatewayError(`Não foi possível validar ${resource} no sistema de origem.`);
  }
}

interface AnalyticsContext {
  userId: string;
  storeId: string;
  legacyStoreId: number | null;
}

async function authorizedContext(req: Request): Promise<AnalyticsContext> {
  if (!req.user?.vendaExpressToken || !req.user.id) throw new UnauthorizedError("Sessão de vendedor inválida.");
  const me = await upstream(
    () => vendaExpressAdapter.get<{ user?: { id?: string; account_kind?: string } }>("/auth/me"),
    "a sessão VendaExpress",
  );
  if (!me?.user?.id || String(me.user.id) !== String(req.user.id)) throw new UnauthorizedError("A sessão já não corresponde à conta autenticada.");
  if (me.user.account_kind === "fornecedor") throw new ForbiddenError("A conta de fornecedor não tem analytics de uma loja.");
  const store = await upstream(
    () => vendaExpressAdapter.get<{ id?: string | number; owner_id?: string | number; id_loja_antiga?: string | number | null } | null>("/stores/mine"),
    "a loja VendaExpress",
  );
  if (!store?.id) throw new NotFoundError("loja");
  if (!store.owner_id || String(store.owner_id) !== String(me.user.id)) throw new ForbiddenError("A loja não pertence ao vendedor autenticado.");
  if (req.user.storeId && String(req.user.storeId) !== String(store.id)) throw new ForbiddenError("A loja da sessão já não corresponde à loja autorizada.");
  let legacyStoreId: number | null = null;
  if (store.id_loja_antiga !== null && store.id_loja_antiga !== undefined) {
    legacyStoreId = Number(store.id_loja_antiga);
    if (!Number.isSafeInteger(legacyStoreId) || legacyStoreId < 0) throw new BadGatewayError("O VendaExpress devolveu uma associação legada inválida.");
  }
  return { userId: String(me.user.id), storeId: String(store.id), legacyStoreId };
}

function numericAmount(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function itemSource(item: Row, defaultSource: AnalyticsSource): AnalyticsSource {
  return item.source === "venda_express" || item.source === "vendaexpress" || item.item_type === "product"
    ? "venda_express"
    : defaultSource;
}

function normalizeItems(value: unknown, defaultSource: AnalyticsSource): AnalyticsOrder["items"] | null {
  if (!Array.isArray(value)) return null;
  const items: AnalyticsOrder["items"] = [];
  for (const item of value as Row[]) {
    const quantity = Number(item.quantity ?? item.qty);
    const id = item.product_id ?? item.productId ?? item.id;
    if (id === null || id === undefined || !Number.isFinite(quantity) || quantity <= 0) continue;
    items.push({
      id: String(id),
      source: itemSource(item, defaultSource),
      name: String(item.product_name ?? item.name ?? item.description ?? id),
      quantity,
    });
  }
  return items;
}

function normalizeOrder(row: Row, source: AnalyticsSource, items: AnalyticsOrder["items"]): AnalyticsOrder {
  return {
    id: String(row.id ?? row.order_id ?? row.order_ref ?? ""),
    source,
    status: String(source === "sete" ? row.loja_status ?? row.status ?? "unknown" : row.status ?? "unknown"),
    total: numericAmount(row.total ?? row.grand_total),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
    customerId: row.customer_id == null ? null : String(row.customer_id),
    customerName: row.customer_name == null ? null : String(row.customer_name),
    items,
  };
}

async function nativeOrders(): Promise<{ rows: AnalyticsOrder[]; available: boolean; complete: boolean; itemsComplete: boolean }> {
  const rows: AnalyticsOrder[] = [];
  let expectedTotal: number | null = null;
  let itemsComplete = true;
  try {
    for (let page = 1; page <= 1000; page += 1) {
      const path = `/orders?${new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })}`;
      const result = await vendaExpressAdapter.get<{ orders?: Row[]; total?: number }>(path);
      if (!Array.isArray(result?.orders)) throw new BadGatewayError("O VendaExpress devolveu pedidos inválidos para analytics.");
      if (typeof result.total === "number" && Number.isFinite(result.total) && result.total >= 0) expectedTotal = result.total;
      const pageOrders = await Promise.all(result.orders.map(async (row) => {
        let items = normalizeItems(row.items, "venda_express");
        if (items === null) {
          try {
            const fetched = await vendaExpressAdapter.get<unknown>(`/orders/${encodeURIComponent(String(row.id))}/items`);
            items = normalizeItems(fetched, "venda_express");
          } catch {
            items = null;
          }
        }
        if (items === null) itemsComplete = false;
        return normalizeOrder(row, "venda_express", items ?? []);
      }));
      rows.push(...pageOrders);
      if (expectedTotal !== null && rows.length >= expectedTotal) return { rows, available: true, complete: true, itemsComplete };
      if (result.orders.length < PAGE_SIZE) {
        return { rows, available: true, complete: expectedTotal === null || rows.length >= expectedTotal, itemsComplete };
      }
    }
    return { rows, available: true, complete: false, itemsComplete };
  } catch {
    return { rows, available: rows.length > 0, complete: false, itemsComplete: false };
  }
}

async function legacyOrders(context: AnalyticsContext): Promise<{ rows: AnalyticsOrder[]; linked: boolean; available: boolean; complete: boolean; itemsComplete: boolean }> {
  if (context.legacyStoreId === null) return { rows: [], linked: false, available: true, complete: true, itemsComplete: true };
  try {
    const response = await setePhpAdapter.post<unknown>("/loja-pedidos.php", {
      action: "list", loja_status: "all", limit: PAGE_SIZE,
      store_id: context.storeId, owner_id: context.userId,
    });
    const envelope = normalizeLegacyEnvelope(response);
    if (!Array.isArray(envelope.pedidos)) throw new BadGatewayError("A API 7Sete devolveu uma lista de pedidos inválida para analytics.");
    let itemsComplete = true;
    const rows = (envelope.pedidos as Row[]).map((row) => {
      const items = normalizeItems(row.items, "sete");
      if (items === null) itemsComplete = false;
      return normalizeOrder(row, "sete", items ?? []);
    });
    const complete = rows.length < PAGE_SIZE;
    return { rows, linked: true, available: true, complete, itemsComplete };
  } catch {
    return { rows: [], linked: true, available: false, complete: false, itemsComplete: false };
  }
}

function normalizeProduct(row: Row, source: AnalyticsSource): AnalyticsProduct {
  const stock = Number(row.stock ?? row.quantity ?? row.p_qty);
  const rawThreshold = row.lowStockThreshold ?? row.low_stock_threshold ?? row.stock_alert_threshold;
  const threshold = rawThreshold == null || rawThreshold === "" || !Number.isFinite(Number(rawThreshold)) ? null : Math.max(0, Number(rawThreshold));
  return {
    id: String(row.id ?? row.sourceId ?? row.p_id ?? ""),
    source,
    name: String(row.name ?? row.p_name ?? row.title ?? "Produto"),
    stock: Number.isFinite(stock) && stock >= 0 ? stock : 0,
    threshold,
    published: row.status === "archived" || row.status === "draft" || row.active === false || Number(row.active) === 0 ? false : true,
  };
}

async function sourceProducts(source: AnalyticsSource, linked: boolean): Promise<{ rows: AnalyticsProduct[]; available: boolean; complete: boolean }> {
  if (!linked) return { rows: [], available: true, complete: true };
  const rows: AnalyticsProduct[] = [];
  let expectedTotal: number | null = null;
  try {
    for (let page = 1; page <= 1000; page += 1) {
      const querySource = source === "sete" ? "sete" : "ve";
      const path = `/products?${new URLSearchParams({ source: querySource, page: String(page), limit: String(PAGE_SIZE) })}`;
      const result = await vendaExpressAdapter.get<{ products?: Row[]; total?: number }>(path);
      if (!Array.isArray(result?.products)) throw new BadGatewayError("O VendaExpress devolveu produtos inválidos para analytics.");
      if (typeof result.total === "number" && Number.isFinite(result.total) && result.total >= 0) expectedTotal = result.total;
      rows.push(...result.products.map((row) => normalizeProduct(row, source)));
      if (expectedTotal !== null && rows.length >= expectedTotal) return { rows, available: true, complete: true };
      if (result.products.length < PAGE_SIZE) return { rows, available: true, complete: expectedTotal === null || rows.length >= expectedTotal };
    }
    return { rows, available: true, complete: false };
  } catch {
    return { rows, available: false, complete: false };
  }
}

async function analyticsSnapshot(req: Request) {
  const context = await authorizedContext(req);
  const period = selectedPeriod(req);
  const [native, legacy, nativeCatalog, legacyCatalog] = await Promise.all([
    nativeOrders(),
    legacyOrders(context),
    sourceProducts("venda_express", true),
    sourceProducts("sete", context.legacyStoreId !== null),
  ]);
  const sources: AnalyticsSourceStatus[] = [
    {
      source: "venda_express", linked: true, ordersAvailable: native.available, ordersComplete: native.complete,
      itemsComplete: native.itemsComplete, productsAvailable: nativeCatalog.available, productsComplete: nativeCatalog.complete,
    },
    {
      source: "sete", linked: legacy.linked, ordersAvailable: legacy.available, ordersComplete: legacy.complete,
      itemsComplete: legacy.itemsComplete, productsAvailable: legacyCatalog.available, productsComplete: legacyCatalog.complete,
    },
  ];
  return buildAnalyticsSnapshot({ period, orders: [...native.rows, ...legacy.rows], products: [...nativeCatalog.rows, ...legacyCatalog.rows], sources });
}

router.get("/analytics/overview", authMiddleware, asyncHandler(async (req, res) => {
  const data = await analyticsSnapshot(req);
  res.json({ data, meta: { period: data.period, dataComplete: data.dataComplete, sources: data.sourceStatus, requestId: generateRequestId() } });
}));

router.get("/analytics/sales", authMiddleware, asyncHandler(async (req, res) => {
  const data = await analyticsSnapshot(req);
  res.json({
    data: {
      period: data.period,
      currency: data.currency,
      points: data.series.map((point) => ({ date: point.date, revenue: point.grossOrderValue.knownValue, orders: point.orders.knownValue, complete: point.grossOrderValue.complete && point.orders.complete })),
      totals: { revenue: data.summary.grossOrderValue.knownValue, orders: data.summary.totalOrders.knownValue, averageOrderValue: data.summary.averageOrderValue.value },
      generatedAt: data.generatedAt,
    },
    meta: { dataComplete: data.dataComplete, sources: data.sourceStatus, requestId: generateRequestId() },
  });
}));

router.get("/analytics/top-products", authMiddleware, asyncHandler(async (req, res) => {
  const data = await analyticsSnapshot(req);
  const limitValue = Number(queryString(req, "limit") ?? 10);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100) throw new ValidationError("O limite deve estar entre 1 e 100.");
  res.json({ data: data.topProducts.slice(0, limitValue), meta: { dataComplete: data.topProducts.every((product) => product.complete), sources: data.sourceStatus, requestId: generateRequestId() } });
}));

router.get("/dashboard", authMiddleware, asyncHandler(async (req, res) => {
  const data = await analyticsSnapshot(req);
  res.json({
    data: {
      summary: {
        revenue: data.summary.grossOrderValue.knownValue,
        orders: data.summary.totalOrders.knownValue,
        averageOrderValue: data.summary.averageOrderValue.value,
        grossOrderValueComplete: data.summary.grossOrderValue.complete,
        orderCountComplete: data.summary.totalOrders.complete,
      },
      series: data.series,
      topProducts: data.topProducts,
      lowStockProducts: data.lowStockProducts,
      lowStockComplete: data.lowStockComplete,
      topCustomers: data.topCustomers,
      categoryBreakdown: [],
      orderStatusBreakdown: data.orderStatusBreakdown,
      sourceBreakdown: data.sourceBreakdown,
      sourceStatus: data.sourceStatus,
      dataComplete: data.dataComplete,
      generatedAt: data.generatedAt,
    },
    meta: { period: data.period, dataComplete: data.dataComplete, sources: data.sourceStatus, requestId: generateRequestId() },
  });
}));

export default router;
