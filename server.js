// YouTube for Meta Ray-Ban Display — serves the glasses web app and proxies
// YouTube Data API search/trending so the API key never reaches the glasses.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY = process.env.YOUTUBE_API_KEY || "";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const REGION = /^[A-Z]{2}$/.test(process.env.REGION || "") ? process.env.REGION : "US";
const YT = process.env.YOUTUBE_API_BASE || "https://www.googleapis.com/youtube/v3";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const authorized = (req) => !ACCESS_TOKEN || req.headers["x-access-token"] === ACCESS_TOKEN;

// search.list returns HTML-escaped titles.
const decode = (s = "") =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e]);

// ISO 8601 duration (PT1H2M3S) -> seconds
function seconds(iso = "") {
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + min * 60 + s;
}

async function yt(endpoint, params) {
  const url = new URL(`${YT}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: API_KEY })) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data.error?.errors?.[0]?.reason || "";
    const err = new Error(
      reason === "quotaExceeded" ? "YouTube search limit reached for today" :
      reason === "keyInvalid" || res.status === 400 ? "YouTube API key is invalid" :
      data.error?.message || `YouTube error ${res.status}`,
    );
    err.status = res.status;
    throw err;
  }
  return data;
}

const toVideo = (item) => ({
  id: typeof item.id === "string" ? item.id : item.id?.videoId,
  title: decode(item.snippet?.title),
  channel: decode(item.snippet?.channelTitle),
  seconds: seconds(item.contentDetails?.duration),
  live: item.snippet?.liveBroadcastContent === "live",
});

// Small in-memory cache: search costs 100 of the 10,000 free daily quota units.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function search(q) {
  return cached(`s:${q.toLowerCase()}`, 30 * 60 * 1000, async () => {
    const found = await yt("search", {
      part: "snippet", q, type: "video", videoEmbeddable: "true", maxResults: "15", safeSearch: "moderate", regionCode: REGION,
    });
    const ids = found.items.map((i) => i.id.videoId).filter(Boolean);
    if (!ids.length) return [];
    // One extra quota unit gets durations.
    const details = await yt("videos", { part: "snippet,contentDetails", id: ids.join(",") });
    const byId = new Map(details.items.map((i) => [i.id, i]));
    return ids.map((id) => byId.get(id)).filter(Boolean).map(toVideo);
  });
}

async function trending() {
  return cached(`t:${REGION}`, 30 * 60 * 1000, async () => {
    const data = await yt("videos", { part: "snippet,contentDetails,status", chart: "mostPopular", regionCode: REGION, maxResults: "20" });
    return data.items.filter((i) => i.status?.embeddable !== false).map(toVideo);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      locked: Boolean(ACCESS_TOKEN),
      apiKey: Boolean(API_KEY),
      region: REGION,
      version: (process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 7),
    });
  }
  if (!authorized(req)) return sendJson(res, 401, { error: "Wrong or missing access key" });
  if (!API_KEY) return sendJson(res, 500, { error: "YOUTUBE_API_KEY isn't set on the server" });
  try {
    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
      if (!q) return sendJson(res, 400, { error: "Empty search" });
      return sendJson(res, 200, { videos: await search(q) });
    }
    if (url.pathname === "/api/trending") return sendJson(res, 200, { videos: await trending() });
  } catch (err) {
    console.error("YouTube API error:", err);
    return sendJson(res, err.status === 403 || err.status === 400 ? 502 : 500, { error: err.message || "YouTube error" });
  }
  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir + path.sep)) return res.writeHead(403).end();
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") return res.writeHead(405).end();
      return await handleApi(req, res, url);
    }
    if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res, url);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`YouTube for Meta Ray-Ban Display on http://${HOST}:${PORT}`);
  if (!API_KEY) console.warn("Warning: YOUTUBE_API_KEY is not set — search and Hot won't work.");
  if (!ACCESS_TOKEN) console.warn("Warning: ACCESS_TOKEN is not set — anyone with the URL can use your YouTube quota.");
});
