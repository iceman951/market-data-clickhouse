import * as eodhd from "./eodhd";
import { SourceError, type FetchStatus } from "./http";
import { append, readState, type State } from "./tinybird";
import { addDays, isoDate, type Dataset, type Source } from "./types";
import * as yahoo from "./yahoo";

export interface Env {
  TINYBIRD_HOST: string;
  TINYBIRD_TOKEN: string; // ingest_token (APPEND)
  TINYBIRD_STATE_TOKEN: string; // state_token (READ ingest_state)
  EODHD_API_KEY?: string;
  SYMBOLS: string; // "AAPL.US,MSFT.US"
  FX_PAIRS: string; // "USD/THB"
  SOURCE?: string; // auto | eodhd | yahoo
  FORCE_REFRESH?: string; // "true" ignores the weekly/monthly cadence
}

const BACKFILL_DAYS = 365;
const OVERLAP_DAYS = 7;
const REFRESH_DAYS: Partial<Record<Dataset, number>> = { splits: 7, dividends: 7, tickers: 30 };
const DIVIDEND_LOOKBACK_DAYS = 400;
const SOURCE_RANK: Record<Source, number> = { EODHD: 2, YAHOO: 1 };
const DAY_MS = 86_400_000;

const TABLES = ["eod_prices", "fx_rates", "stock_splits", "dividends", "tickers", "fetch_log"] as const;
type Table = (typeof TABLES)[number];

const list = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** "YYYY-MM-DD HH:MM:SS.mmm" in UTC */
const timestamp = (date: Date) => date.toISOString().replace("T", " ").slice(0, 23);

export interface Summary {
  datasets: Dataset[];
  eodhd: string;
  sent: Partial<Record<Table, number>>;
  results: string[];
  /** Backfills / full histories postponed until EODHD has quota again. */
  deferred: string[];
  failed: string[];
}

class Run {
  readonly out: Record<Table, object[]> = { eod_prices: [], fx_rates: [], stock_splits: [], dividends: [], tickers: [], fetch_log: [] };
  readonly results: string[] = [];
  readonly failed: string[] = [];
  readonly deferred: string[] = [];
  readonly now = new Date();
  readonly ingestedAt = timestamp(this.now);
  readonly today = isoDate(this.now);
  readonly actions = new yahoo.Actions();

  constructor(
    readonly api: eodhd.Eodhd,
    readonly state: State,
    readonly source: string,
    readonly forceRefresh: boolean,
  ) {}

  /** ReplacingMergeTree version: EODHD always beats Yahoo for a key; newer fetch wins within a source. */
  version(source: Source): number {
    return SOURCE_RANK[source] * 10 ** 13 + this.now.getTime();
  }

  /** Adds key fields, source, timestamp and version to a freshly built row (in place, no copy). */
  stamp(row: object, extra: object, source: Source, timeField: "ingested_at" | "updated_at" = "ingested_at") {
    return Object.assign(row, extra, { source, [timeField]: this.ingestedAt, version: this.version(source) });
  }

  log(dataset: Dataset, key: string, source: Source, status: FetchStatus, opts: { error?: SourceError; start?: string; end?: string; rows?: number; calls?: number; message?: string } = {}) {
    this.out.fetch_log.push({
      fetched_at: timestamp(new Date()),
      dataset,
      symbol: key,
      source,
      status,
      http_status: opts.error ? opts.error.httpStatus : status === "ok" || status === "empty" ? 200 : 0,
      from_date: opts.start ?? null,
      to_date: opts.end ?? null,
      rows: opts.rows ?? 0,
      api_calls: opts.calls ?? 0,
      message: (opts.error ? opts.error.message : (opts.message ?? "")).slice(0, 500),
    });
  }

  /** EODHD first, then Yahoo; every attempt is logged. Empty EODHD prices/FX fall through to Yahoo. */
  async fetch<T>(
    dataset: Dataset,
    key: string,
    fromEodhd: () => Promise<T[]>,
    fromYahoo: () => Promise<T[]>,
    { start, end, deferOnQuota = false }: { start?: string; end?: string; deferOnQuota?: boolean } = {},
  ): Promise<{ rows: T[]; source: Source } | null> {
    if (this.source === "auto" || this.source === "eodhd") {
      const before = this.api.used;
      try {
        const rows = await fromEodhd();
        const calls = this.api.used - before;
        if (rows.length || this.source === "eodhd" || dataset === "splits" || dataset === "dividends") {
          this.log(dataset, key, "EODHD", rows.length ? "ok" : "empty", { start, end, rows: rows.length, calls });
          return { rows, source: "EODHD" };
        }
        this.log(dataset, key, "EODHD", "empty", { start, end, calls });
      } catch (error) {
        const e = error instanceof SourceError ? error : new SourceError(String(error));
        this.log(dataset, key, "EODHD", e.status, { error: e, start, end, calls: this.api.used - before });
        console.warn(`${key} ${dataset} eodhd ${e.status}: ${e.message}`);
        // Backfills and full histories wait for EODHD's quota instead of pulling them from Yahoo:
        // the primary source stays authoritative and the run stays within 10 ms CPU.
        if (e.status === "quota" && deferOnQuota && this.source === "auto") {
          this.deferred.push(`${dataset}:${key}`);
          return null;
        }
      }
    }
    if (this.source === "auto" || this.source === "yahoo") {
      try {
        const rows = await fromYahoo();
        this.log(dataset, key, "YAHOO", rows.length ? "ok" : "empty", { start, end, rows: rows.length });
        return { rows, source: "YAHOO" };
      } catch (error) {
        const e = error instanceof SourceError ? error : new SourceError(String(error));
        this.log(dataset, key, "YAHOO", e.status, { error: e, start, end });
        console.warn(`${key} ${dataset} yahoo ${e.status}: ${e.message}`);
      }
    }
    this.failed.push(`${dataset}:${key}`);
    return null;
  }

