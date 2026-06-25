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
const openAiModel = process.env.OPENAI_MODEL || "gpt-4.1";
const openAiTimeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 9 * 60_000);
const openAiMaxOutputTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 16_000);
const hyperframesTimeoutMs = Number(process.env.HYPERFRAMES_TIMEOUT_MS || 8 * 60_000);
const ffmpegTimeoutMs = Number(process.env.FFMPEG_TIMEOUT_MS || 2 * 60_000);
const generationJobTimeoutMs = Number(process.env.GENERATION_JOB_TIMEOUT_MS || 10 * 60_000);
const jobs = new Map();

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

class GenerationError extends Error {
  constructor(stage, message, options = {}) {
    super(message);
    this.name = "GenerationError";
    this.stage = stage;
    this.code = options.code || "GENERATION_FAILED";
    this.detail = options.detail || "";
    this.suggestion = options.suggestion || "";
  }
}

function errorPayload(error, traceId) {
  const stage = error.stage || "unknown";
  const suggestions = {
    openai:
      "Check OPENAI_API_KEY, OPENAI_MODEL, quota, model access, and OpenAI latency. This product waits for OpenAI instead of substituting fallback creative.",
    hyperframes:
      "Check Chromium/HyperFrames availability, render duration, and whether the generated HTML violates the composition contract.",
    ffmpeg:
      "Check ffmpeg availability, disk space, and whether frame generation completed.",
    fallback:
      "Check prompt parsing and SVG frame rendering. Try a shorter prompt or structured ranking data.",
    generation:
      "The full job hit the 10-minute safety limit. Check the last reported stage and Railway logs for the trace ID.",
    request: "Check the prompt payload and try again.",
    unknown: "Check Railway logs for the trace ID and failing stage.",
  };

  return {
    error: {
      code: error.code || "VIDEO_GENERATION_FAILED",
      message: error.message || "Video generation failed.",
      stage,
      detail: error.detail || "",
      suggestion: error.suggestion || suggestions[stage] || suggestions.unknown,
      traceId,
    },
  };
}

