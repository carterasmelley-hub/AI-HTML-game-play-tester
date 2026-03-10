import {
  createUploadedGameUrl,
  getUploadedGames,
} from "./browser-library.js";

const manifestUrl = new URL("../data/games.json", import.meta.url);

const elements = {
  aiOutput: document.querySelector("#ai-output"),
  aiPrompt: document.querySelector("#ai-focus-prompt"),
  aiRunButton: document.querySelector("#ai-run-button"),
  aiStatus: document.querySelector("#ai-status"),
  description: document.querySelector("#player-description"),
  directLink: document.querySelector("#direct-link"),
  frame: document.querySelector("#game-frame"),
  frameShell: document.querySelector("#player-frame-shell"),
  fullscreenButton: document.querySelector("#fullscreen-button"),
  iconTemplate: document.querySelector("#icon-tile-template"),
  logoutButton: document.querySelector("#logout-button"),
  message: document.querySelector("#player-message"),
  meta: document.querySelector("#player-meta"),
  note: document.querySelector("#player-note"),
  relatedRail: document.querySelector("#related-rail"),
  title: document.querySelector("#player-title"),
};

let currentGame = null;
let uploadedGameCleanup = null;

bootstrap().catch((error) => {
  showMessage(
    "This game could not be loaded. Check the manifest and make sure the URL or HTML file still exists."
  );
  console.error(error);
});

async function bootstrap() {
  const slug = new URLSearchParams(window.location.search).get("game");
  if (!slug) {
    showMessage("No game was selected. Go back to the arcade and choose one.");
    return;
  }

  const [manifestGames, uploadedGames] = await Promise.all([
    loadManifestGames(),
    getUploadedGames(),
  ]);
  const allGames = [...uploadedGames, ...manifestGames];
  currentGame = allGames.find((entry) => entry.slug === slug);

  if (!currentGame) {
    showMessage("That game slug is missing from the catalog.");
    return;
  }

  document.title = `${currentGame.title} | Arcade Grid`;
  elements.title.textContent = currentGame.title;
  elements.description.textContent =
    currentGame.description || "No description was added for this game yet.";
  renderMeta(currentGame);
  updateAssetNote(currentGame);
  renderRail(allGames, currentGame.slug);

  elements.fullscreenButton?.addEventListener("click", enterFullscreen);
  elements.aiRunButton?.addEventListener("click", runAiReview);
  elements.logoutButton?.addEventListener("click", logout);
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  window.addEventListener("beforeunload", cleanupUploadedGame);
  elements.frame?.addEventListener("load", handleFrameLoad, { once: true });

  if (currentGame.embed === false) {
    elements.directLink.href = getPlayableUrl(currentGame);
    showMessage(
      "This game is set to open directly instead of inside the player. Use the direct button above."
    );
    return;
  }

  if (currentGame.sourceType === "upload") {
    const uploadHandle = await createUploadedGameUrl(currentGame);
    uploadedGameCleanup = uploadHandle.cleanup;
    elements.directLink.href = uploadHandle.url;
    elements.directLink.textContent = "Open uploaded game";
    elements.frame.src = uploadHandle.url;
  } else {
    const playableUrl = getPlayableUrl(currentGame);
    elements.directLink.href = playableUrl;
    elements.directLink.textContent =
      currentGame.sourceType === "external" ? "Open external page" : "Open raw game";
    elements.frame.src = playableUrl;
  }

  elements.frame.hidden = false;
}

function renderMeta(game) {
  const items = [getSourceLabel(game), ...(game.tags || [])];
  if (game.filename) {
    items.push(game.filename);
  }
  if (game.requiresFolderMode) {
    items.push("Missing assets");
  }

  elements.meta.replaceChildren(
    ...items.map((label) => {
      const span = document.createElement("span");
      span.className = "tag-chip";
      span.textContent = label;
      return span;
    })
  );
}

function renderRail(games, currentSlug) {
  if (!elements.relatedRail || !elements.iconTemplate) {
    return;
  }

  const orderedGames = [...games].sort((left, right) => {
    if (left.slug === currentSlug) {
      return -1;
    }
    if (right.slug === currentSlug) {
      return 1;
    }
    return 0;
  });

  if (!orderedGames.length) {
    const empty = document.createElement("article");
    empty.className = "empty-state";
    empty.innerHTML = "<h3>No other games yet</h3><p>Add more games and this shelf will fill in.</p>";
    elements.relatedRail.replaceChildren(empty);
    return;
  }

  elements.relatedRail.replaceChildren(
    ...orderedGames.map((game) => buildIconTile(game, currentSlug))
  );
}

