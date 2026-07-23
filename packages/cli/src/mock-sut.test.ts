import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startMockSut, type MockSut } from "./mock-sut";

describe("mock SUT", () => {
  let sut: MockSut;

  beforeEach(async () => {
    sut = await startMockSut();
  });
  afterEach(async () => {
    await sut.close();
  });

  it("listens on an ephemeral loopback port", () => {
    expect(sut.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("POST /auth/login returns a token and a positive expiry", async () => {
    const res = await fetch(`${sut.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "qa@example.com", password: "x" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { token: string; user: { id: string }; expiresIn: number };
    expect(typeof body.token).toBe("string");
    expect(body.user.id).toBeTruthy();
    expect(body.expiresIn).toBeGreaterThan(0);
  });

  it("GET /invoices/:id echoes the id and reports a paid invoice", async () => {
    const res = await fetch(`${sut.url}/invoices/inv-9`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; amount: number; status: string };
    expect(body.id).toBe("inv-9");
    expect(body.status).toBe("paid");
    expect(typeof body.amount).toBe("number");
  });

  it("serves the refund chain (order → capture → refund → ledger)", async () => {
    const order = await fetch(`${sut.url}/orders`, { method: "POST" });
    expect(order.status).toBe(201);
    const { paymentId } = (await order.json()) as { paymentId: string };

    const capture = await fetch(`${sut.url}/payments/${paymentId}/capture`, { method: "POST" });
    expect(capture.status).toBe(200);

    const refund = await fetch(`${sut.url}/payments/${paymentId}/refund`, { method: "POST" });
    expect(refund.status).toBe(202);
    const { id: refundId } = (await refund.json()) as { id: string };

    const ledger = await fetch(`${sut.url}/ledger/refunds/${refundId}`);
    expect(ledger.status).toBe(200);
    expect(((await ledger.json()) as { status: string }).status).toBe("settled");
  });

  it("returns 404 for an unknown route", async () => {
    const res = await fetch(`${sut.url}/nope`);
    expect(res.status).toBe(404);
  });
});