function withTimeout(promise, timeoutMs, stage, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new GenerationError(stage, message, {
          code: "STAGE_TIMEOUT",
          detail: `${stage} exceeded ${Math.round(timeoutMs / 1000)}s`,
        }),
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function stageTimeout(deadlineMs, requestedTimeoutMs, reserveMs = 5_000) {
  if (!deadlineMs) return requestedTimeoutMs;
  const remaining = deadlineMs - Date.now() - reserveMs;
  return Math.max(1_000, Math.min(requestedTimeoutMs, remaining));
}

function assertStageBudget(stage, timeoutMs) {
  if (timeoutMs <= 1_000) {
    throw new GenerationError(stage, `Not enough time left to start ${stage}.`, {
      code: "GENERATION_BUDGET_EXHAUSTED",
      detail: `${stage} had less than 1s remaining before the 10-minute job limit.`,
    });
  }
}

function trimProcessOutput(stdout, stderr, limit = 4_000) {
  const sections = [];
  if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
  if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
  const output = sections.join("\n\n");
  return output ? output.slice(-limit) : "";
}

function safeTimelineScript(durationSeconds) {
  const duration = Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : 4;
  return `<script>
(() => {
  const duration = ${JSON.stringify(clamp(duration, 2, 8))};
  let current = 0;
  let scale = 1;
  const timeline = {
    duration: () => duration,
    time: () => current,
    seek: (value) => {
      current = Math.max(0, Math.min(duration, Number(value) || 0));
      return timeline;
    },
    totalTime: (value) => (value === undefined ? current : timeline.seek(value)),
    play: () => timeline,
    pause: () => timeline,
    timeScale: (value) => {
      if (value !== undefined) scale = Number(value) || 1;
      return scale;
    }
  };
  window.__timelines = window.__timelines || {};
  window.__timelines.main = timeline;
})();
</script>`;
}

function sanitizeCompositionHtml(html, durationSeconds) {
  const withoutScripts = String(html || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const script = safeTimelineScript(durationSeconds);
  if (/<\/body>/i.test(withoutScripts)) return withoutScripts.replace(/<\/body>/i, `${script}</body>`);
  return `${withoutScripts}${script}`;
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

function splitTextLines(value, maxChars = 22, maxLines = 2) {
  const words = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];

  for (const word of words) {
    const current = lines[lines.length - 1] || "";
    if (!current || `${current} ${word}`.length > maxChars) {
      if (lines.length < maxLines) lines.push(word);
      else lines[lines.length - 1] = `${lines[lines.length - 1]} ${word}`;
    } else {
      lines[lines.length - 1] = `${current} ${word}`;
    }
  }

  return lines.length ? lines : [""];
}

function svgTextBlock({ lines, x, y, lineHeight, attrs }) {
  return lines
    .map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" ${attrs}>${escapeXml(line)}</text>`)
    .join("");
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
  const normalized = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    return JSON.parse(normalized);
  } catch {
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return {};
    try {
      return JSON.parse(normalized.slice(start, end + 1));
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
  const durationSeconds = Number(rawSpec.durationSeconds || fallbackData.durationSeconds || fallbackData.duration || 4);

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
    durationSeconds: Number.isFinite(durationSeconds) ? clamp(durationSeconds, 2, 8) : 4,
  };
}

function parsePlainTextLeaderboard(prompt) {
  const text = String(prompt || "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const title = text.match(/\btitle\s*:\s*([^.]*(?:\.[^D])?)/i)?.[1]?.trim().replace(/\s+Data:?$/i, "");
  const duration = Number(text.match(/(\d+(?:\.\d+)?)\s*-\s*second|\b(\d+(?:\.\d+)?)\s*second/i)?.[1] || text.match(/\b(\d+(?:\.\d+)?)\s*second/i)?.[1] || 4);
  const cta = text.match(/\bCTA\s*:\s*(.+)$/i)?.[1]?.trim();
  const dataStart = text.search(/\bData\s*:/i);
  const afterData = dataStart >= 0 ? text.slice(dataStart).replace(/^Data\s*:\s*/i, "") : text;
  const dataText = afterData.split(/\bAnimate\b|\bEnd with\b|\bCTA\s*:/i)[0];
  const rowPattern = /(\d+)\.\s*([A-Za-z0-9][A-Za-z0-9 _.'-]*?)\s*-\s*([\d,]+)\s*([A-Za-z ]+?)?\s*-\s*([^,.;]+)(?=,\s*\d+\.|\.|;|$)/g;
  const items = [];
  let match;

  while ((match = rowPattern.exec(dataText))) {
    items.push({
      rank: Number(match[1]),
      name: match[2].trim(),
      sublabel: match[5].trim(),
      value: Number(match[3].replaceAll(",", "")),
      unit: (match[4] || "").trim(),
    });
  }

  if (!items.length) return null;

  const fiery = /fire|fiery|ember|battle|medieval|purple|red/i.test(text);
  return normalizeRenderSpec({
    kind: "leaderboard",
    title: title || "WEEKLY TOP CLANS",
    subtitle: items[0]?.unit ? `Ranked by ${items[0].unit}` : "",
    cta: cta || "JOIN THE BATTLE",
    durationSeconds: duration,
    theme: fiery
      ? {
          primary: "#FFD700",
          secondary: "#FF3B1F",
          bronze: "#CD7F32",
          background: "#140014",
        }
      : {
          primary: "#FFD700",
          secondary: "#C0C0C0",
          bronze: "#CD7F32",
          background: "#0a0a0a",
        },
    items,
  });
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

  const parsedLeaderboard = parsePlainTextLeaderboard(prompt);
  if (parsedLeaderboard) return parsedLeaderboard;

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
    "final": { "teamA": "string", "teamB": "string" },
    "durationSeconds": 4
  }
}

HTML requirements:
- One complete index.html document.
- 1080x1920 portrait composition.
- Root visual element must include data-composition-id="main", data-width="1080", data-height="1920", data-start="0", data-duration matching renderSpec.durationSeconds, and data-track-index="0".
- Inline CSS only. No script tags, external assets, CDN, or remote images.
- Use deterministic CSS only. No Date.now(), Math.random(), network requests, or infinite loops.
- Use CSS keyframes for animation. Prefer transform and opacity.
- The HTML should visually reflect the user's prompt.
- Do not use JavaScript, repeat: -1, setInterval, setTimeout, requestAnimationFrame, async scripts, or Promise-based timeline construction.
- Keep the HTML compact and under 12,000 characters.

RenderSpec requirements:
- Use the user's JSON/data if present.
- Set durationSeconds from the requested duration when present, between 2 and 8 seconds.
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

  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), openAiTimeoutMs);
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: openAiModel,
        input: buildCompositionPrompt(prompt, flow),
        max_output_tokens: openAiMaxOutputTokens,
      }),
    });
  } catch (error) {
    throw new GenerationError("openai", "OpenAI request did not complete.", {
      code: error.name === "AbortError" ? "OPENAI_TIMEOUT" : "OPENAI_NETWORK_ERROR",
      detail: error.message,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new GenerationError("openai", "OpenAI generation failed.", {
      code: "OPENAI_REQUEST_FAILED",
      detail: errorText.slice(0, 800),
    });
  }

  const json = await response.json();
  const parsed = extractJsonObject(responseText(json));
  if (!parsed.html || !parsed.renderSpec) {
    throw new GenerationError("openai", "OpenAI did not return a valid composition payload.", {
      code: "OPENAI_BAD_PAYLOAD",
      detail: responseText(json).slice(0, 800),
      suggestion:
        "OpenAI responded, but the payload was not parseable as the required JSON composition. Check whether output was truncated or wrapped unexpectedly.",
    });
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
  const titleLines = splitTextLines((data.title || "WEEKLY TOP PLAYERS").replace(/[.]+$/, ""), 21, 2);
  const subtitleY = titleLines.length > 1 ? 282 : 248;
  const ctaLines = splitTextLines(data.cta || "CAN YOU BEAT THEM?", 24, 2);

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
      ${svgTextBlock({
        lines: titleLines,
        x: 540,
        y: titleLines.length > 1 ? 145 : 178,
        lineHeight: 64,
        attrs: `text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="900" fill="${escapeXml(theme.primary || "#FFD700")}" filter="url(#glow)"`,
      })}
      <text x="540" y="${subtitleY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700" fill="${escapeXml(theme.secondary || "#C0C0C0")}">${escapeXml(data.subtitle || "")}</text>
      ${rows.join("")}
      ${svgTextBlock({
        lines: ctaLines,
        x: 540,
        y: ctaLines.length > 1 ? 1565 : 1600,
        lineHeight: 58,
        attrs: `text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="50" font-weight="900" fill="#ffffff" opacity="${ctaOpacity}" filter="url(#glow)"`,
      })}
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
      durationSeconds: spec.durationSeconds,
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
    durationSeconds: spec.durationSeconds,
  };
}

function renderSpecSvg(spec, frame) {
  const legacyData = renderSpecToLegacyData(spec);
  return spec.kind === "bracket" ? bracketSvg(legacyData, frame) : leaderboardSvg(legacyData, frame);
}

async function runFfmpeg(args, timeoutMs = ffmpegTimeoutMs) {
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { cwd: rootDir, stdio: ["ignore", "ignore", "pipe"] });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new GenerationError("ffmpeg", "ffmpeg timed out while encoding the video.", {
          code: "FFMPEG_TIMEOUT",
          detail: `ffmpeg exceeded ${Math.round(timeoutMs / 1000)}s.`,
        }),
      );
    }, timeoutMs);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new GenerationError("ffmpeg", "ffmpeg could not start.", {
          code: "FFMPEG_UNAVAILABLE",
          detail: error.message,
        }),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        reject(
          new GenerationError("ffmpeg", "ffmpeg failed while encoding the video.", {
            code: "FFMPEG_FAILED",
            detail: stderr.slice(-1000) || `ffmpeg exited with ${code}`,
          }),
        );
      }
    });
  });
}

