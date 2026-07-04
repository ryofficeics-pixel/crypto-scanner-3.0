// lib/announcements.ts
//
// Binance's public spot-listing announcements, used as a PRE-PRICE early
// warning signal — catches a coin before it even has price/candle history,
// unlike the candle-truncation heuristic in scoring.ts (which can only
// detect a listing once it's already trading and has at least one candle).
//
// IMPORTANT CAVEATS — read before relying on this:
//
// 1. There is NO official REST API for this data. Binance's own documented
//    announcement feed (developers.binance.com/docs/cms/announcement) is
//    WebSocket-push ONLY, requires a signed API key, and needs a
//    persistent connection kept alive with pings every 30s + reconnects
//    every 24h. That's fundamentally incompatible with Vercel serverless
//    functions (stateless, ~10s free-tier budget, no long-lived
//    connections) — implementing it properly would require a separate
//    always-on process (small VPS / Railway / a scheduled GitHub Actions
//    relay), which is out of scope for "keep it free, stay serverless".
//
// 2. The endpoint below is the UNDOCUMENTED internal JSON API Binance's own
//    website calls to render binance.com/en/support/announcement. It is
//    NOT a committed public contract. It has returned 403 before for some
//    callers (confirmed on Binance's own developer forum, Jan 2025) and
//    could change or break again without notice.
//
// 3. Because of (2), every call here is wrapped to fail SILENTLY (returns
//    an empty array on any error/timeout) rather than throwing — this
//    feature is a bonus signal, not a dependency. If it goes dark, the
//    rest of the scanner (candle-based isNewListing / possibleExitLiquidity
//    detection) is completely unaffected, since it's a separate code path
//    called from a separate API route.

const ANNOUNCEMENTS_URL =
  "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query";

const NEW_LISTING_CATALOG_ID = 48; // Binance's "New Cryptocurrency Listing" catalog
const MAX_ANNOUNCEMENT_AGE_HOURS = 168; // 7 days — older ones are stale/already absorbed

export interface ListingAnnouncement {
  symbol: string;
  title: string;
  publishDate: number; // ms epoch
  ageHours: number;
}

/**
 * Binance's spot listing announcement titles follow a consistent format:
 * "Binance Will List <Name> (<SYMBOL>)", sometimes with a suffix like
 * "with Seed Tag Applied". Grab the first parenthesized all-caps token.
 */
function extractSymbol(title: string): string | null {
  const match = title.match(/\(([A-Z0-9]{2,10})\)/);
  return match ? match[1] : null;
}

/**
 * The catalog also contains futures perpetual launches, margin pair
 * additions, tokenized-stock listings, fee promos, delisting notices, etc.
 * We only want genuine new SPOT listings, which all start with this exact
 * phrase in practice.
 */
function isGenuineSpotListingTitle(title: string): boolean {
  return /^Binance Will List\b/i.test(title.trim());
}

export async function getNewListingAnnouncements(): Promise<ListingAnnouncement[]> {
  const url = `${ANNOUNCEMENTS_URL}?type=1&catalogId=${NEW_LISTING_CATALOG_ID}&pageNo=1&pageSize=30`;

  let json: any;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000) // don't let a slow/dead endpoint stall the caller
    });
    if (!res.ok) return [];
    json = await res.json();
  } catch {
    return []; // best-effort, see caveat (3) above
  }

  const articles: any[] = json?.data?.catalogs?.[0]?.articles ?? [];
  const now = Date.now();
  const bySymbol = new Map<string, ListingAnnouncement>();

  for (const a of articles) {
    if (typeof a?.title !== "string" || typeof a?.releaseDate !== "number") continue;
    if (!isGenuineSpotListingTitle(a.title)) continue;

    const symbol = extractSymbol(a.title);
    if (!symbol) continue;

    const ageHours = (now - a.releaseDate) / 3_600_000;
    if (ageHours > MAX_ANNOUNCEMENT_AGE_HOURS || ageHours < 0) continue;

    // Keep the EARLIEST announcement per symbol — Binance sometimes posts a
    // follow-up ("... with Seed Tag Applied") for the same coin; the first
    // one is the real heads-up moment.
    const existing = bySymbol.get(symbol);
    if (!existing || a.releaseDate < existing.publishDate) {
      bySymbol.set(symbol, { symbol, title: a.title, publishDate: a.releaseDate, ageHours });
    }
  }

  return Array.from(bySymbol.values()).sort((a, b) => a.ageHours - b.ageHours);
}
