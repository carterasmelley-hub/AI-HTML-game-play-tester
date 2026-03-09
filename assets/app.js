import {
  buildUploadDrafts,
  clearUploadedGames,
  deleteUploadedGame,
  getUploadedGames,
  saveUploadDrafts,
  updateUploadedGameMetadata,
} from "./browser-library.js";

const manifestUrl = new URL("../data/games.json", import.meta.url);

const state = {
  activeTag: "All",
  isEditMode: false,
  manifestGames: [],
  search: "",
  uploadedGames: [],
};

const elements = {
  browseButton: document.querySelector("#browse-button"),
  browseFolderButton: document.querySelector("#browse-folder-button"),
  clearUploadsButton: document.querySelector("#clear-uploads-button"),
  count: document.querySelector("#game-count"),
  dropzone: document.querySelector("#upload-dropzone"),
  editLibraryButton: document.querySelector("#edit-library-button"),
  filters: document.querySelector("#tag-filters"),
  grid: document.querySelector("#game-grid"),
  iconTemplate: document.querySelector("#icon-tile-template"),
  logoutButton: document.querySelector("#logout-button"),
  quickLaunchRail: document.querySelector("#quick-launch-rail"),
  resultsCopy: document.querySelector("#results-copy"),
  search: document.querySelector("#search-input"),
  template: document.querySelector("#game-card-template"),
  uploadFolderInput: document.querySelector("#upload-folder-input"),
  uploadInput: document.querySelector("#upload-input"),
  uploadStatus: document.querySelector("#upload-status"),
};

bootstrap().catch((error) => {
  renderEmpty(
    "The catalog could not be loaded.",
    "Run the manifest generator from the README, then refresh the page."
  );
  console.error(error);
});

async function bootstrap() {
  state.manifestGames = await loadManifestGames();
  state.uploadedGames = await getUploadedGames();

  elements.search?.addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    render();
  });

  elements.logoutButton?.addEventListener("click", logout);
  elements.editLibraryButton?.addEventListener("click", toggleEditMode);

  setupUploads();
  renderFilters();
  render();
}

function renderFilters() {
  if (!elements.filters) {
    return;
  }

  const tags = new Set(["All"]);
  for (const game of getAllGames()) {
    for (const tag of game.tags || []) {
      tags.add(tag);
    }
    if (game.missingAssets?.length) {
      tags.add("Missing Assets");
    }
  }

  if (!tags.has(state.activeTag)) {
    state.activeTag = "All";
  }

  elements.filters.replaceChildren(
    ...Array.from(tags).map((tag) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = tag;
      button.classList.toggle("active", tag === state.activeTag);
      button.addEventListener("click", () => {
        state.activeTag = tag;
        renderFilters();
        render();
      });
      return button;
    })
  );
}

function render() {
  const allGames = getAllGames();
  const filteredGames = allGames.filter((game) => {
    const tags = game.missingAssets?.length
      ? [...(game.tags || []), "Missing Assets"]
      : game.tags || [];
    const matchesTag = state.activeTag === "All" || tags.includes(state.activeTag);
    const haystack = [game.title, game.description, game.sourceType, ...tags]
      .join(" ")
      .toLowerCase();
    const matchesSearch = !state.search || haystack.includes(state.search);
    return matchesTag && matchesSearch;
  });

  document.body.classList.toggle("edit-mode", state.isEditMode);

  if (elements.count) {
    elements.count.textContent = `${allGames.length} ${
      allGames.length === 1 ? "game" : "games"
    }`;
  }

  if (elements.editLibraryButton) {
    elements.editLibraryButton.textContent = state.isEditMode
      ? "Done Editing"
      : "Edit Library";
  }

  updateUploadSummary();
  renderQuickLaunch(allGames);

  if (elements.resultsCopy) {
    elements.resultsCopy.textContent = filteredGames.length
      ? `${filteredGames.length} ${
          filteredGames.length === 1 ? "game" : "games"
        } ready to launch`
      : "No matches yet. Try a different search or tag.";
  }

  if (!filteredGames.length) {
    renderEmpty(
      allGames.length
        ? "No games match the current filters."
        : "Your arcade is empty right now.",
      allGames.length
        ? "Clear the search or switch back to the All tag."
        : "Drop a full game folder, or an index.html plus its asset files, into the upload area."
    );
    return;
  }

  elements.grid?.replaceChildren(...filteredGames.map((game) => buildCard(game)));
}

function buildCard(game) {
  const fragment = elements.template.content.cloneNode(true);
  const shell = fragment.querySelector(".game-card");
  const link = fragment.querySelector(".game-link");
  const art = fragment.querySelector(".game-art");
  const badge = fragment.querySelector(".art-badge");
  const title = fragment.querySelector(".game-title");
  const description = fragment.querySelector(".game-description");
  const sourcePill = fragment.querySelector(".source-pill");
  const tagList = fragment.querySelector(".tag-list");
  const deleteButton = fragment.querySelector(".delete-button");

  configureGameVisuals({
    art,
    badge,
    description,
    game,
    sourcePill,
    tagList,
    title,
  });

  link.href = `./play.html?game=${encodeURIComponent(game.slug)}`;
  link.setAttribute("aria-label", `Open ${game.title}`);

  if (game.sourceType === "upload") {
    shell.classList.add("is-editable");
    wireEditableGame(shell, link, deleteButton, game);
  } else {
    deleteButton?.remove();
  }

  return fragment;
}

