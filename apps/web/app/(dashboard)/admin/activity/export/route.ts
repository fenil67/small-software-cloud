import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export async function GET(request: Request): Promise<NextResponse> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const params = new URLSearchParams();
  for (const key of ["q", "event_type", "from", "to"]) {
    const val = url.searchParams.get(key);
    if (val) params.set(key, val);
  }

  const apiRes = await fetch(`${API_URL}/v1/admin/activity/export?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!apiRes.ok) {
    return NextResponse.json({ error: "export_failed" }, { status: apiRes.status });
  }

  const today = new Date().toISOString().slice(0, 10);
  return new NextResponse(apiRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="activity-${today}.csv"`,
    },
  });
}
