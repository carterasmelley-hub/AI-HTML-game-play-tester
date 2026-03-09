const DB_NAME = "arcade-grid-browser-library";
const STORE_NAME = "uploaded-games";
const DB_VERSION = 1;

let dbPromise;

export async function getUploadedGames() {
  const db = await openDatabase();
  const records = await withRequest(
    db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll()
  );

  return records
    .map(mapRecordToGame)
    .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
}

export async function getUploadedGameBySlug(slug) {
  const games = await getUploadedGames();
  return games.find((game) => game.slug === slug) || null;
}

export async function buildUploadDrafts(inputEntries) {
  const entries = normalizeUploadEntries(inputEntries);
  const htmlEntries = entries.filter((entry) => /\.html?$/i.test(entry.path));

  if (!htmlEntries.length) {
    return {
      drafts: [],
      rejected: entries.length,
    };
  }

  const packages = groupEntriesIntoPackages(entries, htmlEntries);
  const drafts = await Promise.all(packages.map(buildPackageDraft));

  return {
    drafts,
    rejected: entries.filter((entry) => !isSupportedPackageFile(entry.path)).length,
  };
}

export async function saveUploadDrafts(drafts) {
  if (!drafts.length) {
    return { added: 0, updated: 0 };
  }

  const db = await openDatabase();
  const existingRecords = await withRequest(
    db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll()
  );
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);

  let added = 0;
  let updated = 0;

  for (const draft of drafts) {
    const normalizedTitle = (draft.title || draft.suggestedTitle || "").trim() || draft.suggestedTitle;
    const titleKey = slugify(normalizedTitle) || draft.fileKey;
    const previous = findExistingRecord(existingRecords, draft.fileKey, titleKey);
    const recordId = previous?.id || `upload-${draft.fileKey}`;

    for (const duplicate of existingRecords) {
      if (
        duplicate.id !== recordId &&
        (duplicate.fileKey === draft.fileKey ||
          duplicate.titleKey === titleKey ||
          duplicate.slug === titleKey ||
          getFilenameKey(duplicate.filename) === draft.fileKey)
      ) {
        store.delete(duplicate.id);
      }
    }

    store.put({
      id: recordId,
      slug: titleKey,
      title: normalizedTitle,
      titleKey,
      fileKey: draft.fileKey,
      description: draft.description,
      tags: Array.isArray(draft.tags) ? draft.tags : ["Uploaded", "Browser"],
      filename: draft.filename,
      entryPath: draft.entryPath,
      files: draft.files.map((file) => ({
        blob: file.file,
        name: file.name,
        path: file.path,
        type: file.type,
      })),
      html: draft.html,
      uploadedAt: new Date().toISOString(),
      accent: draft.accent,
      featured: true,
      embed: true,
      sourceType: "upload",
      thumbnail: draft.thumbnail,
      linkedAssets: draft.linkedAssets,
      missingAssets: draft.missingAssets,
      requiresFolderMode: draft.missingAssets.length > 0,
    });

    if (previous) {
      updated += 1;
    } else {
      added += 1;
    }
  }

  await transactionDone(transaction);
  return { added, updated };
}

export async function updateUploadedGameMetadata(id, updates) {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const record = await withRequest(store.get(id));

  if (!record) {
    await transactionDone(transaction);
    return;
  }

  const title = updates.title?.trim() || record.title;
  record.title = title;
  record.titleKey = slugify(title) || record.titleKey || record.slug;
  record.slug = record.titleKey;

  if (typeof updates.thumbnail === "string") {
    record.thumbnail = updates.thumbnail;
  }

  store.put(record);
  await transactionDone(transaction);
}

export async function deleteUploadedGame(id) {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).delete(id);
  await transactionDone(transaction);
}

export async function clearUploadedGames() {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).clear();
  await transactionDone(transaction);
}

export async function createUploadedGameUrl(game) {
  if (!Array.isArray(game.files) || !game.files.length) {
    return {
      cleanup() {},
      url: URL.createObjectURL(
        new Blob([game.html], {
          type: "text/html",
        })
      ),
    };
  }

  return createPackageUrl(game);
}

function mapRecordToGame(record) {
  return {
    id: record.id,
    slug: record.slug,
    title: record.title,
    description: record.description,
    tags: Array.isArray(record.tags) ? record.tags : ["Uploaded", "Browser"],
    accent: record.accent || "#52d2ff",
    featured: Boolean(record.featured),
    order: -50,
    sourceType: "upload",
    directUrl: null,
    embed: record.embed !== false,
    uploadedAt: record.uploadedAt,
    html: record.html,
    filename: record.filename,
    thumbnail: record.thumbnail || null,
    entryPath: record.entryPath || "index.html",
    files: Array.isArray(record.files)
      ? record.files.map((file) => ({
          file: file.blob,
          name: file.name,
          path: file.path,
          type: file.type,
        }))
      : [],
    linkedAssets: Array.isArray(record.linkedAssets) ? record.linkedAssets : [],
    missingAssets: Array.isArray(record.missingAssets) ? record.missingAssets : [],
    requiresFolderMode: Boolean(record.requiresFolderMode),
  };
}

