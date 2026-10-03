// The page shell every dashboard page shares: head (fonts, the inline
// stylesheet, an optional self-refresh), the navy top bar with the signed-in
// user, and main. Hono JSX escapes every value it renders; the stylesheet is
// the one raw string, and it's ours.

import type { Child } from "hono/jsx";
import { REFRESH_SECONDS } from "../model";
import { STYLES } from "../styles";

/** The Umbraco logo mark, from the Cloud Portal design system's assets. */
export function Logo() {
  return (
    <svg viewBox="0 0 40 40" width="28" height="28" aria-hidden="true">
      <path
        fill="currentColor"
        d="M0,20C0,8.9,9,0,20,0s20,9,20,20s-9,20-20,20C8.9,40,0,31,0,20L0,20z M19.6,26.8c-1.6,0-3.1-0.1-4.6-0.4c-1.1-0.2-2.1-1-2.5-2c-0.5-1-0.7-2.6-0.7-4.8c0-1.1,0.1-2.3,0.2-3.4c0.1-1.1,0.3-2,0.4-2.7l0.1-0.7c0,0,0,0,0-0.1c0-0.2-0.1-0.4-0.3-0.4l-2.6-0.4H9.6c-0.2,0-0.4,0.1-0.4,0.3c0,0.2-0.1,0.3-0.1,0.7c-0.1,0.8-0.3,1.5-0.4,2.6c-0.2,1.2-0.3,2.4-0.3,3.5c-0.1,0.8-0.1,1.6,0,2.5c0.1,2.2,0.4,3.9,1.1,5.2c0.7,1.3,1.9,2.2,3.5,2.8c1.6,0.6,3.9,0.9,6.9,0.8h0.4c2.9,0,5.2-0.3,6.9-0.8c1.6-0.6,2.8-1.5,3.5-2.8c0.7-1.3,1.1-3.1,1.1-5.2c0.1-0.8,0.1-1.6,0-2.5c0-1.2-0.1-2.4-0.3-3.5c-0.1-1.1-0.3-1.8-0.4-2.6c-0.1-0.4-0.1-0.5-0.1-0.7c0-0.2-0.2-0.3-0.4-0.3h-0.1l-2.6,0.4c-0.2,0-0.3,0.2-0.3,0.4c0,0,0,0,0,0.1l0.1,0.7c0.1,0.7,0.3,1.6,0.4,2.7c0.1,1.1,0.2,2.3,0.2,3.4c0,2.2-0.2,3.8-0.7,4.8c-0.5,1-1.4,1.8-2.5,2c-1.5,0.3-3.1,0.5-4.6,0.4L19.6,26.8z"
      />
    </svg>
  );
}

export function Layout({ title, user, refresh = false, children }: { title: string; user?: string; refresh?: boolean; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {refresh && <meta http-equiv="refresh" content={String(REFRESH_SECONDS)} />}
        <title>{title}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap" />
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <header class="top-bar">
          <a class="home" href="/status" aria-label="Issues and pull requests">
            <Logo />
          </a>
          <div class="product">
            Agent orchestrator <span>/ Live status</span>
          </div>
          {user && (
            <div class="user">
              {user}
              <a href="/auth/logout">Sign out</a>
            </div>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
