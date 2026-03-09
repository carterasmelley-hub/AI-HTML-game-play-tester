import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const rootDir = process.cwd();
const port = Number(process.env.PORT || 4173);
const sessionCookieName = "arcade_grid_session";
const sessionTtlMs = 1000 * 60 * 60 * 24 * 7;
const loginRateLimit = createRateLimiter({
  limit: 8,
  windowMs: 1000 * 60 * 10,
});
const aiRateLimit = createRateLimiter({
  limit: 12,
  windowMs: 1000 * 60 * 10,
});

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

validateStartupConfig();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = requestUrl.pathname;

    if (pathname === "/healthz") {
      return sendJson(res, 200, {
        ok: true,
      });
    }

    if (pathname === "/login" && req.method === "GET") {
      return handleLoginPage(req, res, requestUrl);
    }

    if (pathname === "/api/login" && req.method === "POST") {
      return handleLogin(req, res, requestUrl);
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      return handleLogout(req, res);
    }

    if (!isAuthenticated(req)) {
      return handleUnauthenticated(req, res, requestUrl);
    }

    if (!isSameOriginRequest(req, requestUrl) && req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 403, {
        error: "Cross-origin request blocked.",
      });
    }

    if (pathname === "/api/health") {
      return sendJson(res, 200, {
        authConfigured: hasAuthConfig(),
        hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
        ok: true,
      });
    }

    if (pathname === "/api/ai-playtest" && req.method === "POST") {
      return handleAiPlaytest(req, res);
    }

    if (pathname === "/api/ai-autoplay" && req.method === "POST") {
      return handleAiAutoplay(req, res, requestUrl);
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "Method not allowed." });
    }

    return serveStatic(requestUrl.pathname, res, req.method === "HEAD");
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      error: "Internal server error.",
    });
  }
});

server.listen(port, () => {
  console.log(`Arcade Grid running at http://127.0.0.1:${port}`);
});

async function handleLoginPage(req, res, requestUrl) {
  if (isAuthenticated(req)) {
    return redirect(res, sanitizeNext(requestUrl.searchParams.get("next") || "/"));
  }

  const html = buildLoginPage({
    next: sanitizeNext(requestUrl.searchParams.get("next") || "/"),
  });

  sendHtml(res, 200, html);
}

async function handleLogin(req, res, requestUrl) {
  if (!hasAuthConfig()) {
    return sendJson(res, 500, {
      error: "APP_PASSWORD and SESSION_SECRET must both be configured on the server.",
    });
  }

  const rate = loginRateLimit.consume(getClientKey(req));
  if (!rate.allowed) {
    return sendJson(res, 429, {
      error: "Too many login attempts. Try again later.",
    });
  }

  const body = await readJsonBody(req);
  const submittedPassword = String(body.password || "");
  const expectedPassword = String(process.env.APP_PASSWORD || "");

  if (!safeEqual(submittedPassword, expectedPassword)) {
    return sendJson(res, 401, {
      error: "Incorrect password.",
    });
  }

  const next = sanitizeNext(body.next || requestUrl.searchParams.get("next") || "/");
  const cookie = createSessionCookie(requestUrl.protocol === "https:");
  sendJson(
    res,
    200,
    {
      ok: true,
      redirectTo: next,
    },
    {
      "Set-Cookie": cookie,
    }
  );
}

async function handleLogout(req, res) {
  sendJson(
    res,
    200,
    {
      ok: true,
    },
    {
      "Set-Cookie": clearSessionCookie(req.headers["x-forwarded-proto"] === "https"),
    }
  );
}

function handleUnauthenticated(req, res, requestUrl) {
  if (requestUrl.pathname.startsWith("/api/")) {
    return sendJson(res, 401, {
      error: "Authentication required.",
    });
  }

  const next = sanitizeNext(`${requestUrl.pathname}${requestUrl.search}`);
  return redirect(res, `/login?next=${encodeURIComponent(next)}`);
}

