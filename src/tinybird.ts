import { sleep } from "./http";

export interface State {
  /** "eod|AAPL.US" or "fx|USD/THB" -> last stored date */
  lastDate: Map<string, string>;
  /** "dividends|AAPL.US" -> last successful fetch (ms since epoch) */
  lastOk: Map<string, number>;
}

/** Bookkeeping from the ingest_state endpoint (last stored dates, last successful fetches). */
export async function readState(host: string, stateToken: string): Promise<State> {
  const response = await fetch(`${host.replace(/\/$/, "")}/v0/pipes/ingest_state.json`, {
    headers: { Authorization: `Bearer ${stateToken}` },
  });
  if (!response.ok) throw new Error(`Tinybird ingest_state HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const { data } = (await response.json()) as { data: Array<{ dataset: string; key: string; last_date: string; last_ok_fetch: string }> };
  const state: State = { lastDate: new Map(), lastOk: new Map() };
  for (const r of data) {
    if (r.dataset.startsWith("fetch:")) state.lastOk.set(`${r.dataset.slice(6)}|${r.key}`, Date.parse(`${r.last_ok_fetch.slice(0, 19).replace(" ", "T")}Z`));
    else state.lastDate.set(`${r.dataset}|${r.key}`, r.last_date);
  }
  return state;
}

/** Append NDJSON rows through the Events API, retrying 429s with backoff. */
export async function append(host: string, token: string, datasource: string, rows: object[], batch = 5000): Promise<void> {
  const url = `${host.replace(/\/$/, "")}/v0/events?${new URLSearchParams({ name: datasource, wait: "true" })}`;
  for (let i = 0; i < rows.length; i += batch) {
    const body = rows.slice(i, i + batch).map((r) => JSON.stringify(r)).join("\n");
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
      if (response.status === 429 && attempt < 4) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`Tinybird ${datasource} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const out = (await response.json()) as { quarantined_rows?: number };
      if (out.quarantined_rows) console.warn(`${datasource}: ${out.quarantined_rows} rows quarantined`);
      break;
    }
  }
}
