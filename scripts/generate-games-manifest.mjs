import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const gamesDir = path.join(rootDir, "games");
const dataDir = path.join(rootDir, "data");
const outputFile = path.join(dataDir, "games.json");
const externalConfigFile = path.join(dataDir, "external-games.json");

const LOCAL_META_FILENAMES = new Set(["game.json"]);

await fs.mkdir(dataDir, { recursive: true });

const [localGames, externalGames] = await Promise.all([
  loadLocalGames(),
  loadExternalGames(),
]);

const games = dedupeSlugs([...localGames, ...externalGames]).sort(compareGames);

await fs.writeFile(
  outputFile,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      games,
    },
    null,
    2
  ) + "\n",
  "utf8"
);

console.log(`Generated ${games.length} game entries in ${path.relative(rootDir, outputFile)}.`);

async function loadLocalGames() {
  const files = await collectHtmlFiles(gamesDir);
  const games = [];

  for (const file of files) {
    const relativeFile = normalizePath(path.relative(rootDir, file));
    const parsed = path.parse(file);
    const isFolderIndex = parsed.base.toLowerCase() === "index.html";
    const baseName = isFolderIndex ? path.basename(parsed.dir) : parsed.name;
    const slug = slugify(baseName);
    const sidecar = isFolderIndex
      ? path.join(parsed.dir, "game.json")
      : path.join(parsed.dir, `${parsed.name}.game.json`);
    const metadata = await readJson(sidecar);
    const title = metadata?.title || titleize(baseName);
    const description =
      metadata?.description ||
      "Launch this game in the built-in arcade player and expand to fullscreen.";
    const tags = normalizeTags(metadata?.tags);
    const thumbnail =
      resolveLocalThumbnail(metadata?.thumbnail, parsed.dir) ||
      (await detectLocalThumbnail(file, parsed, isFolderIndex));

    games.push({
      slug,
      title,
      description,
      tags,
      thumbnail,
      accent: metadata?.accent || null,
      featured: Boolean(metadata?.featured),
      order: Number.isFinite(metadata?.order) ? metadata.order : 999,
      sourceType: "local",
      directUrl: relativeFile,
      embed: metadata?.embed !== false,
    });
  }

  return games;
}

async function loadExternalGames() {
  const config = (await readJson(externalConfigFile)) || [];
  if (!Array.isArray(config)) {
    throw new Error("data/external-games.json must contain an array.");
  }

  return config
    .filter((entry) => entry && entry.title && entry.url)
    .map((entry) => ({
      slug: entry.slug ? slugify(entry.slug) : slugify(entry.title),
      title: entry.title.trim(),
      description:
        entry.description ||
        "External game link routed through the shared arcade player.",
      tags: normalizeTags(entry.tags),
      thumbnail: entry.thumbnail || null,
      accent: entry.accent || null,
      featured: Boolean(entry.featured),
      order: Number.isFinite(entry.order) ? entry.order : 999,
      sourceType: "external",
      directUrl: entry.url,
      embed: entry.embed !== false,
    }));
}

async function collectHtmlFiles(startDir) {
  const results = [];
  await walk(startDir, results);
  return results;
}

async function walk(currentDir, results) {
  let entries = [];

  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      await walk(fullPath, results);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const lower = entry.name.toLowerCase();
    if (LOCAL_META_FILENAMES.has(lower) || lower.endsWith(".game.json")) {
      continue;
    }

    if (lower.endsWith(".html")) {
      results.push(fullPath);
    }
  }
}

async function readJson(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveLocalThumbnail(thumbnail, fileDir) {
  if (!thumbnail) {
    return null;
  }

  if (/^(https?:)?\/\//.test(thumbnail)) {
    return thumbnail;
  }

  const resolved = path.resolve(fileDir, thumbnail);
  return normalizePath(path.relative(rootDir, resolved));
}

async function detectLocalThumbnail(filePath, parsed, isFolderIndex) {
  const candidates = isFolderIndex
    ? [
        "cover.png",
        "cover.jpg",
        "cover.jpeg",
        "thumbnail.png",
        "thumbnail.jpg",
        "icon.png",
        "icon.jpg",
        "splash.png",
        "screenshot.png",
      ]
    : [
        `${parsed.name}.png`,
        `${parsed.name}.jpg`,
        `${parsed.name}.jpeg`,
        `${parsed.name}.webp`,
      ];

  const searchDir = isFolderIndex ? parsed.dir : path.dirname(filePath);

  for (const candidate of candidates) {
    const candidatePath = path.join(searchDir, candidate);
    if (await fileExists(candidatePath)) {
      return normalizePath(path.relative(rootDir, candidatePath));
    }
  }

  return null;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 6);
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function titleize(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function dedupeSlugs(games) {
  const seen = new Map();

  return games.map((game) => {
    const count = seen.get(game.slug) || 0;
    seen.set(game.slug, count + 1);

    if (count === 0) {
      return game;
    }

    return {
      ...game,
      slug: `${game.slug}-${count + 1}`,
    };
  });
}

function compareGames(left, right) {
  if (left.order !== right.order) {
    return left.order - right.order;
  }

  if (left.featured !== right.featured) {
    return left.featured ? -1 : 1;
  }

  return left.title.localeCompare(right.title);
}