async function serveStatic(pathname, res, headOnly) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(safePath);
  } catch {
    return sendJson(res, 400, { error: "Bad request." });
  }

  const filePath = path.resolve(rootDir, `.${decodedPath}`);

  if (!filePath.startsWith(rootDir)) {
    return sendJson(res, 403, { error: "Forbidden." });
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendJson(res, 404, { error: "Not found." });
  }

  const resolvedPath = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
  let finalStat;
  try {
    finalStat = await fsp.stat(resolvedPath);
  } catch {
    return sendJson(res, 404, { error: "Not found." });
  }

  const headers = buildCommonHeaders({
    contentLength: finalStat.size,
    contentType:
      mimeTypes[path.extname(resolvedPath).toLowerCase()] || "application/octet-stream",
  });

  res.writeHead(200, headers);

  if (headOnly) {
    return res.end();
  }

  fs.createReadStream(resolvedPath).pipe(res);
}

async function handleAiPlaytest(req, res) {
  const key = getClientKey(req);
  const rate = aiRateLimit.consume(key);
  if (!rate.allowed) {
    return sendJson(res, 429, {
      error: "Too many AI requests. Try again later.",
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return sendJson(res, 500, {
      error: "OPENAI_API_KEY is not set in the server environment.",
    });
  }

  const payload = await readJsonBody(req);
  const prompt = buildReviewPrompt(payload);
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are an expert HTML game playtest reviewer. Review the supplied game files, current runtime state, and user focus notes. Give actionable findings, likely bug causes, and concrete fixes. Prioritize gameplay blockers, broken assets, input issues, mobile issues, performance issues, and UX confusion. Be concise and structured. If evidence is incomplete, say what is inferred versus observed.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return sendJson(res, 502, {
      details: errorText,
      error: "OpenAI request failed.",
    });
  }

  const data = await response.json();
  const report = data.choices?.[0]?.message?.content?.trim() || "No report returned.";

  return sendJson(res, 200, {
    report,
  });
}

async function handleAiAutoplay(req, res, requestUrl) {
  const key = getClientKey(req);
  const rate = aiRateLimit.consume(key);
  if (!rate.allowed) {
    return sendJson(res, 429, {
      error: "Too many AI requests. Try again later.",
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return sendJson(res, 500, {
      error: "OPENAI_API_KEY is not set in the server environment.",
    });
  }

  const payload = await readJsonBody(req);
  if (!payload?.game?.playableUrl) {
    return sendJson(res, 400, {
      error:
        "This game does not expose a server-playable URL yet. Use a repo-backed game or hosted game for autonomous play.",
    });
  }

  const browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
  });

  try {
    const context = await browser.newContext({
      viewport: {
        height: 900,
        width: 1366,
      },
    });
    const page = await context.newPage();
    const targetUrl = resolvePlayableUrl(payload.game.playableUrl, requestUrl);
    if (!isAllowedAutoplayTarget(targetUrl, requestUrl)) {
      return sendJson(res, 400, {
        error:
          "AI autoplay is restricted to games hosted on this same private site. Move the game into /games and open that hosted copy.",
      });
    }
    await authenticateAutoplayContext(context, targetUrl, requestUrl);
    await page.goto(targetUrl, {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1500);

    const transcript = [];
    const actionHistory = [];
    const maxSteps = Number(payload.maxSteps || 8);

    for (let step = 0; step < maxSteps; step += 1) {
      const observation = await capturePageObservation(page);
      const actionPlan = await chooseNextAction({
        actionHistory,
        files: payload.files || [],
        focusPrompt: payload.focusPrompt || "",
        game: payload.game,
        observation,
        step,
      });

      transcript.push({
        action: actionPlan,
        observation: observation.domState,
        step: step + 1,
      });

      if (actionPlan.action === "finish") {
        actionHistory.push(actionPlan);
        break;
      }

      const execution = await executeAction(page, actionPlan, observation);
      actionHistory.push({
        ...actionPlan,
        execution,
      });
      transcript[transcript.length - 1].execution = execution;
    }

    const finalObservation = await capturePageObservation(page);
    const report = await summarizeAutoplay({
      files: payload.files || [],
      finalObservation,
      focusPrompt: payload.focusPrompt || "",
      game: payload.game,
      transcript,
    });

    await context.close();

    return sendJson(res, 200, {
      report,
      transcript,
    });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      details: error.message,
      error: "AI autoplay failed.",
    });
  } finally {
    await browser.close();
  }
}