async function buildPackageDraft(pkg) {
  const html = await pkg.entry.file.text();
  const metadata = extractHtmlMetadata(html);
  const suggestedTitle = metadata.title || titleize(pkg.baseName);
  const filePathSet = new Set(pkg.entries.map((entry) => entry.path));
  const linkedAssets = extractRelativeAssetPaths(html);
  const missingAssets = linkedAssets.filter((assetPath) => {
    const resolved = normalizePath(joinPath(dirname(pkg.entryRelativePath), assetPath));
    return !filePathSet.has(resolved);
  });

  const thumbnail =
    metadata.thumbnail || (await detectPackageThumbnail(pkg.entries)) || null;

  return {
    accent: metadata.accent,
    description: metadata.description || "Dragged into the arcade from this browser.",
    entryPath: pkg.entryRelativePath,
    fileKey: slugify(pkg.baseName),
    files: pkg.entries,
    filename: pkg.entry.name,
    html,
    linkedAssets,
    missingAssets,
    suggestedTitle,
    tags: ["Uploaded", "Browser"],
    thumbnail,
    title: suggestedTitle,
  };
}

function groupEntriesIntoPackages(entries, htmlEntries) {
  if (htmlEntries.length === 1) {
    const entry = htmlEntries[0];
    const rootDir = dirname(entry.path);
    return [
      {
        baseName: basename(rootDir || entry.path.replace(/\.html?$/i, "")),
        entries: entries
          .filter((candidate) => isInDirectory(candidate.path, rootDir))
          .map((candidate) => ({
            ...candidate,
            path: stripDirectoryPrefix(candidate.path, rootDir),
          })),
        entry: {
          ...entry,
          path: stripDirectoryPrefix(entry.path, rootDir),
        },
        entryRelativePath: stripDirectoryPrefix(entry.path, rootDir),
      },
    ];
  }

  return htmlEntries.map((entry) => {
    const rootDir = dirname(entry.path);
    const packageEntries = entries
      .filter((candidate) => isInDirectory(candidate.path, rootDir))
      .map((candidate) => ({
        ...candidate,
        path: stripDirectoryPrefix(candidate.path, rootDir),
      }));

    return {
      baseName: basename(rootDir || entry.path.replace(/\.html?$/i, "")),
      entries: packageEntries,
      entry: {
        ...entry,
        path: stripDirectoryPrefix(entry.path, rootDir),
      },
      entryRelativePath: stripDirectoryPrefix(entry.path, rootDir),
    };
  });
}

function normalizeUploadEntries(inputEntries) {
  return Array.from(inputEntries || [])
    .map((entry) => {
      if (entry?.file && entry?.path) {
        return {
          file: entry.file,
          name: entry.file.name,
          path: normalizePath(entry.path),
          type: entry.file.type || guessMimeType(entry.file.name),
        };
      }

      if (entry instanceof File) {
        const path = entry.webkitRelativePath || entry.name;
        return {
          file: entry,
          name: entry.name,
          path: normalizePath(path),
          type: entry.type || guessMimeType(entry.name),
        };
      }

      return null;
    })
    .filter(Boolean);
}

async function createPackageUrl(game) {
  const fileMap = new Map(
    game.files.map((file) => [
      normalizePath(file.path),
      {
        file: file.file,
        name: file.name,
        type: file.type || guessMimeType(file.name),
      },
    ])
  );
  const urlCache = new Map();
  const createdUrls = [];

  const resolveReference = async (reference, baseDir) => {
    if (!isRelativeAssetPath(reference)) {
      return reference;
    }

    const targetPath = normalizePath(joinPath(baseDir, reference));
    return createResolvedUrl(targetPath);
  };

  const createResolvedUrl = async (path) => {
    const normalizedPath = normalizePath(path);
    if (urlCache.has(normalizedPath)) {
      return urlCache.get(normalizedPath);
    }

    const entry = fileMap.get(normalizedPath);
    if (!entry) {
      return normalizedPath;
    }

    const ext = extname(normalizedPath);
    let blob;

    if (ext === ".css") {
      const text = await entry.file.text();
      blob = new Blob([await rewriteCss(text, dirname(normalizedPath), resolveReference)], {
        type: entry.type || "text/css",
      });
    } else if (ext === ".js") {
      const text = await entry.file.text();
      blob = new Blob([await rewriteJs(text, dirname(normalizedPath), resolveReference)], {
        type: entry.type || "text/javascript",
      });
    } else if (ext === ".html") {
      const text = await entry.file.text();
      blob = new Blob([await rewriteHtml(text, normalizedPath, resolveReference)], {
        type: entry.type || "text/html",
      });
    } else {
      blob = entry.file;
    }

    const url = URL.createObjectURL(blob);
    urlCache.set(normalizedPath, url);
    createdUrls.push(url);
    return url;
  };

  const htmlUrl = await createResolvedUrl(game.entryPath || "index.html");
  return {
    cleanup() {
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    },
    url: htmlUrl,
  };
}

