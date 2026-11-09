import { createHash } from "node:crypto";
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
import { legacyOrderDto, nativeOrderDto, normalizeLegacyEnvelope, type LegacyOrder, type NativeOrder } from "../orders/orders-domain";

const router = Router();
const LEGACY_ORDERS_ENDPOINT = "/loja-pedidos.php";
const PAGE_SIZE = 100;
type CustomerSource = "vendaexpress" | "7sete";
type CustomerRecord = Record<string, any> & {
  id: string;
  source: CustomerSource;
  sourceId?: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  ordersCount: number;
  totalSpent: number;
  lastPurchaseAt: string;
  lastActivityAt: string;
  customerSince: string;
  segment: "novo" | "recorrente" | "vip";
  historyMayBeTruncated?: boolean;
  legacyUnavailable?: boolean;
  orders: Record<string, any>[];
};

async function fromUpstream<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new BadGatewayError("Um serviço de clientes ou pedidos está temporariamente indisponível.");
  }
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" ? value : Array.isArray(value) ? String(value[0] ?? "") : undefined;
}

function pagination(req: Request) {
  const page = Number(queryString(req, "page") ?? 1);
  const limit = Number(queryString(req, "limit") ?? 50);
  if (!Number.isInteger(page) || page < 1) throw new ValidationError("A página deve ser um inteiro positivo.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("O limite deve estar entre 1 e 100.");
  return { page, limit };
}

function normalizedSource(value?: string): CustomerSource | undefined {
  if (!value) return undefined;
  if (value === "vendaexpress" || value === "venda_express") return "vendaexpress";
  if (value === "7sete" || value === "sete") return "7sete";
  throw new ValidationError("Origem do cliente inválida.");
}

async function authorizedContext(req: Request) {
  if (!req.user?.vendaExpressToken || !req.user.id) throw new UnauthorizedError("Sessão de vendedor inválida.");
  const me = await fromUpstream(() => vendaExpressAdapter.get<{ user?: { id?: string; account_kind?: string } }>("/auth/me"));
  if (!me?.user?.id || String(me.user.id) !== String(req.user.id)) throw new UnauthorizedError("A sessão já não corresponde à conta autenticada.");
  if (me.user.account_kind === "fornecedor") throw new ForbiddenError("A conta de fornecedor não tem clientes de loja própria.");
  const store = await fromUpstream(() => vendaExpressAdapter.get<{ id?: string; owner_id?: string; id_loja_antiga?: number | string | null }>("/stores/mine"));
  if (!store?.id) throw new NotFoundError("loja");
  if (!store.owner_id || String(store.owner_id) !== String(me.user.id)) throw new ForbiddenError("A loja não pertence ao vendedor autenticado.");
  if (req.user.storeId && String(req.user.storeId) !== String(store.id)) throw new ForbiddenError("A loja da sessão já não corresponde à loja autorizada.");
  return { userId: String(me.user.id), storeId: String(store.id), legacyStoreId: store.id_loja_antiga ?? null };
}

async function fetchAllNativeCustomers() {
  const customers: Array<Record<string, any>> = [];
  let total = Number.POSITIVE_INFINITY;
  for (let page = 1; page <= 1000 && customers.length < total; page += 1) {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    const response = await fromUpstream(() => vendaExpressAdapter.get<{ customers?: Array<Record<string, any>>; total?: number }>(`/customers?${params}`));
    if (!Array.isArray(response?.customers)) throw new BadGatewayError("O backend VendaExpress devolveu uma lista de clientes inválida.");
    customers.push(...response.customers);
    total = Number(response.total ?? customers.length);
    if (!response.customers.length) break;
  }
  if (customers.length < total) throw new BadGatewayError("Não foi possível obter todas as páginas de clientes.");
  return customers;
}

async function fetchAllNativeOrders() {
  const orders: NativeOrder[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let page = 1; page <= 1000 && orders.length < total; page += 1) {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    const response = await fromUpstream(() => vendaExpressAdapter.get<{ orders?: NativeOrder[]; total?: number }>(`/orders?${params}`));
    if (!Array.isArray(response?.orders)) throw new BadGatewayError("O backend VendaExpress devolveu uma lista de pedidos inválida.");
    orders.push(...response.orders);
    total = Number(response.total ?? orders.length);
    if (!response.orders.length) break;
  }
  if (orders.length < total) throw new BadGatewayError("Não foi possível obter todas as páginas de pedidos.");
  return orders;
}

async function fetchLegacyOrders(context: Awaited<ReturnType<typeof authorizedContext>>) {
  if (context.legacyStoreId === null) return [] as LegacyOrder[];
  const response = await setePhpAdapter.post<unknown>(LEGACY_ORDERS_ENDPOINT, {
    action: "list",
    loja_status: "all",
    limit: PAGE_SIZE,
    store_id: context.storeId,
    owner_id: context.userId,
  });
  const envelope = normalizeLegacyEnvelope(response);
  if (!Array.isArray(envelope.pedidos)) throw new BadGatewayError("A API legada devolveu uma lista de pedidos inválida.");
  return envelope.pedidos as LegacyOrder[];
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function phoneKey(value: unknown): string {
  return text(value).replace(/\D/g, "");
}

function legacyIdentity(order: LegacyOrder): string {
  const customerId = text(order.customer_id ?? order.customerId);
  if (customerId) return `id:${customerId}`;
  const phone = phoneKey(order.customer_phone);
  if (phone) return `phone:${phone}`;
  const name = text(order.customer_name).toLocaleLowerCase("pt");
  const city = text(order.municipio ?? order.provincia).toLocaleLowerCase("pt");
  // Without an ID or contact, keep each order separate instead of merging unrelated people by name.
  return `order:${String(order.id)}:${name}:${city}`;
}

function customerId(source: CustomerSource, identity: string): string {
  if (source === "vendaexpress") return `ve:${identity}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `sete:${digest}`;
}

function isConfirmedPurchase(source: CustomerSource, order: Record<string, any>): boolean {
  if (source === "7sete") return order.status === "confirmed";
  return ["paid", "confirmed", "shipped", "delivered"].includes(String(order.status));
}

function historyOrder(source: CustomerSource, raw: NativeOrder | LegacyOrder): Record<string, unknown> {
  const order = source === "7sete" ? legacyOrderDto(raw as LegacyOrder) : nativeOrderDto({ ...(raw as NativeOrder), items: [] });
  return {
    id: order.id,
    reference: order.reference,
    source: order.source,
    status: order.status,
    createdAt: order.createdAt,
    total: order.total,
  };
}

function buildCustomerRecords(customers: Array<Record<string, any>>, nativeOrders: NativeOrder[], legacyOrders: LegacyOrder[]): CustomerRecord[] {
  const records = new Map<string, CustomerRecord>();
  const nativeIdToKey = new Map<string, string>();
  const nativePhoneToKey = new Map<string, string>();

  for (const customer of customers) {
    const sourceId = text(customer.id);
    if (!sourceId) continue;
    const key = customerId("vendaexpress", sourceId);
    const phone = text(customer.phone);
    const record: CustomerRecord = {
      id: key, source: "vendaexpress", sourceId,
      name: text(customer.name), email: text(customer.email), phone,
      city: text(customer.city ?? customer.municipality), ordersCount: 0, totalSpent: 0,
      lastPurchaseAt: "", lastActivityAt: "", customerSince: text(customer.created_at ?? customer.createdAt),
      segment: "novo", orders: [],
    };
    records.set(key, record);
    nativeIdToKey.set(sourceId, key);
    if (phoneKey(phone)) nativePhoneToKey.set(phoneKey(phone), key);
  }

  for (const raw of nativeOrders) {
    const sourceCustomerId = text(raw.customer_id ?? raw.customerId);
    const phone = phoneKey(raw.customer_phone);
    const fallbackIdentity = sourceCustomerId || (phone ? `phone:${phone}` : `order:${raw.id}`);
    const key = nativeIdToKey.get(sourceCustomerId) ?? nativePhoneToKey.get(phone) ?? customerId("vendaexpress", fallbackIdentity);
    let record = records.get(key);
    if (!record) {
      record = { id: key, source: "vendaexpress", sourceId: sourceCustomerId || undefined, name: text(raw.customer_name), email: "", phone: text(raw.customer_phone), city: text(raw.city), ordersCount: 0, totalSpent: 0, lastPurchaseAt: "", lastActivityAt: "", customerSince: "", segment: "novo", orders: [] };
      records.set(key, record);
      if (sourceCustomerId) nativeIdToKey.set(sourceCustomerId, key);
      if (phone && !nativePhoneToKey.has(phone)) nativePhoneToKey.set(phone, key);
    }
    if (!record.name) record.name = text(raw.customer_name);
    if (!record.phone) record.phone = text(raw.customer_phone);
    record.orders.push(historyOrder("vendaexpress", raw));
  }

  const legacyGroups = new Map<string, LegacyOrder[]>();
  for (const order of legacyOrders) {
    const identity = legacyIdentity(order);
    const group = legacyGroups.get(identity) ?? [];
    group.push(order);
    legacyGroups.set(identity, group);
  }
  for (const [identity, orders] of legacyGroups) {
    const latest = [...orders].sort((a, b) => Date.parse(String(b.created_at ?? "").replace(" ", "T")) - Date.parse(String(a.created_at ?? "").replace(" ", "T")))[0];
    const sourceId = text(latest.customer_id ?? latest.customerId) || undefined;
    records.set(customerId("7sete", identity), {
      id: customerId("7sete", identity), source: "7sete", sourceId,
      name: text(latest.customer_name), email: text(latest.customer_email), phone: text(latest.customer_phone),
      city: [text(latest.municipio), text(latest.provincia)].filter(Boolean).join(", "),
      ordersCount: 0, totalSpent: 0, lastPurchaseAt: "", lastActivityAt: "", customerSince: "", segment: "novo",
      historyMayBeTruncated: legacyOrders.length >= PAGE_SIZE,
      orders: orders.map((order) => historyOrder("7sete", order)),
    });
  }

  for (const record of records.values()) {
    record.ordersCount = record.orders.length;
    const newest = [...record.orders].sort((a, b) => Date.parse(String(b.createdAt ?? "")) - Date.parse(String(a.createdAt ?? "")))[0];
    const oldest = [...record.orders].sort((a, b) => Date.parse(String(a.createdAt ?? "")) - Date.parse(String(b.createdAt ?? "")))[0];
    record.lastActivityAt = text(newest?.createdAt);
    const latestPurchase = record.orders.filter((order) => isConfirmedPurchase(record.source, order)).sort((a, b) => Date.parse(String(b.createdAt ?? "")) - Date.parse(String(a.createdAt ?? "")))[0];
    record.lastPurchaseAt = text(latestPurchase?.createdAt);
    if (!record.customerSince) record.customerSince = text(oldest?.createdAt);
    record.totalSpent = record.orders.reduce((sum, order) => sum + (isConfirmedPurchase(record.source, order) ? Number(order.total ?? 0) : 0), 0);
    record.segment = record.ordersCount === 0 ? "novo" : "recorrente";
  }
  return [...records.values()];
}

async function customerRecords(context: Awaited<ReturnType<typeof authorizedContext>>) {
  const [customers, orders] = await Promise.all([
    fetchAllNativeCustomers(),
    fetchAllNativeOrders(),
  ]);
  let legacyOrders: LegacyOrder[] = [];
  let legacyUnavailable = false;
  if (context.legacyStoreId !== null) {
    try {
      legacyOrders = await fetchLegacyOrders(context);
    } catch {
      legacyUnavailable = true;
    }
  }
  const records = buildCustomerRecords(customers, orders, legacyOrders);
  if (legacyUnavailable) records.forEach((record) => { record.legacyUnavailable = true; });
  return { records, legacyUnavailable };
}

router.get("/customers", authMiddleware, asyncHandler(async (req, res) => {
  const context = await authorizedContext(req);
  const { page, limit } = pagination(req);
  const source = normalizedSource(queryString(req, "source"));
  const search = (queryString(req, "search") ?? "").trim().toLocaleLowerCase("pt");
  const { records: allRecords, legacyUnavailable } = await customerRecords(context);
  let records = allRecords;
  if (source) records = records.filter((record) => record.source === source);
  if (search) {
    const phoneSearch = phoneKey(search);
    records = records.filter((record) =>
      `${record.name} ${record.email} ${record.city}`.toLocaleLowerCase("pt").includes(search) ||
      Boolean(phoneSearch && phoneKey(record.phone).includes(phoneSearch)),
    );
  }
  records.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) || a.name.localeCompare(b.name, "pt"));
  const total = records.length;
  const data = records.slice((page - 1) * limit, page * limit).map(({ orders: _orders, ...record }) => ({ ...record, source: record.source === "vendaexpress" ? "venda_express" : "sete" }));
  res.json({ data, meta: { page, limit, total, legacyUnavailable, requestId: generateRequestId() } });
}));

router.get("/customers/:id", authMiddleware, asyncHandler(async (req, res) => {
  const context = await authorizedContext(req);
  const source = normalizedSource(queryString(req, "source"));
  if (!source) throw new ValidationError("Indique source=vendaexpress ou source=7sete para consultar o cliente.");
  const { records, legacyUnavailable } = await customerRecords(context);
  if (legacyUnavailable && source === "7sete") throw new BadGatewayError("O histórico de clientes 7Sete está temporariamente indisponível.");
  const customer = records.find((record) => record.id === req.params.id && record.source === source);
  if (!customer) throw new NotFoundError("cliente");
  const { orders, ...profile } = customer;
  orders.sort((a, b) => Date.parse(String(b.createdAt ?? "")) - Date.parse(String(a.createdAt ?? "")));
  res.json({ data: { ...profile, source: profile.source === "vendaexpress" ? "venda_express" : "sete", legacyUnavailable, orders }, meta: { requestId: generateRequestId() } });
}));

export default router;
