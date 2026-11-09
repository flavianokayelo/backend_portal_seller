import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import cookieParser from "cookie-parser";
import notificationRoutes from "../../modules/notifications/routes";
import { errorHandler } from "../../middleware/auth";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { testSessionCookie } from "../session";

async function withNotifications(
  run: (url: string, cookie: string) => Promise<void>,
  options: {
    legacyStoreId?: number | null;
    ownerId?: string;
    failValidation?: boolean;
  } = {},
) {
  const ve = vendaExpressAdapter as any;
  const originalGet = ve.get;
  ve.get = async (path: string) => {
    if (options.failValidation) throw new Error("VendaExpress unavailable");
    if (path === "/auth/me")
      return { user: { id: "seller-1", account_kind: "loja" } };
    if (path === "/stores/mine")
      return {
        id: "store-1",
        owner_id: options.ownerId ?? "seller-1",
        id_loja_antiga:
          options.legacyStoreId === undefined ? null : options.legacyStoreId,
      };
    throw new Error(`Unexpected upstream GET ${path}`);
  };
  const app = express();
  app.use(cookieParser());
  app.use(notificationRoutes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`, testSessionCookie());
  } finally {
    server.close();
    ve.get = originalGet;
  }
}

describe("Seller notification routes", () => {
  it("returns an incomplete empty feed when the native source has no contract", async () => {
    await withNotifications(async (url, cookie) => {
      const response = await fetch(`${url}/notifications`, {
        headers: { cookie },
      });
      const payload = (await response.json()) as any;
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(payload.data));
      assert.equal(payload.data.length, 0);
      assert.equal(payload.meta.complete, false);
      assert.equal(payload.meta.unreadCount, null);
      assert.equal(payload.meta.code, "NOTIFICATIONS_SOURCE_UNSUPPORTED");
    });
  });

  it("returns incomplete feed and documents missing legacy user mapping", async () => {
    await withNotifications(
      async (url, cookie) => {
        const response = await fetch(`${url}/notifications`, {
          headers: { cookie },
        });
        const payload = (await response.json()) as any;
        assert.equal(response.status, 200);
        assert.ok(Array.isArray(payload.data));
        assert.equal(payload.data.length, 0);
        assert.equal(payload.meta.complete, false);
        assert.equal(
          payload.meta.code,
          "NOTIFICATIONS_IDENTITY_MAPPING_REQUIRED",
        );
        assert.match(
          payload.meta.message,
          /ID do fornecedor não é usado como userid/,
        );
      },
      { legacyStoreId: 1 },
    );
  });

  it("does not acknowledge read changes without a persistent source operation", async () => {
    await withNotifications(async (url, cookie) => {
      const response = await fetch(`${url}/notifications/sete%3A42/read`, {
        method: "PATCH",
        headers: { cookie },
      });
      const payload = (await response.json()) as any;
      assert.equal(response.status, 501);
      assert.equal(payload.error.code, "NOTIFICATIONS_SOURCE_UNSUPPORTED");
      assert.equal("data" in payload, false);
    });
  });

  it("blocks access when the authenticated user does not own the store", async () => {
    await withNotifications(
      async (url, cookie) => {
        const response = await fetch(`${url}/notifications`, {
          headers: { cookie },
        });
        assert.equal(response.status, 403);
      },
      { ownerId: "seller-2" },
    );
  });

  it("reports failure validating the source instead of returning an empty feed", async () => {
    await withNotifications(
      async (url, cookie) => {
        const response = await fetch(`${url}/notifications`, {
          headers: { cookie },
        });
        assert.equal(response.status, 502);
      },
      { failValidation: true },
    );
  });
});