async function rewriteHtml(html, htmlPath, resolveReference) {
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  const baseDir = dirname(htmlPath);

  const attributeSelectors = [
    ["img[src]", "src"],
    ["audio[src]", "src"],
    ["video[src]", "src"],
    ["source[src]", "src"],
    ["script[src]", "src"],
    ["iframe[src]", "src"],
    ["link[href]", "href"],
  ];

  for (const [selector, attribute] of attributeSelectors) {
    const nodes = Array.from(documentNode.querySelectorAll(selector));
    for (const node of nodes) {
      const current = node.getAttribute(attribute);
      if (!current) {
        continue;
      }
      node.setAttribute(attribute, await resolveReference(current, baseDir));
    }
  }

  const styleTags = Array.from(documentNode.querySelectorAll("style"));
  for (const tag of styleTags) {
    tag.textContent = await rewriteCss(tag.textContent || "", baseDir, resolveReference);
  }

  const inlineScripts = Array.from(documentNode.querySelectorAll("script:not([src])"));
  for (const script of inlineScripts) {
    script.textContent = await rewriteJs(script.textContent || "", baseDir, resolveReference);
  }

  const styledNodes = Array.from(documentNode.querySelectorAll("[style]"));
  for (const node of styledNodes) {
    node.setAttribute(
      "style",
      await rewriteCss(node.getAttribute("style") || "", baseDir, resolveReference)
    );
  }

  return `<!DOCTYPE html>\n${documentNode.documentElement.outerHTML}`;
}

