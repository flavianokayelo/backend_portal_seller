import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import app from "../../main";
import { hasTestCredentials, request, login } from "../helpers";

describe("Integration API — Catalog (Products)", { skip: !hasTestCredentials }, () => {
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

  it("GET /seller/products lists products", async () => {
    const res = await request(server, "GET", "/api/v1/seller/products", undefined, cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.meta);
    assert.ok(res.body.meta.total >= 0);
  });

  it("GET /seller/products/:id returns product detail", async () => {
    const res = await request(server, "GET", "/api/v1/seller/products/prd_samakaka?source=sete", undefined, cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.id, "prd_samakaka");
    assert.strictEqual(res.body.data.source, "sete");
  });

  it("GET /seller/products/:id with wrong source returns 404", async () => {
    const res = await request(server, "GET", "/api/v1/seller/products/prd_samakaka?source=venda_express", undefined, cookie);
    assert.strictEqual(res.status, 404);
  });

  it("POST /seller/products creates a product", async () => {
    const res = await request(server, "POST", "/api/v1/seller/products", {
      name: "Produto Teste",
      description: "Descrição de teste",
      category: "Teste",
      price: 5000,
      stock: 10,
      status: "draft",
    }, cookie);
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.data.id);
    assert.strictEqual(res.body.data.name, "Produto Teste");
    assert.strictEqual(res.body.data.stock, 10);
  });

  it("PATCH /seller/products/:id/stock updates stock", async () => {
    const create = await request(server, "POST", "/api/v1/seller/products", {
      name: "Stock Teste",
      description: "Desc",
      category: "Teste",
      price: 1000,
      stock: 5,
      status: "published",
    }, cookie);
    const productId = create.body.data.id;

    const res = await request(server, "PATCH", `/api/v1/seller/products/${productId}/stock`, {
      stock: 20,
    }, cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.stock, 20);
  });

  it("PATCH /seller/products/:id/stock with negative stock returns 422", async () => {
    const res = await request(server, "PATCH", "/api/v1/seller/products/prd_samakaka/stock", {
      stock: -1,
    }, cookie);
    assert.strictEqual(res.status, 422);
  });

  it("DELETE /seller/products/:id archives product", async () => {
    const create = await request(server, "POST", "/api/v1/seller/products", {
      name: "To Archive",
      description: "Desc",
      category: "Teste",
      price: 1000,
      stock: 5,
      status: "published",
    }, cookie);
    const productId = create.body.data.id;

    const res = await request(server, "DELETE", `/api/v1/seller/products/${productId}`, undefined, cookie);
    assert.strictEqual(res.status, 204);

    const get = await request(server, "GET", `/api/v1/seller/products/${productId}`, undefined, cookie);
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.body.data.status, "archived");
  });

  it("GET /catalog/categories returns categories", async () => {
    const res = await request(server, "GET", "/api/v1/catalog/categories");
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length > 0);
  });
});
