# Math Bomber Arena

Math Bomber Arena is a mobile-friendly multiplayer web game inspired by Bomberman. Players move through a fixed DOM/CSS arena, place bombs, destroy boxes, collect math challenge tokens, and solve quick mental-math prompts for score.

This repository starts as a clean MVP extracted from `bomberman-dom`, with a static frontend for GitHub Pages and an authoritative Node.js WebSocket server for Railway, Render, Fly.io, or local play.

## MVP Status

- DOM/CSS arena, no canvas or WebGL.
- Node.js WebSocket server with authoritative movement, bombs, explosions, blocks, lives, chat, and scoring.
- Lobby with nickname, game mode, and math difficulty selection.
- Friendly Mode: frozen while answering and protected from explosions.
- Hardcore Mode: frozen while answering and still vulnerable.
- Math tokens can drop from destroyed boxes.
- Challenge modal with calculator-style buttons and desktop keyboard input.
- Mobile joystick and Bomb button.
- PWA manifest, app icon, and service worker for install-to-home-screen testing.
- Beta auth with nickname + 4-digit PIN through backend API.
- Leaderboard with total score, games played, wins, solved math count, and best score.

## Run Locally

```sh
npm start
```

Open `http://localhost:3000` in 2 to 4 browser tabs.

The server also serves `apps/web/public` for local development. In production, GitHub Pages publishes `apps/web/public` through `.github/workflows/deploy-pages.yml`, while the WebSocket/API backend runs separately on Railway.

## Beta Login

The MVP uses a friend-only beta login:

- Create/login with nickname + 4-digit PIN.
- PINs are hashed on the backend.
- Session tokens are stored in browser `localStorage`.
- Local development stores beta users in `apps/server/data/beta-auth.json`, which is ignored by git.

This is intentionally lightweight for testing with friends. Before a public release, add stronger abuse protection, invite codes, and a production auth review.

## Environment

Frontend config lives in `apps/web/public/config.js`:

```js
window.MATH_BOMBER_WS_URL = "wss://your-game-server.example.com";
window.MATH_BOMBER_API_URL = "https://your-game-server.example.com";
```

Backend variables:

```sh
PORT=3000
HOST=0.0.0.0
CORS_ORIGIN=https://astana17.github.io
SUPABASE_URL=https://yulwyakpfjxrgxtuqsvf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-backend-only-service-role-key
```

`SUPABASE_URL` is safe to show publicly, but `SUPABASE_SERVICE_ROLE_KEY` must always stay secret and backend-only. Put the real service role key only in Railway environment variables, never in README, `config.js`, frontend files, GitHub Pages, or browser code. If those Supabase variables are missing, the backend uses the local ignored JSON fallback.

Supabase schema lives in `supabase/migrations/001_beta_auth.sql` and has been prepared for the `Brain_bomber` Supabase project.

Leaderboard schema lives in `supabase/migrations/002_leaderboard.sql`.

## Controls

- Move: `WASD`, arrow keys, or mobile joystick.
- Drop bomb: `Space` or mobile Bomb button.
- Math modal: number keys, Backspace, Enter, or on-screen calculator.

## Roadmap

1. Basic project scaffold.
2. Lobby/create/join match.
3. Realtime movement and bombs.
4. Destructible boxes and math token drops.
5. Math challenge modal.
6. Friendly/Hardcore behavior.
7. Difficulty levels.
8. Mobile controls.
9. Supabase leaderboard, profiles, and match history.
10. GitHub Pages frontend plus hosted WebSocket backend deployment.
