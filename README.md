# market-data-clickhouse

Daily market data into **Tinybird (ClickHouse)**, running as a **Cloudflare Worker on Cron Triggers**.
**EODHD** is the primary source (free tier: 20 calls/day). **Yahoo Finance** fills in when EODHD fails, has
no data, or the daily quota is used up. The schema follows Merton's precision and valuation rules, so the
data can be imported as Merton `instrument_prices` / `fx_rates`.

```
Cloudflare cron ──► Worker (src/) ──► EODHD ─(fallback)─► Yahoo
                          │
                          ├─ reads  Tinybird ingest_state  (what is already stored / due)
                          └─ writes Tinybird Events API    (eod_prices, fx_rates, stock_splits, dividends, tickers, fetch_log)
```

## Layout

| Path | What |
|---|---|
| `src/index.ts` | `scheduled()` handler; maps each cron to its datasets |
| `src/ingest.ts` | run logic: EODHD first, Yahoo fallback, quota, cadence, `fetch_log`, source-priority `version` |
| `src/eodhd.ts`, `src/yahoo.ts` | source clients and transforms |
| `src/decimal.ts` | exact BigInt decimals (8 places, half-to-even); JSON numbers kept as source text |
| `src/tinybird.ts` | `ingest_state` reader and Events API appender |
| `test/` | Vitest: decimals, Yahoo split/dividend un-adjusting (AAPL 2020), EODHD parsing, quota guard |
| `tinybird/` | Tinybird Forward project: 6 datasources, 3 endpoints |
| `scripts/deploy-tinybird.sh` | deploys `tinybird/` through the Tinybird deploy API (no `tb` CLI) |
| `wrangler.toml` | Worker config, cron triggers, symbols, FX pairs |

## Schedule

All times UTC (Cloudflare crons are UTC). 01:00 UTC = 08:00 Asia/Bangkok, after the US close and EODHD's EOD update.

| Cron | Datasets | Cadence inside the run |
|---|---|---|
| `0 1 * * *` | `eod`, `fx` | every day, incremental (last stored date − 7 days, or a 365-day backfill) |
| `15 1 * * *` | `splits` | each symbol weekly |
| `30 1 * * *` | `dividends` | each symbol weekly: full history the first time, then the last 400 days |
| `45 1 * * *` | `tickers` | each symbol monthly (EODHD Search API) |

The order is also the EODHD quota priority. When the quota is used up, incremental updates fall back to
Yahoo, but a **first-time backfill or full dividend history waits for EODHD** (logged as `status = 'quota'`,
listed under `deferred` in the run summary, retried on the next run). Yahoo still covers them when EODHD
errors, for example for a symbol EODHD doesn't have.

The runs are split up to fit Workers Free limits: **10 ms CPU** and **50 subrequests** per cron run, and
**5 cron triggers** per account (this uses 4). CPU is the tighter one: the daily prices + FX run for the
5 default symbols measured **9 ms on Cloudflare** (2026-11-03), mostly fixed runtime overhead. So
Workers Free fits about these 5 symbols; for more, use **Workers Paid** (30 s CPU per run, 10,000
subrequests). To change times, edit both `wrangler.toml` and `SCHEDULES` in `src/index.ts`.

## Deploy to Cloudflare

```bash
npm install
npx wrangler login
npm run deploy
npx wrangler secret put EODHD_API_KEY
npx wrangler secret put TINYBIRD_TOKEN
npx wrangler secret put TINYBIRD_STATE_TOKEN
```

- `TINYBIRD_TOKEN` is Tinybird's `ingest_token` (APPEND on all tables) and `TINYBIRD_STATE_TOKEN` is
  `state_token` (READ on `ingest_state`). Both are on the Tinybird **Tokens** page. Never give the Worker
  the workspace admin token.
- Symbols, FX pairs and the Tinybird host are plain `[vars]` in `wrangler.toml`; change them and run
  `npm run deploy` again.
- After deploying, Cloudflare dashboard → Workers → `market-data-clickhouse` → Settings → Triggers lists
  the 4 crons; each run's summary JSON is in **Logs**. A run with failures throws, so it shows as an error.
- The Worker has no public URL (`workers_dev = false`); it only runs on its crons.

## Run locally

```bash
cp .dev.vars.example .dev.vars
npm run dev
curl "http://localhost:8787/__scheduled?cron=0+1+*+*+*"
```

