import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import cookieParser from "cookie-parser";
import productRoutes from "../../modules/catalog/routes";
import { errorHandler } from "../../middleware/auth";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { testSessionCookie } from "../session";

const native = { id: 12, name: "Native", description: "keep me", category_id: "cat-1", price: 10, stock: 4, active: true, images: [] };
const legacy = { id: "sete-12", sete_p_id: 12, source: "sete", name: "Legacy", description: "old", price: 20, stock: 6, active: true, images: [] };

async function withProducts(
  run: (url: string, cookie: string, state: { puts: Array<{ path: string; payload: any }>; posts: unknown[] }) => Promise<void>,
  options: { ownerId?: string; products?: any[]; putFailure?: boolean } = {},
) {
  const adapter = vendaExpressAdapter as any;
  const oldMethods = { get: adapter.get, post: adapter.post, put: adapter.put, delete: adapter.delete, postStream: adapter.postStream };
  const state = { puts: [] as Array<{ path: string; payload: any }>, posts: [] as unknown[] };
  const rows = options.products ?? [native, legacy];
  adapter.get = async (path: string) => {
    if (path === "/auth/me") return { user: { id: "seller-1", account_kind: "loja" } };
    if (path === "/stores/mine") return { id: "store-1", owner_id: options.ownerId ?? "seller-1", id_loja_antiga: 1 };
    if (path === "/categories") return [{ id: "cat-1", name: "Geral" }];
    if (path.startsWith("/products?")) {
      const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const source = query.get("source");
      const products = rows.filter((row) => source === "all" || (source === "sete" ? row.source === "sete" : row.source !== "sete"));
      return { products, total: products.length, page: Number(query.get("page") ?? 1), limit: Number(query.get("limit") ?? 100) };
    }
    throw new Error(`Unexpected upstream GET ${path}`);
  };
  adapter.post = async (path: string, payload: unknown) => {
    state.posts.push(payload);
    if (path === "/products") return { id: 99, ...payload };
    throw new Error(`Unexpected upstream POST ${path}`);
  };
  adapter.put = async (path: string, payload: any) => {
    state.puts.push({ path, payload });
    if (options.putFailure) throw new Error("upstream unavailable");
    return { ...payload, id: path.endsWith("sete-12") ? "sete-12" : 12, source: path.endsWith("sete-12") ? "sete" : "ve" };
  };
  adapter.delete = async () => undefined;
  adapter.postStream = async () => ({ photos: [{ url: "/uploads/p.png", hash: "img-hash" }] });

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(productRoutes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`, testSessionCookie(), state);
  } finally {
    server.close();
    Object.assign(adapter, oldMethods);
  }
}

describe("Seller product routes", () => {
  it("lists native and legacy products with source-qualified IDs", async () => {
    await withProducts(async (url, cookie) => {
      const response = await fetch(`${url}/products?source=all`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.deepEqual(payload.data.map((p: any) => [p.id, p.source, p.sourceId]), [["12", "venda_express", "12"], ["sete-12", "sete", "12"]]);
    });
  });

  it("blocks access to a store owned by another seller", async () => {
    await withProducts(async (url, cookie) => {
      const response = await fetch(`${url}/products`, { headers: { cookie } });
      assert.equal(response.status, 403);
    }, { ownerId: "seller-2" });
  });

  it("merges partial native updates before calling the full-update upstream contract", async () => {
    await withProducts(async (url, cookie, state) => {
      const response = await fetch(`${url}/products/12?source=ve`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ price: 15 }) });
      assert.equal(response.status, 200);
      assert.equal(state.puts[0]?.payload.name, "Native");
      assert.equal(state.puts[0]?.payload.price, 15);
      assert.equal(state.puts[0]?.payload.description, "keep me");
    });
  });

  it("routes legacy edits through the legacy facade and rejects unsupported image edits", async () => {
    await withProducts(async (url, cookie, state) => {
      const allowed = await fetch(`${url}/products/sete-12?source=sete`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ price: 25 }) });
      assert.equal(allowed.status, 200);
      assert.equal(state.puts[0]?.path, "/products/sete-12");
      const rejected = await fetch(`${url}/products/sete-12?source=sete`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ images: [] }) });
      assert.equal(rejected.status, 501);
      assert.equal(state.puts.length, 1);
    });
  });

  it("returns explicit upstream errors and does not claim persistence succeeded", async () => {
    await withProducts(async (url, cookie) => {
      const response = await fetch(`${url}/products/12?source=ve`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ price: 15 }) });
      assert.equal(response.status, 502);
    }, { putFailure: true });
  });

  it("creates native products and returns uploaded image hashes from the upstream", async () => {
    await withProducts(async (url, cookie, state) => {
      const created = await fetch(`${url}/products`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Novo produto", category: "Geral", price: 10, stock: 2, status: "published" }) });
      assert.equal(created.status, 201);
      assert.equal(state.posts.length, 1);
      const body = new FormData();
      body.append("files", new Blob(["image"], { type: "image/png" }), "image.png");
      const uploaded = await fetch(`${url}/uploads/product-images`, { method: "POST", headers: { cookie }, body });
      assert.equal(uploaded.status, 201);
      assert.equal(((await uploaded.json() as any).data.photos[0]).hash, "img-hash");
    });
  });

  it("does not expose legacy hard-delete without historical-order safety", async () => {
    await withProducts(async (url, cookie) => {
      const response = await fetch(`${url}/products/sete-12?source=sete`, { method: "DELETE", headers: { cookie } });
      assert.equal(response.status, 501);
    });
  });
});
