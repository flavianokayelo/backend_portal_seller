import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import app from "../../main";
import { hasTestCredentials, request, login } from "../helpers";

describe("Integration API — Security", { skip: !hasTestCredentials }, () => {
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

  it("Unauthenticated access to /seller/store returns 401", async () => {
    const res = await request(server, "GET", "/api/v1/seller/store");
    assert.strictEqual(res.status, 401);
  });

  it("Unauthenticated access to /seller/orders returns 401", async () => {
    const res = await request(server, "GET", "/api/v1/seller/orders");
    assert.strictEqual(res.status, 401);
  });

  it("Invalid session cookie returns 401", async () => {
    const res = await request(server, "GET", "/api/v1/me", undefined, "sid=invalid");
    assert.strictEqual(res.status, 401);
  });

  it("Rate limiting on login endpoint", async () => {
    const email = process.env.INTEGRATION_TEST_EMAIL;
    assert.ok(email, "Defina INTEGRATION_TEST_EMAIL no ambiente.");
    let rateLimited = false;
    for (let i = 0; i < 15; i++) {
      const res = await request(server, "POST", "/api/v1/auth/login", {
        email,
        password: `invalid-${i}-${Date.now()}`,
      });
      if (res.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert.ok(rateLimited, "should hit rate limit after multiple failed logins");
  });

  it("POST /seller/products without authentication returns 401", async () => {
    const res = await request(server, "POST", "/api/v1/seller/products", {
      name: "No Auth Product",
      description: "Desc",
      category: "Teste",
      price: 1000,
      stock: 5,
      status: "draft",
    });
    assert.strictEqual(res.status, 401);
  });

  it("Error response does not leak stack traces or internal details", async () => {
    const res = await request(server, "GET", "/api/v1/seller/products/nonexistent", undefined, cookie);
    assert.strictEqual(res.status, 404);
    assert.ok(res.body.error);
    assert.ok(res.body.error.code);
    assert.ok(res.body.error.message);
    assert.ok(res.body.error.requestId);
    assert.strictEqual(res.body.error.stack, undefined);
  });

  it("CORS headers present on responses", async () => {
    const res = await request(server, "GET", "/api/v1/me", undefined, cookie);
    assert.ok(res.headers["access-control-allow-credentials"]);
  });
});
