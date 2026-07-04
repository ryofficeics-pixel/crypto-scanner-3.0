// app/api/announcements/route.ts
//
// Deliberately a SEPARATE endpoint from /api/scan. This calls an
// undocumented, unofficial Binance endpoint (see lib/announcements.ts for
// the full caveat) that could break at any time — keeping it isolated
// means a failure here never blocks or slows down the main scan.

import { NextResponse } from "next/server";
import { getNewListingAnnouncements } from "@/lib/announcements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const announcements = await getNewListingAnnouncements();
  return NextResponse.json({
    fetchedAt: new Date().toISOString(),
    announcements
  });
}
