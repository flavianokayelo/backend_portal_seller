import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  legacyProductId,
  mergeProductPatch,
  productIdentityKey,
  productOrigin,
  requireProductOrigin,
  statusFilter,
  supportsLegacyProductPatch,
  toLegacyProductPayload,
} from "../../modules/catalog/products-domain";

describe("product source and patch contract", () => {
  it("keeps native and legacy IDs distinct even when their source IDs coincide", () => {
    assert.equal(productIdentityKey("venda_express", 12), "venda_express:12");
    assert.equal(productIdentityKey("sete", 12), "sete:12");
    assert.equal(legacyProductId("sete-12"), 12);
    assert.equal(legacyProductId("12"), null);
    assert.equal(productOrigin(undefined, "sete-12"), "sete");
    assert.equal(productOrigin(undefined, "12"), "venda_express");
    assert.throws(() => requireProductOrigin("sete-12", "venda_express"), { code: "PRODUCT_SOURCE_MISMATCH" });
  });

  it("merges partial updates without erasing omitted values", () => {
    const current = { name: "Produto", price: 25, stock: 8, description: "Texto" };
    assert.deepEqual(mergeProductPatch(current, { price: 30 }), { ...current, price: 30 });
  });

  it("allows only contract-supported legacy fields and maps to the existing adapter payload", () => {
    assert.equal(supportsLegacyProductPatch({ price: 30, stock: 2 }), true);
    assert.equal(supportsLegacyProductPatch({ images: [] }), false);
    assert.deepEqual(toLegacyProductPayload({ name: "P", price: 5, stock: 3, status: "archived" }), {
      name: "P", description: "", price: 5, compare_at_price: null, stock: 3,
      active: false, product_kind: "fisico", return_policy: "",
    });
  });

  it("maps only published and archived filters supported by the source", () => {
    assert.equal(statusFilter("published"), "active");
    assert.equal(statusFilter("archived"), "inactive");
    assert.throws(() => statusFilter("draft"), { code: "PRODUCT_STATUS_UNSUPPORTED" });
  });
});