function buildReviewPrompt(payload) {
  return [
    "Review this HTML game as an AI playtester.",
    "",
    `Focus prompt: ${payload.focusPrompt || "General gameplay, bugs, UX, controls, assets, performance, and mobile behavior."}`,
    "",
    "Game metadata:",
    JSON.stringify(payload.game || {}, null, 2),
    "",
    "Runtime state snapshot:",
    JSON.stringify(payload.runtime || {}, null, 2),
    "",
    "Files:",
    JSON.stringify(payload.files || [], null, 2),
    "",
    "Respond with these sections:",
    "1. Summary",
    "2. Findings",
    "3. Likely fixes",
    "4. Extra tests to run",
  ].join("\n");
}

async function capturePageObservation(page) {
  const screenshot = await page.screenshot({
    fullPage: false,
    type: "png",
  });

  const domState = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };

    const interactiveSelectors = [
      "button",
      "a",
      "input",
      "select",
      "textarea",
      "[role='button']",
      "canvas",
    ];

    const interactive = Array.from(
      document.querySelectorAll(interactiveSelectors.join(","))
    )
      .filter(visible)
      .slice(0, 30)
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        return {
          index,
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || element.textContent || "").trim().slice(0, 120),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      });

    return {
      audioCount: document.querySelectorAll("audio").length,
      canvasCount: document.querySelectorAll("canvas").length,
      interactive,
      textSample: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000),
      title: document.title,
      url: location.href,
    };
  });

  return {
    domState,
    screenshotBase64: screenshot.toString("base64"),
  };
}

