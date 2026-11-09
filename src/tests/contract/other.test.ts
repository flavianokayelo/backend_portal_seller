import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import app from "../../main";
import { hasTestCredentials, request, login } from "../helpers";

describe("Integration API — Customers, Reviews, Finance, Notifications, Analytics", { skip: !hasTestCredentials }, () => {
  let server;
  let cookie;

  before(async () => {
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    cookie = await login(server);
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("GET /seller/customers lists customers", async () => {
    const res = await request(server, "GET", "/api/v1/seller/customers", undefined, cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  });

  it("GET /seller/reviews lists reviews", async () => {
    const res = await request(server, "GET", "/api/v1/seller/reviews", undefined, cookie);
    assert.ok([200, 501, 502].includes(res.status));
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.data));
      assert.ok(typeof res.body.meta.dataComplete === "boolean");
    }
  });

  it("GET /seller/finance/summary returns finance data", async () => {
    const res = await request(server, "GET", "/api/v1/seller/finance/summary", undefined, cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data);
    assert.ok(res.body.data.orderedValue);
    assert.ok(res.body.data.paidValue);
    assert.ok(res.body.data.pendingPaymentValue);
    assert.strictEqual(res.body.data.salesPaymentConfirmationAvailable, false);
    assert.strictEqual(res.body.data.refundedValue.value, null);
    assert.strictEqual(res.body.data.currency, "AOA");
  });

  it("GET /seller/finance/transactions lists transactions", async () => {
    const res = await request(server, "GET", "/api/v1/seller/finance/transactions", undefined, cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.strictEqual(res.body.data[0]?.type, "order");
  });

  it("GET /seller/notifications returns incomplete empty feed when source is not confirmed", async () => {
    const res = await request(server, "GET", "/api/v1/seller/notifications", undefined, cookie);
    // 200 = feed incompleto (opção A); 502 = falha a validar a origem
    assert.ok([200, 502].includes(res.status));
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.data));
      assert.equal(res.body.data.length, 0);
      assert.equal(res.body.meta.complete, false);
      assert.ok(
        ["NOTIFICATIONS_SOURCE_UNSUPPORTED", "NOTIFICATIONS_IDENTITY_MAPPING_REQUIRED"].includes(
          res.body.meta.code,
        ),
      );
    }
  });

  it("PATCH /seller/notifications/:id/read never claims an unpersisted read state", async () => {
    const res = await request(server, "PATCH", "/api/v1/seller/notifications/ntf_001/read", undefined, cookie);
    assert.ok([501, 502].includes(res.status));
    if (res.status === 501) assert.equal("data" in res.body, false);
  });

  it("GET /seller/dashboard returns dashboard data", async () => {
    const res = await request(server, "GET", "/api/v1/seller/dashboard", undefined, cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.summary);
    assert.ok(Array.isArray(res.body.data.series));
    assert.ok(Array.isArray(res.body.data.topProducts));
  });

  it("GET /health returns ok", async () => {
    const res = await request(server, "GET", "/health");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, "ok");
  });
});
