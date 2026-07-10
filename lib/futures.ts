export interface FundingRate {
  symbol: string;
  fundingRate: number;
  signal: "extreme_short" | "extreme_long" | "moderate" | "neutral";
}

const FUTURES_BASE = "https://fapi.binance.com";

async function safeFetch(url: string): Promise<unknown> {
  const res = await fetch(url, { next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`Futures API error ${res.status}`);
  return res.json();
}

export async function getFundingSignals(): Promise<Map<string, FundingRate>> {
  try {
    const data = await safeFetch(`${FUTURES_BASE}/fapi/v1/premiumIndex`) as Record<string, unknown>[];
    const map = new Map<string, FundingRate>();
    for (const item of data) {
      const symbol = item.symbol as string;
      if (!symbol.endsWith("USDT")) continue;
      const fr = parseFloat(item.lastFundingRate as string) * 100;
      const sig: FundingRate["signal"] = fr < -0.1 ? "extreme_short" : fr > 0.1 ? "extreme_long" : Math.abs(fr) > 0.05 ? "moderate" : "neutral";
      map.set(symbol, { symbol, fundingRate: fr, signal: sig });
    }
    return map;
  } catch {
    return new Map();
  }
}
