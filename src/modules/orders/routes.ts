import { Router, type Request } from "express";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  AppError,
  BadGatewayError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../../shared/utils/errors";
import { authMiddleware } from "../../middleware/auth";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { setePhpAdapter } from "../../adapters/sete-php/client";
import { auditLogger } from "../../shared/utils/audit";
import { generateRequestId } from "../../shared/utils/errors";
import { OrderStatusSchema } from "../../shared/schemas/validation";
import {
  isLegacySource,
  isNativeSource,
  canTransitionNativeStatus,
  legacyOrderDto,
  nativeOrderDto,
  normalizeLegacyActionResponse,
  normalizeLegacyEnvelope,
  normalizeLegacyStatus,
  normalizeNativeStatus,
  toLegacyAction,
  portalStatusToLegacyAction,
  toNativeStatus,
  type LegacyOrder,
  type NativeOrder,
  type OrderSource,
} from "./orders-domain";

const router = Router();
const LEGACY_ENDPOINT = "/loja-pedidos.php";

interface OrderContext {
  userId: string;
  store: { id: string; owner_id?: string; id_loja_antiga?: number | string | null } | null;
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function pagination(req: Request) {
  const pageValue = Number(queryString(req, "page") ?? 1);
  const limitValue = Number(queryString(req, "limit") ?? 20);
  if (!Number.isInteger(pageValue) || pageValue < 1) {
    throw new ValidationError("A página deve ser um inteiro positivo.");
  }
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100) {
    throw new ValidationError("O limite deve estar entre 1 e 100.");
  }
  return { page: pageValue, limit: limitValue };
}

function requestedSource(req: Request): OrderSource | "all" {
  const source = queryString(req, "source");
  if (!source) return "all";
  if (isNativeSource(source)) return "venda_express";
  if (isLegacySource(source)) return "sete";
  throw new ValidationError("Origem do pedido inválida.");
}

/** Revalida identidade e loja no backend que emitiu o bearer token. */
async function authorizedContext(req: Request): Promise<OrderContext> {
  if (!req.user?.vendaExpressToken || !req.user.id) {
    throw new UnauthorizedError("Sessão de vendedor inválida.");
  }

  const me = await vendaExpressAdapter.get<{ user?: { id?: string; account_kind?: string } }>("/auth/me");
  const verifiedId = me?.user?.id;
  if (!verifiedId || String(verifiedId) !== String(req.user.id)) {
    throw new UnauthorizedError("A sessão já não corresponde à conta autenticada.");
  }
  if (me.user?.account_kind === "fornecedor") {
    throw new ForbiddenError("A conta de fornecedor não tem pedidos de loja própria.");
  }

  const store = await vendaExpressAdapter.get<OrderContext["store"]>("/stores/mine");
  if (!store?.id) return { userId: String(verifiedId), store: null };
  if (!store.owner_id || String(store.owner_id) !== String(verifiedId)) {
    throw new ForbiddenError("A loja autenticada não pertence a este vendedor.");
  }
  if (req.user.storeId && String(req.user.storeId) !== String(store.id)) {
    throw new ForbiddenError("A loja da sessão já não corresponde à loja autorizada.");
  }
  return { userId: String(verifiedId), store };
}

async function nativeOrderList(page: number, limit: number, search?: string): Promise<{ orders: NativeOrder[]; total: number }> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (search) params.set("search", search);
  const result = await vendaExpressAdapter.get<{ orders?: NativeOrder[]; total?: number }>(`/orders?${params}`);
  if (!Array.isArray(result?.orders)) {
    throw new BadGatewayError("O backend VendaExpress devolveu uma lista de pedidos inválida.");
  }

  // O contrato upstream separa itens num endpoint próprio e valida ownership.
  const orders = await Promise.all(result.orders.map(async (order) => {
    const items = await vendaExpressAdapter.get<NativeOrder["items"]>(`/orders/${encodeURIComponent(String(order.id))}/items`);
    if (!Array.isArray(items)) throw new BadGatewayError("O backend VendaExpress devolveu itens inválidos para um pedido.");
    return { ...order, items };
  }));
  return { orders, total: Number(result.total ?? orders.length) };
}

/** Lista leve sem items — usada pelo poll para não sobrecarregar o VE. */
async function nativeOrderSummary(page: number, limit: number): Promise<{ orders: NativeOrder[]; total: number }> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  const result = await vendaExpressAdapter.get<{ orders?: NativeOrder[]; total?: number }>(`/orders?${params}`);
  if (!Array.isArray(result?.orders)) {
    throw new BadGatewayError("O backend VendaExpress devolveu uma lista de pedidos inválida.");
  }
  return { orders: result.orders, total: Number(result.total ?? result.orders.length) };
}