function hyperframesCommand() {
  if (process.env.HYPERFRAMES_BIN) {
    const command = process.env.HYPERFRAMES_BIN;
    const needsPackageArg = command.endsWith("npx") || command === "npx" || command.endsWith("bunx") || command === "bunx";
    return { command, prefixArgs: needsPackageArg ? ["hyperframes"] : [] };
  }

  const localBinary = join(rootDir, "node_modules", ".bin", "hyperframes");
  if (existsSync(localBinary)) return { command: localBinary, prefixArgs: [] };
  return { command: "npx", prefixArgs: ["hyperframes"] };
}

async function runHyperframesRender(jobDir, outputPath, timeoutMs = hyperframesTimeoutMs) {
  const { command, prefixArgs } = hyperframesCommand();
  const args = [
    ...prefixArgs,
    "render",
    jobDir,
    "--output",
    outputPath,
    "--fps",
    "60",
    "--quality",
    "draft",
    "--workers",
    "1",
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new GenerationError("hyperframes", "HyperFrames render timed out.", {
          code: "HYPERFRAMES_TIMEOUT",
          detail:
            trimProcessOutput(stdout, stderr) ||
            `Command exceeded ${Math.round(timeoutMs / 1000)}s: ${command} ${args.join(" ")}`,
          suggestion:
            "HyperFrames started but did not finish inside the render budget. Check Railway CPU/memory, Chromium availability, and generated composition complexity.",
        }),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new GenerationError("hyperframes", "HyperFrames could not start.", {
          code: "HYPERFRAMES_UNAVAILABLE",
          detail: `${error.message}\nCommand: ${command} ${args.join(" ")}`,
        }),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        reject(
          new GenerationError("hyperframes", "HyperFrames render failed.", {
            code: "HYPERFRAMES_FAILED",
            detail: trimProcessOutput(stdout, stderr) || `hyperframes exited with ${code}`,
          }),
        );
      }
    });
  });
}

