import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import cookieParser from "cookie-parser";
import financeRoutes from "../../modules/finance/routes";
import { errorHandler } from "../../middleware/auth";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { testSessionCookie } from "../session";
import { setePhpAdapter } from "../../adapters/sete-php/client";

async function withFinance(run: (url: string, cookie: string) => Promise<void>, options: { ownerId?: string; failLegacy?: boolean; legacyStoreId?: number | null } = {}) {
  const ve = vendaExpressAdapter as any;
  const sete = setePhpAdapter as any;
  const oldVeGet = ve.get;
  const oldSetePost = sete.post;
  const nativeOrders = [
    { id: "same-1", reference: "N-1", total: 100, status: "paid", payment_method: "transferencia", created_at: "2026-11-01T10:00:00Z" },
    { id: "n-2", total: 40, status: "pending", created_at: "2026-11-02T10:00:00Z" },
    { id: "n-3", total: 10, status: "cancelled", created_at: "2026-11-03T10:00:00Z" },
  ];
  ve.get = async (path: string) => {
    if (path === "/auth/me") return { user: { id: "seller-1", account_kind: "loja" } };
    if (path === "/stores/mine") return { id: "store-1", owner_id: options.ownerId ?? "seller-1", id_loja_antiga: options.legacyStoreId === undefined ? 1 : options.legacyStoreId };
    if (path.startsWith("/orders?")) return { orders: nativeOrders, total: nativeOrders.length };
    throw new Error(`Unexpected GET ${path}`);
  };
  sete.post = async (_path: string) => {
    if (options.failLegacy) throw new Error("legacy unavailable");
    return { success: true, pedidos: [{ id: "same-1", order_ref: "L-1", total: 30, loja_status: "recusado", created_at: "2026-11-04 09:00:00" }] };
  };
  const app = express();
  app.use(cookieParser());
  app.use(financeRoutes);
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

describe("Seller finance routes", () => {
  it("returns source-separated order movements and explicit incomplete payment metrics", async () => {
    await withFinance(async (url, cookie) => {
      const response = await fetch(`${url}/finance?period=all&limit=100`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.ok(payload.data.transactions.every((row: any) => row.type === "order"));
      assert.equal(payload.data.summary.orderedValue.knownValue, 180);
      assert.equal(payload.data.summary.paidValue.value, null);
      assert.equal(payload.data.summary.pendingPaymentValue.value, null);
      assert.equal(payload.data.summary.pendingOrderValue.knownValue, 40);
      assert.equal(payload.data.summary.cancelledValue.value, 40);
      assert.equal(payload.data.summary.refundedValue.value, null);
      assert.equal(payload.data.summary.availableBalance.value, null);
      assert.equal(payload.data.transactions.filter((row: any) => row.orderId === "same-1").length, 2);
      assert.notEqual(payload.data.transactions.find((row: any) => row.orderId === "same-1" && row.source === "venda_express").id, payload.data.transactions.find((row: any) => row.orderId === "same-1" && row.source === "sete").id);
      assert.equal(payload.data.summary.legacyPaymentStatusAvailable, false);
      assert.equal(payload.data.summary.salesPaymentConfirmationAvailable, false);
    });
  });

  it("validates the authenticated seller's store ownership", async () => {
    await withFinance(async (url, cookie) => {
      const response = await fetch(`${url}/finance/summary`, { headers: { cookie } });
      assert.equal(response.status, 403);
    }, { ownerId: "seller-2" });
  });

  it("keeps native figures while marking legacy history unavailable", async () => {
    await withFinance(async (url, cookie) => {
      const response = await fetch(`${url}/finance/summary?period=all`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.legacyUnavailable, true);
      assert.equal(payload.data.orderedValue.value, null);
      assert.equal(payload.data.orderedValue.knownValue, 150);
    }, { failLegacy: true });
  });

  it("does not call the legacy adapter for a native store and reports complete zero-period values", async () => {
    await withFinance(async (url, cookie) => {
      const response = await fetch(`${url}/finance/transactions?period=all&page=10&limit=10`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.length, 0);
      assert.equal(payload.meta.summary.salesPaymentConfirmationAvailable, false);
      assert.equal(payload.meta.total, 3);
    }, { legacyStoreId: null });
  });
});