async function findNativeOrder(id: string): Promise<NativeOrder> {
  const first = await nativeOrderList(1, 100);
  const found = first.orders.find((item) => String(item.id) === id);
  if (found) return found;
  const pages = Math.ceil(first.total / 100);
  for (let page = 2; page <= pages; page += 1) {
    const result = await nativeOrderList(page, 100);
    const order = result.orders.find((item) => String(item.id) === id);
    if (order) return order;
    if (result.orders.length === 0) break;
  }
  throw new NotFoundError("pedido");
}

async function legacyRequest(context: OrderContext, action: Record<string, unknown>) {
  if (!context.store?.id || context.store.id_loja_antiga == null) {
    throw new NotFoundError("loja legada associada");
  }
  const response = await setePhpAdapter.post<unknown>(LEGACY_ENDPOINT, {
    ...action,
    // Esses identificadores vêm do backend VE autenticado, nunca do browser.
    store_id: context.store.id,
    owner_id: context.userId,
  });
  return normalizeLegacyEnvelope(response);
}

async function legacyOrderList(context: OrderContext, limit: number, status?: string) {
  const response = await legacyRequest(context, {
    action: "list",
    loja_status: status ?? "all",
    limit,
  });
  const orders = response.pedidos;
  if (!Array.isArray(orders)) {
    throw new BadGatewayError("A API legada devolveu uma lista de pedidos inválida.");
  }
  return orders as LegacyOrder[];
}

router.get("/orders", authMiddleware, asyncHandler(async (req, res) => {
  const context = await authorizedContext(req);
  const { page, limit } = pagination(req);
  const source = requestedSource(req);
  const results: Array<{ order: Record<string, unknown>; createdAt: number }> = [];
  let total = 0;

  if ((source === "all" || source === "venda_express") && context.store) {
    const native = await nativeOrderList(page, limit, queryString(req, "search"));
    total += native.total;
    results.push(...native.orders.map((order) => ({
      order: nativeOrderDto(order),
      createdAt: Date.parse(String(order.created_at ?? "")) || 0,
    })));
  }

  if ((source === "all" || source === "sete") && context.store?.id_loja_antiga != null) {
    if (page > 1) {
      throw new ValidationError("A API legada não suporta paginação por página; use limit até 100.");
    }
    const legacy = await legacyOrderList(context, limit);
    const search = (queryString(req, "search") ?? "").trim().toLocaleLowerCase();
    const status = queryString(req, "status");
    const matching = legacy.filter((order) => {
      if (search && !`${order.order_ref ?? ""} ${order.customer_name ?? ""} ${order.customer_phone ?? ""}`.toLocaleLowerCase().includes(search)) return false;
      return !status || status === "all" || normalizeLegacyStatus(order.loja_status) === status;
    });
    total += matching.length;
    results.push(...matching.map((order) => ({
      order: legacyOrderDto(order),
      createdAt: Date.parse(String(order.created_at ?? "").replace(" ", "T")) || 0,
    })));
  }

  results.sort((a, b) => b.createdAt - a.createdAt);
  res.json({
    data: results.map(({ order }) => order),
    meta: { page, limit, total, requestId: generateRequestId() },
  });
}));

router.get("/orders/stats", authMiddleware, asyncHandler(async (req, res) => {
  const context = await authorizedContext(req);
  const source = requestedSource(req);
  const stats: Record<string, unknown> = {};

  if ((source === "all" || source === "venda_express") && context.store) {
    stats.venda_express = await vendaExpressAdapter.get("/stores/mine/stats");
  }
  if ((source === "all" || source === "sete") && context.store?.id_loja_antiga != null) {
    stats.seven_sete = (await legacyRequest(context, { action: "stats" })).stats;
  }
  res.json({ data: stats, meta: { requestId: generateRequestId() } });
}));

/**
 * Polling leve: fingerprint dos pedidos recentes (id+status).
 * O frontend compara com o valor anterior e só recarrega a lista completa
 * quando muda — evita refresh manual e não substitui GET /orders.
 */