  due(dataset: Dataset, key: string): boolean {
    if (this.forceRefresh) return true;
    const seen = this.state.lastOk.get(`${dataset}|${key}`);
    return seen === undefined || this.now.getTime() - seen >= (REFRESH_DAYS[dataset] ?? 0) * DAY_MS;
  }

  /** Incremental window: last stored date minus an overlap, or a 365-day backfill. */
  window(dataset: Dataset, key: string): { start: string; end: string; backfill: boolean } {
    const last = this.state.lastDate.get(`${dataset}|${key}`);
    return last
      ? { start: addDays(last, -OVERLAP_DAYS), end: this.today, backfill: false }
      : { start: addDays(this.today, -BACKFILL_DAYS), end: this.today, backfill: true };
  }

  report(dataset: Dataset, key: string, result: { rows: unknown[]; source: Source } | null, extra = "") {
    if (result) this.results.push(`${key} ${dataset} ${result.source} ${result.rows.length} rows ${extra}`.trim());
  }
}

/** Fetch the given datasets and append them to Tinybird. EODHD quota priority follows the array order. */
export async function runIngest(env: Env, datasets: Dataset[]): Promise<Summary> {
  const source = env.SOURCE || "auto";
  const symbols = list(env.SYMBOLS);
  const pairs = list(env.FX_PAIRS).map((p) => p.toUpperCase());
  const api = new eodhd.Eodhd(env.EODHD_API_KEY, source !== "yahoo");
  const [state] = await Promise.all([readState(env.TINYBIRD_HOST, env.TINYBIRD_STATE_TOKEN), api.init()]);
  const usedBefore = api.used;
  const run = new Run(api, state, source, env.FORCE_REFRESH === "true");

  for (const dataset of datasets) {
    if (dataset === "eod") {
      for (const sym of symbols) {
        const { start, end, backfill } = run.window("eod", sym);
        const r = await run.fetch("eod", sym, () => eodhd.eod(api, sym, start, end), () => yahoo.eod(sym, start, end), { start, end, deferOnQuota: backfill });
        r?.rows.forEach((row) => run.out.eod_prices.push(run.stamp(row, { symbol: sym }, r.source)));
        run.report("eod", sym, r, `${start}..${end}`);
      }
    } else if (dataset === "fx") {
      for (const pair of pairs) {
        const [base, quote] = pair.split("/");
        const { start, end, backfill } = run.window("fx", pair);
        const r = await run.fetch("fx", pair, () => eodhd.fx(api, base, quote, start, end), () => yahoo.fx(base, quote, start, end), { start, end, deferOnQuota: backfill });
        r?.rows.forEach((row) => run.out.fx_rates.push(run.stamp(row, { base_currency: base, quote_currency: quote }, r.source)));
        run.report("fx", pair, r, `${start}..${end}`);
      }
    } else if (dataset === "splits") {
      for (const sym of symbols.filter((s) => run.due("splits", s))) {
        const r = await run.fetch("splits", sym, () => eodhd.splits(api, sym), async () => yahoo.splitRowsFromChart(await run.actions.get(sym)));
        r?.rows.forEach((row) => run.out.stock_splits.push(run.stamp(row, { symbol: sym }, r.source)));
        run.report("splits", sym, r);
      }
    } else if (dataset === "dividends") {
      for (const sym of symbols.filter((s) => run.due("dividends", s))) {
        // Full history the first time; afterwards only recent ex-dates (keeps the run small for 10 ms CPU).
        const from = state.lastOk.has(`dividends|${sym}`) ? addDays(run.today, -DIVIDEND_LOOKBACK_DAYS) : undefined;
        const r = await run.fetch(
          "dividends",
          sym,
          () => eodhd.dividends(api, sym, from),
          async () => yahoo.dividendRowsFromChart(await run.actions.get(sym, from ? "2y" : "max")).filter((d) => !from || d.ex_date >= from),
          { start: from, deferOnQuota: !from },
        );
        r?.rows.forEach((row) => run.out.dividends.push(run.stamp(row, { symbol: sym }, r.source)));
        run.report("dividends", sym, r, from ? `since ${from}` : "full history");
      }
    } else if (dataset === "tickers") {
      for (const sym of symbols.filter((s) => run.due("tickers", s))) {
        const r = await run.fetch("tickers", sym, () => eodhd.ticker(api, sym), () => yahoo.ticker(sym));
        r?.rows.forEach((row) => run.out.tickers.push(run.stamp(row, { symbol: sym, yahoo_symbol: "", is_delisted: 0 }, r.source, "updated_at")));
        run.report("tickers", sym, r);
      }
    }
  }

  const sent: Summary["sent"] = {};
  for (const table of TABLES) {
    if (!run.out[table].length) continue;
    await append(env.TINYBIRD_HOST, env.TINYBIRD_TOKEN, table, run.out[table]);
    sent[table] = run.out[table].length;
  }
  return {
    datasets,
    eodhd: api.active || api.limit ? `${usedBefore}->${api.used}/${api.limit} calls` : "disabled",
    sent,
    results: run.results,
    deferred: run.deferred,
    failed: run.failed,
  };
}
