import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildFinanceSnapshot, deduplicateFinanceOrders, legacyFinanceOrder, nativeFinanceOrder, periodBounds, type FinanceOrder } from "../../modules/finance/finance-domain";

const base = {
  period: "all", from: null, until: null, legacyLinked: true, legacyUnavailable: false,
  legacyHistoryMayBeTruncated: false, nativeHistoryComplete: true,
};

describe("finance domain", () => {
  it("separates order value, paid, pending, and cancelled values across sources", () => {
    const orders = [
      nativeFinanceOrder({ id: 1, total: "100", status: "paid", created_at: "2026-01-01" }),
      nativeFinanceOrder({ id: 2, total: 50, status: "pending", created_at: "2026-01-02" }),
      nativeFinanceOrder({ id: 3, total: 15, status: "cancelled", created_at: "2026-01-03" }),
      legacyFinanceOrder({ id: 1, total: 40, loja_status: "atendido", method_payment: "dinheiro" }),
      legacyFinanceOrder({ id: 4, total: 20, loja_status: "recusado" }),
    ];
    const result = buildFinanceSnapshot(orders, base).summary;
    assert.equal(result.orderedValue.knownValue, 225);
    assert.equal(result.paidValue.value, null);
    assert.equal(result.paidValue.knownValue, 0);
    assert.equal(result.pendingPaymentValue.value, null);
    assert.equal(result.pendingOrderValue.knownValue, 50);
    assert.equal(result.cancelledValue.value, 35);
    assert.equal(result.refundedValue.value, null);
    assert.equal(result.commissionValue.value, null);
    assert.equal(result.availableBalance.value, null);
  });

  it("deduplicates within an origin without merging matching IDs across origins", () => {
    const orders: FinanceOrder[] = [
      { id: "7", source: "venda_express", reference: "A", status: "paid", amount: 10, paymentMethod: null, createdAt: "2026-01-01" },
      { id: "7", source: "venda_express", reference: "A", status: "paid", amount: 10, paymentMethod: null, createdAt: "2026-01-01" },
      { id: "7", source: "sete", reference: "B", status: "recusado", amount: 3, paymentMethod: null, createdAt: "2026-01-02" },
    ];
    const unique = deduplicateFinanceOrders(orders);
    assert.equal(unique.length, 2);
    assert.equal(buildFinanceSnapshot(orders, { ...base, legacyLinked: false }).summary.orderedValue.value, 13);
  });

  it("keeps missing amounts unknown and marks unavailable/truncated source totals incomplete", () => {
    const result = buildFinanceSnapshot([
      nativeFinanceOrder({ id: "1", status: "paid", total: 20 }),
      nativeFinanceOrder({ id: "2", status: "pending" }),
    ], { ...base, legacyUnavailable: true, legacyHistoryMayBeTruncated: true }).summary;
    assert.equal(result.orderedValue.value, null);
    assert.equal(result.orderedValue.knownValue, 20);
    assert.equal(result.orderedValue.missingAmountCount, 1);
    assert.equal(result.paidValue.value, null);
    assert.equal(result.pendingPaymentValue.value, null);
    assert.equal(result.orderCountComplete, false);
  });

  it("filters periods and represents a source with no activity as zero only when complete", () => {
    const period = periodBounds("7d", new Date("2026-01-08T00:00:00Z"));
    const result = buildFinanceSnapshot([
      nativeFinanceOrder({ id: "in", status: "paid", total: 10, created_at: "2026-01-07T00:00:00Z" }),
      nativeFinanceOrder({ id: "out", status: "paid", total: 30, created_at: "2025-12-01T00:00:00Z" }),
    ], { ...base, legacyLinked: false, period: "7d", ...period }).summary;
    assert.equal(result.orderedValue.value, 10);
    const empty = buildFinanceSnapshot([], { ...base, legacyLinked: false }).summary;
    assert.equal(empty.orderedValue.value, 0);
  });
});
