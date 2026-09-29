// YouTube for Meta Ray-Ban Display — serves the glasses web app and proxies
// YouTube Data API search/trending so the API key never reaches the glasses.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY = process.env.YOUTUBE_API_KEY || "";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const REGION = /^[A-Z]{2}$/.test(process.env.REGION || "") ? process.env.REGION : "US";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const OAUTH = process.env.GOOGLE_OAUTH_BASE || "https://oauth2.googleapis.com";
const YT_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
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

// Calls the YouTube Data API with the server's API key, or as the signed-in user.
async function yt(endpoint, params, accessToken) {
  const url = new URL(`${YT}/${endpoint}`);
  for (const [k, v] of Object.entries(accessToken ? params : { ...params, key: API_KEY })) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data.error?.errors?.[0]?.reason || "";
    const err = new Error(
      reason === "quotaExceeded" ? "YouTube search limit reached for today" :
      reason === "keyInvalid" || (res.status === 400 && !accessToken) ? "YouTube API key is invalid" :
      reason === "youtubeSignupRequired" || reason === "channelNotFound" ? "This Google account has no YouTube channel" :
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

// --- Google sign-in (device flow: code on the glasses, approve on your phone) --

const signInEnabled = () => Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

// The refresh token lives on the glasses, sealed with a key only this server has.
const sealKey = () => createHash("sha256").update("glasses-youtube:" + GOOGLE_CLIENT_SECRET).digest();
function seal(text) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey(), iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}
function unseal(blob) {
  try {
    const raw = Buffer.from(String(blob), "base64url");
    const d = createDecipheriv("aes-256-gcm", sealKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

async function oauth(endpoint, form) {
  const res = await fetch(`${OAUTH}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(8000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

class SignedOut extends Error {}

const accessCache = new Map(); // sha256(refresh token) -> { token, until }
async function accessTokenFor(req) {
  const refresh = unseal(req.headers["x-google-session"] || "");
  if (!refresh) throw new SignedOut("Not signed in");
  const key = createHash("sha256").update(refresh).digest("hex");
  const hit = accessCache.get(key);
  if (hit && hit.until > Date.now()) return { token: hit.token, key };
  const { status, data } = await oauth("token", {
    client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token",
  });
  if (!data.access_token) {
    if (status === 400 || status === 401) throw new SignedOut("Google sign-in expired. Sign in again.");
    throw new Error(data.error_description || "Couldn't reach Google");
  }
  if (accessCache.size > 100) accessCache.clear();
  accessCache.set(key, { token: data.access_token, until: Date.now() + (Number(data.expires_in) - 120) * 1000 });
  return { token: data.access_token, key };
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16 * 1024) throw new Error("Request too large");
  }
  return body ? JSON.parse(body) : {};
}

// Look up full details (duration, embeddable) for a list of ids, keeping order.
async function details(ids, token) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await yt("videos", { part: "snippet,contentDetails,status", id: chunk.join(",") }, token);
    const byId = new Map(data.items.map((it) => [it.id, it]));
    for (const id of chunk) {
      const it = byId.get(id);
      if (it && it.status?.embeddable !== false) out.push(toVideo(it));
    }
  }
  return out;
}

// Newest uploads across the channels you subscribe to (first 50 by relevance).
async function subscriptionFeed(token, key) {
  return cached(`subs:${key}`, 15 * 60 * 1000, async () => {
    const subs = await yt("subscriptions", { part: "snippet", mine: "true", maxResults: "50", order: "relevance" }, token);
    const channels = subs.items.map((s) => s.snippet?.resourceId?.channelId).filter(Boolean);
    const uploads = await Promise.all(
      channels.map((ch) =>
        yt("playlistItems", { part: "contentDetails", playlistId: "UU" + ch.slice(2), maxResults: "4" }, token)
          .then((d) => d.items)
          .catch(() => []),
      ),
    );
    const newest = uploads
      .flat()
      .map((it) => ({ id: it.contentDetails?.videoId, at: it.contentDetails?.videoPublishedAt || "" }))
      .filter((v) => v.id)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 40)
      .map((v) => v.id);
    return details(newest, token);
  });
}

async function handleAccount(req, res, url) {
  if (!signInEnabled()) return sendJson(res, 501, { error: "Google sign-in isn't set up on the server" });

  if (url.pathname === "/api/auth/start" && req.method === "POST") {
    const { status, data } = await oauth("device/code", { client_id: GOOGLE_CLIENT_ID, scope: YT_SCOPE });
    if (!data.device_code) return sendJson(res, 502, { error: data.error_description || data.error || `Google error ${status}` });
    return sendJson(res, 200, {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUrl: data.verification_url || data.verification_uri || "https://www.google.com/device",
      interval: Number(data.interval) || 5,
      expiresIn: Number(data.expires_in) || 1800,
    });
  }

  if (url.pathname === "/api/auth/poll" && req.method === "POST") {
    const { deviceCode } = await readJson(req);
    if (typeof deviceCode !== "string" || !deviceCode) return sendJson(res, 400, { error: "Missing device code" });
    const { data } = await oauth("token", {
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (data.refresh_token) return sendJson(res, 200, { session: seal(data.refresh_token) });
    if (data.error === "authorization_pending") return sendJson(res, 200, { pending: true });
    if (data.error === "slow_down") return sendJson(res, 200, { pending: true, slowDown: true });
    if (data.error === "access_denied") return sendJson(res, 200, { denied: true });
    return sendJson(res, 200, { expired: true, error: data.error_description || data.error || "Sign-in failed" });
  }

  if (url.pathname === "/api/auth/signout" && req.method === "POST") {
    const refresh = unseal(req.headers["x-google-session"] || "");
    if (refresh) await oauth("revoke", { token: refresh }).catch(() => {});
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  const { token, key } = await accessTokenFor(req);

  if (url.pathname === "/api/me") {
    const data = await cached(`me:${key}`, 60 * 60 * 1000, () => yt("channels", { part: "snippet", mine: "true" }, token));
    return sendJson(res, 200, { name: data.items?.[0]?.snippet?.title || "YouTube account" });
  }
  if (url.pathname === "/api/me/subs") return sendJson(res, 200, { videos: await subscriptionFeed(token, key) });
  if (url.pathname === "/api/me/liked") {
    const data = await yt("videos", { part: "snippet,contentDetails,status", myRating: "like", maxResults: "50" }, token);
    return sendJson(res, 200, { videos: data.items.filter((i) => i.status?.embeddable !== false).map(toVideo) });
  }
  if (url.pathname === "/api/me/playlists") {
    const data = await yt("playlists", { part: "snippet,contentDetails", mine: "true", maxResults: "25" }, token);
    return sendJson(res, 200, {
      playlists: data.items.map((p) => ({ id: p.id, title: decode(p.snippet?.title), count: p.contentDetails?.itemCount ?? 0 })),
    });
  }
  if (url.pathname === "/api/me/playlist") {
    const id = url.searchParams.get("id") || "";
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) return sendJson(res, 400, { error: "Bad playlist id" });
    const data = await yt("playlistItems", { part: "contentDetails", playlistId: id, maxResults: "50" }, token);
    const ids = data.items.map((i) => i.contentDetails?.videoId).filter(Boolean);
    return sendJson(res, 200, { videos: await details(ids, token) });
  }
  sendJson(res, 404, { error: "Not found" });
}

// --- For you -----------------------------------------------------------------
// YouTube's API no longer exposes personal recommendations or "related videos", so
// this builds a feed from the wearer's own signals: videos watched/saved in the app
// (sent by the glasses) plus liked videos when signed in. It mixes new uploads from
// the channels they watch most with trending videos in their favourite categories.
// Costs ~10 quota units (no search calls).
async function forYou(seedIds, req) {
  let token = null;
  let userKey = "anon";
  if (signInEnabled() && req.headers["x-google-session"]) {
    try {
      ({ token, key: userKey } = await accessTokenFor(req));
    } catch { /* fall back to the in-app signals only */ }
  }
  return cached(`fy:${userKey}:${seedIds.join(",")}`, 20 * 60 * 1000, async () => {
    const seeds = [];
    if (seedIds.length) seeds.push(...(await yt("videos", { part: "snippet", id: seedIds.join(",") })).items);
    if (token) {
      const liked = await yt("videos", { part: "snippet", myRating: "like", maxResults: "25" }, token).catch(() => ({ items: [] }));
      seeds.push(...liked.items);
    }
    if (!seeds.length) return [];

    const tally = (key) => {
      const counts = new Map();
      for (const v of seeds) {
        const k = key(v);
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    };
    const channels = tally((v) => v.snippet?.channelId).slice(0, 6);
    const categories = tally((v) => v.snippet?.categoryId).slice(0, 3);

    const [uploads, popular] = await Promise.all([
      Promise.all(
        channels.map((ch) =>
          yt("playlistItems", { part: "contentDetails", playlistId: "UU" + ch.slice(2), maxResults: "4" })
            .then((d) => d.items.map((i) => i.contentDetails?.videoId))
            .catch(() => []),
        ),
      ),
      Promise.all(
        categories.map((cat) =>
          yt("videos", { part: "id", chart: "mostPopular", regionCode: REGION, videoCategoryId: cat, maxResults: "8" })
            .then((d) => d.items.map((i) => i.id))
            .catch(() => []), // some categories have no chart
        ),
      ),
    ]);

    // Interleave: one from each channel, one from each category, repeat.
    const seen = new Set(seeds.map((v) => v.id));
    const picked = [];
    const lanes = [...uploads, ...popular];
    for (let round = 0; picked.length < 30 && lanes.some((l) => l.length > round); round++) {
      for (const lane of lanes) {
        const id = lane[round];
        if (id && !seen.has(id)) {
          seen.add(id);
          picked.push(id);
        }
      }
    }
    return details(picked.slice(0, 30));
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      locked: Boolean(ACCESS_TOKEN),
      apiKey: Boolean(API_KEY),
      signIn: signInEnabled(),
      region: REGION,
      version: (process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 7),
    });
  }
  if (!authorized(req)) return sendJson(res, 401, { error: "Wrong or missing access key" });
  if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/me" || url.pathname.startsWith("/api/me/")) {
    try {
      return await handleAccount(req, res, url);
    } catch (err) {
      if (err instanceof SignedOut) return sendJson(res, 401, { error: err.message, signedOut: true });
      console.error("Account error:", err);
      return sendJson(res, 502, { error: err.message || "YouTube error" });
    }
  }
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  if (!API_KEY) return sendJson(res, 500, { error: "YOUTUBE_API_KEY isn't set on the server" });
  try {
    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
      if (!q) return sendJson(res, 400, { error: "Empty search" });
      return sendJson(res, 200, { videos: await search(q) });
    }
    if (url.pathname === "/api/trending") return sendJson(res, 200, { videos: await trending() });
    if (url.pathname === "/api/foryou") {
      const seeds = (url.searchParams.get("seeds") || "")
        .split(",")
        .filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id))
        .slice(0, 20);
      return sendJson(res, 200, { videos: await forYou(seeds, req) });
    }
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