Fill in `.dev.vars` before starting. Local runs write to the real Tinybird workspace and use the real EODHD
quota. Put `FORCE_REFRESH=true` in `.dev.vars` to refresh splits, dividends and tickers regardless of cadence.

```bash
npm test
npm run typecheck
```

## Tinybird

```bash
cp .env.example .env
npm run tinybird:check
npm run tinybird:deploy
sh scripts/deploy-tinybird.sh --allow-destructive
```

`.env` holds the workspace admin token, for deploys only. Use `--allow-destructive` only when a
`.datasource` file is removed, which drops that table. An incompatible change to a table with data needs a
`FORWARD_QUERY` in its `.datasource` file; remove it once that deployment is live.

### Tables

| Table | Key (dedupe) | EODHD | Yahoo fallback |
|---|---|---|---|
| `eod_prices` | `symbol, price_date` | `/api/eod/{SYMBOL}` | chart API, converted back to raw prices |
| `fx_rates` | `base_currency, quote_currency, rate_date` | `/api/eod/{BASEQUOTE}.FOREX` | `{BASEQUOTE}=X` |
| `stock_splits` | `symbol, split_date` | `/api/splits/{SYMBOL}` | chart events |
| `dividends` | `symbol, ex_date` | `/api/div/{SYMBOL}` | chart events (no payment/record dates) |
| `tickers` | `symbol` | `/api/search/{CODE}?exchange=` | chart meta (no ISIN) |
| `fetch_log` | — (1-year TTL) | one row per upstream request; `api_calls` = EODHD calls | |

### Rules

- **Decimals:** `Decimal(23, 8)`, Merton's ADR-NUM-04 limit (8 places, 15 integer digits). Values are
  parsed from the JSON source text and sent as decimal strings, rounded half-to-even (ADR-NUM-05).
  Dates are `Date32`.
- **Raw prices:** `close` is the raw close in the quote currency. Yahoo OHLC and dividends are
  split-adjusted, so the Worker converts them back with exact rational arithmetic (AAPL 2020: 499.23,
  matching EODHD). `volume` stays split-adjusted, as both sources deliver it. Don't trust stored
  `adjusted_close`; derive adjusted series from `dividends` + `stock_splits`.
- **Splits:** `ratio_new:ratio_old` (Merton ADR-TXN-07). Snowball's coefficient = new ÷ old.
- **FX:** 1 `base_currency` = `rate` `quote_currency` (ADR-VAL-06); inverse pairs stay in Merton.
- **Source priority:** ReplacingMergeTree `version` = source rank × 10^13 + fetch time (ms). For the same key
  **EODHD always beats Yahoo**; within a source the newest fetch wins. Always query with `FINAL`.

### Endpoints (`read_token`)

```bash
curl "$TINYBIRD_HOST/v0/pipes/latest_prices.json?as_of=2026-11-02&ticker=AAPL.US" -H "Authorization: Bearer $READ_TOKEN"
curl "$TINYBIRD_HOST/v0/pipes/latest_fx_rates.json?base_currency=USD&quote_currency=THB" -H "Authorization: Bearer $READ_TOKEN"
```

Both return the latest value on or before `as_of` (default today) as a decimal string, with `stale` after
7 days for prices and 3 days for FX (ADR-VAL-02). `ingest_state` is the Worker's bookkeeping.

## Known limits

- EODHD free tier: 20 calls/day, about 1 year of EOD history. `/api/user` keeps reporting the last day's
  count (with its `apiRequestsDate`) until the next request, so the Worker treats a count dated before today
  (UTC) as 0 used. EODHD MCP calls share the same quota.
- Yahoo's chart API is unofficial and may rate-limit Cloudflare's IPs. EODHD is unaffected; a blocked
  fallback shows up as `status = 'error'` rows in `fetch_log`.
- Workers Free CPU is 10 ms per run (network waits don't count). Measured cold in Node for 5 symbols:
  daily prices + FX about 4 ms, weekly dividends about 2.5 ms, a first-time 365-day backfill about 8 ms.
  CPU grows with the number of symbols backfilled at once, so add many new symbols a few at a time, or
  use Workers Paid (30 s per run).
- Exactness: JSON is parsed natively when every number has at most 15 significant digits (doubles
  round-trip those exactly); longer literals switch to source-text parsing. Decimals that need no rounding
  are canonicalized as text, everything else goes through BigInt.
