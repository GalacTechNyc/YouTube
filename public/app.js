// YouTube for Meta Ray-Ban Display.
// Input on the glasses arrives as ArrowUp/Down/Left/Right, Enter (pinch) and
// Escape (back). Pinching the focused search box opens the on-glasses voice /
// handwriting composer; the text comes back through `input`/`change` events.
// Playback uses YouTube's official IFrame Player API with its own controls
// hidden; the iframe never takes focus, so keys always reach this page.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const homeEl = $("home");
  const statusEl = $("status");
  const searchEl = $("search");
  const tabs = [$("tabHot"), $("tabRecent"), $("tabSaved")];
  const listTitleEl = $("listTitle");
  const listEl = $("list");
  const emptyEl = $("empty");
  const playerEl = $("player");
  const titleEl = $("title");
  const progressEl = $("progress");
  const metaEl = $("meta");
  const topRow = [searchEl, ...tabs];

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  // Access key: open the app once as https://your-host/?key=YOUR_ACCESS_TOKEN
  const params = new URLSearchParams(location.search);
  if (params.has("key")) {
    store.set("accessKey", params.get("key"));
    history.replaceState(null, "", location.pathname);
  }
  const accessKey = store.get("accessKey", "");

  let recent = store.get("recent", []); // [{id,title,channel,seconds,live}]
  let saved = store.get("saved", []);
  let tab = "hot";
  let videos = []; // the list currently shown
  let listLabel = "";
  let view = "home";

  function setStatus(text, kind = "") {
    statusEl.textContent = text;
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };

  const isSaved = (id) => saved.some((v) => v.id === id);

  // --- Data ------------------------------------------------------------------

  async function api(path) {
    const res = await fetch(path, { headers: { "X-Access-Token": accessKey } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Wrong access key");
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    return body;
  }

  async function loadTab(name, { focusList = false } = {}) {
    tab = name;
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    if (name === "recent") return showList(recent, "Recently watched", "Nothing watched yet.", focusList);
    if (name === "saved") return showList(saved, "Saved", "Swipe → on a video to save it.", focusList);
    showList([], "Trending", "", false);
    setStatus("Loading…", "busy");
    try {
      const { videos: found } = await api("api/trending");
      if (tab !== "hot") return;
      setStatus("");
      showList(found, "Trending now", "Nothing trending right now.", focusList);
    } catch (err) {
      if (tab === "hot") setStatus(err.message, "error");
    }
  }

  async function runSearch() {
    const q = searchEl.value.trim();
    if (!q) return;
    searchEl.blur();
    tab = "search";
    tabs.forEach((t) => t.classList.remove("active"));
    showList([], `“${q}”`, "", false);
    setStatus("Searching…", "busy");
    try {
      const { videos: found } = await api(`api/search?q=${encodeURIComponent(q)}`);
      if (tab !== "search") return;
      setStatus("");
      showList(found, `“${q}”`, "No videos found.", true);
    } catch (err) {
      setStatus(err.message, "error");
      searchEl.focus();
    }
  }

  // --- List ------------------------------------------------------------------

  function showList(list, label, emptyText, focusFirst) {
    videos = list;
    listLabel = label;
    listTitleEl.textContent = label;
    emptyEl.hidden = list.length > 0 || !emptyText;
    emptyEl.textContent = emptyText;
    listEl.replaceChildren(...list.map(renderItem));
    if (focusFirst && list.length) listEl.children[0].focus();
  }

  function renderItem(v, i) {
    const item = document.createElement("button");
    item.className = "focusable item";
    item.dataset.index = String(i);

    const thumb = document.createElement("span");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`;
    thumb.append(img);
    if (v.live || v.seconds) {
      const dur = document.createElement("span");
      dur.className = "dur" + (v.live ? " live" : "");
      dur.textContent = v.live ? "LIVE" : fmtTime(v.seconds);
      thumb.append(dur);
    }

    const text = document.createElement("span");
    text.className = "text";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = v.title;
    const c = document.createElement("span");
    c.className = "c";
    c.textContent = v.channel || "YouTube";
    if (isSaved(v.id)) {
      const star = document.createElement("span");
      star.className = "star";
      star.textContent = "★ ";
      c.prepend(star);
    }
    text.append(t, c);
    item.append(thumb, text);
    item.addEventListener("click", () => play(i));
    item.addEventListener("focus", () => setStatus(isSaved(v.id) ? "→ unsave" : "→ save"));
    return item;
  }

  function toggleSave(i) {
    const v = videos[i];
    if (!v) return;
    const nowSaved = !isSaved(v.id);
    saved = nowSaved ? [v, ...saved].slice(0, 100) : saved.filter((s) => s.id !== v.id);
    store.set("saved", saved);
    if (tab === "saved") {
      showList(saved, "Saved", "Swipe → on a video to save it.", false);
      const next = listEl.children[Math.min(i, listEl.children.length - 1)];
      (next || tabs[2]).focus();
    } else {
      listEl.children[i].replaceWith(renderItem(v, i));
      listEl.children[i].focus();
    }
    setStatus(nowSaved ? "★ Saved" : "Removed"); // after focus, which shows the hint
  }

  // --- Player ----------------------------------------------------------------

  let ytApi = null;
  let player = null;
  let playerReady = false;
  let current = 0;
  let timer = null;
  let notice = "";
  let volume = store.get("volume", 80);

  function loadYouTubeApi() {
    if (!ytApi) {
      ytApi = new Promise((resolve, reject) => {
        window.onYouTubeIframeAPIReady = () => resolve(window.YT);
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        tag.onerror = () => { ytApi = null; reject(new Error("Couldn't load YouTube")); };
        document.head.append(tag);
      });
    }
    return ytApi;
  }

  function renderMeta() {
    if (!player || !playerReady) { metaEl.textContent = notice || "Loading…"; return; }
    const cur = player.getCurrentTime() || 0;
    const dur = player.getDuration() || 0;
    progressEl.style.width = dur ? `${Math.min(100, (cur / dur) * 100)}%` : "0";
    const state = player.getPlayerState();
    const icon = state === 1 ? "▶" : state === 3 ? "…" : "⏸";
    metaEl.textContent = notice || `${icon}  ${fmtTime(cur)} / ${fmtTime(dur)}   ·   Vol ${volume}`;
  }

  function flash(text, ms = 1500) {
    notice = text;
    renderMeta();
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { notice = ""; renderMeta(); }, ms);
  }

  function remember(v) {
    recent = [v, ...recent.filter((r) => r.id !== v.id)].slice(0, 30);
    store.set("recent", recent);
  }

  async function play(i) {
    const v = videos[i];
    if (!v) return;
    current = i;
    view = "player";
    homeEl.hidden = true;
    playerEl.hidden = false;
    playerEl.focus();
    titleEl.textContent = v.title;
    progressEl.style.width = "0";
    notice = "";
    remember(v);
    clearInterval(timer);
    timer = setInterval(renderMeta, 500);

    if (player && playerReady) {
      player.loadVideoById(v.id);
      return;
    }
    renderMeta();
    try {
      const YT = await loadYouTubeApi();
      if (player) return; // created while we waited; onReady plays the current video
      player = new YT.Player("ytPlayer", {
        width: 600,
        height: 338,
        videoId: v.id,
        playerVars: { autoplay: 1, playsinline: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: (e) => {
            playerReady = true;
            const frame = e.target.getIframe();
            frame.setAttribute("tabindex", "-1");
            frame.setAttribute("allow", "autoplay; encrypted-media");
            e.target.setVolume(volume);
            if (videos[current].id !== v.id) e.target.loadVideoById(videos[current].id);
            else e.target.playVideo();
            playerEl.focus();
            // If the browser blocked autoplay with sound, ask for a pinch.
            setTimeout(() => {
              if (view === "player" && ![1, 3].includes(e.target.getPlayerState())) flash("Pinch to play", 4000);
            }, 2500);
          },
          onStateChange: (e) => {
            // Autoplay the next video in the list when one ends.
            if (e.data === 0 && view === "player" && current + 1 < videos.length) play(current + 1);
          },
          onError: (e) => {
            flash(e.data === 101 || e.data === 150 ? "This video can't play here" : "Couldn't play this video", 3000);
          },
        },
      });
    } catch (err) {
      flash(err.message || "Couldn't load YouTube", 4000);
    }
  }

  function closePlayer() {
    if (player && playerReady) player.stopVideo();
    clearInterval(timer);
    view = "home";
    playerEl.hidden = true;
    homeEl.hidden = false;
    if (tab === "recent") showList(recent, "Recently watched", "Nothing watched yet.", false);
    const item = listEl.children[Math.min(current, listEl.children.length - 1)];
    (item || searchEl).focus();
  }

  // --- Input -----------------------------------------------------------------

  // Text from the on-glasses composer arrives as a change event.
  searchEl.addEventListener("change", () => { if (searchEl.value.trim()) runSearch(); });
  tabs.forEach((t) => t.addEventListener("click", () => loadTab(t.dataset.tab, { focusList: true })));

  function handleHomeKey(e) {
    const active = document.activeElement;
    const items = [...listEl.children];
    const rowIndex = topRow.indexOf(active);
    const itemIndex = items.indexOf(active);

    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        if (itemIndex >= 0) {
          if (e.key === "ArrowRight") toggleSave(itemIndex);
          return;
        }
        const next = Math.max(0, Math.min(topRow.length - 1, (rowIndex < 0 ? 0 : rowIndex) + (e.key === "ArrowLeft" ? -1 : 1)));
        topRow[next].focus();
        break;
      }
      case "ArrowDown":
        e.preventDefault();
        if (itemIndex >= 0) {
          const next = items[Math.min(items.length - 1, itemIndex + 1)];
          next.focus();
          next.scrollIntoView({ block: "nearest" });
        } else if (items.length) {
          items[0].focus();
          items[0].scrollIntoView({ block: "nearest" });
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (itemIndex > 0) {
          items[itemIndex - 1].focus();
          items[itemIndex - 1].scrollIntoView({ block: "nearest" });
        } else if (itemIndex === 0) {
          const activeTab = tabs.find((t) => t.classList.contains("active"));
          (activeTab || searchEl).focus();
          setStatus("");
        }
        break;
      case "Enter":
        // With text already typed (e.g. in the browser simulator), Enter searches.
        // On an empty box, let the pinch through so the glasses open the composer.
        if (active === searchEl && searchEl.value.trim()) {
          e.preventDefault();
          runSearch();
        }
        break;
    }
  }

  function handlePlayerKey(e) {
    if (!player || !playerReady) {
      if (e.key === "Escape") { e.preventDefault(); closePlayer(); }
      return;
    }
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        if (player.getPlayerState() === 1) player.pauseVideo();
        else player.playVideo();
        notice = "";
        setTimeout(renderMeta, 150);
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const delta = e.key === "ArrowLeft" ? -10 : 10;
        const to = Math.max(0, Math.min((player.getDuration() || 0) - 1, (player.getCurrentTime() || 0) + delta));
        player.seekTo(to, true);
        flash(`${delta > 0 ? "»" : "«"} ${fmtTime(to)}`, 900);
        break;
      }
      case "ArrowUp":
      case "ArrowDown":
        e.preventDefault();
        volume = Math.max(0, Math.min(100, volume + (e.key === "ArrowUp" ? 10 : -10)));
        store.set("volume", volume);
        player.unMute();
        player.setVolume(volume);
        flash(`Volume ${volume}`, 900);
        break;
      case "Escape":
        e.preventDefault();
        closePlayer();
        break;
    }
  }

  document.addEventListener("keydown", (e) => (view === "player" ? handlePlayerKey(e) : handleHomeKey(e)));

  // Keep keys coming to the page if focus ever lands inside the player iframe.
  window.addEventListener("blur", () => {
    if (view === "player") setTimeout(() => playerEl.focus(), 0);
  });

  // --- Start -----------------------------------------------------------------
  loadTab("hot");
  searchEl.focus();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
