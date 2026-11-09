import { Router, type Request } from "express";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  AppError,
  BadGatewayError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../../shared/utils/errors";
import { authMiddleware } from "../../middleware/auth";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { setePhpAdapter } from "../../adapters/sete-php/client";
import { generateRequestId } from "../../shared/utils/errors";
import { normalizeLegacyEnvelope, type LegacyOrder } from "../orders/orders-domain";
import { buildFinanceSnapshot, legacyFinanceOrder, nativeFinanceOrder, periodBounds, type FinanceSnapshot } from "./finance-domain";

const router = Router();
const PAGE_SIZE = 100;
const LEGACY_ORDERS_ENDPOINT = "/loja-pedidos.php";

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function pageParams(req: Request) {
  const page = Number(queryString(req, "page") ?? 1);
  const limit = Number(queryString(req, "limit") ?? 20);
  if (!Number.isInteger(page) || page < 1) throw new ValidationError("A página deve ser um inteiro positivo.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("O limite deve estar entre 1 e 100.");
  return { page, limit };
}

async function fromUpstream<T>(operation: () => Promise<T>, name: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new BadGatewayError(`Não foi possível consultar ${name}.`);
  }
}

async function authorizedContext(req: Request) {
  if (!req.user?.vendaExpressToken || !req.user.id) throw new UnauthorizedError("Sessão de vendedor inválida.");
  const me = await fromUpstream(() => vendaExpressAdapter.get<{ user?: { id?: string; account_kind?: string } }>("/auth/me"), "a sessão VendaExpress");
  if (!me?.user?.id || String(me.user.id) !== String(req.user.id)) throw new UnauthorizedError("A sessão já não corresponde à conta autenticada.");
  if (me.user.account_kind === "fornecedor") throw new ForbiddenError("A conta de fornecedor não tem finanças de uma loja.");
  const store = await fromUpstream(() => vendaExpressAdapter.get<{ id?: string; owner_id?: string; id_loja_antiga?: number | string | null }>("/stores/mine"), "a loja VendaExpress");
  if (!store?.id) throw new NotFoundError("loja");
  if (!store.owner_id || String(store.owner_id) !== String(me.user.id)) throw new ForbiddenError("A loja não pertence ao vendedor autenticado.");
  if (req.user.storeId && String(req.user.storeId) !== String(store.id)) throw new ForbiddenError("A loja da sessão já não corresponde à loja autorizada.");
  return { userId: String(me.user.id), storeId: String(store.id), legacyStoreId: store.id_loja_antiga ?? null };
}

async function nativeOrders(): Promise<{ orders: ReturnType<typeof nativeFinanceOrder>[]; complete: boolean }> {
  const rows: ReturnType<typeof nativeFinanceOrder>[] = [];
  let expectedTotal = Number.POSITIVE_INFINITY;
  for (let page = 1; page <= 1000 && rows.length < expectedTotal; page += 1) {
    const path = `/orders?${new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })}`;
    const result = await fromUpstream(() => vendaExpressAdapter.get<{ orders?: Array<Record<string, any>>; total?: number }>(path), "os pedidos VendaExpress");
    if (!Array.isArray(result?.orders)) throw new BadGatewayError("O backend VendaExpress devolveu pedidos inválidos para o financeiro.");
    rows.push(...result.orders.map(nativeFinanceOrder));
    expectedTotal = Number(result.total ?? rows.length);
    if (!result.orders.length) break;
  }
  return { orders: rows, complete: rows.length >= expectedTotal };
}

async function legacyOrders(context: Awaited<ReturnType<typeof authorizedContext>>): Promise<{ orders: ReturnType<typeof legacyFinanceOrder>[]; unavailable: boolean; mayBeTruncated: boolean }> {
  if (context.legacyStoreId === null) return { orders: [], unavailable: false, mayBeTruncated: false };
  try {
    const response = await setePhpAdapter.post<unknown>(LEGACY_ORDERS_ENDPOINT, {
      action: "list",
      loja_status: "all",
      limit: PAGE_SIZE,
      store_id: context.storeId,
      owner_id: context.userId,
    });
    const envelope = normalizeLegacyEnvelope(response);
    if (!Array.isArray(envelope.pedidos)) throw new BadGatewayError("A API legada devolveu pedidos inválidos para o financeiro.");
    const orders = envelope.pedidos as LegacyOrder[];
    return { orders: orders.map(legacyFinanceOrder), unavailable: false, mayBeTruncated: orders.length >= PAGE_SIZE };
  } catch {
    return { orders: [], unavailable: true, mayBeTruncated: false };
  }
}

async function financeSnapshot(req: Request): Promise<FinanceSnapshot> {
  const context = await authorizedContext(req);
  const period = queryString(req, "period") ?? "30d";
  let bounds: ReturnType<typeof periodBounds>;
  try {
    bounds = periodBounds(period);
  } catch {
    throw new ValidationError("Período inválido. Use 7d, 30d, 90d ou all.");
  }
  const [native, legacy] = await Promise.all([nativeOrders(), legacyOrders(context)]);
  return buildFinanceSnapshot([...native.orders, ...legacy.orders], {
    period,
    ...bounds,
    legacyLinked: context.legacyStoreId !== null,
    legacyUnavailable: legacy.unavailable,
    legacyHistoryMayBeTruncated: legacy.mayBeTruncated,
    nativeHistoryComplete: native.complete,
  });
}

function pageTransactions(snapshot: FinanceSnapshot, page: number, limit: number) {
  const total = snapshot.orders.length;
  return {
    data: snapshot.orders.slice((page - 1) * limit, page * limit).map((order) => ({
      ...order,
      type: "order" as const,
      orderId: order.id,
      id: `${order.source}:${order.id}`,
    })),
    meta: { page, limit, total, requestId: generateRequestId() },
  };
}

router.get("/finance", authMiddleware, asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const snapshot = await financeSnapshot(req);
  const transactions = pageTransactions(snapshot, page, limit);
  res.json({ data: { summary: snapshot.summary, transactions: transactions.data }, meta: { ...transactions.meta, legacyUnavailable: snapshot.summary.legacyUnavailable } });
}));

router.get("/finance/summary", authMiddleware, asyncHandler(async (req, res) => {
  const snapshot = await financeSnapshot(req);
  res.json({ data: snapshot.summary, meta: { requestId: generateRequestId() } });
}));

router.get("/finance/transactions", authMiddleware, asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const snapshot = await financeSnapshot(req);
  const result = pageTransactions(snapshot, page, limit);
  res.json({ ...result, meta: { ...result.meta, summary: snapshot.summary } });
}));

export default router;