async function chooseNextAction(payload) {
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: {
        type: "json_object",
      },
      messages: [
        {
          role: "system",
          content:
            "You are controlling a browser to play and test an HTML game. Return JSON only. Choose one next action that is most useful for exploration or validation. Prefer interacting with visible menu buttons first, then focus the canvas/game area, then use keyboard inputs. If you have enough evidence, return action=finish.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildActionPrompt(payload),
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${payload.observation.screenshotBase64}`,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "{}";
  const parsed = JSON.parse(raw);

  return {
    action: parsed.action || "finish",
    holdMs: clampNumber(parsed.holdMs, 200, 5000, 800),
    key: parsed.key || "",
    rationale: parsed.rationale || "",
    targetIndex: Number.isFinite(parsed.targetIndex) ? parsed.targetIndex : -1,
    waitMs: clampNumber(parsed.waitMs, 200, 4000, 1000),
  };
}

function buildActionPrompt(payload) {
  return [
    `Focus prompt: ${payload.focusPrompt || "General gameplay, controls, bugs, and onboarding."}`,
    `Step: ${payload.step + 1}`,
    "",
    "Game metadata:",
    JSON.stringify(payload.game || {}, null, 2),
    "",
    "Current observation:",
    JSON.stringify(payload.observation.domState, null, 2),
    "",
    "Recent action history:",
    JSON.stringify(payload.actionHistory.slice(-5), null, 2),
    "",
    "Important instructions:",
    "- Allowed actions: click_target, press_key, wait, finish",
    "- For click_target, choose targetIndex from observation.domState.interactive",
    "- For press_key, use keys like ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, Enter, KeyZ, KeyX",
    "- Prefer menus, start buttons, restart buttons, or focusing the game canvas before movement",
    "- Return JSON only with fields: action, targetIndex, key, holdMs, waitMs, rationale",
  ].join("\n");
}

async function executeAction(page, actionPlan, observation) {
  if (actionPlan.action === "click_target") {
    const target = observation.domState.interactive.find(
      (item) => item.index === actionPlan.targetIndex
    );
    if (!target) {
      return {
        ok: false,
        result: "Target index was not found.",
      };
    }

    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(actionPlan.waitMs);
    return {
      ok: true,
      result: `Clicked ${target.tag} "${target.text}"`,
    };
  }

  if (actionPlan.action === "press_key") {
    if (!actionPlan.key) {
      return {
        ok: false,
        result: "No key was supplied.",
      };
    }

    await page.keyboard.down(actionPlan.key);
    await page.waitForTimeout(actionPlan.holdMs);
    await page.keyboard.up(actionPlan.key);
    await page.waitForTimeout(actionPlan.waitMs);
    return {
      ok: true,
      result: `Pressed ${actionPlan.key} for ${actionPlan.holdMs}ms`,
    };
  }

  if (actionPlan.action === "wait") {
    await page.waitForTimeout(actionPlan.waitMs);
    return {
      ok: true,
      result: `Waited ${actionPlan.waitMs}ms`,
    };
  }

  return {
    ok: true,
    result: "Finished action loop.",
  };
}

async function summarizeAutoplay(payload) {
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are an expert HTML game playtester. Based on the observed browser play session, runtime state, and source files, write a concise but concrete report. Separate observed issues from likely code-level causes. Include likely bug fixes.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `Focus prompt: ${payload.focusPrompt || "General gameplay, bugs, UX, controls, and mobile issues."}`,
                "",
                "Game metadata:",
                JSON.stringify(payload.game || {}, null, 2),
                "",
                "Play transcript:",
                JSON.stringify(payload.transcript, null, 2),
                "",
                "Final observation:",
                JSON.stringify(payload.finalObservation.domState, null, 2),
                "",
                "Files:",
                JSON.stringify(payload.files || [], null, 2),
                "",
                "Respond with sections:",
                "1. Session summary",
                "2. Observed issues",
                "3. Likely fixes",
                "4. Suggested next playtests",
              ].join("\n"),
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${payload.finalObservation.screenshotBase64}`,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "No autoplay report returned.";
}

function resolvePlayableUrl(playableUrl, requestUrl) {
  if (/^https?:\/\//.test(playableUrl)) {
    return playableUrl;
  }

  const origin = `${requestUrl.protocol}//${requestUrl.host}`;
  return new URL(playableUrl, origin).toString();
}

function isAllowedAutoplayTarget(targetUrl, requestUrl) {
  const appOrigin = `${requestUrl.protocol}//${requestUrl.host}`;

  try {
    const parsed = new URL(targetUrl);
    return parsed.origin === appOrigin;
  } catch {
    return false;
  }
}

async function authenticateAutoplayContext(context, targetUrl, requestUrl) {
  if (!hasAuthConfig()) {
    return;
  }

  const appOrigin = `${requestUrl.protocol}//${requestUrl.host}`;
  const targetOrigin = new URL(targetUrl).origin;
  if (targetOrigin !== appOrigin) {
    return;
  }

  await context.addCookies([
    {
      domain: requestUrl.hostname,
      httpOnly: true,
      name: sessionCookieName,
      path: "/",
      sameSite: "Strict",
      secure: requestUrl.protocol === "https:",
      value: createSessionToken(),
    },
  ]);
}

function buildLoginPage({ next }) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Arcade Grid Login</title>
    <style>
      :root {
        color-scheme: dark;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top, rgba(82, 210, 255, 0.18), transparent 28%),
          radial-gradient(circle at 82% 12%, rgba(255, 138, 61, 0.16), transparent 24%),
          linear-gradient(180deg, #09131f 0%, #07111a 100%);
        color: #f5f7fb;
        font-family: system-ui, sans-serif;
      }
      .panel {
        width: min(100%, 440px);
        padding: 28px;
        border-radius: 24px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(10,24,37,0.92);
        box-shadow: 0 22px 60px rgba(0,0,0,0.35);
      }
      h1 { margin: 0 0 10px; font-size: 2rem; }
      p { margin: 0 0 18px; color: #aabbd0; line-height: 1.7; }
      label { display: grid; gap: 10px; font-weight: 700; }
      input {
        width: 100%;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.05);
        color: #fff;
        font: inherit;
      }
      button {
        width: 100%;
        margin-top: 16px;
        min-height: 48px;
        border: 0;
        border-radius: 999px;
        background: linear-gradient(135deg, #ffcf3f, #ff8a3d);
        color: #09131f;
        font: inherit;
        font-weight: 800;
        cursor: pointer;
      }
      .status {
        margin-top: 14px;
        min-height: 24px;
        color: #ffb0b0;
      }
      .small {
        margin-top: 18px;
        font-size: 0.9rem;
      }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>Private Arcade</h1>
      <p>This app is locked. Enter the password to access the site and the AI playtester.</p>
      <label for="password-input">
        Password
        <input id="password-input" type="password" autocomplete="current-password" />
      </label>
      <button id="login-button" type="button">Unlock</button>
      <div id="status" class="status"></div>
      <p class="small">Your OpenAI key stays on the server and never goes to the browser.</p>
    </main>
    <script>
      const next = ${JSON.stringify(next)};
      const passwordInput = document.getElementById("password-input");
      const button = document.getElementById("login-button");
      const status = document.getElementById("status");

      button.addEventListener("click", submit);
      passwordInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
      });

      async function submit() {
        status.textContent = "";
        button.disabled = true;
        button.textContent = "Unlocking...";

        try {
          const response = await fetch("/api/login", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              next,
              password: passwordInput.value
            })
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || "Login failed.");
          }

          window.location.href = data.redirectTo || "/";
        } catch (error) {
          status.textContent = error.message || String(error);
          button.disabled = false;
          button.textContent = "Unlock";
        }
      }
    </script>
  </body>
