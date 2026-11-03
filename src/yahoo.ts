import { type Dec, ONE, decStr, divRound, isPositive, mul, round, toDec, toStr } from "./decimal";
import { SourceError, getJson } from "./http";
import { addDays, assetClass, type DividendRow, type FxRow, type PriceRow, type SplitRow, type TickerRow } from "./types";

const CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";

/** EODHD exchange suffix -> Yahoo suffix (null = none); unlisted suffixes are kept as is. */
const SUFFIX: Record<string, string | null> = {
  US: null, LSE: "L", XETRA: "DE", KO: "KS", KQ: "KQ", SHG: "SS", SHE: "SZ", AU: "AX", NEO: "NE",
};

export function yahooSymbol(symbol: string): string {
  const dot = symbol.lastIndexOf(".");
  if (dot < 0) return symbol;
  const code = symbol.slice(0, dot);
  const exchange = symbol.slice(dot + 1);
  if (exchange === "CC") return code; // BTC-USD.CC -> BTC-USD
  if (exchange === "FOREX") return `${code}=X`; // USDTHB.FOREX -> USDTHB=X
  if (exchange === "INDX") return `^${code}`; // GSPC.INDX -> ^GSPC
  const suffix = exchange in SUFFIX ? SUFFIX[exchange] : exchange;
  return suffix === null ? code : `${code}.${suffix}`;
}

export interface ChartResult {
  meta?: { gmtoffset?: number; priceHint?: number; currency?: string; instrumentType?: string; longName?: string; shortName?: string; fullExchangeName?: string; exchangeName?: string };
  timestamp?: number[];
  indicators: {
    quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }>;
    adjclose?: Array<{ adjclose: (number | null)[] }>;
  };
  events?: {
    splits?: Record<string, { date: number; numerator: number; denominator: number }>;
    dividends?: Record<string, { date: number; amount: number }>;
  };
}

export async function chart(symbol: string, params: Record<string, string>): Promise<ChartResult> {
  const data = (await getJson(`${CHART}${encodeURIComponent(yahooSymbol(symbol))}?${new URLSearchParams(params)}`)) as {
    chart?: { result?: ChartResult[]; error?: unknown };
  };
  const result = data.chart?.result?.[0];
  if (data.chart?.error || !result) throw new SourceError(`yahoo: ${JSON.stringify(data.chart?.error ?? "no result")}`, 200);
  return result;
}

/** Exchange-local trading date of a Yahoo timestamp. */
const localDate = (ts: number, res: ChartResult): string =>
  new Date((ts + (res.meta?.gmtoffset ?? 0)) * 1000).toISOString().slice(0, 10);

interface Split {
  date: string;
  ratioNew: Dec;
  ratioOld: Dec;
}

export function chartSplits(res: ChartResult): Split[] {
  return Object.values(res.events?.splits ?? {})
    .map((s) => ({ date: localDate(s.date, res), ratioNew: toDec(s.numerator), ratioOld: toDec(s.denominator) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Products of new and old ratios for splits after `date` (null when none): split-adjusted x new / old = raw. */
function laterSplits(splits: Split[], date: string): { num: Dec; den: Dec } | null {
  let num = ONE;
  let den = ONE;
  let any = false;
  for (const s of splits) {
    if (s.date > date) {
      num = mul(num, s.ratioNew);
      den = mul(den, s.ratioOld);
      any = true;
    }
  }
  return any ? { num, den } : null;
}

/**
 * Yahoo OHLC are split-adjusted; convert back to raw with the later splits, rounding half-to-even
 * to Yahoo's priceHint. Volume stays split-adjusted (same as EODHD).
 */
export function priceRowsFromChart(res: ChartResult, start: string, end: string): PriceRow[] {
  const hint = Number(res.meta?.priceHint ?? 2);
  const splits = chartSplits(res);
  const q = res.indicators.quote[0];
  const adj = res.indicators.adjclose?.[0]?.adjclose ?? q.close;
  const rows: PriceRow[] = [];
  (res.timestamp ?? []).forEach((ts, i) => {
    const open = q.open[i], high = q.high[i], low = q.low[i], close = q.close[i];
    if (open == null || high == null || low == null || close == null) return;
    const day = localDate(ts, res);
    if (day < start || day > end) return;
    const later = laterSplits(splits, day);
    // No later split (the common case): one rounding. Otherwise strip float noise, scale, round.
    const raw = later
      ? (v: number) => toStr(divRound(mul(round(toDec(v), hint + 4), later.num), later.den, hint))
      : (v: number) => decStr(v, hint);
    rows.push({
      price_date: day,
      open: raw(open),
      high: raw(high),
      low: raw(low),
      close: raw(close),
      adjusted_close: decStr(adj[i] ?? close, hint + 2),
      volume: Number(q.volume[i] ?? 0),
    });
  });
  return rows;
}

export function dividendRowsFromChart(res: ChartResult): DividendRow[] {
  const splits = chartSplits(res);
  return Object.values(res.events?.dividends ?? {})
    .map((d) => {
      const exDate = localDate(d.date, res);
      const later = laterSplits(splits, exDate);
      const adjusted = decStr(d.amount);
      return {
        ex_date: exDate,
        declaration_date: null,
        record_date: null,
        payment_date: null,
        period: "",
        per_share: later ? toStr(divRound(mul(toDec(adjusted), later.num), later.den, 8)) : adjusted,
        split_adjusted_per_share: adjusted,
        currency: res.meta?.currency ?? "",
      };
    })
    .sort((a, b) => a.ex_date.localeCompare(b.ex_date));
}

export function splitRowsFromChart(res: ChartResult): SplitRow[] {
  return chartSplits(res).map((s) => ({ split_date: s.date, ratio_new: decStr(s.ratioNew), ratio_old: decStr(s.ratioOld) }));
}

const unix = (date: string) => String(Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000));

export async function eod(symbol: string, start: string, end: string): Promise<PriceRow[]> {
  const res = await chart(symbol, { period1: unix(start), period2: unix(addDays(end, 1)), interval: "1d", events: "split" });
  return priceRowsFromChart(res, start, end);
}

export async function fx(base: string, quote: string, start: string, end: string): Promise<FxRow[]> {
  const rows = await eod(`${base}${quote}.FOREX`, start, end);
  return rows.filter((r) => isPositive(r.close)).map((r) => ({ rate_date: r.price_date, rate: r.close }));
}

/** Dividend + split history in one call ("max", or "2y" for incremental refreshes), cached per run. */
export class Actions {
  private cache = new Map<string, Promise<ChartResult>>();

  get(symbol: string, range: "max" | "2y" = "max"): Promise<ChartResult> {
    const key = `${symbol}|${range}`;
    if (!this.cache.has(key)) this.cache.set(key, chart(symbol, { range, interval: "1mo", events: "div,split" }));
    return this.cache.get(key)!;
  }
}

export async function ticker(symbol: string): Promise<TickerRow[]> {
  const meta = (await chart(symbol, { range: "5d", interval: "1d" })).meta ?? {};
  const type = meta.instrumentType ?? "";
  const dot = symbol.lastIndexOf(".");
  return [
    {
      code: dot < 0 ? symbol : symbol.slice(0, dot),
      exchange: meta.fullExchangeName ?? meta.exchangeName ?? "",
      name: meta.longName ?? meta.shortName ?? "",
      quote_currency: meta.currency ?? "",
      country: "",
      asset_class: assetClass(type),
      source_type: type,
      isin: null,
    },
  ];
}