router.get("/orders/poll", authMiddleware, asyncHandler(async (req, res) => {
  const context = await authorizedContext(req);
  const source = requestedSource(req);
  const entries: Array<{ id: string; status: string; createdAt: number }> = [];

  if ((source === "all" || source === "venda_express") && context.store) {
    const native = await nativeOrderSummary(1, 100);
    for (const order of native.orders) {
      const status = normalizeNativeStatus(order.status);
      entries.push({
        id: String(order.id),
        status,
        createdAt: Date.parse(String(order.created_at ?? order.createdAt ?? "")) || 0,
      });
    }
  }

  if ((source === "all" || source === "sete") && context.store?.id_loja_antiga != null) {
    const legacy = await legacyOrderList(context, 100);
    for (const order of legacy) {
      const status = normalizeLegacyStatus(order.loja_status);
      entries.push({
        id: String(order.id),
        status,
        createdAt: Date.parse(String(order.created_at ?? "").replace(" ", "T")) || 0,
      });
    }
  }

  entries.sort((a, b) => b.createdAt - a.createdAt);

  const pendingCount = entries.filter((entry) => entry.status === "pending").length;
  const fingerprint = entries.map((entry) => `${entry.id}:${entry.status}`).join("|");
  const latest = entries[0];

  res.json({
    data: {
      fingerprint,
      total: entries.length,
      pendingCount,
      latestId: latest?.id ?? null,
      latestCreatedAt: latest
        ? new Date(latest.createdAt).toISOString()
        : null,
    },
    meta: { requestId: generateRequestId() },
  });
}));

router.get("/orders/:id", authMiddleware, asyncHandler(async (req, res) => {
  const context = await authorizedContext(req);
  const source = requestedSource(req);
  if (source === "all") throw new ValidationError("Indique source=venda_express ou source=sete para consultar um pedido.");

  if (source === "venda_express") {
    if (!context.store) throw new NotFoundError("loja");
    const order = await findNativeOrder(req.params.id);
    return res.json({ data: nativeOrderDto(order), meta: { requestId: generateRequestId() } });
  }

  const orders = await legacyOrderList(context, 100);
  const order = orders.find((item) => String(item.id) === req.params.id);
  if (!order) throw new NotFoundError("pedido");
  return res.json({ data: legacyOrderDto(order), meta: { requestId: generateRequestId() } });
}));

router.patch("/orders/:id/action", authMiddleware, asyncHandler(async (req, res) => {
  const context = await authorizedContext(req);
  const source = requestedSource(req);
  if (source === "all") throw new ValidationError("Indique a origem do pedido.");
  const action = req.body?.action;
  if (action !== "accept" && action !== "refuse") {
    throw new ValidationError("Ação inválida. Use accept ou refuse.");
  }

  if (source === "sete") {
    const orders = await legacyOrderList(context, 100);
    const order = orders.find((item) => String(item.id) === req.params.id);
    if (!order) throw new NotFoundError("pedido");
    if (order.loja_status !== "pendente") {
      throw new ConflictError("Só é possível atender ou recusar pedidos pendentes.");
    }
    const result = await legacyRequest(context, {
      action: toLegacyAction(action),
      pedido_id: order.id,
      ...(action === "refuse" && typeof req.body?.reason === "string" ? { motivo: req.body.reason.slice(0, 500) } : {}),
    });
    const updated = normalizeLegacyActionResponse(result, order, action);
    auditLogger.log({ actorId: context.userId, actorRole: req.user?.role ?? "seller", action: action === "accept" ? "attend_legacy_order" : "refuse_legacy_order", resource: "order", resourceId: req.params.id, source: "sete", outcome: "success", timestamp: new Date().toISOString() });
    return res.json({ data: legacyOrderDto(updated), meta: { requestId: generateRequestId() } });
  }

  if (!context.store) throw new NotFoundError("loja");
  const order = await findNativeOrder(req.params.id);
  if (normalizeNativeStatus(order.status) !== "pending") {
    throw new ConflictError("Só é possível aceitar ou recusar pedidos pendentes.");
  }
  const status = toNativeStatus(action);
  const updated = await vendaExpressAdapter.patch<NativeOrder>(`/orders/${encodeURIComponent(req.params.id)}/status`, { status });
  auditLogger.log({ actorId: context.userId, actorRole: req.user?.role ?? "seller", action: action === "accept" ? "accept_order" : "refuse_order", resource: "order", resourceId: req.params.id, source: "venda_express", outcome: "success", timestamp: new Date().toISOString() });
  return res.json({ data: nativeOrderDto(updated), meta: { requestId: generateRequestId() } });
}));

