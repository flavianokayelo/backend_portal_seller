import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import app from "../../main";
import { hasTestCredentials, request, login } from "../helpers";

describe("Integration API — Orders", { skip: !hasTestCredentials }, () => {
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

  it("GET /seller/orders lists orders", async () => {
    const res = await request(server, "GET", "/api/v1/seller/orders", undefined, cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.meta.total >= 0);
  });

  it("GET /seller/orders/:id returns order detail", async () => {
    const res = await request(server, "GET", "/api/v1/seller/orders/ord_10321?source=sete", undefined, cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.id, "ord_10321");
    assert.strictEqual(res.body.data.reference, "7S-10321");
    assert.ok(Array.isArray(res.body.data.items));
  });

  it("PATCH /seller/orders/:id/status transitions order", async () => {
    const res = await request(server, "PATCH", "/api/v1/seller/orders/ord_10321/status", {
      status: "confirmed",
    }, cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.status, "confirmed");
  });

  it("PATCH /seller/orders/:id/status invalid transition returns 422", async () => {
    const res = await request(server, "PATCH", "/api/v1/seller/orders/ord_10321/status", {
      status: "pending",
    }, cookie);
    assert.strictEqual(res.status, 422);
  });

  it("GET /seller/orders with source filter", async () => {
    const res = await request(server, "GET", "/api/v1/seller/orders?source=sete", undefined, cookie);
    assert.strictEqual(res.status, 200);
    for (const order of res.body.data) {
      assert.strictEqual(order.source, "sete");
    }
  });
});
