import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import cookieParser from "cookie-parser";
import storeRoutes from "../../modules/stores/routes";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { testSessionCookie } from "../session";

type StoreFixture = Record<string, any> | null;

async function withApi(
  store: StoreFixture,
  run: (url: string, state: { updates: unknown[] }, cookie: string) => Promise<void>,
  options: { ownerId?: string; putError?: Error } = {},
) {
  const adapter = vendaExpressAdapter as any;
  const oldGet = adapter.get;
  const oldPut = adapter.put;
  const oldPostStream = adapter.postStream;
  const updates: unknown[] = [];
  let currentStore = store;
  adapter.get = async (path: string) => {
    if (path === "/auth/me") return { user: { id: "seller-1", account_kind: "loja" } };
    if (path === "/stores/mine") {
      return currentStore ? { ...currentStore, owner_id: options.ownerId ?? "seller-1" } : null;
    }
    throw new Error(`Unexpected upstream GET ${path}`);
  };
  adapter.put = async (_path: string, payload: unknown) => {
    updates.push(payload);
    if (options.putError) throw options.putError;
    if (currentStore) currentStore = { ...currentStore, ...(payload as object) };
    return {};
  };
  adapter.postStream = async (path: string) => path.endsWith("store-logo")
    ? { url: "/uploads/store-1/logo.png" }
    : { urls: ["/uploads/store-1/banner.png"] };

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(storeRoutes);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`, { updates }, testSessionCookie({ storeId: store?.id ?? undefined }));
  } finally {
    server.close();
    adapter.get = oldGet;
    adapter.put = oldPut;
    adapter.postStream = oldPostStream;
  }
}

const native = { id: "store-ve-1", name: "Loja", slug: "loja", status: "active", id_loja_antiga: null };

describe("Seller store routes", () => {
  it("returns a native store with explicit null legacy identity", async () => {
    await withApi(native, async (url, _state, cookie) => {
      const response = await fetch(`${url}/store`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.legacyStoreId, null);
      assert.equal(payload.data.storeKind, "native");
      assert.equal(payload.data.sourceId, "store-ve-1");
    });
  });

  it("preserves a legacy supplier ID without replacing the VendaExpress store ID", async () => {
    await withApi({ ...native, id_loja_antiga: 1 }, async (url, _state, cookie) => {
      const response = await fetch(`${url}/store`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.id, "store-ve-1");
      assert.equal(payload.data.legacyStoreId, 1);
      assert.equal(payload.data.sourceId, "1");
      assert.equal(payload.data.storeKind, "legacy");
      assert.equal(payload.data.source, "sete");
    });
  });

  it("returns not found when the authenticated seller has no store", async () => {
    await withApi(null, async (url, _state, cookie) => {
      const response = await fetch(`${url}/store`, { headers: { cookie } });
      assert.equal(response.status, 404);
    });
  });

  it("blocks a store owned by a different seller", async () => {
    await withApi(native, async (url, _state, cookie) => {
      const response = await fetch(`${url}/store`, { headers: { cookie } });
      assert.equal(response.status, 403);
    }, { ownerId: "seller-2" });
  });

  it("sends only changed native fields upstream", async () => {
    await withApi(native, async (url, state, cookie) => {
      const response = await fetch(`${url}/store`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Nova loja" }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(state.updates, [{ name: "Nova loja" }]);
      assert.equal((await response.json() as any).data.name, "Nova loja");
    });
  });

  it("does not claim success when the VendaExpress update fails", async () => {
    await withApi(native, async (url, _state, cookie) => {
      const response = await fetch(`${url}/store`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Nova loja" }),
      });
      assert.equal(response.status, 502);
    }, { putError: new Error("upstream unavailable") });
  });

  it("does not send legacy profile updates to VendaExpress", async () => {
    await withApi({ ...native, id_loja_antiga: 1 }, async (url, state, cookie) => {
      const response = await fetch(`${url}/store`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Nova loja" }),
      });
      assert.equal(response.status, 501);
      assert.deepEqual(state.updates, []);
    });
  });

  it("uploads a native store logo through the authenticated adapter", async () => {
    await withApi(native, async (url, _state, cookie) => {
      const body = new FormData();
      body.append("file", new Blob(["image"], { type: "image/png" }), "logo.png");
      const response = await fetch(`${url}/uploads/store-logo`, {
        method: "POST",
        headers: { cookie },
        body,
      });
      const payload = await response.json() as any;
      assert.equal(response.status, 201);
      assert.equal(new URL(payload.data.url).pathname, "/uploads/store-1/logo.png");
    });
  });

  it("blocks native-only store media uploads for legacy shops", async () => {
    await withApi({ ...native, id_loja_antiga: 1 }, async (url, _state, cookie) => {
      const body = new FormData();
      body.append("file", new Blob(["image"], { type: "image/png" }), "logo.png");
      const response = await fetch(`${url}/uploads/store-logo`, {
        method: "POST",
        headers: { cookie },
        body,
      });
      assert.equal(response.status, 501);
    });
  });
});
