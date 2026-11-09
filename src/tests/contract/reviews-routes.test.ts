import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import cookieParser from "cookie-parser";
import reviewRoutes from "../../modules/reviews/routes";
import { errorHandler } from "../../middleware/auth";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { setePhpAdapter } from "../../adapters/sete-php/client";
import { testSessionCookie } from "../session";

const reviews = [
  { id: 12, cliente_id: 8, nome_cliente: "Ana", nota: 5, comentario: "Excelente", data_avaliacao: "2026-01-01", product_name: "Produto A" },
  { id: "13", nome_cliente: "Bia", nota: 4, comentario: "", tempo: "há 2 dias" },
];

async function withReviews(
  run: (url: string, cookie: string) => Promise<void>,
  options: { ownerId?: string; legacyStoreId?: number | null; failLegacy?: boolean } = {},
) {
  const ve = vendaExpressAdapter as any;
  const sete = setePhpAdapter as any;
  const oldVeGet = ve.get;
  const oldSeteGet = sete.get;
  const calls: string[] = [];
  ve.get = async (path: string) => {
    if (path === "/auth/me") return { user: { id: "seller-1", account_kind: "loja" } };
    if (path === "/stores/mine") return { id: "store-1", owner_id: options.ownerId ?? "seller-1", id_loja_antiga: options.legacyStoreId === undefined ? 1 : options.legacyStoreId };
    throw new Error(`Unexpected GET ${path}`);
  };
  sete.get = async (path: string) => {
    calls.push(path);
    if (options.failLegacy) throw new Error("legacy unavailable");
    const url = new URL(path, "https://7sete.ao");
    assert.equal(url.pathname, "/api_avaliacoes.php");
    assert.equal(url.searchParams.get("fornecedor_id"), String(options.legacyStoreId === undefined ? 1 : options.legacyStoreId));
    const offset = Number(url.searchParams.get("offset"));
    const data = offset === 0 ? reviews : [];
    return { success: true, data, meta: { total: 2, media: 4.5, distribuicao: { "4": 1, "5": 1 } } };
  };
  const app = express();
  app.use(cookieParser());
  app.use(reviewRoutes);
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
    sete.get = oldSeteGet;
  }
}

describe("Seller review routes", () => {
  it("lists source-qualified legacy reviews and hides the average while a source is incomplete", async () => {
    await withReviews(async (url, cookie) => {
      const response = await fetch(`${url}/reviews?limit=10`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.length, 2);
      assert.equal(payload.data[0].id, "sete:12");
      assert.equal(payload.data[1].id, "sete:13");
      assert.equal(payload.data[1].comment, "");
      assert.equal(payload.meta.dataComplete, false);
      assert.equal(payload.meta.legacyDataComplete, true);
      assert.equal(payload.meta.averageRating, null);
      assert.equal(payload.meta.sourceStatus.venda_express, "unsupported");
      assert.equal(payload.meta.repliesSupported, false);
    });
  });

  it("resolves details only for an origin-qualified legacy review ID", async () => {
    await withReviews(async (url, cookie) => {
      const response = await fetch(`${url}/reviews/${encodeURIComponent("sete:12")}`, { headers: { cookie } });
      const payload = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(payload.data.id, "sete:12");
      assert.equal(payload.data.source, "sete");
      assert.equal(payload.data.sourceId, "12");
      const wrongOrigin = await fetch(`${url}/reviews/${encodeURIComponent("venda_express:12")}`, { headers: { cookie } });
      assert.equal(wrongOrigin.status, 422);
    });
  });

  it("blocks stores owned by a different account", async () => {
    await withReviews(async (url, cookie) => {
      const response = await fetch(`${url}/reviews`, { headers: { cookie } });
      assert.equal(response.status, 403);
    }, { ownerId: "seller-2" });
  });

  it("does not convert a legacy outage into an empty review list", async () => {
    await withReviews(async (url, cookie) => {
      const response = await fetch(`${url}/reviews`, { headers: { cookie } });
      assert.equal(response.status, 502);
    }, { failLegacy: true });
  });

  it("reports native reviews and seller replies as unsupported", async () => {
    await withReviews(async (url, cookie) => {
      const list = await fetch(`${url}/reviews`, { headers: { cookie } });
      const listPayload = await list.json() as any;
      assert.equal(list.status, 501);
      assert.equal(listPayload.error.code, "REVIEW_OPERATION_UNSUPPORTED");
      const reply = await fetch(`${url}/reviews/sete%3A12/response`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ response: "Obrigado" }) });
      assert.equal(reply.status, 501);
    }, { legacyStoreId: null });
  });
});
