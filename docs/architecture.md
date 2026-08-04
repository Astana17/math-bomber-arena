# Architecture

## Current MVP

- `apps/web/public`: static frontend for Netlify.
- `apps/server`: Node.js HTTP + WebSocket server.
- No external runtime dependencies yet.
- Server owns the authoritative game state.
- Clients send input, chat, join settings, and math answers.
- Clients render server snapshots with DOM elements and `requestAnimationFrame`.

## Realtime Model

The first player in a lobby chooses `mode` and `difficulty`. The server stores those settings for the match and broadcasts them in state snapshots.

Players are frozen while `player.challenge` exists. In Friendly Mode, explosions ignore players who are solving. In Hardcore Mode, those players can still be damaged.

Math challenge answers are never included in public player snapshots. The server only sends the active player's challenge prompt to that player.

## Future Supabase Use

Supabase should be added after the gameplay loop feels good. Good first tables:

- `profiles`: auth user id or guest id, display name, avatar, created date.
- `matches`: mode, difficulty, started/ended timestamps, winner.
- `match_players`: match id, player id, score, math solved, rank.
- `leaderboard_events`: score deltas, fastest answers, wins.

Keep Supabase out of the hot movement loop. Realtime gameplay should stay on the WebSocket server.
