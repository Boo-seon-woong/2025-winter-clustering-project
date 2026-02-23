# assets

Browser-side JS/CSS loaded by static HTML pages.

## Shared Assets

- `app.css`: global styling.
- `api.js`: authenticated fetch wrapper + token storage helpers.
- `ws.js`: websocket connection and reconnect helper.

## Page Scripts

- `login.js`: login flow (`index.html`).
- `register.js`: registration flow (`register.html`).
- `main.js`: feed render + realtime post handling (`main.html`).
- `new.js`: post creation flow (`new.html`).
- `post.js`: single post fetch/render (`post.html`).

## Dependency Order

Page templates load `api.js` first, then page-specific scripts that use `window.Api`.
