import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const frameDir = join(process.cwd(), "assets", "leaderboard_frames");
await mkdir(frameDir, { recursive: true });

const players = [
  {
    rank: 1,
    name: "ShadowHunter",
    clan: "AlphaSquad",
    score: 15420,
    color: "#FFD700",
    width: 1,
  },
  {
    rank: 2,
    name: "NightStalker",
    clan: "BravoTeam",
    score: 12800,
    color: "#C0C0C0",
    width: 0.82,
  },
  {
    rank: 3,
    name: "PhoenixRise",
    clan: "CharlieUnit",
    score: 10100,
    color: "#CD7F32",
    width: 0.65,
  },
];

const totalFrames = 240;
const fps = 60;

function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function formatScore(value) {
  return Math.round(value).toLocaleString("en-US");
}

function row(player, index, frame) {
  const seconds = frame / fps;
  const start = 0.35 + index * 0.28;
  const progress = easeOutCubic(clamp((seconds - start) / 0.65));
  const countProgress = easeOutCubic(clamp((seconds - start) / 2));
  const y = 510 + index * 180;
  const rowX = 150 + (1 - progress) * 160;
  const rowOpacity = progress;
  const barWidth = 780 * player.width * countProgress;
  const score = formatScore(player.score * countProgress);

  return `
    <g transform="translate(${rowX}, ${y})" opacity="${rowOpacity}">
      <rect x="0" y="0" width="780" height="116" rx="24" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.16)" />
      <rect x="0" y="0" width="${barWidth}" height="116" rx="24" fill="${player.color}" opacity="0.22" />
      <circle cx="58" cy="58" r="34" fill="${player.color}" opacity="0.22" stroke="${player.color}" stroke-width="3" />
      <text x="54" y="73" text-anchor="middle" font-size="42" font-weight="800" fill="${player.color}">${player.rank}</text>
      <text x="120" y="52" font-size="42" font-weight="800" fill="#ffffff">${player.name}</text>
      <text x="122" y="88" font-size="27" font-weight="600" fill="#888888">${player.clan}</text>
      <text x="742" y="70" text-anchor="end" font-size="42" font-weight="800" fill="${player.color}">${score}</text>
    </g>`;
}

for (let frame = 0; frame < totalFrames; frame += 1) {
  const seconds = frame / fps;
  const flashOpacity = seconds < 0.28 ? 0.22 * (1 - seconds / 0.28) : seconds > 3.78 ? 0.24 * clamp((seconds - 3.78) / 0.22) : 0;
  const ctaOpacity = clamp((seconds - 3) / 0.45);
  const shake = seconds > 3.45 && seconds < 3.65 ? Math.sin(frame * 1.9) * 8 : 0;
  const scanY = (frame * 7) % 14;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0a0a0a"/>
        <stop offset="100%" stop-color="#1a0000"/>
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
    <g opacity="0.18">
      <circle cx="140" cy="280" r="3" fill="#ffffff" />
      <circle cx="880" cy="410" r="2" fill="#ffffff" />
      <circle cx="320" cy="1260" r="2" fill="#ffffff" />
      <circle cx="760" cy="1440" r="3" fill="#ffffff" />
      <circle cx="520" cy="1020" r="2" fill="#FFD700" />
    </g>
    <g transform="translate(${shake}, 0)">
      <text x="540" y="178" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="900" fill="#FFD700" filter="url(#glow)">WEEKLY TOP PLAYERS</text>
      <text x="540" y="248" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700" fill="#C0C0C0">Season 8 - Week 3</text>
      ${players.map((player, index) => row(player, index, frame)).join("")}
      <text x="540" y="1600" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="900" fill="#ffffff" opacity="${ctaOpacity}" filter="url(#glow)">CAN YOU BEAT THEM?</text>
    </g>
    <rect width="1080" height="1920" fill="#ff0000" opacity="${flashOpacity}" />
    <g opacity="0.06">
      ${Array.from({ length: 140 }, (_, index) => `<rect x="0" y="${index * 14 + scanY}" width="1080" height="2" fill="#ffffff" />`).join("")}
    </g>
  </svg>`;

  const frameName = String(frame).padStart(3, "0");
  await writeFile(join(frameDir, `frame_${frameName}.svg`), svg);
  await sharp(Buffer.from(svg)).png().toFile(join(frameDir, `frame_${frameName}.png`));
}
