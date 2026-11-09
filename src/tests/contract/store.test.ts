import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import app from "../../main";
import { hasTestCredentials, request, login } from "../helpers";

describe("Integration API — Stores", { skip: !hasTestCredentials }, () => {
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

  it("GET /seller/store returns the seller's store", async () => {
    const res = await request(server, "GET", "/api/v1/seller/store", undefined, cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data);
    assert.strictEqual(res.body.data.id, "str_muxima");
    assert.strictEqual(res.body.data.name, "Muxima Concept Store");
    assert.strictEqual(res.body.data.source, "venda_express");
  });

  it("PATCH /seller/store updates allowed fields", async () => {
    const res = await request(server, "PATCH", "/api/v1/seller/store", {
      name: "Muxima Concept Store Atualizada",
      phone: "+244 923 000 999",
    }, cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.name, "Muxima Concept Store Atualizada");
    assert.strictEqual(res.body.data.phone, "+244 923 000 999");
  });

  it("POST /seller/store without idempotency key returns 422", async () => {
    const res = await request(server, "POST", "/api/v1/seller/store", {
      name: "No Idempotency",
      email: "noid@test.ao",
      phone: "+244 900 000 000",
      city: "Luanda",
      province: "Luanda",
    }, cookie);
    assert.strictEqual(res.status, 422);
  });
});
