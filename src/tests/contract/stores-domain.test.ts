import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  legacyStoreId,
  nativeStoreUpdate,
  storeOrigin,
  storeOwnedBy,
  supportsStoreUpdate,
} from "../../modules/stores/stores-domain";

describe("Store origin and update contract", () => {
  it("distinguishes native NULL from the legacy supplier ID", () => {
    assert.equal(legacyStoreId(null), null);
    assert.equal(storeOrigin(null), "native");
    assert.equal(legacyStoreId(1), 1);
    assert.equal(storeOrigin(1), "legacy");
    assert.equal(storeOrigin(0), "legacy");
  });

  it("preserves numeric-string legacy IDs and rejects invalid values", () => {
    assert.equal(legacyStoreId("1"), 1);
    assert.throws(() => legacyStoreId(""), /id_loja_antiga inválido/);
    assert.throws(() => legacyStoreId(1.5), /id_loja_antiga inválido/);
  });

  it("does not allow cross-seller access or stale session store IDs", () => {
    assert.equal(storeOwnedBy("seller-1", "seller-1", "store-1", "store-1"), true);
    assert.equal(storeOwnedBy("seller-2", "seller-1", "store-1", "store-1"), false);
    assert.equal(storeOwnedBy("seller-1", "seller-1", "store-1", "store-2"), false);
    assert.equal(storeOwnedBy("seller-1", "seller-1", null), false);
  });

  it("maps only supplied native fields and preserves omitted fields", () => {
    assert.deepEqual(nativeStoreUpdate({ name: "Nova", city: "Benguela" }), {
      name: "Nova",
      address: { municipality: "Benguela" },
    });
  });

  it("maps uploaded logo and banner URLs to the VendaExpress fields", () => {
    assert.deepEqual(nativeStoreUpdate({ avatarUrl: "https://cdn.test/logo.png", coverUrl: "https://cdn.test/banner.png" }), {
      logo_url: "https://cdn.test/logo.png",
      banner_urls: ["https://cdn.test/banner.png"],
    });
  });

  it("rejects profile edits for legacy shops without the PHP update contract", () => {
    assert.equal(supportsStoreUpdate("legacy", { name: "Nova" }), false);
    assert.equal(supportsStoreUpdate("legacy", {}), true);
    assert.equal(supportsStoreUpdate("native", { name: "Nova" }), true);
  });
});