</html>`;
}

function validateStartupConfig() {
  if (!hasAuthConfig()) {
    console.warn("APP_PASSWORD or SESSION_SECRET is missing. Login will not work until both are set.");
  }
}

function hasAuthConfig() {
  return Boolean(process.env.APP_PASSWORD) && Boolean(process.env.SESSION_SECRET);
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[sessionCookieName];
  if (!token || !process.env.SESSION_SECRET) {
    return false;
  }

  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) {
    return false;
  }

  const expectedSignature = signValue(payloadPart, process.env.SESSION_SECRET);
  if (!safeEqual(signaturePart, expectedSignature)) {
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  return Number(payload.exp) > Date.now();
}

function createSessionCookie(isSecure = false) {
  const token = createSessionToken();
  const secure = isSecure ? "; Secure" : "";
  return `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`;
}

function createSessionToken() {
  const payloadPart = Buffer.from(
    JSON.stringify({
      exp: Date.now() + sessionTtlMs,
      nonce: crypto.randomBytes(16).toString("hex"),
    })
  ).toString("base64url");
  const signature = signValue(payloadPart, process.env.SESSION_SECRET || "");
  return `${payloadPart}.${signature}`;
}

function clearSessionCookie(isSecure = false) {
  const secure = isSecure ? "; Secure" : "";
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function signValue(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function parseCookies(cookieHeader) {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), part.slice(index + 1)];
      })
  );
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isSameOriginRequest(req, requestUrl) {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  const expectedOrigin = `${requestUrl.protocol}//${requestUrl.host}`;
  return origin === expectedOrigin;
}

function sanitizeNext(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

function redirect(res, location) {
  const headers = buildCommonHeaders({
    location,
  });
  res.writeHead(302, headers);
  res.end();
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  const headers = buildCommonHeaders({
    contentLength: Buffer.byteLength(body),
    contentType: "application/json; charset=utf-8",
    extraHeaders,
  });
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendHtml(res, statusCode, html, extraHeaders = {}) {
  const headers = buildCommonHeaders({
    contentLength: Buffer.byteLength(html),
    contentType: "text/html; charset=utf-8",
    extraHeaders,
  });
  res.writeHead(statusCode, headers);
  res.end(html);
}

function buildCommonHeaders({
  contentLength,
  contentType,
  extraHeaders = {},
  location,
} = {}) {
  return {
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    ...(Number.isFinite(contentLength) ? { "Content-Length": contentLength } : {}),
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...(location ? { Location: location } : {}),
    ...extraHeaders,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length) {
      return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || "unknown";
}

function createRateLimiter({ limit, windowMs }) {
  const buckets = new Map();

  return {
    consume(key) {
      const now = Date.now();
      const current = buckets.get(key) || {
        count: 0,
        resetAt: now + windowMs,
      };

      if (now > current.resetAt) {
        current.count = 0;
        current.resetAt = now + windowMs;
      }

      current.count += 1;
      buckets.set(key, current);

      return {
        allowed: current.count <= limit,
        remaining: Math.max(0, limit - current.count),
        resetAt: current.resetAt,
      };
    },
  };
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}
