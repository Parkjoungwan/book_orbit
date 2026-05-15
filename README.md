# 2026 Book Orbit

3D 우주 공간에 읽을 책을 띄우고, 완독한 책은 블랙홀로 흡수시키는 브라우저 기반 북리스트입니다.

## Local Run

```bash
npm start
```

Open `http://127.0.0.1:4173/`.

## Storage

Book state is stored in the user's browser with `localStorage`.

- Each browser/device keeps its own orbit and done list.
- The server does not write a shared JSON state file.
- Clearing site data or using another browser starts a separate list.

## Deploy

This project is ready for Vercel-style free hosting:

- Static files are served from the project root.
- `/api/search` and `/api/image` are implemented as Node functions in `api/`.
- No database is required for user state because it stays in each user's browser.

Recommended deploy flow:

1. Push this folder to a GitHub repository.
2. Import the repository in Vercel.
3. Use the default/Other framework settings.
4. Deploy.

The same structure can also be adapted to Netlify or Cloudflare Pages, but their function folder conventions differ.
