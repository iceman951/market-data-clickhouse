import { parseJsonExact } from "./decimal";

export const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) market-data-clickhouse/1.0";

export type FetchStatus = "ok" | "empty" | "error" | "quota";

export class SourceError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 0,
    readonly status: FetchStatus = "error",
  ) {
    super(message);
  }
}

/** GET JSON. URLs may carry API keys, so they never appear in errors or logs. */
export async function getJson(url: string, exactNumbers = false): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  } catch (error) {
    throw new SourceError(`network: ${String(error)}`);
  }
  const body = await response.text();
  if (!response.ok) throw new SourceError(`HTTP ${response.status}: ${body.slice(0, 200).trim()}`, response.status);
  try {
    return exactNumbers ? parseJsonExact(body) : JSON.parse(body);
  } catch {
    throw new SourceError(`not JSON: ${body.slice(0, 200).trim()}`, response.status);
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
