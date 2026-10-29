import type { Child } from "hono/jsx";
import { DISCLAIMER, PROGRAM_NAME } from "../content";

const FONT_URL = "/fonts/atkinson-hyperlegible-next.woff2";

/**
 * Design tokens and base styles. Tokens are OKLCH: warm tinted neutrals with a
 * single juniper-green accent reserved for actions, links, focus, and selection.
 * See PRODUCT.md for who this is designed for (older members on phones).
 */
const styles = `
@font-face {
  font-family: "Atkinson Hyperlegible Next";
  src: url("${FONT_URL}") format("woff2");
  font-weight: 200 800;
  font-style: normal;
  font-display: swap;
}
:root {
  color-scheme: light dark;
  --paper: oklch(0.975 0.008 85);
  --surface: oklch(0.993 0.004 85);
  --ink: oklch(0.25 0.015 70);
  --ink-muted: oklch(0.46 0.016 70);
  --line: oklch(0.87 0.012 80);
  --line-strong: oklch(0.72 0.015 75);
  --accent: oklch(0.45 0.075 160);
  --accent-hover: oklch(0.39 0.075 160);
  --accent-ink: oklch(0.985 0.01 160);
  --accent-tint: oklch(0.95 0.025 160);
  --info-tint: oklch(0.95 0.02 85);
  --error: oklch(0.47 0.15 28);
  --error-tint: oklch(0.955 0.025 28);

  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
  --space-5: 1.5rem; --space-6: 2rem; --space-7: 3rem; --space-8: 4rem;
  --radius: 0.75rem; --radius-sm: 0.5rem;
  --ease-out: cubic-bezier(0.25, 1, 0.5, 1);
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: oklch(0.2 0.01 70);
    --surface: oklch(0.235 0.012 70);
    --ink: oklch(0.94 0.01 85);
    --ink-muted: oklch(0.76 0.012 80);
    --line: oklch(0.35 0.012 70);
    --line-strong: oklch(0.52 0.014 75);
    --accent: oklch(0.8 0.09 160);
    --accent-hover: oklch(0.86 0.08 160);
    --accent-ink: oklch(0.2 0.03 160);
    --accent-tint: oklch(0.29 0.035 160);
    --info-tint: oklch(0.27 0.015 80);
    --error: oklch(0.8 0.11 28);
    --error-tint: oklch(0.29 0.045 28);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font-family: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 1.125rem; line-height: 1.6;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
.page { max-width: 40rem; margin: 0 auto; padding: var(--space-5) var(--space-5) var(--space-7); }

.site-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: var(--space-7); }
.brand { display: inline-flex; align-items: center; gap: var(--space-3); color: var(--ink); text-decoration: none; }
.brand-mark {
  width: 2rem; height: 2rem; border-radius: var(--radius-sm); flex: none;
  display: grid; place-items: center; background: var(--accent); color: var(--accent-ink);
}
.brand-name { font-weight: 700; line-height: 1.15; }
.brand-name small { display: block; font-weight: 400; font-size: 0.875rem; color: var(--ink-muted); }

h1 { font-size: 2.125rem; line-height: 1.15; letter-spacing: -0.015em; font-weight: 700; margin: 0 0 var(--space-4); text-wrap: balance; }
h2 { font-size: 1.3125rem; line-height: 1.3; font-weight: 700; margin: var(--space-7) 0 var(--space-3); text-wrap: balance; }
p, ul, ol { margin: 0 0 var(--space-4); }
.lead { font-size: 1.25rem; line-height: 1.5; color: var(--ink-muted); max-width: 34rem; text-wrap: pretty; }
.muted { color: var(--ink-muted); }
.small { font-size: 1rem; }
a { color: var(--accent); text-decoration-thickness: 0.08em; text-underline-offset: 0.18em; }
a:hover { color: var(--accent-hover); }
strong { font-weight: 700; }

:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; border-radius: 4px; }

.button {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  min-height: 3.25rem; padding: 0 var(--space-6); border: 0; border-radius: var(--radius-sm);
  font: inherit; font-weight: 700; text-decoration: none; cursor: pointer;
  background: var(--accent); color: var(--accent-ink);
  transition: background-color 160ms var(--ease-out), transform 160ms var(--ease-out);
}
.button:hover { background: var(--accent-hover); color: var(--accent-ink); }
.button:active { transform: translateY(1px); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4) var(--space-5); margin: var(--space-6) 0 0; }

.steps { list-style: none; padding: 0; margin: 0; counter-reset: step; display: grid; gap: var(--space-5); }
.steps li { counter-increment: step; display: grid; grid-template-columns: 2.25rem 1fr; gap: var(--space-4); align-items: start; margin: 0; }
.steps li::before {
  content: counter(step); width: 2.25rem; height: 2.25rem; border-radius: 50%;
  display: grid; place-items: center; font-weight: 700; font-size: 1rem;
  background: var(--accent-tint); color: var(--accent);
}
.steps strong { display: block; }

.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-6) var(--space-5); margin: var(--space-6) 0; }
.field { margin: 0 0 var(--space-5); }
.label { display: block; font-weight: 700; margin: 0 0 var(--space-2); }
.hint { display: block; font-size: 1rem; color: var(--ink-muted); margin: calc(var(--space-1) * -1) 0 var(--space-2); }
.input {
  width: 100%; min-height: 3.25rem; padding: 0 var(--space-4);
  font: inherit; color: var(--ink); background: var(--paper);
  border: 1.5px solid var(--line-strong); border-radius: var(--radius-sm);
  transition: border-color 160ms var(--ease-out);
}
.input:hover { border-color: var(--ink-muted); }
.input:focus-visible { outline-offset: 1px; border-color: var(--accent); }
.input[aria-invalid="true"] { border-color: var(--error); }
.field-error { display: block; color: var(--error); font-size: 1rem; font-weight: 700; margin: var(--space-2) 0 0; }

fieldset { border: 0; padding: 0; margin: 0 0 var(--space-5); min-width: 0; }
legend { font-weight: 700; padding: 0; margin: 0 0 var(--space-2); }
.options { display: grid; gap: var(--space-3); }
.option {
  display: flex; align-items: center; gap: var(--space-4); min-height: 3.5rem;
  padding: var(--space-3) var(--space-4); cursor: pointer;
  border: 1.5px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--paper);
  transition: border-color 160ms var(--ease-out), background-color 160ms var(--ease-out);
}
.option:hover { border-color: var(--ink-muted); }
.option:has(input:checked) { border-color: var(--accent); background: var(--accent-tint); }
.option-text { display: grid; line-height: 1.35; }
.option-text span { font-size: 1rem; color: var(--ink-muted); }
input[type=checkbox] { width: 1.375rem; height: 1.375rem; margin: 0; flex: none; accent-color: var(--accent); cursor: pointer; }

.consent {
  display: flex; gap: var(--space-4); align-items: flex-start; cursor: pointer;
  padding: var(--space-4); border-radius: var(--radius-sm); background: var(--info-tint);
}
.consent input { margin-top: 0.2rem; }
.consent-wrap { margin: 0 0 var(--space-5); }

.notice { border-radius: var(--radius-sm); padding: var(--space-4); margin: 0 0 var(--space-5); }
.notice p:last-child { margin: 0; }
.notice-info { background: var(--info-tint); }
.notice-error { background: var(--error-tint); color: var(--ink); }
.notice-error strong { color: var(--error); }
.notice-ok { background: var(--accent-tint); }

.submit-row { display: grid; gap: var(--space-3); }
.alt-path { margin-top: var(--space-5); }

.prose { max-width: 36rem; }
.prose h2:first-of-type { margin-top: var(--space-6); }
.prose li { margin-bottom: var(--space-2); }
.effective { font-size: 1rem; color: var(--ink-muted); margin-top: calc(var(--space-2) * -1); }

.site-footer { border-top: 1px solid var(--line); margin-top: var(--space-8); padding-top: var(--space-5); font-size: 1rem; color: var(--ink-muted); }
.site-footer nav { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); margin: 0 0 var(--space-4); }
.site-footer a { color: var(--ink-muted); }
.site-footer a:hover { color: var(--ink); }
.site-footer p { margin: 0; max-width: 34rem; }

@media (min-width: 40rem) {
  .page { padding-top: var(--space-6); }
  h1 { font-size: 2.5rem; }
  .panel { padding: var(--space-6); }
  .submit-row { grid-template-columns: auto 1fr; align-items: center; gap: var(--space-5); }
}
@media (max-width: 39.99rem) {
  .button { width: 100%; }
  .actions .button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
`;

/** Speech-bubble mark in the header; decorative, so hidden from screen readers. */
function BrandMark() {
  return (
    <span class="brand-mark" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      </svg>
    </span>
  );
}

/**
 * Shared page shell: ward lockup, content, and the not-official footer.
 * @param title page title; the program name is appended
 */
export function Layout({ title, children }: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <meta name="theme-color" content="#f6f4ee" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#1d1b19" media="(prefers-color-scheme: dark)" />
        <title>{`${title} · ${PROGRAM_NAME}`}</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="preload" href={FONT_URL} as="font" type="font/woff2" crossorigin="anonymous" />
        <style>{styles}</style>
      </head>
      <body>
        <div class="page">
          <header class="site-header">
            <a class="brand" href="/">
              <BrandMark />
              <span class="brand-name">
                Payson 10th Ward
                <small>Announcements by text</small>
              </span>
            </a>
          </header>
          <main>{children}</main>
          <footer class="site-footer">
            <nav aria-label="Site">
              <a href="/join">Sign up</a>
              <a href="/terms">Terms</a>
              <a href="/privacy">Privacy</a>
            </nav>
            <p>{DISCLAIMER}</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
