# frontend

`frontend/` contains static pages served by the Node backend.

## Pages

- `index.html`: login page (`/`).
- `register.html`: registration page (`/register`).
- `main.html`: main feed/dashboard (`/main`).
- `new.html`: create post page (`/new`).
- `post.html`: post detail page (`/post/:id`).

## Assets

- `assets/` provides shared CSS and page scripts.

## Serving

Files are served directly by `server/backend/server.js` without a bundler step.
