import { afterEach, describe, expect, it, vi } from "vitest";
import { type Env, runIngest } from "../src/ingest";

const env: Env = {
  TINYBIRD_HOST: "https://tb.example",
  TINYBIRD_TOKEN: "t",
  TINYBIRD_STATE_TOKEN: "s",
  EODHD_API_KEY: "k",
  SYMBOLS: "AAPL.US",
  FX_PAIRS: "",
};

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const yahooBar = {
  chart: {
    result: [
      {
        meta: { gmtoffset: 0, priceHint: 2, currency: "USD" },
        timestamp: [Math.floor(Date.parse(`${daysAgo(1)}T14:30:00Z`) / 1000)],
        indicators: { quote: [{ open: [1.5], high: [2], low: [1], close: [1.75], volume: [10] }], adjclose: [{ adjclose: [1.75] }] },
      },
    ],
  },
};

/** Stub every upstream; records which hosts/paths were called and what was appended. */
function stub(quotaUsed: number, lastEod: string | null) {
  const calls: string[] = [];
  const appended: Record<string, string> = {};
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(url.hostname + url.pathname);
    if (url.pathname === "/api/user") return Response.json({ apiRequests: quotaUsed, dailyRateLimit: 20, apiRequestsDate: today });
    if (url.pathname.endsWith("/ingest_state.json"))
      return Response.json({ data: lastEod ? [{ dataset: "eod", key: "AAPL.US", last_date: lastEod, last_ok_fetch: "" }] : [] });
    if (url.pathname === "/v0/events") {
      appended[url.searchParams.get("name")!] = String(init?.body);
      return Response.json({ successful_rows: 1, quarantined_rows: 0 });
    }
    if (url.hostname.includes("yahoo")) return Response.json(yahooBar);
    return new Response("unexpected", { status: 500 });
  });
  return { calls, appended };
}

describe("runIngest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defers a backfill while the EODHD quota is used up (no Yahoo backfill)", async () => {
    const { calls, appended } = stub(20, null);
    const summary = await runIngest(env, ["eod"]);
    expect(summary.deferred).toEqual(["eod:AAPL.US"]);
    expect(summary.failed).toEqual([]);
    expect(calls.some((c) => c.includes("yahoo"))).toBe(false);
    expect(appended.eod_prices).toBeUndefined();
    expect(appended.fetch_log).toContain('"status":"quota"');
  });

  it("falls back to Yahoo for incremental updates when the quota is used up", async () => {
    const { appended } = stub(20, daysAgo(3));
    const summary = await runIngest(env, ["eod"]);
    expect(summary.deferred).toEqual([]);
    expect(summary.results).toEqual([expect.stringMatching(/^AAPL\.US eod YAHOO 1 rows/)]);
    const row = JSON.parse(appended.eod_prices);
    expect(row).toMatchObject({ symbol: "AAPL.US", close: "1.75", open: "1.5", source: "YAHOO" });
    expect(row.version).toBeLessThan(2 * 10 ** 13); // Yahoo rank below EODHD
  });
});
