import type { Child } from "hono/jsx";
import { DISCLAIMER, PROGRAM_NAME } from "../content";

const styles = `
:root {
  --bg: #f6f5f2; --surface: #ffffff; --text: #1d1d1b; --muted: #5c5b57;
  --border: #dcdad4; --accent: #2d5b8a; --accent-text: #ffffff;
  --error-bg: #fbebeb; --error-text: #8a1f1f; --ok-bg: #e5f4e4; --ok-text: #1f5a24;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --surface: #20201e; --text: #ecebe7; --muted: #a8a6a0;
    --border: #3a3936; --accent: #7fb0e0; --accent-text: #0e1a26;
    --error-bg: #3a1f1f; --error-text: #f3b4b4; --ok-bg: #1d3320; --ok-text: #b4e3b8;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 17px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 640px; margin: 0 auto; padding: 32px 20px 48px; }
header a { color: var(--muted); text-decoration: none; font-size: 15px; }
h1 { font-size: 28px; line-height: 1.2; margin: 12px 0 8px; }
h2 { font-size: 19px; margin: 28px 0 6px; }
p, li { margin: 0 0 12px; }
a { color: var(--accent); }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 24px; margin: 20px 0;
}
label { display: block; font-weight: 600; margin: 0 0 6px; }
input[type=text], input[type=tel] {
  width: 100%; font: inherit; padding: 10px 12px; color: var(--text);
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
}
.field { margin: 0 0 18px; }
fieldset { border: 0; padding: 0; margin: 0 0 18px; }
legend { font-weight: 600; margin: 0 0 6px; padding: 0; }
.check { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; margin: 0 0 8px; }
.check input { margin-top: 5px; width: 18px; height: 18px; flex: none; }
.fine { font-size: 15px; color: var(--muted); }
button, .button {
  font: inherit; font-weight: 600; padding: 11px 20px; border: 0; border-radius: 8px;
  background: var(--accent); color: var(--accent-text); cursor: pointer;
  display: inline-block; text-decoration: none;
}
.notice { border-radius: 8px; padding: 12px 14px; margin: 0 0 18px; }
.notice.error { background: var(--error-bg); color: var(--error-text); }
.notice.ok { background: var(--ok-bg); color: var(--ok-text); }
footer { border-top: 1px solid var(--border); margin-top: 36px; padding-top: 16px; }
footer p { font-size: 14px; color: var(--muted); }
`;

/**
 * Shared page shell: header link home, content, and the not-official footer.
 * @param title page title; the program name is appended
 */
export function Layout({ title, children }: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{`${title} · ${PROGRAM_NAME}`}</title>
        <style>{styles}</style>
      </head>
      <body>
        <main>
          <header>
            <a href="/">{PROGRAM_NAME}</a>
          </header>
          {children}
          <footer>
            <p>{DISCLAIMER}</p>
            <p>
              <a href="/join">Sign up</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a>
            </p>
          </footer>
        </main>
      </body>
    </html>
  );
}