async function rewriteCss(text, baseDir, resolveReference) {
  return replaceAsync(text, /url\(([^)]+)\)/g, async (fullMatch, rawValue) => {
    const cleaned = rawValue.trim().replace(/^['"]|['"]$/g, "");
    const resolved = await resolveReference(cleaned, baseDir);
    return `url("${resolved}")`;
  });
}

async function rewriteJs(text, baseDir, resolveReference) {
  return replaceAsync(
    text,
    /(["'`])((?:\\.|(?!\1)[^\\\n\r])*)\1/g,
    async (fullMatch, quote, value) => {
      if (!isLikelyRelativeScriptAssetPath(value)) {
        return fullMatch;
      }

      const resolved = await resolveReference(value, baseDir);
      if (resolved === value) {
        return fullMatch;
      }

      return `${quote}${resolved}${quote}`;
    }
  );
}

function isLikelyRelativeScriptAssetPath(value) {
  if (!isRelativeAssetPath(value)) {
    return false;
  }

  if (/\s/.test(value)) {
    return false;
  }

  if (value.startsWith("./") || value.startsWith("../")) {
    return true;
  }

  if (/[\\/]/.test(value)) {
    return true;
  }

  return /\.(?:css|gif|html?|ico|jpe?g|js|json|m4a|mp3|ogg|png|svg|wav|webm|webp|woff2?|ttf|otf|mp4)(?:[?#].*)?$/i.test(
    value
  );
}

async function replaceAsync(text, pattern, replacer) {
  const matches = Array.from(text.matchAll(pattern));
  if (!matches.length) {
    return text;
  }

  let cursor = 0;
  let output = "";

  for (const match of matches) {
    const index = match.index ?? 0;
    output += text.slice(cursor, index);
    output += await replacer(...match);
    cursor = index + match[0].length;
  }

  output += text.slice(cursor);
  return output;
}

async function detectPackageThumbnail(entries) {
  const preferred = [
    "cover.png",
    "cover.jpg",
    "cover.jpeg",
    "thumbnail.png",
    "thumbnail.jpg",
    "icon.png",
    "favicon.ico",
  ];

  const preferredEntry = preferred
    .map((candidate) => entries.find((entry) => entry.path.toLowerCase() === candidate))
    .find(Boolean);

  if (!preferredEntry) {
    return null;
  }

  return fileToDataUrl(preferredEntry.file);
}

function findExistingRecord(records, fileKey, titleKey) {
  return (
    records.find((record) => record.fileKey === fileKey) ||
    records.find((record) => getFilenameKey(record.filename) === fileKey) ||
    records.find((record) => record.titleKey === titleKey) ||
    records.find((record) => record.slug === titleKey) ||
    null
  );
}

function openDatabase() {
  if (!("indexedDB" in window)) {
    throw new Error("IndexedDB is not available in this browser.");
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.addEventListener("upgradeneeded", () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      });

      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
  }

  return dbPromise;
}

function withRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
}

function extractHtmlMetadata(html) {
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  const possibleTitle = [
    documentNode.querySelector("title")?.textContent?.trim(),
    documentNode.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim(),
    documentNode.querySelector('meta[name="twitter:title"]')?.getAttribute("content")?.trim(),
    documentNode.querySelector("h1")?.textContent?.trim(),
  ];

  const title = possibleTitle.find((value) => value && !looksGenericTitle(value)) || "";
  const description =
    documentNode.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ||
    documentNode.querySelector("h2")?.textContent?.trim() ||
    "";
  const accent =
    documentNode.querySelector('meta[name="theme-color"]')?.getAttribute("content")?.trim() ||
    null;

  const candidateSources = [
    documentNode.querySelector('meta[property="og:image"]')?.getAttribute("content"),
    documentNode.querySelector('meta[name="twitter:image"]')?.getAttribute("content"),
    documentNode.querySelector("img[src]")?.getAttribute("src"),
  ];

  const thumbnail =
    candidateSources.find((value) => typeof value === "string" && /^(data:|https?:)/.test(value)) ||
    null;

  return {
    title,
    description,
    accent,
    thumbnail,
  };
}

function extractRelativeAssetPaths(html) {
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  const selectors = [
    "img[src]",
    "audio[src]",
    "video[src]",
    "source[src]",
    "script[src]",
    "iframe[src]",
    "link[href]",
  ];

  const urls = selectors.flatMap((selector) =>
    Array.from(documentNode.querySelectorAll(selector)).map((node) =>
      node.getAttribute(selector.includes("[src]") ? "src" : "href")
    )
  );

  return Array.from(
    new Set(
      urls
        .map((value) => value?.trim())
        .filter((value) => value && isRelativeAssetPath(value))
    )
  );
}

function isRelativeAssetPath(value) {
  if (!value) {
    return false;
  }

  if (
    value.startsWith("#") ||
    value.startsWith("data:") ||
    value.startsWith("blob:") ||
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("//") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:") ||
    value.startsWith("/") ||
    value.startsWith("?")
  ) {
    return false;
  }

  return true;
}

function guessMimeType(filename) {
  const ext = extname(filename);
  return (
    {
      ".css": "text/css",
      ".gif": "image/gif",
      ".html": "text/html",
      ".ico": "image/x-icon",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".js": "text/javascript",
      ".json": "application/json",
      ".m4a": "audio/mp4",
      ".mp3": "audio/mpeg",
      ".mp4": "video/mp4",
      ".ogg": "audio/ogg",
      ".otf": "font/otf",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".wav": "audio/wav",
      ".webm": "video/webm",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[ext] || "application/octet-stream"
  );
}

function normalizePath(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "")
    .replace(/\/+/g, "/");
}

function dirname(value) {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function basename(value) {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function extname(value) {
  const name = basename(value).toLowerCase();
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index);
}

function joinPath(base, relative) {
  const baseParts = base ? normalizePath(base).split("/") : [];
  const relParts = normalizePath(relative).split("/");
  const parts = [...baseParts];

  for (const part of relParts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.join("/");
}

function stripDirectoryPrefix(path, prefix) {
  if (!prefix) {
    return normalizePath(path);
  }

  const normalizedPath = normalizePath(path);
  const normalizedPrefix = normalizePath(prefix);
  return normalizedPath.startsWith(`${normalizedPrefix}/`)
    ? normalizedPath.slice(normalizedPrefix.length + 1)
    : normalizedPath;
}

function isInDirectory(path, directory) {
  if (!directory) {
    return true;
  }
  const normalizedPath = normalizePath(path);
  const normalizedDirectory = normalizePath(directory);
  return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`);
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

function looksGenericTitle(value) {
  const normalized = value.toLowerCase();
  return ["index", "untitled", "document", "game", "home"].includes(normalized);
}

function getFilenameKey(filename = "") {
  return slugify(filename.replace(/\.[^.]+$/, ""));
}

function isSupportedPackageFile(path) {
  return [
    ".css",
    ".gif",
    ".html",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".m4a",
    ".mp3",
    ".mp4",
    ".ogg",
    ".otf",
    ".png",
    ".svg",
    ".ttf",
    ".wav",
    ".webm",
    ".webp",
    ".woff",
    ".woff2",
  ].includes(extname(path));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}
