import { describe, expect, it } from "vitest";
import { decStr, divRound, mul, parseDec, parseJsonExact, round, toDec, toStr } from "../src/decimal";

describe("decimal", () => {
  it("parses and formats canonically", () => {
    expect(toStr(parseDec("4.000000"))).toBe("4");
    expect(toStr(parseDec("-0.10"))).toBe("-0.1");
    expect(toStr(parseDec("1e-7"))).toBe("0.0000001");
    expect(toStr(parseDec("1.5E+3"))).toBe("1500");
    expect(toStr(parseDec(".5"))).toBe("0.5");
    expect(() => parseDec("abc")).toThrow();
  });

  it("rounds half to even (ADR-NUM-05)", () => {
    expect(decStr("0.125", 2)).toBe("0.12");
    expect(decStr("0.135", 2)).toBe("0.14");
    expect(decStr("-0.125", 2)).toBe("-0.12");
    expect(decStr("2.5", 0)).toBe("2");
    expect(decStr("3.5", 0)).toBe("4");
    expect(decStr("1.123456789")).toBe("1.12345679"); // capped at 8 places
  });

  it("multiplies and divides exactly", () => {
    expect(toStr(mul(parseDec("0.205"), parseDec("4")))).toBe("0.82");
    expect(toStr(divRound(parseDec("1"), parseDec("3"), 8))).toBe("0.33333333");
    expect(toStr(divRound(parseDec("2"), parseDec("3"), 8))).toBe("0.66666667");
    expect(toStr(round(parseDec("124.80750274658203"), 6))).toBe("124.807503");
  });

  it("parses short JSON numbers natively, exactly", () => {
    const data = parseJsonExact('{"a":121.1519,"b":1e-7,"c":155552400,"d":123456789012.345}') as Record<string, number>;
    expect(typeof data.a).toBe("number"); // fast path
    expect(String(data.a)).toBe("121.1519");
    expect(decStr(data.b)).toBe("0.0000001");
    expect(data.c).toBe(155552400);
    expect(decStr(data.d)).toBe("123456789012.345"); // 15 significant digits still exact
  });

  it("keeps long JSON numbers as exact source text", () => {
    const data = parseJsonExact('{"a":121.1519,"d":0.1000000000000000055511151231257827,"e":1234567890123456.7}') as Record<string, string>;
    expect(data.a).toBe("121.1519");
    expect(data.d).toBe("0.1000000000000000055511151231257827");
    expect(decStr(data.d)).toBe("0.1");
    expect(data.e).toBe("1234567890123456.7");
  });

  it("text fast path canonicalizes like the BigInt path", () => {
    expect(decStr("0500.0400")).toBe("500.04");
    expect(decStr("-0.00")).toBe("0");
    expect(decStr("-0.50")).toBe("-0.5");
    expect(decStr(500.04)).toBe("500.04");
    expect(decStr(" 7 ")).toBe("7");
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 5000; i++) {
      const places = Math.floor(rand() * 11);
      const text = `${rand() < 0.2 ? "-" : ""}${Math.floor(rand() * 10 ** (1 + Math.floor(rand() * 8)))}${places ? "." + String(Math.floor(rand() * 10 ** places)).padStart(places, "0") : ""}`;
      for (const p of [2, 4, 8]) expect(decStr(text, p)).toBe(toStr(round(toDec(text), p)));
    }
  });

  it("uses the shortest round-trip form for JS numbers", () => {
    expect(toStr(toDec(0.1 + 0.2))).toBe("0.30000000000000004");
    expect(decStr(0.1 + 0.2)).toBe("0.3");
  });
});