function buildIconTile(game) {
  const fragment = elements.iconTemplate.content.cloneNode(true);
  const shell = fragment.querySelector(".icon-tile-shell");
  const link = fragment.querySelector(".icon-tile");
  const thumb = fragment.querySelector(".icon-thumb");
  const badge = fragment.querySelector(".art-badge");
  const title = fragment.querySelector(".icon-title");
  const source = fragment.querySelector(".icon-source");
  const deleteButton = fragment.querySelector(".delete-button");

  title.textContent = game.title;
  source.textContent = getSourceLabel(game);
  badge.textContent = getInitials(game.title);

  if (game.thumbnail) {
    thumb.classList.add("has-thumb");
    thumb.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.02), rgba(0,0,0,0.02)), url("${game.thumbnail}")`;
  } else if (game.accent) {
    thumb.style.background = `radial-gradient(circle at 18% 18%, rgba(255,255,255,0.24), transparent 24%), linear-gradient(135deg, ${game.accent}, var(--accent-strong))`;
  }

  link.href = `./play.html?game=${encodeURIComponent(game.slug)}`;
  link.setAttribute("aria-label", `Open ${game.title}`);

  if (game.sourceType === "upload") {
    shell.classList.add("is-editable");
    wireEditableGame(shell, link, deleteButton, game);
  } else {
    deleteButton?.remove();
  }

  return fragment;
}

function configureGameVisuals({
  art,
  badge,
  description,
  game,
  sourcePill,
  tagList,
  title,
}) {
  title.textContent = game.title;
  description.textContent = game.description || "No description yet.";
  sourcePill.textContent = getSourceLabel(game);
  badge.textContent = getInitials(game.title);

  if (game.thumbnail) {
    art.classList.add("has-thumb");
    art.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.02), rgba(0,0,0,0.02)), url("${game.thumbnail}")`;
  } else if (game.accent) {
    art.style.background = `radial-gradient(circle at 18% 18%, rgba(255,255,255,0.24), transparent 24%), linear-gradient(135deg, ${game.accent}, var(--accent-strong))`;
  }

  const tags = [...(game.tags || [])];
  if (game.missingAssets?.length) {
    tags.push("Missing Assets");
  }

  for (const tag of tags.slice(0, 5)) {
    const pill = document.createElement("span");
    pill.className = "tag-chip";
    pill.textContent = tag;
    tagList.appendChild(pill);
  }
}

function renderQuickLaunch(games) {
  if (!elements.quickLaunchRail || !elements.iconTemplate) {
    return;
  }

  if (!games.length) {
    const empty = document.createElement("article");
    empty.className = "empty-state";
    empty.innerHTML =
      "<h3>No icons yet</h3><p>Add a game and the quick-launch shelf will populate automatically.</p>";
    elements.quickLaunchRail.replaceChildren(empty);
    return;
  }

  elements.quickLaunchRail.replaceChildren(...games.map((game) => buildIconTile(game)));
}

function renderEmpty(title, body) {
  if (!elements.grid) {
    return;
  }

  const wrapper = document.createElement("article");
  wrapper.className = "empty-state";
  wrapper.innerHTML = `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p>`;
  elements.grid.replaceChildren(wrapper);
}

function setupUploads() {
  elements.browseButton?.addEventListener("click", () => elements.uploadInput?.click());
  elements.browseFolderButton?.addEventListener("click", () =>
    elements.uploadFolderInput?.click()
  );
  elements.uploadInput?.addEventListener("change", async (event) => {
    await handleEntries(collectEntriesFromFiles(event.target.files));
    event.target.value = "";
  });
  elements.uploadFolderInput?.addEventListener("change", async (event) => {
    await handleEntries(collectEntriesFromFiles(event.target.files));
    event.target.value = "";
  });
  elements.clearUploadsButton?.addEventListener("click", async () => {
    await clearUploadedGames();
    await refreshUploadedGames();
    setUploadStatus("Cleared browser-uploaded games.");
  });

  if (!elements.dropzone) {
    return;
  }

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropzone.classList.add("is-dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropzone.classList.remove("is-dragover");
    });
  });

  elements.dropzone.addEventListener("drop", async (event) => {
    const entries = await collectDroppedEntries(event.dataTransfer);
    await handleEntries(entries);
  });

  elements.dropzone.addEventListener("click", (event) => {
    if (event.target.closest("button")) {
      return;
    }
    elements.uploadInput?.click();
  });

  elements.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.uploadInput?.click();
    }
  });
}

