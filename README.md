# Math Bomber Arena

Math Bomber Arena is a mobile-friendly multiplayer web game inspired by Bomberman. Players move through a fixed DOM/CSS arena, place bombs, destroy boxes, collect math challenge tokens, and solve quick mental-math prompts for score.

This repository starts as a clean MVP extracted from `bomberman-dom`, with a static frontend for Netlify and an authoritative Node.js WebSocket server for Render, Railway, Fly.io, or local play.

## MVP Status

- DOM/CSS arena, no canvas or WebGL.
- Node.js WebSocket server with authoritative movement, bombs, explosions, blocks, lives, chat, and scoring.
- Lobby with nickname, game mode, and math difficulty selection.
- Friendly Mode: frozen while answering and protected from explosions.
- Hardcore Mode: frozen while answering and still vulnerable.
- Math tokens can drop from destroyed boxes.
- Challenge modal with calculator-style buttons and desktop keyboard input.
- Mobile D-pad and Bomb button.

## Run Locally

```sh
npm start
```

Open `http://localhost:3000` in 2 to 4 browser tabs.

The server also serves `apps/web/public` for local development. For Netlify, publish `apps/web/public` and set `window.MATH_BOMBER_WS_URL` in `apps/web/public/config.js` to the deployed WebSocket server URL, for example `wss://your-server.onrender.com`.

## Controls

- Move: `WASD`, arrow keys, or mobile D-pad.
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
10. Netlify frontend plus hosted WebSocket backend deployment.
