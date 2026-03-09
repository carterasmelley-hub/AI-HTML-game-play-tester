# Arcade Grid

Static arcade site for GitHub Pages. The homepage works like a simple Coolmath-style launcher, and every game card opens a separate player tab with a fullscreen button.

It also includes a browser-side drag-and-drop area so you can test self-contained HTML files without committing them first.

## Best setup

Use **one GitHub Pages repo for the arcade**, then choose one of these ways to add games:

1. **Recommended:** put each game inside this repo under `games/`
2. Optional: list already-hosted GitHub Pages games in `data/external-games.json`

Local games are the better default because:

- the fullscreen player is more reliable
- all branding stays in one place
- asset paths are easier to manage
- you only deploy one site

External links still work, but some third-party pages may refuse to load inside an iframe. If that happens, set `"embed": false` on that game so the player page shows a direct-open button instead.

## Folder structure

```text
.
├── assets/
├── data/
├── games/
├── index.html
├── play.html
└── scripts/
```

## Add local games

Supported patterns:

- `games/my-game.html`
- `games/my-game/index.html`

Optional metadata:

- `games/my-game.game.json`
- `games/my-game/game.json`

Example metadata:

```json
{
  "title": "Neon Knockout",
  "description": "Fast dodge game with glowing hazards.",
  "tags": ["Arcade", "Skill"],
  "thumbnail": "cover.png",
  "featured": true,
  "order": 1,
  "embed": true
}
```

## Drag and drop directly in the browser

The homepage has a real upload zone. You can drag `.html` files onto it and they will:

- be saved in your browser on that device
- show up in the catalog immediately
- open in the same player page and fullscreen flow

This is meant for quick testing. It does **not** push files into GitHub or write them into the repo.

Use repo-backed files in `games/` if:

- the game needs neighboring assets like images, audio, or scripts
- you want the game published for everyone on GitHub Pages
- you want the game preserved in source control

## Add external GitHub Pages games

Edit [data/external-games.json](/Users/cartersmelley/Documents/web workflow/api project/web info finder/test website/data/external-games.json) and add objects like this:

```json
[
  {
    "title": "Rooftop Dash",
    "url": "https://your-name.github.io/rooftop-dash/",
    "description": "Fast reaction platformer.",
    "tags": ["Platformer", "Skill"],
    "featured": true,
    "embed": true
  }
]
```

If an external game does not load in the player, change `"embed"` to `false`.

## Regenerate the catalog locally

```bash
npm run generate
```

That updates [data/games.json](/Users/cartersmelley/Documents/web workflow/api project/web info finder/test website/data/games.json).

## Run the local AI-enabled server

The AI playtester requires the local Node server because your OpenAI API key must stay on the server side. It also uses Playwright to launch a real browser and interact with repo-backed or hosted games.

```bash
OPENAI_API_KEY=your_key_here npm run dev
```

Then open:

```text
http://127.0.0.1:4173
```

If you already export `OPENAI_API_KEY` in your shell, just run:

```bash
npm run dev
```

Open a game page and use the `AI Playtester` panel to run an autonomous browser play session plus a bug report.

## Private Render deployment

This app can be deployed as a private password-gated Render web service. The password gate protects the site and the API routes. Your OpenAI key stays server-side in Render environment variables.

### Required environment variables

- `APP_PASSWORD`
- `SESSION_SECRET`
- `OPENAI_API_KEY`
- optional: `OPENAI_MODEL`
- optional: `PLAYWRIGHT_HEADLESS=true`

### Render settings

- Service type: `Web Service`
- Runtime: `Node`
- Build Command:

```bash
npm install && npm run build && npm run setup:playwright
```

- Start Command:

```bash
npm run start
```

### What the password gate does

- blocks every page until you log in
- blocks every API route until you log in
- keeps the OpenAI key on the server only
- uses an HttpOnly signed session cookie

### Production note

The autonomous AI player currently works best for repo-backed games under `games/` or other hosted URLs that the Render server can open directly in Playwright.

## Publish on GitHub Pages

1. Create a GitHub repo and upload this folder.
2. In GitHub, open **Settings > Pages**.
3. Set **Source** to **GitHub Actions**.
4. Push to `main` or `master`.
5. GitHub will run `.github/workflows/deploy.yml`, build the manifest, and deploy the site.

If your default branch is not `main` or `master`, update [deploy.yml](/Users/cartersmelley/Documents/web workflow/api project/web info finder/test website/.github/workflows/deploy.yml).

## Fast workflow

1. Drop a game into `games/`
2. Add a metadata file only if you want nicer titles, thumbnails, tags, or descriptions
3. Run `npm run generate`
4. Commit and push

## Notes

- GitHub Pages is static, so the homepage cannot auto-scan folders in the browser. That is why the generator writes `data/games.json`.
- The included GitHub Action runs that generator automatically when you push.