async function handleEntries(entries) {
  if (!entries?.length) {
    return;
  }

  try {
    const { drafts, rejected } = await buildUploadDrafts(entries);
    if (!drafts.length) {
      setUploadStatus("No HTML entry file was found. Include an index.html or another HTML entry file.");
      return;
    }

    const namedDrafts = drafts.map((draft) => ({
      ...draft,
      title: requestGameTitle(draft),
    }));
    const result = await saveUploadDrafts(namedDrafts);
    await refreshUploadedGames();

    const missingAssets = namedDrafts
      .filter((draft) => draft.missingAssets.length)
      .map((draft) => `${draft.title}: ${draft.missingAssets.slice(0, 3).join(", ")}`);

    const parts = [];
    if (result.added) {
      parts.push(`added ${result.added}`);
    }
    if (result.updated) {
      parts.push(`updated ${result.updated}`);
    }
    if (rejected) {
      parts.push(`skipped ${rejected} unsupported file${rejected === 1 ? "" : "s"}`);
    }
    if (missingAssets.length) {
      parts.push(`missing assets in ${missingAssets.length} package${missingAssets.length === 1 ? "" : "s"}`);
    }

    setUploadStatus(
      parts.length
        ? `Browser import complete: ${parts.join(", ")}.`
        : "Browser import complete."
    );
  } catch (error) {
    console.error(error);
    setUploadStatus("Import failed. Refresh the page and try again.");
  }
}

function requestGameTitle(draft) {
  const assetNote = draft.missingAssets.length
    ? `\n\nMissing asset files: ${draft.missingAssets.slice(0, 3).join(", ")}`
    : "";
  const answer = window.prompt(
    `Name this game for the arcade.\n\nEntry file: ${draft.filename}${assetNote}`,
    draft.suggestedTitle
  );
  return answer?.trim() || draft.suggestedTitle;
}

function wireEditableGame(shell, link, deleteButton, game) {
  deleteButton?.addEventListener("click", async (event) => {
    if (!state.isEditMode) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    await deleteUploadedGame(game.id);
    await refreshUploadedGames();
    setUploadStatus(`Deleted ${game.title}.`);
  });

  link.addEventListener("click", async (event) => {
    if (!state.isEditMode) {
      return;
    }

    event.preventDefault();
    await editUploadedGame(game);
  });
}

async function editUploadedGame(game) {
  const titleAnswer = window.prompt(
    `Edit the game title.\n\nCurrent title: ${game.title}\nLeave blank to keep it.`,
    game.title
  );
  const nextTitle = titleAnswer?.trim() || game.title;

  let nextThumbnail;
  const wantsCover = window.confirm(
    "Choose OK to pick a custom cover image now. Choose Cancel to keep the current cover."
  );

  if (wantsCover) {
    const imageFile = await pickImageFile();
    if (imageFile) {
      nextThumbnail = await fileToDataUrl(imageFile);
    }
  }

  await updateUploadedGameMetadata(game.id, {
    thumbnail: nextThumbnail,
    title: nextTitle,
  });
  await refreshUploadedGames();
  setUploadStatus(`Updated ${nextTitle}.`);
}

function toggleEditMode() {
  state.isEditMode = !state.isEditMode;
  render();
}

async function refreshUploadedGames() {
  state.uploadedGames = await getUploadedGames();
  renderFilters();
  render();
}

function updateUploadSummary() {
  if (!elements.uploadStatus) {
    return;
  }

  if (!state.uploadedGames.length) {
    elements.uploadStatus.textContent = "No browser-uploaded games yet.";
    return;
  }

  elements.uploadStatus.textContent = `${state.uploadedGames.length} browser game${
    state.uploadedGames.length === 1 ? "" : "s"
  } saved on this device. Upload a folder or index.html plus its assets for audio/images/scripts.`;
}

function setUploadStatus(message) {
  if (elements.uploadStatus) {
    elements.uploadStatus.textContent = message;
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

function getAllGames() {
  return [...state.uploadedGames, ...state.manifestGames];
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

function collectEntriesFromFiles(files) {
  return Array.from(files || []).map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
}

async function collectDroppedEntries(dataTransfer) {
  if (!dataTransfer?.items?.length) {
    return collectEntriesFromFiles(dataTransfer?.files);
  }

  const entries = [];
  for (const item of Array.from(dataTransfer.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (!entry) {
      const file = item.getAsFile?.();
      if (file) {
        entries.push({
          file,
          path: file.name,
        });
      }
      continue;
    }

    entries.push(...(await readEntry(entry)));
  }

  return entries;
}

async function readEntry(entry) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });
    return [
      {
        file,
        path: entry.fullPath.replace(/^\//, ""),
      },
    ];
  }

  if (entry.isDirectory) {
    const reader = entry.createReader();
    const children = await readAllEntries(reader);
    const nested = await Promise.all(children.map((child) => readEntry(child)));
    return nested.flat();
  }

  return [];
}

async function readAllEntries(reader) {
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) {
      return entries;
    }
    entries.push(...batch);
  }
}

function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => resolve(input.files?.[0] || null), { once: true });
    input.click();
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function logout() {
  await fetch("/api/logout", {
    method: "POST",
  });
  window.location.href = "/login";
}