async function generateVideo(prompt, flow = "leaderboard", options = {}) {
  const onStage = options.onStage || (() => {});
  const deadlineMs = options.deadlineMs || Date.now() + generationJobTimeoutMs;
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const jobDir = join(generatedDir, id);
  const frameDir = join(jobDir, "frames");
  await mkdir(frameDir, { recursive: true });
  const fallbackSpec = fallbackRenderSpec(prompt);
  let composition = null;
  const warnings = [];
  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);

  try {
    onStage("openai", "Generating composition with OpenAI. This can take several minutes for detailed prompts.");
    composition = await generateCompositionWithOpenAI(prompt, flow);
  } catch (error) {
    if (hasOpenAiKey) {
      throw error;
    }

    warnings.push({
      stage: error.stage || "openai",
      code: error.code || "OPENAI_FAILED",
      message: error.message,
      detail: error.detail || "",
    });
    console.warn(`[openai] ${error.message}`);
  }

  onStage("prepare", "Preparing the generated composition for rendering.");
  const renderSpec = composition?.renderSpec || fallbackSpec;
  const type = renderSpec.kind || "custom";
  const html = composition?.html
    ? sanitizeCompositionHtml(composition.html, renderSpec.durationSeconds)
    : compositionHtml({ prompt, data: renderSpecToLegacyData(renderSpec), type });
  const indexPath = join(jobDir, "index.html");
  const outputPath = join(jobDir, "video.mp4");
  await writeFile(indexPath, html);
  await writeFile(join(jobDir, "render-spec.json"), JSON.stringify(renderSpec, null, 2));

  if (composition?.html) {
    try {
      const renderTimeoutMs = stageTimeout(deadlineMs, hyperframesTimeoutMs);
      assertStageBudget("hyperframes", renderTimeoutMs);
      onStage(
        "hyperframes",
        `Rendering the composition with HyperFrames. Render budget: ${Math.round(renderTimeoutMs / 1000)}s.`,
      );
      await runHyperframesRender(jobDir, outputPath, renderTimeoutMs);
      return {
        videoUrl: `/assets/generated/${id}/video.mp4`,
        compositionUrl: `/assets/generated/${id}/index.html`,
        type,
        renderer: "hyperframes",
        warnings,
      };
    } catch (error) {
      warnings.push({
        stage: error.stage || "hyperframes",
        code: error.code || "HYPERFRAMES_FAILED",
        message: error.message,
        detail: error.detail || "",
      });
      console.warn(`[hyperframes] Rendering backup MP4 with frame renderer: ${error.message}`);
    }
  }

  const frameRate = 30;
  const totalFrames = Math.round((renderSpec.durationSeconds || 4) * frameRate);
  const frameNumbers = Array.from({ length: totalFrames }, (_, frame) => frame);
  const batchSize = Number(process.env.FRAME_RENDER_CONCURRENCY || 6);
  onStage("fallback", "Rendering backup frames from the generated render spec.");
  for (let index = 0; index < frameNumbers.length; index += batchSize) {
    const batch = frameNumbers.slice(index, index + batchSize);
    await Promise.all(
      batch.map(async (frame) => {
        const svg = renderSpecSvg(renderSpec, frame * 2);
        await sharp(Buffer.from(svg))
          .png()
          .toFile(join(frameDir, `frame_${String(frame).padStart(3, "0")}.png`));
      }),
    );
  }

  const encodeTimeoutMs = stageTimeout(deadlineMs, ffmpegTimeoutMs);
  assertStageBudget("ffmpeg", encodeTimeoutMs);
  onStage("ffmpeg", `Encoding the rendered frames into MP4. Encode budget: ${Math.round(encodeTimeoutMs / 1000)}s.`);
  await runFfmpeg([
    "-y",
    "-framerate",
    String(frameRate),
    "-i",
    join(frameDir, "frame_%03d.png"),
    "-c:v",
    "libx264",
    "-r",
    "60",
    "-preset",
    "ultrafast",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ], encodeTimeoutMs);

  return {
    videoUrl: `/assets/generated/${id}/video.mp4`,
    compositionUrl: `/assets/generated/${id}/index.html`,
    type,
    renderer: composition?.html ? "fallback-after-hyperframes" : "fallback",
    warnings,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result || null,
    error: job.error || null,
  };
}

