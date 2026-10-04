// A page component as a Response: the doctype, and the headers every
// dashboard page carries.

import type { JSX } from "hono/jsx/jsx-runtime";

export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  // Inline styles and Lato from Google Fonts; forms post here only; no script.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'",
};

export async function htmlResponse(page: JSX.Element, status = 200): Promise<Response> {
  return new Response(`<!doctype html>${await page.toString()}`, { status, headers: PAGE_HEADERS });
}
