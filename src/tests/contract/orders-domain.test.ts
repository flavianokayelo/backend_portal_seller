import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  isLegacySource,
  isNativeSource,
  canTransitionNativeStatus,
  legacyOrderDto,
  nativeOrderDto,
  normalizeLegacyActionResponse,
  normalizeLegacyEnvelope,
  normalizeLegacyStatus,
  normalizeNativeStatus,
  toLegacyAction,
  toNativeStatus,
} from "../../modules/orders/orders-domain";

describe("Order source mapping", () => {
  it("keeps native and legacy source identifiers distinct", () => {
    assert.equal(isNativeSource("venda_express"), true);
    assert.equal(isLegacySource("sete"), true);
    assert.equal(isLegacySource("vendaexpress"), false);
  });

  it("maps only native persisted statuses to portal statuses", () => {
    assert.equal(normalizeNativeStatus("paid"), "confirmed");
    assert.equal(normalizeNativeStatus("canceled"), "cancelled");
    assert.equal(normalizeNativeStatus("shipped"), "shipped");
  });

  it("preserves the documented legacy order states", () => {
    assert.equal(normalizeLegacyStatus("pendente"), "pending");
    assert.equal(normalizeLegacyStatus("atendido"), "confirmed");
    assert.equal(normalizeLegacyStatus("recusado"), "cancelled");
    assert.throws(() => normalizeLegacyStatus("paid"), /estado de pedido não suportado/);
  });

  it("maps native actions to the backend status vocabulary", () => {
    assert.equal(toNativeStatus("accept"), "paid");
    assert.equal(toNativeStatus("refuse"), "cancelled");
  });

  it("allows only status transitions supported by the native seller flow", () => {
    assert.equal(canTransitionNativeStatus("pending", "confirmed"), true);
    assert.equal(canTransitionNativeStatus("confirmed", "preparing"), false);
    assert.equal(canTransitionNativeStatus("shipped", "delivered"), true);
    assert.equal(canTransitionNativeStatus("delivered", "cancelled"), false);
  });

  it("maps documented legacy actions and preserves the legacy order id/source", () => {
    assert.equal(toLegacyAction("accept"), "atender");
    assert.equal(toLegacyAction("refuse"), "recusar");
    const dto = legacyOrderDto({
      id: 33,
      order_ref: "PED-33",
      loja_status: "pendente",
      can_atender: true,
      items: [{ id: "prod-uuid", name: "Item", quantity: 2, price: 50 }],
    });
    assert.equal(dto.id, "33");
    assert.equal(dto.source, "sete");
    assert.equal(dto.items[0].productId, "prod-uuid");
    assert.equal(dto.canAccept, true);
  });

  it("requires the legacy origin to confirm successful action", () => {
    const order = { id: 33, loja_status: "pendente" };
    assert.throws(
      () => normalizeLegacyActionResponse({ success: true, pedido_id: 34, loja_status: "atendido" }, order, "accept"),
      /identificador de pedido diferente/,
    );
    assert.equal(
      normalizeLegacyActionResponse({ success: true, pedido_id: 33, loja_status: "atendido" }, order, "accept").loja_status,
      "atendido",
    );
  });

  it("does not turn legacy errors into success-shaped data", () => {
    assert.throws(() => normalizeLegacyEnvelope({ success: false, status: 409, message: "Já atendido" }), /Já atendido/);
    assert.throws(() => normalizeLegacyEnvelope({ success: false, message: "Indisponível" }), /Indisponível/);
  });

  it("maps real native order and item fields", () => {
    const dto = nativeOrderDto({
      id: "native-1",
      status: "paid",
      total: "100",
      items: [{ product_id: "uuid-1", product_name: "Produto", quantity: 2, unit_price: 50 }],
    });
    assert.equal(dto.id, "native-1");
    assert.equal(dto.source, "venda_express");
    assert.equal(dto.status, "confirmed");
    assert.equal(dto.items[0].productId, "uuid-1");
  });
});
