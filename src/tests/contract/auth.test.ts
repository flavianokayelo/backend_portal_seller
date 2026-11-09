import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import app from "../../main";
import { hasTestCredentials, request, login } from "../helpers";

describe("Integration API — Authentication", { skip: !hasTestCredentials }, () => {
  let server;
  let cookie;

  before(async () => {
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("POST /auth/login returns session and sets cookie", async () => {
    const email = process.env.INTEGRATION_TEST_EMAIL;
    const password = process.env.INTEGRATION_TEST_PASSWORD;
    assert.ok(email && password, "Defina as credenciais de teste no ambiente.");
    const res = await request(server, "POST", "/api/v1/auth/login", {
      email,
      password,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data);
    assert.ok(res.body.data.user);
    assert.ok(res.body.data.user.id);
    assert.ok(res.body.data.seller);
    assert.ok(Array.isArray(res.body.data.stores));
    assert.ok(res.body.data.stores.length > 0);
    const setCookie = res.headers["set-cookie"];
    assert.ok(setCookie);
    cookie = setCookie[0].split(";")[0];
    assert.ok(cookie.startsWith("sid="));
  });

  it("GET /me returns authenticated seller session", async () => {
    cookie = await login(server);
    const res = await request(server, "GET", "/api/v1/me", undefined, cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.user.id);
    assert.ok(res.body.data.storeId);
  });

  it("GET /me without cookie returns 401", async () => {
    const res = await request(server, "GET", "/api/v1/me");
    assert.strictEqual(res.status, 401);
  });

  it("POST /auth/login with wrong password returns 401", async () => {
    const email = process.env.INTEGRATION_TEST_EMAIL;
    assert.ok(email, "Defina INTEGRATION_TEST_EMAIL no ambiente.");
    const res = await request(server, "POST", "/api/v1/auth/login", {
      email,
      password: `invalid-${Date.now()}`,
    });
    assert.strictEqual(res.status, 401);
  });

  it("POST /auth/logout clears session", async () => {
    cookie = await login(server);
    const res = await request(server, "POST", "/api/v1/auth/logout", undefined, cookie);
    assert.strictEqual(res.status, 200);
    const res2 = await request(server, "GET", "/api/v1/me", undefined, cookie);
    assert.strictEqual(res2.status, 401);
  });
});
