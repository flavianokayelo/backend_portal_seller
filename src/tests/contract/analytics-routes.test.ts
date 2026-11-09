import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import cookieParser from "cookie-parser";
import analyticsRoutes from "../../modules/analytics/routes";
import { errorHandler } from "../../middleware/auth";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { setePhpAdapter } from "../../adapters/sete-php/client";
import { testSessionCookie } from "../session";

const nativeOrders = [
  { id: "same", status: "delivered", total: 100, created_at: "2026-11-05T09:00:00+01:00", customer_id: "c1", customer_name: "Ana" },
  { id: "n2", status: "cancelled", total: 20, created_at: "2026-11-04T10:00:00+01:00", customer_id: "c2", customer_name: "Bia" },
];
const legacyOrders = [
  { id: "same", loja_status: "atendido", total: 50, created_at: "2026-11-05 11:00:00", customer_id: "c1", customer_name: "Ana", items: [{ id: "p1", name: "Produto legado", quantity: 3 }] },
];
const nativeProducts = [
  { id: "p1", name: "Produto nativo", stock: 1, lowStockThreshold: 2, status: "published" },
  { id: "p2", name: "Sem vendas", stock: 0, lowStockThreshold: 5, status: "published" },
];

async function withAnalytics(
  run: (url: string, cookie: string) => Promise<void>,
  options: { ownerId?: string; legacyStoreId?: number | null; failLegacy?: boolean; failNative?: boolean } = {},
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
    if (path.startsWith("/orders?")) {
      if (options.failNative) throw new Error("native unavailable");
      return { orders: nativeOrders, total: nativeOrders.length };
    }
    if (path.startsWith("/orders/") && path.endsWith("/items")) return [];
    if (path.startsWith("/products?source=ve")) return { products: nativeProducts, total: nativeProducts.length };
    if (path.startsWith("/products?source=sete")) return { products: [{ id: "lp1", name: "Produto legado", stock: 2, lowStockThreshold: 4, status: "published" }], total: 1 };
    throw new Error(`Unexpected GET ${path}`);
  };
  sete.post = async (path: string, payload: any) => {
    assert.equal(path, "/loja-pedidos.php");
    assert.equal(payload.action, "list");
    assert.equal(payload.store_id, "store-1");
    assert.equal(payload.owner_id, "seller-1");
    if (options.failLegacy) throw new Error("legacy unavailable");
    return { success: true, pedidos: legacyOrders };
  };
  const app = express();
  app.use(cookieParser());
  app.use(analyticsRoutes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`, testSessionCookie(), calls);
  } finally {
    server.close();
    ve.get = oldVeGet;
    sete.post = oldSetePost;
  }
}

describe("Seller analytics routes", () => {
  it("returns period-filtered order metrics and source-qualified products/statuses", async () => {
    await withAnalytics(async (url, cookie) => {
      const response = await fetch(`${url}/analytics/overview?period=30d`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.summary.totalOrders.value, 3);
      assert.equal(payload.data.summary.grossOrderValue.value, 170);
      assert.equal(payload.data.topProducts[0].source, "sete");
      assert.equal(payload.data.topProducts[0].unitsOrdered, 3);
      assert.equal(payload.data.topProducts.length, 1);
      assert.equal(payload.data.lowStockProducts.length, 3);
      assert.ok(payload.data.sourceBreakdown.some((source: any) => source.source === "sete"));
      assert.ok(payload.data.orderStatusBreakdown.some((row: any) => row.status === "cancelled" && row.count === 1));
      assert.equal(payload.meta.dataComplete, true);
    });
  });

  it("does not query the legacy adapter for native stores and confirms empty-period zeros", async () => {
    await withAnalytics(async (url, cookie, calls) => {
      const response = await fetch(`${url}/analytics/overview?period=7d`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.sourceStatus.find((source: any) => source.source === "sete").linked, false);
      assert.equal(payload.data.summary.totalOrders.value, 2);
      assert.equal(calls.some((path) => path.includes("source=sete")), false);
    }, { legacyStoreId: null });
  });

  it("marks unavailable upstream sources and totals incomplete while preserving known values", async () => {
    await withAnalytics(async (url, cookie) => {
      const response = await fetch(`${url}/analytics/overview?period=all`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.sourceStatus.find((source: any) => source.source === "sete").ordersAvailable, false);
      assert.equal(payload.data.summary.totalOrders.value, null);
      assert.equal(payload.data.summary.totalOrders.knownValue, 2);
      assert.equal(payload.data.dataComplete, false);
    }, { failLegacy: true });
  });

  it("validates seller ownership before collecting analytics", async () => {
    await withAnalytics(async (url, cookie) => {
      const response = await fetch(`${url}/analytics/overview`, { headers: { cookie } });
      assert.equal(response.status, 403);
    }, { ownerId: "seller-2" });
  });

  it("rejects unsupported periods and maintains the dashboard compatibility contract", async () => {
    await withAnalytics(async (url, cookie) => {
      const invalid = await fetch(`${url}/analytics/overview?period=365d`, { headers: { cookie } });
      assert.equal(invalid.status, 422);
      const dashboard = await fetch(`${url}/dashboard?period=all`, { headers: { cookie } });
      const payload = await dashboard.json() as any;
      assert.equal(dashboard.status, 200);
      assert.ok(payload.data.summary);
      assert.ok(Array.isArray(payload.data.series));
      assert.ok(Array.isArray(payload.data.topProducts));
      assert.ok(Array.isArray(payload.data.lowStockProducts));
    });
  });
});
