import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { signSessionCookie, verifySessionCookie } from "../../shared/utils/session";

describe("signed seller sessions", () => {
  it("accepts a valid, unexpired session", () => {
    const previous = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "unit-test-session-secret-long-enough";
    try {
      const token = signSessionCookie({ id: "seller-1", email: "seller@example.test", role: "seller" }, 100);
      assert.equal(verifySessionCookie(token, 101)?.id, "seller-1");
    } finally {
      if (previous === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previous;
    }
  });

  it("rejects tampered and expired sessions", () => {
    const previous = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "unit-test-session-secret-long-enough";
    try {
      const token = signSessionCookie({ id: "seller-1", email: "seller@example.test", role: "seller" }, 100);
      const [payload, signature] = token.split(".");
      assert.equal(verifySessionCookie(`${payload}x.${signature}`, 101), null);
      assert.equal(verifySessionCookie(token, 100 + 7 * 24 * 60 * 60), null);
    } finally {
      if (previous === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previous;
    }
  });
});
