import { type Env, runIngest } from "./ingest";
import type { Dataset } from "./types";

/**
 * Cron (UTC) -> datasets. Must match [triggers].crons in wrangler.toml.
 * Staggered so each invocation stays within Workers Free limits (50 subrequests, 10 ms CPU),
 * and ordered so the EODHD daily quota goes to prices and FX first.
 * 01:00 UTC = 08:00 Asia/Bangkok, after the US close (04:00/03:00 ICT) and EODHD's EOD update.
 */
export const SCHEDULES: Record<string, Dataset[]> = {
  "0 1 * * *": ["eod", "fx"],
  "15 1 * * *": ["splits"], // weekly per symbol (cadence checked in ingest)
  "30 1 * * *": ["dividends"], // weekly per symbol
  "45 1 * * *": ["tickers"], // monthly per symbol
};

export default {
  async scheduled(controller, env, _ctx) {
    const datasets = SCHEDULES[controller.cron];
    if (!datasets) throw new Error(`no datasets configured for cron "${controller.cron}"`);
    const summary = await runIngest(env, datasets);
    console.log(JSON.stringify(summary));
    if (summary.failed.length) throw new Error(`failed: ${summary.failed.join(", ")}`);
  },
} satisfies ExportedHandler<Env>;
