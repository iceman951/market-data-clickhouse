// Exact decimal arithmetic on BigInt, following Merton's precision rules:
// at most 8 places (ADR-NUM-04) and half-to-even rounding (ADR-NUM-05). No binary floats.

export const MAX_PLACES = 8;

/** value = m / 10^s, s >= 0 */
export interface Dec {
  m: bigint;
  s: number;
}

export const ONE: Dec = { m: 1n, s: 0 };

const POW10 = Array.from({ length: 48 }, (_, i) => 10n ** BigInt(i));
const pow10 = (n: number): bigint => (n < POW10.length ? POW10[n] : 10n ** BigInt(n));

/** Parse a decimal literal, including exponent notation ("1e-7"). */
export function parseDec(text: string): Dec {
  const match = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match || (!match[2] && !match[3])) throw new Error(`invalid decimal: ${text}`);
  const [, sign, int = "", frac = "", exp = "0"] = match;
  let m = BigInt(int + frac || "0");
  let s = frac.length - Number(exp);
  if (s < 0) {
    m *= pow10(-s);
    s = 0;
  }
  return { m: sign === "-" ? -m : m, s };
}

/**
 * Exact Dec from source text, or from a JS number via its shortest round-trip form
 * (Yahoo floats: 124.80750274658203 stays 124.80750274658203).
 */
export function toDec(value: string | number | Dec): Dec {
  if (typeof value === "string") return parseDec(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`invalid number: ${value}`);
    return parseDec(String(value));
  }
  return value;
}

export const mul = (a: Dec, b: Dec): Dec => ({ m: a.m * b.m, s: a.s + b.s });

/** a / b rounded half-to-even to `places`. */
export function divRound(a: Dec, b: Dec, places: number): Dec {
  if (b.m === 0n) throw new Error("division by zero");
  let num = a.m * pow10(b.s + places);
  let den = b.m * pow10(a.s);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const negative = num < 0n;
  if (negative) num = -num;
  let q = num / den;
  const twice = 2n * (num % den);
  if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  return { m: negative ? -q : q, s: places };
}

export const round = (a: Dec, places: number): Dec => divRound(a, ONE, places);

/** Canonical string: no exponent, no trailing zeros ("4.000000" -> "4"). */
export function toStr(a: Dec): string {
  let { m, s } = a;
  while (s > 0 && m % 10n === 0n) {
    m /= 10n;
    s--;
  }
  const negative = m < 0n;
  const digits = (negative ? -m : m).toString().padStart(s + 1, "0");
  const out = s ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits;
  return negative ? `-${out}` : out;
}

const PLAIN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Round half-to-even to `places` (capped at 8) and format canonically.
 * Plain literals that need no rounding (most EODHD values) are canonicalized as text, without BigInt.
 */
export function decStr(value: string | number | Dec, places = MAX_PLACES): string {
  const p = Math.min(places, MAX_PLACES);
  if (typeof value !== "object") {
    const match = PLAIN.exec(typeof value === "number" ? String(value) : value.trim());
    if (match && (match[3]?.length ?? 0) <= p) {
      const int = match[2].replace(/^0+(?=\d)/, "");
      const frac = (match[3] ?? "").replace(/0+$/, "");
      const out = frac ? `${int}.${frac}` : int;
      return match[1] && out !== "0" ? `-${out}` : out;
    }
  }
  return toStr(round(toDec(value), p));
}

export const isPositive = (value: string | number | Dec): boolean => toDec(value).m > 0n;

/** A numeric literal with 16+ significant digits, which a double cannot round-trip. */
const LONG_NUMBER = /\d(?:\.?\d){15}/;

/**
 * JSON.parse without binary-float loss. Doubles round-trip every decimal of up to 15 significant
 * digits, so String(n) gives back the exact source text and plain JSON.parse is exact (and fast).
 * Only a body with a longer literal (or a long digit run inside a string) takes the slow path,
 * which keeps every number as its exact source text.
 */
export function parseJsonExact(text: string): unknown {
  if (!LONG_NUMBER.test(text)) return JSON.parse(text);
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" ? (context?.source ?? String(value)) : value;
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}
