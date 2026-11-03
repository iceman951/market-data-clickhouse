import { afterEach, describe, expect, it, vi } from "vitest";
import * as eodhd from "../src/eodhd";
import { type ChartResult, dividendRowsFromChart, priceRowsFromChart, splitRowsFromChart, yahooSymbol } from "../src/yahoo";

// AAPL around its 4:1 split on 2020-08-31, as returned by Yahoo (split-adjusted floats).
const aaplChart: ChartResult = {
  meta: { gmtoffset: -14400, priceHint: 2, currency: "USD" },
  timestamp: [1598535000, 1598621400, 1598880600],
  indicators: {
    quote: [
      {
        open: [127.14250183105469, 126.01249694824219, 127.58000183105469],
        high: [127.48500061035156, 126.44249725341797, 131],
        low: [123.83250427246094, 124.57749938964844, 126],
        close: [125.01000213623047, 124.80750274658203, 129.0399932861328],
        volume: [155552400, 187630000, 225702700],
      },
    ],
    adjclose: [{ adjclose: [121.15190124511719, 120.95570373535156, 125.05750274658203] }],
  },
  events: {
    splits: { "1598880600": { date: 1598880600, numerator: 4, denominator: 1 } },
    dividends: {
      "1581085800": { date: 1581085800, amount: 0.1925 },
      "1596807000": { date: 1596807000, amount: 0.205 },
      "1604673000": { date: 1604673000, amount: 0.205 },
    },
  },
};

describe("yahoo transforms", () => {
  it("maps EODHD symbols to Yahoo tickers", () => {
    expect(yahooSymbol("AAPL.US")).toBe("AAPL");
    expect(yahooSymbol("PTT.BK")).toBe("PTT.BK");
    expect(yahooSymbol("VOD.LSE")).toBe("VOD.L");
    expect(yahooSymbol("BTC-USD.CC")).toBe("BTC-USD");
    expect(yahooSymbol("USDTHB.FOREX")).toBe("USDTHB=X");
    expect(yahooSymbol("GSPC.INDX")).toBe("^GSPC");
  });

  it("converts split-adjusted prices back to raw (matches EODHD)", () => {
    const rows = priceRowsFromChart(aaplChart, "2020-08-27", "2020-08-31");
    expect(rows.map((r) => [r.price_date, r.open, r.close])).toEqual([
      ["2020-08-27", "508.57", "500.04"],
      ["2020-08-28", "504.05", "499.23"],
      ["2020-08-31", "127.58", "129.04"],
    ]);
    expect(rows[0].volume).toBe(155552400); // volume stays split-adjusted, like EODHD
    expect(rows[0].adjusted_close).toBe("121.1519");
  });

  it("filters to the requested window", () => {
    expect(priceRowsFromChart(aaplChart, "2020-08-28", "2020-08-28").map((r) => r.price_date)).toEqual(["2020-08-28"]);
  });

  it("restores dividends to the amount actually paid", () => {
    expect(dividendRowsFromChart(aaplChart).map((d) => [d.ex_date, d.per_share, d.split_adjusted_per_share, d.currency])).toEqual([
      ["2020-02-07", "0.77", "0.1925", "USD"],
      ["2020-08-07", "0.82", "0.205", "USD"],
      ["2020-11-06", "0.205", "0.205", "USD"],
    ]);
  });

  it("reads splits as new:old", () => {
    expect(splitRowsFromChart(aaplChart)).toEqual([{ split_date: "2020-08-31", ratio_new: "4", ratio_old: "1" }]);
  });
});

describe("eodhd parsing", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(routes: Record<string, string>) {
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname.replace("/api/", "");
      const body = routes[path];
      return new Response(body ?? "Not found", { status: body ? 200 : 404 });
    });
  }

  async function client() {
    const api = new eodhd.Eodhd("test-key");
    await api.init();
    return api;
  }

  it("keeps exact decimals and counts quota", async () => {
    stubFetch({
      user: '{"apiRequests":3,"dailyRateLimit":20}',
      "eod/AAPL.US": '[{"date":"2020-08-28","open":504.05,"high":505.77,"low":498.31,"close":499.23,"adjusted_close":120.9557,"volume":187630000}]',
    });
    const api = await client();
    const rows = await eodhd.eod(api, "AAPL.US", "2020-08-28", "2020-08-28");
    expect(rows).toEqual([{ price_date: "2020-08-28", open: "504.05", high: "505.77", low: "498.31", close: "499.23", adjusted_close: "120.9557", volume: 187630000 }]);
    expect(api.used).toBe(4);
  });

  it("parses splits and dividends", async () => {
    stubFetch({
      user: '{"apiRequests":0,"dailyRateLimit":20}',
      "splits/AAPL.US": '[{"date":"2020-08-31","split":"4.000000/1.000000"}]',
      "div/AAPL.US": '[{"date":"2020-08-07","declarationDate":"2020-07-30","recordDate":"2020-08-10","paymentDate":"2020-08-13","period":"Quarterly","value":0.205,"unadjustedValue":0.82,"currency":"USD"}]',
    });
    const api = await client();
    expect(await eodhd.splits(api, "AAPL.US")).toEqual([{ split_date: "2020-08-31", ratio_new: "4", ratio_old: "1" }]);
    expect(await eodhd.dividends(api, "AAPL.US")).toEqual([
      { ex_date: "2020-08-07", declaration_date: "2020-07-30", record_date: "2020-08-10", payment_date: "2020-08-13", period: "Quarterly", per_share: "0.82", split_adjusted_per_share: "0.205", currency: "USD" },
    ]);
  });

  it("treats a usage count from an earlier day as a fresh quota", async () => {
    stubFetch({
      user: '{"apiRequests":20,"dailyRateLimit":20,"apiRequestsDate":"2000-01-01"}',
      "eod/AAPL.US": '[{"date":"2020-08-28","open":1,"high":1,"low":1,"close":1,"adjusted_close":1,"volume":1}]',
    });
    const api = await client();
    expect(api.used).toBe(0);
    expect(await eodhd.eod(api, "AAPL.US", "2020-08-28", "2020-08-28")).toHaveLength(1);
  });

  it("refuses calls once the daily quota is used", async () => {
    stubFetch({ user: '{"apiRequests":20,"dailyRateLimit":20}' });
    const api = await client();
    await expect(eodhd.eod(api, "AAPL.US", "2020-08-28", "2020-08-28")).rejects.toMatchObject({ status: "quota" });
  });
});