function startGenerationJob({ prompt, flow, traceId }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  const now = new Date().toISOString();
  const deadlineMs = Date.now() + generationJobTimeoutMs;
  const job = {
    id,
    traceId,
    prompt,
    flow,
    status: "queued",
    stage: "queued",
    message: "Generation queued.",
    createdAt: now,
    updatedAt: now,
    result: null,
    error: null,
  };
  jobs.set(id, job);

  queueMicrotask(async () => {
    const updateStage = (stage, message) => {
      job.status = "running";
      job.stage = stage;
      job.message = message;
      job.updatedAt = new Date().toISOString();
      console.log(`[${traceId}] job=${id} stage=${stage} ${message}`);
    };

    updateStage("openai", "Generating composition with OpenAI.");

    try {
      const result = await withTimeout(
        generateVideo(prompt, flow, { onStage: updateStage, deadlineMs }),
        generationJobTimeoutMs,
        "generation",
        "Video generation exceeded the 10-minute safety limit.",
      );
      job.status = "succeeded";
      job.stage = "complete";
      job.message = "Video generated.";
      job.result = { ...result, traceId };
      job.updatedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed";
      job.stage = error.stage || "unknown";
      job.message = error.message || "Video generation failed.";
      job.error = errorPayload(error, traceId).error;
      job.updatedAt = new Date().toISOString();
      console.error(
        `[${traceId}] job=${id} failed stage=${job.stage} code=${job.error.code} message=${job.message} detail=${String(
          job.error.detail || "",
        ).slice(0, 2000)}`,
      );
    }
  });

  return job;
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
  const traceId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
    if (request.method === "GET" && requestUrl.pathname.startsWith("/api/jobs/")) {
      const jobId = decodeURIComponent(requestUrl.pathname.slice("/api/jobs/".length));
      const job = jobs.get(jobId);
      if (!job) {
        sendJson(
          response,
          404,
          errorPayload(
            new GenerationError("request", "Generation job was not found.", {
              code: "JOB_NOT_FOUND",
            }),
            traceId,
          ),
        );
        return;
      }

      sendJson(response, 200, publicJob(job));
      return;
    }

    if (request.method === "POST" && request.url === "/api/generate") {
      const body = await readBody(request);
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch (error) {
        sendJson(
          response,
          400,
          errorPayload(
            new GenerationError("request", "Request body must be valid JSON.", {
              code: "BAD_JSON",
              detail: error.message,
            }),
            traceId,
          ),
        );
        return;
      }
      const prompt = String(payload.prompt || "").trim();
      const flow = String(payload.flow || "leaderboard");
      if (!prompt) {
        sendJson(
          response,
          400,
          errorPayload(
            new GenerationError("request", "Prompt is required.", {
              code: "PROMPT_REQUIRED",
            }),
            traceId,
          ),
        );
        return;
      }

      const job = startGenerationJob({ prompt, flow, traceId });
      sendJson(response, 202, {
        jobId: job.id,
        status: job.status,
        stage: job.stage,
        message: job.message,
        statusUrl: `/api/jobs/${job.id}`,
        traceId,
      });
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    console.error(`[${traceId}]`, error);
    sendJson(response, 500, errorPayload(error, traceId));
  }
});

server.listen(port, host, () => {
  console.log(`UA Genius prototype running at http://${host}:${port}`);
});