function buildIconTile(game, currentSlug) {
  const fragment = elements.iconTemplate.content.cloneNode(true);
  const link = fragment.querySelector(".icon-tile");
  const thumb = fragment.querySelector(".icon-thumb");
  const badge = fragment.querySelector(".art-badge");
  const title = fragment.querySelector(".icon-title");
  const source = fragment.querySelector(".icon-source");

  link.href = `./play.html?game=${encodeURIComponent(game.slug)}`;
  link.setAttribute("aria-label", `Open ${game.title}`);

  if (game.slug === currentSlug) {
    link.classList.add("is-active");
    link.setAttribute("aria-current", "page");
  }

  title.textContent = game.title;
  source.textContent = getSourceLabel(game);
  badge.textContent = getInitials(game.title);

  if (game.thumbnail) {
    thumb.classList.add("has-thumb");
    thumb.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.02), rgba(0,0,0,0.02)), url("${game.thumbnail}")`;
  } else if (game.accent) {
    thumb.style.background = `radial-gradient(circle at 18% 18%, rgba(255,255,255,0.24), transparent 24%), linear-gradient(135deg, ${game.accent}, var(--accent-strong))`;
  }

  return fragment;
}

async function runAiReview() {
  if (!currentGame) {
    return;
  }

  if (currentGame.sourceType === "upload") {
    if (elements.aiOutput) {
      elements.aiOutput.textContent =
        "Autonomous AI play currently works for repo-backed or hosted URL games. Browser-only uploaded packages still support human play here, but the server-side browser agent cannot open your private IndexedDB package yet.";
    }
    setAiBusy(
      false,
      "Autoplay is not yet supported for browser-only uploads. Move the game into /games for full AI control."
    );
    return;
  }

  setAiBusy(true, "Collecting runtime state and source files...");

  try {
    const [runtime, files] = await Promise.all([
      captureRuntimeSnapshot(),
      collectGameFiles(currentGame),
    ]);

    setAiBusy(true, "Launching the AI player in a real browser session...");

    const response = await fetch("/api/ai-autoplay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files,
        focusPrompt: elements.aiPrompt?.value?.trim() || "",
        game: {
          ...summarizeGame(currentGame),
          playableUrl: getPlayableUrl(currentGame),
        },
        runtime,
        maxSteps: 8,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.details || data.error || "AI review failed.");
    }

    if (elements.aiOutput) {
      elements.aiOutput.textContent = data.report || "No AI report returned.";
    }
    setAiBusy(false, "AI play session complete.");
  } catch (error) {
    console.error(error);
    if (elements.aiOutput) {
      elements.aiOutput.textContent = String(error.message || error);
    }
    setAiBusy(false, "AI player failed. Make sure you are running `npm run dev`, Playwright is installed, and your OpenAI key is in the server environment.");
  }
}

async function captureRuntimeSnapshot() {
  if (!elements.frame) {
    return {
      note: "No game iframe was available.",
    };
  }

  try {
    const frameWindow = elements.frame.contentWindow;
    const frameDocument = frameWindow?.document;
    if (!frameDocument) {
      return {
        note: "The iframe document is not ready yet.",
      };
    }

    const textSample = frameDocument.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 4000) || "";
    const htmlSample = frameDocument.body?.outerHTML?.slice(0, 12000) || "";

    return {
      audioCount: frameDocument.querySelectorAll("audio").length,
      buttonLabels: Array.from(frameDocument.querySelectorAll("button"))
        .map((button) => button.textContent?.trim())
        .filter(Boolean)
        .slice(0, 20),
      canvasCount: frameDocument.querySelectorAll("canvas").length,
      currentUrl: frameWindow?.location?.href || "",
      htmlSample,
      textSample,
      title: frameDocument.title || "",
    };
  } catch (error) {
    return {
      note: `Runtime snapshot was unavailable (${error.message}). This usually means the game is cross-origin or not fully loaded yet.`,
    };
  }
}

async function collectGameFiles(game) {
  if (game.sourceType === "upload") {
    return Promise.all(
      (game.files || []).map(async (file) => ({
        path: file.path,
        size: file.file?.size || 0,
        textContent: isTextFile(file.name || file.path) ? await file.file.text() : null,
        type: file.type || "",
      }))
    );
  }

  if (game.sourceType === "external") {
    return [
      {
        note: "External games are not file-scanned by the local AI playtester.",
        path: game.directUrl,
      },
    ];
  }

  return collectLocalGameFiles(game);
}

async function collectLocalGameFiles(game) {
  const entryUrl = new URL(getPlayableUrl(game));
  const html = await fetchText(entryUrl);
  const files = [
    {
      path: game.directUrl,
      size: html.length,
      textContent: html,
      type: "text/html",
    },
  ];

  const documentNode = new DOMParser().parseFromString(html, "text/html");
  const codeRefs = new Set();

  for (const script of Array.from(documentNode.querySelectorAll("script[src]"))) {
    codeRefs.add(script.getAttribute("src"));
  }
  for (const link of Array.from(documentNode.querySelectorAll('link[href]'))) {
    codeRefs.add(link.getAttribute("href"));
  }
  for (const asset of Array.from(documentNode.querySelectorAll("audio[src],img[src],source[src],video[src]"))) {
    const ref = asset.getAttribute("src");
    if (ref) {
      files.push({
        path: ref,
        size: 0,
        textContent: null,
        type: "asset",
      });
    }
  }

  for (const ref of codeRefs) {
    if (!ref || !isRelativeOrSameOrigin(ref)) {
      continue;
    }

    const fileUrl = new URL(ref, entryUrl);
    if (fileUrl.origin !== window.location.origin) {
      continue;
    }

    try {
      const text = await fetchText(fileUrl);
      files.push({
        path: fileUrl.pathname,
        size: text.length,
        textContent: text,
        type: guessTypeFromPath(fileUrl.pathname),
      });
    } catch (error) {
      files.push({
        note: `Could not fetch ${fileUrl.pathname}: ${error.message}`,
        path: fileUrl.pathname,
      });
    }
  }

  return files;
}

function summarizeGame(game) {
  return {
    description: game.description || "",
    directUrl: game.directUrl || "",
    missingAssets: game.missingAssets || [],
    slug: game.slug,
    sourceType: game.sourceType,
    tags: game.tags || [],
    title: game.title,
  };
}

function getPlayableUrl(game) {
  const directUrl = String(game?.directUrl || "");
  if (!directUrl) {
    return "";
  }

  if (/^https?:\/\//i.test(directUrl)) {
    return directUrl;
  }

  return new URL(encodeRelativeUrlPath(directUrl), window.location.href).toString();
}

function encodeRelativeUrlPath(value) {
  const [pathPart, suffix = ""] = value.split(/([?#].*)/, 2);
  const encodedPath = pathPart
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponentSafe(segment)))
    .join("/");

  return `${encodedPath}${suffix}`;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function setAiBusy(isBusy, message) {
  if (elements.aiRunButton) {
    elements.aiRunButton.disabled = isBusy;
    elements.aiRunButton.textContent = isBusy ? "Running..." : "Run AI Player";
  }
  if (elements.aiStatus) {
    elements.aiStatus.textContent = message;
  }
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed with ${response.status}`);
  }
  return response.text();
}

