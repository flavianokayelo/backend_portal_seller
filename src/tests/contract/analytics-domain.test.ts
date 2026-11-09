import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildAnalyticsSnapshot, type AnalyticsOrder, type AnalyticsSourceStatus } from "../../modules/analytics/analytics-domain";

const nativeSource: AnalyticsSourceStatus = {
  source: "venda_express", linked: true, ordersAvailable: true, ordersComplete: true,
  itemsComplete: true, productsAvailable: true, productsComplete: true,
};
const legacySource: AnalyticsSourceStatus = {
  source: "sete", linked: true, ordersAvailable: true, ordersComplete: true,
  itemsComplete: true, productsAvailable: true, productsComplete: true,
};
const now = new Date("2026-11-05T12:00:00+01:00");

function order(overrides: Partial<AnalyticsOrder>): AnalyticsOrder {
  return {
    id: "1", source: "venda_express", status: "delivered", total: 100,
    createdAt: "2026-11-05T09:00:00+01:00", customerId: "7", customerName: "Ana",
    items: [{ id: "p1", source: "venda_express", name: "Produto", quantity: 2 }],
    ...overrides,
  };
}

describe("analytics domain", () => {
  it("filters 7, 30 and 90 day periods using Luanda calendar dates and emits UTC-independent keys", () => {
    const orders = [
      order({ id: "today" }),
      order({ id: "old", createdAt: "2026-10-01T10:00:00+01:00" }),
    ];
    const seven = buildAnalyticsSnapshot({ period: "7d", now, orders, products: [], sources: [nativeSource] });
    const thirty = buildAnalyticsSnapshot({ period: "30d", now, orders, products: [], sources: [nativeSource] });
    const ninety = buildAnalyticsSnapshot({ period: "90d", now, orders, products: [], sources: [nativeSource] });
    assert.equal(seven.summary.totalOrders.value, 1);
    assert.equal(thirty.summary.totalOrders.value, 1);
    assert.equal(ninety.summary.totalOrders.value, 2);
    assert.equal(seven.series.length, 7);
    assert.equal(thirty.series.length, 30);
    assert.equal(ninety.series.length, 90);
    assert.equal(seven.series.at(-1)?.date, "2026-11-05");
  });

  it("keeps colliding native/legacy order and product IDs separate and excludes cancelled items", () => {
    const snapshot = buildAnalyticsSnapshot({
      period: "all", now,
      orders: [
        order({ id: "same", items: [{ id: "p1", source: "venda_express", name: "Native", quantity: 2 }] }),
        order({ id: "same", source: "sete", total: 50, status: "atendido", customerId: "7", customerName: "Ana", items: [{ id: "p1", source: "sete", name: "Legacy", quantity: 3 }] }),
        order({ id: "cancel", status: "cancelled", items: [{ id: "cancelled-item", source: "venda_express", name: "Cancelled", quantity: 20 }] }),
        order({ id: "legacy-cancel", source: "sete", status: "recusado", items: [{ id: "legacy-cancelled", source: "sete", name: "Cancelled legacy", quantity: 4 }] }),
      ], products: [], sources: [nativeSource, legacySource],
    });
    assert.equal(snapshot.summary.totalOrders.value, 4);
    assert.equal(snapshot.summary.grossOrderValue.value, 350);
    assert.equal(snapshot.topProducts.length, 2);
    assert.deepEqual(snapshot.topProducts.map((item) => [item.source, item.id, item.unitsOrdered]), [
      ["sete", "p1", 3], ["venda_express", "p1", 2],
    ]);
    assert.equal(snapshot.topCustomers.length, 2);
    assert.equal(snapshot.sourceBreakdown.find((source) => source.source === "sete")?.orders.value, 2);
  });

  it("marks totals incomplete when an origin or an order amount is incomplete", () => {
    const snapshot = buildAnalyticsSnapshot({
      period: "30d", now, orders: [order({ total: 100 }), order({ id: "unknown", total: null })],
      products: [], sources: [nativeSource, { ...legacySource, ordersAvailable: false, ordersComplete: false }],
    });
    assert.equal(snapshot.summary.totalOrders.value, null);
    assert.equal(snapshot.summary.totalOrders.knownValue, 2);
    assert.equal(snapshot.summary.grossOrderValue.value, null);
    assert.equal(snapshot.summary.grossOrderValue.knownValue, 100);
    assert.equal(snapshot.topProducts[0].complete, false);
    assert.equal(snapshot.dataComplete, false);
  });

  it("returns complete zero metrics for an empty store and still finds products without order activity", () => {
    const snapshot = buildAnalyticsSnapshot({
      period: "30d", now, orders: [],
      products: [
        { id: "zero", source: "venda_express", name: "Sem stock", stock: 0, threshold: 5, published: true },
        { id: "low", source: "venda_express", name: "Stock baixo", stock: 2, threshold: 3, published: true },
        { id: "archived", source: "venda_express", name: "Arquivado", stock: 0, threshold: 5, published: false },
      ],
      sources: [nativeSource, { ...legacySource, linked: false, ordersAvailable: true, ordersComplete: true, productsAvailable: true, productsComplete: true }],
    });
    assert.equal(snapshot.summary.totalOrders.value, 0);
    assert.equal(snapshot.summary.grossOrderValue.value, 0);
    assert.equal(snapshot.topProducts.length, 0);
    assert.deepEqual(snapshot.lowStockProducts.map((product) => product.id), ["zero", "low"]);
    assert.equal(snapshot.dataComplete, true);
  });

  it("reports all-time monthly grouping and keeps an unavailable catalog source incomplete", () => {
    const snapshot = buildAnalyticsSnapshot({
      period: "all", now, orders: [order({ createdAt: "2026-10-15T10:00:00+01:00" }), order({ id: "this-month" })],
      products: [], sources: [nativeSource, { ...legacySource, ordersAvailable: false, ordersComplete: false, productsAvailable: false, productsComplete: false }],
    });
    assert.deepEqual(snapshot.series.map((point) => point.date), ["2026-10", "2026-11"]);
    assert.equal(snapshot.summary.totalOrders.value, null);
    assert.equal(snapshot.dataComplete, false);
  });
});
