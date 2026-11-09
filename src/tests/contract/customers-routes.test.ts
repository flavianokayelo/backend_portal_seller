import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import cookieParser from "cookie-parser";
import customerRoutes from "../../modules/customers/routes";
import { errorHandler } from "../../middleware/auth";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { testSessionCookie } from "../session";
import { setePhpAdapter } from "../../adapters/sete-php/client";

const customerRows = [
  { id: "5", name: "Ana Silva", email: "ana@example.test", phone: "+244 923 000 001", city: "Luanda", created_at: "2025-01-01" },
  { id: "6", name: "Sem pedidos", email: null, phone: null, city: null, created_at: "2025-02-01" },
];
const nativeOrders = [
  { id: "n-1", customer_id: "5", customer_name: "Ana Silva", customer_phone: "+244 923 000 001", total: 100, status: "paid", created_at: "2026-01-02T00:00:00Z" },
  { id: "n-2", customer_id: "5", customer_name: "Ana Silva", customer_phone: "+244 923 000 001", total: 50, status: "delivered", created_at: "2026-01-03T00:00:00Z" },
  { id: "n-3", customer_id: null, customer_name: "Outro cliente", customer_phone: "555123", total: 20, status: "pending", created_at: "2026-01-05T00:00:00Z" },
  { id: "n-4", customer_id: null, customer_name: "Outro cliente", customer_phone: "555123", total: 30, status: "paid", created_at: "2026-01-06T00:00:00Z" },
];
const legacyOrders = [
  { id: "5", customer_id: "5", customer_name: "Ana Silva legada", customer_phone: "923000002", total: 70, loja_status: "atendido", created_at: "2026-01-04 10:00:00" },
];

async function withCustomers(
  run: (url: string, cookie: string) => Promise<void>,
  options: { ownerId?: string; failOrders?: boolean; failLegacy?: boolean; legacyStoreId?: number | null } = {},
) {
  const ve = vendaExpressAdapter as any;
  const sete = setePhpAdapter as any;
  const oldVeGet = ve.get;
  const oldSetePost = sete.post;
  const calls: string[] = [];
  ve.get = async (path: string) => {
    calls.push(path);
    if (path === "/auth/me") return { user: { id: "seller-1", account_kind: "loja" } };
    if (path === "/stores/mine") return { id: "store-1", owner_id: options.ownerId ?? "seller-1", id_loja_antiga: options.legacyStoreId === undefined ? 1 : options.legacyStoreId };
    if (path.startsWith("/customers?")) return { customers: customerRows, total: customerRows.length };
    if (path.startsWith("/orders?")) {
      if (options.failOrders) throw new Error("upstream unavailable");
      return { orders: nativeOrders, total: nativeOrders.length };
    }
    throw new Error(`Unexpected GET ${path}`);
  };
  sete.post = async (path: string, payload: any) => {
    assert.equal(path, "/loja-pedidos.php");
    assert.equal(payload.store_id, "store-1");
    if (options.failLegacy) throw new Error("legacy upstream unavailable");
    return { success: true, pedidos: options.legacyStoreId === null ? [] : legacyOrders };
  };
  const app = express();
  app.use(cookieParser());
  app.use(customerRoutes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`, testSessionCookie());
  } finally {
    server.close();
    ve.get = oldVeGet;
    sete.post = oldSetePost;
  }
}

describe("Seller customer routes", () => {
  it("aggregates clients with and without orders while keeping same IDs from origins separate", async () => {
    await withCustomers(async (url, cookie) => {
      const response = await fetch(`${url}/customers?limit=100`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      const native = payload.data.find((customer: any) => customer.id === "ve:5");
      const legacy = payload.data.find((customer: any) => customer.source === "sete" && customer.sourceId === "5");
      const empty = payload.data.find((customer: any) => customer.id === "ve:6");
      assert.equal(native.ordersCount, 2);
      assert.equal(native.totalSpent, 150);
      assert.equal(legacy.ordersCount, 1);
      assert.equal(legacy.totalSpent, 70);
      assert.equal(empty.ordersCount, 0);
      assert.equal(empty.totalSpent, 0);
      assert.notEqual(native.id, legacy.id);
      const incomplete = payload.data.find((customer: any) => customer.name === "Outro cliente");
      assert.equal(incomplete.ordersCount, 2);
      assert.equal(incomplete.totalSpent, 30);
    });
  });

  it("searches name and contact, and paginates after aggregation", async () => {
    await withCustomers(async (url, cookie) => {
      const response = await fetch(`${url}/customers?search=923000001&page=1&limit=1`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.meta.total, 1);
      assert.equal(payload.meta.page, 1);
      assert.equal(payload.data.length, 1);
      assert.equal(payload.data[0].name, "Ana Silva");
    }, { legacyStoreId: null });
  });

  it("returns only the selected customer's source-scoped order history", async () => {
    await withCustomers(async (url, cookie) => {
      const response = await fetch(`${url}/customers/${encodeURIComponent("ve:5")}?source=venda_express`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.orders.length, 2);
      assert.ok(payload.data.orders.every((order: any) => order.source === "venda_express"));
      const wrongOrigin = await fetch(`${url}/customers/${encodeURIComponent("ve:5")}?source=sete`, { headers: { cookie } });
      assert.equal(wrongOrigin.status, 404);
    });
  });

  it("resolves legacy customer history by its origin-qualified identity", async () => {
    await withCustomers(async (url, cookie) => {
      const list = await fetch(`${url}/customers?source=sete`, { headers: { cookie } });
      const customer = (await list.json() as any).data[0];
      const response = await fetch(`${url}/customers/${encodeURIComponent(customer.id)}?source=sete`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.source, "sete");
      assert.equal(payload.data.orders[0].id, "5");
      assert.equal(payload.data.orders[0].status, "confirmed");
      assert.equal("deliveryAddress" in payload.data.orders[0], false);
    });
  });

  it("blocks a store owned by another account", async () => {
    await withCustomers(async (url, cookie) => {
      const response = await fetch(`${url}/customers`, { headers: { cookie } });
      assert.equal(response.status, 403);
    }, { ownerId: "seller-2" });
  });

  it("returns a controlled upstream error instead of an incomplete customer list", async () => {
    await withCustomers(async (url, cookie) => {
      const response = await fetch(`${url}/customers`, { headers: { cookie } });
      assert.equal(response.status, 502);
    }, { failOrders: true, legacyStoreId: null });
  });

  it("keeps native customer data available and reports a failed legacy source", async () => {
    await withCustomers(async (url, cookie) => {
      const response = await fetch(`${url}/customers`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.meta.legacyUnavailable, true);
      assert.ok(payload.data.some((customer: any) => customer.source === "venda_express"));
      assert.ok(payload.data.every((customer: any) => customer.source !== "sete"));
    }, { failLegacy: true });
  });
});