function isRelativeOrSameOrigin(value) {
  return (
    !value.startsWith("http://") &&
    !value.startsWith("https://") &&
    !value.startsWith("//") &&
    !value.startsWith("data:") &&
    !value.startsWith("blob:")
  );
}

function isTextFile(path) {
  return [".css", ".html", ".js", ".json", ".md", ".txt"].includes(extname(path));
}

function guessTypeFromPath(path) {
  const ext = extname(path);
  return (
    {
      ".css": "text/css",
      ".html": "text/html",
      ".js": "text/javascript",
      ".json": "application/json",
    }[ext] || "asset"
  );
}

function extname(value) {
  const lastDot = value.toLowerCase().lastIndexOf(".");
  return lastDot === -1 ? "" : value.toLowerCase().slice(lastDot);
}

async function enterFullscreen() {
  if (!elements.frameShell) {
    return;
  }

  if (!document.fullscreenElement) {
    await elements.frameShell.requestFullscreen();
    return;
  }

  await document.exitFullscreen();
}

function handleFullscreenChange() {
  const isFullscreen = document.fullscreenElement === elements.frameShell;
  elements.frameShell?.classList.toggle("is-fullscreen", isFullscreen);
  if (elements.fullscreenButton) {
    elements.fullscreenButton.textContent = isFullscreen
      ? "Exit fullscreen"
      : "Fullscreen";
  }
}

function handleFrameLoad() {
  if (elements.note && !currentGame?.requiresFolderMode) {
    elements.note.textContent =
      "Game loaded. Click inside once for keyboard input, then use fullscreen if you want the stage to fill the screen.";
  }
}

function updateAssetNote(game) {
  if (!elements.note) {
    return;
  }

  if (game.requiresFolderMode) {
    const sampleAssets = (game.missingAssets || game.linkedAssets || []).slice(0, 3).join(", ");
    elements.note.textContent = sampleAssets
      ? `This uploaded package is still missing files (${sampleAssets}). Drop the whole folder, or include index.html plus every referenced asset file.`
      : "This uploaded package is still missing some referenced asset files.";
    return;
  }

  elements.note.textContent =
    "Game loaded. Click inside once for keyboard input, then use fullscreen if you want the stage to fill the screen.";
}

function showMessage(message) {
  if (elements.frame) {
    elements.frame.hidden = true;
    elements.frame.removeAttribute("src");
  }

  if (elements.message) {
    elements.message.hidden = false;
    elements.message.textContent = message;
  }

  if (elements.description) {
    elements.description.textContent = message;
  }

  if (elements.note) {
    elements.note.textContent = message;
  }
}

async function loadManifestGames() {
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) {
      throw new Error(`Manifest request failed with ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data.games) ? data.games : [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

function getSourceLabel(game) {
  if (game.sourceType === "external") {
    return "External";
  }
  if (game.sourceType === "upload") {
    return "Browser";
  }
  return "Local";
}

function getInitials(value) {
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function cleanupUploadedGame() {
  if (uploadedGameCleanup) {
    uploadedGameCleanup();
    uploadedGameCleanup = null;
  }
}

async function logout() {
  await fetch("/api/logout", {
    method: "POST",
  });
  window.location.href = "/login";
}