router.patch("/orders/:id/status", authMiddleware, asyncHandler(async (req, res) => {
  // Body: { status: "preparing" | "shipped" | ... } — validar o campo, não o objecto inteiro.
  const parsed = OrderStatusSchema.safeParse(
    req.body && typeof req.body === "object" ? (req.body as { status?: unknown }).status : undefined,
  );
  if (!parsed.success) throw new ValidationError("Estado inválido.", parsed.error.flatten());
  const context = await authorizedContext(req);
  const source = requestedSource(req);
  if (source === "all") throw new ValidationError("Indique a origem do pedido.");

  if (source === "sete") {
    const legacyAction = portalStatusToLegacyAction(parsed.data);
    if (!legacyAction) {
      throw new AppError(
        "O sistema legado não suporta este estado. Use confirmed, preparing, shipped, delivered ou cancelled.",
        422,
        "UPSTREAM_OPERATION_UNSUPPORTED",
      );
    }
    const orders = await legacyOrderList(context, 100);
    const order = orders.find((item) => String(item.id) === req.params.id);
    if (!order) throw new NotFoundError("pedido");

    if (legacyAction === "atender" || legacyAction === "recusar") {
      if (order.loja_status !== "pendente") {
        throw new ConflictError("Só é possível atender ou recusar pedidos pendentes.");
      }
      const acceptRefuse = legacyAction === "atender" ? "accept" : "refuse";
      const result = await legacyRequest(context, {
        action: legacyAction,
        pedido_id: order.id,
      });
      const updated = normalizeLegacyActionResponse(result, order, acceptRefuse);
      auditLogger.log({
        actorId: context.userId,
        actorRole: req.user?.role ?? "seller",
        action: acceptRefuse === "accept" ? "attend_legacy_order" : "refuse_legacy_order",
        resource: "order",
        resourceId: req.params.id,
        source: "sete",
        outcome: "success",
        timestamp: new Date().toISOString(),
      });
      return res.json({ data: legacyOrderDto(updated), meta: { requestId: generateRequestId() } });
    }

    // preparar | a_caminho | entregue — push no PHP, sem stock
    const result = await legacyRequest(context, {
      action: legacyAction,
      pedido_id: order.id,
    });
    if (result.success !== true) {
      throw new BadGatewayError(String(result.message ?? "A API legada não confirmou a alteração do pedido."));
    }
    const nextStatus = String(result.loja_status ?? "");
    const updated = { ...order, loja_status: nextStatus || order.loja_status };
    auditLogger.log({
      actorId: context.userId,
      actorRole: req.user?.role ?? "seller",
      action: `legacy_order_${legacyAction}`,
      resource: "order",
      resourceId: req.params.id,
      source: "sete",
      outcome: "success",
      timestamp: new Date().toISOString(),
    });
    return res.json({ data: legacyOrderDto(updated), meta: { requestId: generateRequestId() } });
  }

  if (!context.store) throw new NotFoundError("loja");
  const current = await findNativeOrder(req.params.id);
  const currentStatus = normalizeNativeStatus(current.status);
  if (!canTransitionNativeStatus(currentStatus, parsed.data)) {
    throw new ValidationError(`Transição de "${currentStatus}" para "${parsed.data}" não é permitida pelo backend VendaExpress.`);
  }
  // VE só conhece pending|paid|shipped|delivered|cancelled.
  // "preparing"/"ready" ficam como paid no upstream (já confirmado) e
  // reflectimos o estado pedido no DTO de resposta.
  const upstreamStatus =
    parsed.data === "confirmed" || parsed.data === "preparing" || parsed.data === "ready"
      ? "paid"
      : parsed.data;
  const updated = await vendaExpressAdapter.patch<NativeOrder>(
    `/orders/${encodeURIComponent(req.params.id)}/status`,
    { status: upstreamStatus },
  );
  const responseDto = {
    ...nativeOrderDto(updated),
    // Mantém o estado pedido pelo portal quando o VE colapsa preparing→paid.
    status:
      parsed.data === "preparing" || parsed.data === "ready"
        ? parsed.data
        : nativeOrderDto(updated).status,
  };
  auditLogger.log({ actorId: context.userId, actorRole: req.user?.role ?? "seller", action: "update_order_status", resource: "order", resourceId: req.params.id, source: "venda_express", outcome: "success", timestamp: new Date().toISOString() });
  return res.json({ data: responseDto, meta: { requestId: generateRequestId() } });
}));

export default router;
