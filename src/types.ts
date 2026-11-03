export type Source = "EODHD" | "YAHOO";
export type Dataset = "eod" | "fx" | "splits" | "dividends" | "tickers";

/** Fields per table before symbol/source/ingested_at/version are added. Decimals are strings. */
export interface PriceRow {
  price_date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  adjusted_close: string;
  volume: number;
}

export interface FxRow {
  rate_date: string;
  rate: string;
}

export interface SplitRow {
  split_date: string;
  ratio_new: string;
  ratio_old: string;
}

export interface DividendRow {
  ex_date: string;
  declaration_date: string | null;
  record_date: string | null;
  payment_date: string | null;
  period: string;
  per_share: string;
  split_adjusted_per_share: string;
  currency: string;
}

export interface TickerRow {
  code: string;
  exchange: string;
  name: string;
  quote_currency: string;
  country: string;
  asset_class: string;
  source_type: string;
  isin: string | null;
}

/** Upstream instrument type -> Merton asset class (ADR-INST-04); anything else maps to "". */
const ASSET_CLASS: Record<string, string> = {
  "common stock": "STOCK",
  "preferred stock": "STOCK",
  equity: "STOCK",
  etf: "ETF",
  fund: "MUTUAL_FUND",
  "mutual fund": "MUTUAL_FUND",
  mutualfund: "MUTUAL_FUND",
};

export const assetClass = (type: string | undefined): string => ASSET_CLASS[(type ?? "").toLowerCase()] ?? "";

export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}
