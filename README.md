# Math Bomber Arena

Math Bomber Arena is a browser multiplayer game that combines a real-time grid arena with mental arithmetic. Players break boxes to discover math tokens, solve arithmetic prompts, and compete for score.

- **Friendly mode** protects players from explosions while they answer.
- **Hardcore mode** keeps players vulnerable during a challenge.
- Desktop players use the keyboard. Mobile players use an on-screen joystick, Bomb button, and number pad.

## Try a local match

From the repository root, start the Node.js server:

```bash
npm start
```

Open `http://localhost:3000` in two separate browser sessions, such as a regular window and a private window. Create a different test nickname and PIN in each session, then join the arena. Separate sessions keep the two beta logins independent.

Use WASD or the arrow keys to move and Space to place a bomb. In a math prompt, use the on-screen keypad or the number, Backspace, and Enter keys.

## Architecture

- [Browser client](apps/web/public) renders the arena with HTML and CSS and receives updates over WebSocket.
- [Node.js server](apps/server/server.js) owns movement, explosions, scores, and match state. It serves the frontend locally and exposes `GET /health` for deployment checks.
- The PWA manifest and service worker support home-screen installation testing.
- [GitHub Pages workflow](.github/workflows/deploy-pages.yml) publishes the static frontend. A hosted instance needs a separate backend and its API and WebSocket URLs set in [config.js](apps/web/public/config.js).

See [architecture notes](docs/architecture.md) for the project layout and deployment design.

## Beta storage and configuration

The local beta stores test profiles and leaderboard data in `apps/server/data/beta-auth.json`. The server can use Supabase for persistent storage when both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set. The repository contains migrations for [beta profiles](supabase/migrations/001_beta_auth.sql) and the [leaderboard](supabase/migrations/002_leaderboard.sql).

Set `PORT`, `HOST`, and `CORS_ORIGIN` in the server environment as needed. Keep the service-role key in server-side configuration. See the [Supabase API key guide](https://supabase.com/docs/guides/api/api-keys).

The nickname and four-digit PIN flow is intended for a limited beta.

## Check the source

```bash
npm run check
```

This checks JavaScript syntax for the server, client, and service worker.
