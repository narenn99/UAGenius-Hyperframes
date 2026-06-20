import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const generatedDir = join(rootDir, "assets", "generated");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const openAiModel = process.env.OPENAI_MODEL || "gpt-5.2";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function extractJsonFromPrompt(prompt) {
  const start = prompt.indexOf("{");
  const end = prompt.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};

  try {
    return JSON.parse(prompt.slice(start, end + 1));
  } catch {
    return {};
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

function formatScore(value) {
  return Math.round(value).toLocaleString("en-US");
}

function compositionHtml({ prompt, data, type }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Generated ${escapeXml(type)} Composition</title>
    <style>
      body { margin: 0; background: #0a0a0a; color: white; font-family: Arial, sans-serif; }
      .composition { width: 1080px; height: 1920px; padding: 130px 120px; box-sizing: border-box; background: linear-gradient(#0a0a0a, #1a0000); }
      pre { white-space: pre-wrap; line-height: 1.35; font-size: 28px; }
    </style>
  </head>
  <body>
    <main class="composition">
      <h1>${escapeXml(data.title || "Generated Video")}</h1>
      <pre>${escapeXml(prompt)}</pre>
    </main>
    <script>
      window.__uageniusComposition = ${JSON.stringify({ type, data })};
    </script>
  </body>
</html>`;
}

function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return {};
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return {};
    }
  }
}

function responseText(responseJson) {
  if (typeof responseJson.output_text === "string") return responseJson.output_text;
  const chunks = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function normalizeHex(value, fallback) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function normalizeRenderSpec(rawSpec, fallbackData = {}) {
  const rawTheme = rawSpec.theme || fallbackData.theme || {};
  const primary = normalizeHex(rawTheme.primary, "#00D4FF");
  const secondary = normalizeHex(rawTheme.secondary, "#FFD700");
  const background = normalizeHex(rawTheme.background, "#0a0a0a");

  return {
    kind: rawSpec.kind || (Array.isArray(fallbackData.semifinals) ? "bracket" : "leaderboard"),
    title: rawSpec.title || fallbackData.title || "Generated Video",
    subtitle: rawSpec.subtitle || fallbackData.subtitle || "",
    cta: rawSpec.cta || fallbackData.cta || "PLAY NOW",
    theme: {
      primary,
      secondary,
      background,
      bronze: normalizeHex(rawTheme.bronze, "#CD7F32"),
    },
    items: Array.isArray(rawSpec.items) ? rawSpec.items : [],
    matches: Array.isArray(rawSpec.matches) ? rawSpec.matches : [],
    final: rawSpec.final || fallbackData.final || {},
  };
}

function fallbackRenderSpec(prompt) {
  const data = extractJsonFromPrompt(prompt);
  if (Array.isArray(data.semifinals)) {
    return normalizeRenderSpec(
      {
        kind: "bracket",
        title: data.title,
        subtitle: data.subtitle,
        theme: data.theme,
        matches: data.semifinals.map((match) => ({
          label: `SEMIFINAL ${match.match || ""}`.trim(),
          teamA: match.team_a,
          teamB: match.team_b,
          winner: match.winner,
        })),
        final: { teamA: data.final?.team_a, teamB: data.final?.team_b },
        cta: data.cta,
      },
      data,
    );
  }

  if (Array.isArray(data.players)) {
    return normalizeRenderSpec(
      {
        kind: "leaderboard",
        title: data.title,
        subtitle: data.subtitle,
        theme: data.theme,
        items: data.players.map((player) => ({
          rank: player.rank,
          name: player.name,
          sublabel: player.clan || player.team || "",
          value: player.score,
        })),
        cta: data.cta,
      },
      data,
    );
  }

  return normalizeRenderSpec({
    kind: "leaderboard",
    title: "Generated Game Video",
    subtitle: "Prompt-driven creative",
    items: [
      { rank: 1, name: "Concept A", sublabel: "Primary", value: 100 },
      { rank: 2, name: "Concept B", sublabel: "Secondary", value: 82 },
      { rank: 3, name: "Concept C", sublabel: "Tertiary", value: 65 },
    ],
    cta: "PLAY NOW",
  });
}

function flowLabel(flow = "leaderboard") {
  return {
    leaderboard: "Leaderboard",
    "stat-card": "Stat Card",
    "event-countdown": "Event Countdown",
    "custom-data": "Custom Data-to-Video",
  }[flow] || "Custom Data-to-Video";
}

function buildCompositionPrompt(userPrompt, flow = "leaderboard") {
  return `You generate short mobile-game video compositions for a UA creative prototype.

Selected product flow: ${flowLabel(flow)}.

Return ONLY valid JSON with this shape:
{
  "html": "complete standalone HyperFrames-compatible index.html string",
  "renderSpec": {
    "kind": "leaderboard | bracket | stats | event | custom",
    "title": "string",
    "subtitle": "string",
    "cta": "string",
    "theme": { "primary": "#RRGGBB", "secondary": "#RRGGBB", "background": "#RRGGBB", "bronze": "#RRGGBB" },
    "items": [{ "rank": 1, "name": "string", "sublabel": "string", "value": 12345 }],
    "matches": [{ "label": "SEMIFINAL 1", "teamA": "string", "teamB": "string", "winner": "string" }],
    "final": { "teamA": "string", "teamB": "string" }
  }
}

HTML requirements:
- One complete index.html document.
- 1080x1920 portrait composition.
- Root visual element must include data-composition-id="main", data-width="1080", data-height="1920", data-start="0", data-duration="4", data-track-index="0".
- Inline CSS and inline JavaScript only. No external assets, no CDN, no remote images.
- Use deterministic CSS/JS only. No Date.now(), Math.random(), network requests, or infinite loops.
- If using JavaScript animation, make it simple and deterministic. Prefer CSS transforms/opacity.
- The HTML should visually reflect the user's prompt.

RenderSpec requirements:
- Use the user's JSON/data if present.
- For tournament/bracket prompts, put teams in matches/final.
- For leaderboard prompts, put rows in items.
- For stat-card prompts, put comparison rows/items in items with values when possible.
- For event-countdown prompts, set kind to event and put event/offer/timer concepts in items if useful.
- For custom-data prompts, infer the best layout and still provide useful items/matches/final fields.
- For other prompts, still produce a useful generic items array.

User prompt:
${userPrompt}`;
}

async function generateCompositionWithOpenAI(prompt, flow) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openAiModel,
      input: buildCompositionPrompt(prompt, flow),
      max_output_tokens: 6000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI generation failed: ${errorText}`);
  }

  const json = await response.json();
  const parsed = extractJsonObject(responseText(json));
  if (!parsed.html || !parsed.renderSpec) {
    throw new Error("OpenAI did not return a valid composition payload");
  }

  return {
    html: String(parsed.html),
    renderSpec: normalizeRenderSpec(parsed.renderSpec, extractJsonFromPrompt(prompt)),
  };
}

function baseSvg({ background = "#0a0a0a", accent = "#FFD700", frame, body }) {
  const scanY = (frame * 7) % 14;
  return `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${escapeXml(background)}"/>
        <stop offset="100%" stop-color="#101827"/>
      </linearGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="5" result="blur"/>
        <feMerge>
          <feMergeNode in="blur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
    <rect width="1080" height="1920" fill="url(#bg)" />
    <circle cx="170" cy="310" r="260" fill="${escapeXml(accent)}" opacity="0.07" />
    <circle cx="930" cy="1290" r="320" fill="${escapeXml(accent)}" opacity="0.05" />
    ${body}
    <g opacity="0.05">
      ${Array.from({ length: 140 }, (_, index) => `<rect x="0" y="${index * 14 + scanY}" width="1080" height="2" fill="#ffffff" />`).join("")}
    </g>
  </svg>`;
}

function leaderboardSvg(data, frame) {
  const fps = 60;
  const seconds = frame / fps;
  const players = data.players?.length
    ? data.players
    : [
        { rank: 1, name: "Player One", clan: "Alpha", score: 15420 },
        { rank: 2, name: "Player Two", clan: "Bravo", score: 12800 },
        { rank: 3, name: "Player Three", clan: "Charlie", score: 10100 },
      ];
  const theme = data.theme || {};
  const colors = [theme.primary || "#FFD700", theme.secondary || "#C0C0C0", theme.bronze || "#CD7F32"];
  const maxScore = Math.max(...players.map((player) => Number(player.score) || 1));
  const ctaOpacity = clamp((seconds - 3) / 0.45);

  const rows = players.slice(0, 5).map((player, index) => {
    const start = 0.35 + index * 0.22;
    const progress = easeOutCubic(clamp((seconds - start) / 0.65));
    const countProgress = easeOutCubic(clamp((seconds - start) / 2));
    const color = colors[index] || theme.primary || "#00D4FF";
    const y = 500 + index * 155;
    const rowX = 130 + (1 - progress) * 170;
    const width = 820 * ((Number(player.score) || 1) / maxScore) * countProgress;

    return `
      <g transform="translate(${rowX}, ${y})" opacity="${progress}">
        <rect x="0" y="0" width="820" height="112" rx="24" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.16)" />
        <rect x="0" y="0" width="${width}" height="112" rx="24" fill="${escapeXml(color)}" opacity="0.25" />
        <circle cx="58" cy="56" r="34" fill="${escapeXml(color)}" opacity="0.22" stroke="${escapeXml(color)}" stroke-width="3" />
        <text x="58" y="72" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="900" fill="${escapeXml(color)}">${escapeXml(player.rank || index + 1)}</text>
        <text x="122" y="52" font-family="Arial, Helvetica, sans-serif" font-size="41" font-weight="900" fill="#ffffff">${escapeXml(player.name || `Player ${index + 1}`)}</text>
        <text x="124" y="88" font-family="Arial, Helvetica, sans-serif" font-size="27" font-weight="600" fill="#888888">${escapeXml(player.clan || player.team || "")}</text>
        <text x="780" y="70" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="41" font-weight="900" fill="${escapeXml(color)}">${formatScore((Number(player.score) || 0) * countProgress)}</text>
      </g>`;
  });

  return baseSvg({
    frame,
    background: theme.background || "#0a0a0a",
    accent: theme.primary || "#FFD700",
    body: `
      <text x="540" y="178" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="900" fill="${escapeXml(theme.primary || "#FFD700")}" filter="url(#glow)">${escapeXml(data.title || "WEEKLY TOP PLAYERS")}</text>
      <text x="540" y="248" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700" fill="${escapeXml(theme.secondary || "#C0C0C0")}">${escapeXml(data.subtitle || "")}</text>
      ${rows.join("")}
      <text x="540" y="1600" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="900" fill="#ffffff" opacity="${ctaOpacity}" filter="url(#glow)">${escapeXml(data.cta || "CAN YOU BEAT THEM?")}</text>
    `,
  });
}

function bracketSvg(data, frame) {
  const fps = 60;
  const seconds = frame / fps;
  const theme = data.theme || {};
  const primary = theme.primary || "#00D4FF";
  const secondary = theme.secondary || "#FFD700";
  const matches = data.semifinals || [];
  const final = data.final || {};
  const ctaOpacity = clamp((seconds - 3.15) / 0.4);
  const lineProgress = easeOutCubic(clamp((seconds - 1.4) / 0.9));
  const finalOpacity = easeOutCubic(clamp((seconds - 2) / 0.6));
  const pulse = 1 + Math.sin(frame * 0.18) * 0.04;

  const matchBox = ({ x, y, label, teamA, teamB, winner, delay }) => {
    const opacity = easeOutCubic(clamp((seconds - delay) / 0.5));
    return `
      <g opacity="${opacity}">
        <text x="${x + 190}" y="${y - 36}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="800" fill="${escapeXml(primary)}">${escapeXml(label)}</text>
        <rect x="${x}" y="${y}" width="380" height="230" rx="28" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.18)" />
        <text x="${x + 190}" y="${y + 74}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="900" fill="#ffffff">${escapeXml(teamA)}</text>
        <text x="${x + 190}" y="${y + 124}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="900" fill="${escapeXml(primary)}">VS</text>
        <text x="${x + 190}" y="${y + 180}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="900" fill="#ffffff">${escapeXml(teamB)}</text>
        <rect x="${x + 26}" y="${winner === teamA ? y + 38 : y + 144}" width="328" height="56" rx="16" fill="${escapeXml(primary)}" opacity="0.18" />
      </g>`;
  };

  return baseSvg({
    frame,
    background: theme.background || "#0a0a0a",
    accent: primary,
    body: `
      <text x="540" y="175" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="74" font-weight="900" fill="${escapeXml(primary)}" filter="url(#glow)">${escapeXml(data.title || "GRAND FINALS")}</text>
      <text x="540" y="245" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="700" fill="#888888">${escapeXml(data.subtitle || "")}</text>
      ${matchBox({ x: 88, y: 520, label: "SEMIFINAL 1", teamA: matches[0]?.team_a || "TEAM A", teamB: matches[0]?.team_b || "TEAM B", winner: matches[0]?.winner, delay: 0.15 })}
      ${matchBox({ x: 612, y: 520, label: "SEMIFINAL 2", teamA: matches[1]?.team_a || "TEAM C", teamB: matches[1]?.team_b || "TEAM D", winner: matches[1]?.winner, delay: 0.55 })}
      <path d="M468 635 C520 635, 520 790, 540 790" stroke="${escapeXml(primary)}" stroke-width="8" stroke-linecap="round" fill="none" stroke-dasharray="${230 * lineProgress} 230" filter="url(#glow)" />
      <path d="M612 635 C560 635, 560 790, 540 790" stroke="${escapeXml(primary)}" stroke-width="8" stroke-linecap="round" fill="none" stroke-dasharray="${230 * lineProgress} 230" filter="url(#glow)" />
      <g opacity="${finalOpacity}" transform="translate(0 ${10 * (1 - finalOpacity)})">
        <text x="540" y="895" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="78" font-weight="900" fill="${escapeXml(secondary)}" transform="scale(${pulse}) translate(${(1 - pulse) * 540} ${(1 - pulse) * 895})">♛</text>
        <rect x="170" y="940" width="740" height="250" rx="34" fill="rgba(255,255,255,0.09)" stroke="${escapeXml(secondary)}" stroke-width="3" />
        <text x="540" y="1025" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="46" font-weight="900" fill="#ffffff">${escapeXml(final.team_a || matches[0]?.winner || "WINNER 1")}</text>
        <text x="540" y="1090" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="900" fill="${escapeXml(secondary)}" filter="url(#glow)">VS</text>
        <text x="540" y="1160" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="46" font-weight="900" fill="#ffffff">${escapeXml(final.team_b || matches[1]?.winner || "WINNER 2")}</text>
      </g>
      <text x="540" y="1600" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="50" font-weight="900" fill="#ffffff" opacity="${ctaOpacity}" filter="url(#glow)">${escapeXml(data.cta || "WHO TAKES THE CROWN?")}</text>
    `,
  });
}

function renderSpecToLegacyData(spec) {
  if (spec.kind === "bracket") {
    return {
      title: spec.title,
      subtitle: spec.subtitle,
      theme: spec.theme,
      semifinals: (spec.matches || []).map((match, index) => ({
        match: index + 1,
        team_a: match.teamA || match.team_a || "TEAM A",
        team_b: match.teamB || match.team_b || "TEAM B",
        winner: match.winner || match.teamA || match.team_a || "TEAM A",
      })),
      final: {
        team_a: spec.final?.teamA || spec.final?.team_a,
        team_b: spec.final?.teamB || spec.final?.team_b,
      },
      cta: spec.cta,
    };
  }

  return {
    title: spec.title,
    subtitle: spec.subtitle,
    theme: spec.theme,
    players: (spec.items || []).map((item, index) => ({
      rank: item.rank || index + 1,
      name: item.name || `Item ${index + 1}`,
      clan: item.sublabel || item.clan || item.team || "",
      score: Number(item.value || item.score || Math.max(100 - index * 18, 20)),
    })),
    cta: spec.cta,
  };
}

function renderSpecSvg(spec, frame) {
  const legacyData = renderSpecToLegacyData(spec);
  return spec.kind === "bracket" ? bracketSvg(legacyData, frame) : leaderboardSvg(legacyData, frame);
}

async function runFfmpeg(args) {
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { cwd: rootDir, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg exited with ${code}`));
    });
  });
}

async function runHyperframesRender(jobDir, outputPath) {
  const command = process.env.HYPERFRAMES_BIN || "npx";
  const args =
    command.endsWith("bunx") || command === "bunx"
      ? ["hyperframes", "render", jobDir, "-o", outputPath, "-f", "60", "-q", "draft", "--workers", "1"]
      : ["hyperframes", "render", jobDir, "-o", outputPath, "-f", "60", "-q", "draft", "--workers", "1"];

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `hyperframes exited with ${code}`));
    });
  });
}

async function generateVideo(prompt, flow = "leaderboard") {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const jobDir = join(generatedDir, id);
  const frameDir = join(jobDir, "frames");
  await mkdir(frameDir, { recursive: true });
  const fallbackSpec = fallbackRenderSpec(prompt);
  let composition = null;

  try {
    composition = await generateCompositionWithOpenAI(prompt, flow);
  } catch (error) {
    console.warn(error.message);
  }

  const renderSpec = composition?.renderSpec || fallbackSpec;
  const type = renderSpec.kind || "custom";
  const html = composition?.html || compositionHtml({ prompt, data: renderSpecToLegacyData(renderSpec), type });
  const indexPath = join(jobDir, "index.html");
  const outputPath = join(jobDir, "video.mp4");
  await writeFile(indexPath, html);
  await writeFile(join(jobDir, "render-spec.json"), JSON.stringify(renderSpec, null, 2));

  if (composition?.html) {
    try {
      await runHyperframesRender(jobDir, outputPath);
      return {
        videoUrl: `/assets/generated/${id}/video.mp4`,
        compositionUrl: `/assets/generated/${id}/index.html`,
        type,
        renderer: "hyperframes",
      };
    } catch (error) {
      console.warn(`HyperFrames render failed, falling back to frame renderer: ${error.message}`);
    }
  }

  const totalFrames = 240;
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const svg = renderSpecSvg(renderSpec, frame);
    await sharp(Buffer.from(svg))
      .png()
      .toFile(join(frameDir, `frame_${String(frame).padStart(3, "0")}.png`));
  }

  await runFfmpeg([
    "-y",
    "-framerate",
    "60",
    "-i",
    join(frameDir, "frame_%03d.png"),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  return {
    videoUrl: `/assets/generated/${id}/video.mp4`,
    compositionUrl: `/assets/generated/${id}/index.html`,
    type,
    renderer: composition?.html ? "fallback-after-hyperframes" : "fallback",
  };
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
  const cleanPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = normalize(join(rootDir, cleanPath));

  if (!filePath.startsWith(rootDir) || !existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const ext = extname(filePath);
  response.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/api/generate") {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const prompt = String(payload.prompt || "").trim();
      const flow = String(payload.flow || "leaderboard");
      if (!prompt) {
        sendJson(response, 400, { error: "Prompt is required" });
        return;
      }

      const result = await generateVideo(prompt, flow);
      sendJson(response, 200, result);
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || "Something went wrong" });
  }
});

server.listen(port, host, () => {
  console.log(`UA Genius prototype running at http://${host}:${port}`);
});
