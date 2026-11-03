import { decStr } from "./decimal";
import { SourceError, getJson } from "./http";
import { assetClass, type DividendRow, type FxRow, type PriceRow, type SplitRow, type TickerRow } from "./types";

const API = "https://eodhd.com/api";

type Json = Record<string, unknown>;

/** EODHD client with a daily-quota guard; numbers keep their exact JSON source text. */
export class Eodhd {
  used = 0;
  limit = 0;
  private enabled: boolean;

  constructor(private readonly apiKey: string | undefined, enabled = true) {
    this.enabled = Boolean(apiKey) && enabled;
  }

  get active(): boolean {
    return this.enabled;
  }

  /**
   * Read today's usage from /api/user; on failure EODHD is skipped for this run.
   * apiRequests only resets on the next request, so a count dated before today (UTC) means 0 used today.
   */
  async init(): Promise<void> {
    if (!this.enabled) return;
    try {
      const user = (await getJson(`${API}/user?${new URLSearchParams({ api_token: this.apiKey!, fmt: "json" })}`)) as Json;
      const countDate = user.apiRequestsDate ? String(user.apiRequestsDate).slice(0, 10) : "";
      const today = new Date().toISOString().slice(0, 10);
      this.used = countDate && countDate !== today ? 0 : Number(user.apiRequests ?? 0);
      this.limit = Number(user.dailyRateLimit ?? 0);
    } catch (error) {
      console.warn(`eodhd: cannot read quota (${String(error)}); EODHD disabled for this run`);
      this.enabled = false;
    }
  }

  async get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (!this.enabled) throw new SourceError("EODHD disabled", 0, "quota");
    if (this.used >= this.limit) throw new SourceError(`daily quota used (${this.used}/${this.limit})`, 0, "quota");
    const query = new URLSearchParams({ ...params, api_token: this.apiKey!, fmt: "json" });
    const data = await getJson(`${API}/${path}?${query}`, true);
    this.used++;
    if (data && typeof data === "object" && !Array.isArray(data) && ((data as Json).error || (data as Json).errors)) {
      throw new SourceError(`EODHD error: ${JSON.stringify(data).slice(0, 200)}`, 200);
    }
    return data;
  }
}

function asList(data: unknown): Json[] {
  if (!Array.isArray(data)) throw new SourceError(`unexpected response: ${JSON.stringify(data).slice(0, 200)}`, 200);
  return data as Json[];
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const dateOrNull = (v: unknown): string | null => {
  const s = str(v);
  return !s || s.startsWith("0000") ? null : s.slice(0, 10);
};

export async function eod(api: Eodhd, symbol: string, start: string, end: string): Promise<PriceRow[]> {
  const data = asList(await api.get(`eod/${encodeURIComponent(symbol)}`, { from: start, to: end }));
  return data
    .filter((r) => r.close !== null && r.close !== undefined)
    .map((r) => ({
      price_date: str(r.date),
      open: decStr(str(r.open)),
      high: decStr(str(r.high)),
      low: decStr(str(r.low)),
      close: decStr(str(r.close)),
      adjusted_close: decStr(str(r.adjusted_close ?? r.close)),
      volume: Number(r.volume ?? 0), // split-adjusted, as EODHD delivers it
    }));
}

export async function fx(api: Eodhd, base: string, quote: string, start: string, end: string): Promise<FxRow[]> {
  const data = asList(await api.get(`eod/${base}${quote}.FOREX`, { from: start, to: end }));
  return data.filter((r) => r.close).map((r) => ({ rate_date: str(r.date), rate: decStr(str(r.close)) }));
}

export async function splits(api: Eodhd, symbol: string): Promise<SplitRow[]> {
  const data = asList(await api.get(`splits/${encodeURIComponent(symbol)}`));
  return data.map((r) => {
    const [ratioNew, ratioOld] = str(r.split).split("/"); // "4.000000/1.000000"
    return { split_date: str(r.date), ratio_new: decStr(ratioNew), ratio_old: decStr(ratioOld) };
  });
}

/** Full history, or ex-dates from `from` onwards for incremental refreshes. */
export async function dividends(api: Eodhd, symbol: string, from?: string): Promise<DividendRow[]> {
  const data = asList(await api.get(`div/${encodeURIComponent(symbol)}`, from ? { from } : {}));
  return data
    .filter((r) => r.unadjustedValue != null || r.value != null)
    .map((r) => {
      const paid = str(r.unadjustedValue ?? r.value);
      return {
        ex_date: str(r.date),
        declaration_date: dateOrNull(r.declarationDate),
        record_date: dateOrNull(r.recordDate),
        payment_date: dateOrNull(r.paymentDate),
        period: str(r.period),
        per_share: decStr(paid),
        split_adjusted_per_share: decStr(str(r.value ?? paid)),
        currency: str(r.currency),
      };
    });
}

/** Instrument metadata via the Search API (1 call, small response; the exchange list is too big for 10 ms CPU). */
export async function ticker(api: Eodhd, symbol: string): Promise<TickerRow[]> {
  const [code, exchange] = symbol.includes(".") ? [symbol.slice(0, symbol.lastIndexOf(".")), symbol.slice(symbol.lastIndexOf(".") + 1)] : [symbol, ""];
  const params: Record<string, string> = { limit: "10" };
  if (exchange) params.exchange = exchange;
  const data = asList(await api.get(`search/${encodeURIComponent(code)}`, params));
  const hit = data.find((r) => str(r.Code).toUpperCase() === code.toUpperCase() && (!exchange || str(r.Exchange) === exchange));
  if (!hit) return [];
  return [
    {
      code: str(hit.Code),
      exchange: str(hit.Exchange) || exchange,
      name: str(hit.Name),
      quote_currency: str(hit.Currency),
      country: str(hit.Country),
      asset_class: assetClass(str(hit.Type)),
      source_type: str(hit.Type),
      isin: str(hit.ISIN).toUpperCase() || null,
    },
  ];
}
