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
  const tabs = [$("tabForYou"), $("tabHot"), $("tabSubs"), $("tabLibrary")];
  const listTitleEl = $("listTitle");
  const listEl = $("list");
  const emptyEl = $("empty");
  const signinEl = $("signin");
  const signinUrlEl = $("signinUrl");
  const signinCodeEl = $("signinCode");
  const signinNoteEl = $("signinNote");
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
  let session = store.get("googleSession", ""); // sealed Google sign-in, only this server can open it
  let accountName = store.get("accountName", "");
  let signInAvailable = false;
  let tab = "hot";
  let videos = []; // the videos currently listed (empty while a menu is shown)
  let menu = null; // [{icon, title, sub, run}] while a menu is shown
  let back = null; // what the back gesture does inside a sub-list (e.g. a playlist)
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

  async function api(path, options = {}) {
    const headers = { "X-Access-Token": accessKey, ...(session ? { "X-Google-Session": session } : {}) };
    if (options.body) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && body.signedOut) {
      signOutLocally();
      throw new Error(body.error || "Signed out");
    }
    if (res.status === 401) throw new Error("Wrong access key");
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    return body;
  }

  // Loads a list of videos into the list area, ignoring results that arrive after the user moved on.
  // Feeds worth showing instantly from last time, then refreshing in the background.
  const CACHEABLE = /^api\/(trending|foryou|me\/(subs|liked))$/;
  let loadSeq = 0;
  async function loadVideos(path, label, emptyText, { focus = false, backTo = null } = {}) {
    const seq = ++loadSeq;
    back = backTo;
    const basePath = path.split("?")[0];
    const cacheKey = CACHEABLE.test(basePath) ? `list:${basePath}` : null;
    const cachedList = cacheKey ? store.get(cacheKey, null) : null;
    if (cachedList && cachedList.length) {
      showList(cachedList, label, emptyText, focus);
      setStatus("Updating…", "busy");
    } else {
      showList([], label, "", false);
      setStatus("Loading…", "busy");
    }
    try {
      const { videos: found } = await api(path);
      if (seq !== loadSeq) return;
      if (cacheKey) store.set(cacheKey, found);
      const focusedIndex = [...listEl.children].indexOf(document.activeElement);
      const sameList = cachedList && cachedList.length === found.length && cachedList.every((v, i) => v.id === found[i].id);
      if (!sameList) {
        showList(found, label, emptyText, focus && focusedIndex < 0 && !cachedList);
        if (focusedIndex >= 0 && listEl.children.length) listEl.children[Math.min(focusedIndex, listEl.children.length - 1)].focus();
        else if (focus && cachedList && listEl.children.length) listEl.children[0].focus();
      }
      if (statusEl.textContent === "Updating…" || statusEl.textContent === "Loading…") setStatus("");
    } catch (err) {
      if (seq === loadSeq) setStatus(cachedList ? "Offline · showing last list" : err.message, "error");
    }
  }

  // What For you is based on: the latest videos watched and saved in this app.
  function forYouSeeds() {
    const ids = [];
    for (const v of [...recent.slice(0, 12), ...saved.slice(0, 8)]) if (!ids.includes(v.id)) ids.push(v.id);
    return ids.slice(0, 20);
  }

  function loadTab(name, { focusList = false } = {}) {
    cancelSignIn();
    tab = name;
    back = null;
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    if (name === "hot") return loadVideos("api/trending", "Trending now", "Nothing trending right now.", { focus: focusList });
    if (name === "foryou") {
      const seeds = forYouSeeds();
      if (!seeds.length && !session) {
        showList([], "For you", "Watch or save a few videos (or sign in) and this fills with picks for you.", false);
        return;
      }
      return loadVideos(`api/foryou?seeds=${seeds.join(",")}`, "Picked for you", "Nothing yet. Watch a few more videos.", { focus: focusList });
    }
    if (name === "subs") {
      if (!session) {
        return showMenu("Subscriptions", signInEntries("Sign in to see your subscriptions"), focusList);
      }
      return loadVideos("api/me/subs", "New from your subscriptions", "No recent uploads.", { focus: focusList });
    }
    if (name === "library") return showLibrary(focusList);
  }

  async function runSearch() {
    const q = searchEl.value.trim();
    if (!q) return;
    searchEl.blur();
    cancelSignIn();
    tab = "search";
    tabs.forEach((t) => t.classList.remove("active"));
    await loadVideos(`api/search?q=${encodeURIComponent(q)}`, `“${q}”`, "No videos found.", { focus: true });
    if (!videos.length) searchEl.focus();
  }

  // --- Library & account -------------------------------------------------------

  function signInEntries(sub) {
    if (!signInAvailable) return [{ icon: "👤", title: "Google sign-in isn't set up", sub: "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server" }];
    return [{ icon: "👤", title: "Sign in with Google", sub, run: startSignIn }];
  }

  async function showLibrary(focusList, focusIndex = 0) {
    const entries = [
      { icon: "🕘", title: "Recent", sub: `${recent.length} watched`, run: () => showVideoList(recent, "Recently watched", "Nothing watched yet.") },
      { icon: "★", title: "Saved", sub: `${saved.length} saved · swipe → on a video to save`, run: () => showVideoList(saved, "Saved", "Swipe → on a video to save it.") },
    ];
    const q = quality();
    const qualityEntry = {
      icon: "⚙",
      title: `Video quality: ${q.label}`,
      sub: `${q.note} · pinch to change`,
      run: () => {
        cycleQuality();
        showLibrary(true, lastMenuIndex);
      },
    };
    if (!session) {
      showMenu("Library", [...entries, qualityEntry, ...signInEntries("See your playlists and liked videos")], focusList, focusIndex);
      return;
    }
    entries.push({ icon: "👍", title: "Liked videos", sub: "Videos you've liked", run: () => loadVideos("api/me/liked", "Liked videos", "No liked videos.", { focus: true, backTo: returnToLibrary }) });
    const accountEntry = {
      icon: "👤",
      title: accountName ? `Signed in as ${accountName}` : "Signed in",
      sub: "Pinch twice to sign out",
      confirm: true,
      run: signOut,
    };
    showMenu("Library", [...entries, qualityEntry, accountEntry], focusList, focusIndex);
    // Playlists load in after the fixed entries.
    const seq = loadSeq;
    try {
      const { playlists } = await api("api/me/playlists");
      if (seq !== loadSeq || tab !== "library" || !menu) return;
      const lists = playlists.map((pl) => ({
        icon: "📂",
        title: pl.title,
        sub: `${pl.count} videos`,
        run: () => loadVideos(`api/me/playlist?id=${encodeURIComponent(pl.id)}`, pl.title, "This playlist is empty.", { focus: true, backTo: returnToLibrary }),
      }));
      const focused = [...listEl.children].indexOf(document.activeElement);
      showMenu("Library", [...entries, ...lists, qualityEntry, accountEntry], false);
      if (focused >= 0) listEl.children[Math.min(focused, listEl.children.length - 1)].focus();
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  function returnToLibrary() {
    const index = Math.max(0, lastMenuIndex);
    showLibrary(true, index);
  }

  function showVideoList(list, label, emptyText) {
    back = returnToLibrary;
    showList(list, label, emptyText, true);
  }

  // --- Google sign-in: a code on the glasses, approved on your phone ------------

  let signIn = null; // { deviceCode, timer }

  async function startSignIn() {
    cancelSignIn();
    setStatus("Getting a code…", "busy");
    try {
      const start = await api("api/auth/start", { method: "POST", body: "{}" });
      signIn = { deviceCode: start.deviceCode, interval: start.interval, until: Date.now() + start.expiresIn * 1000, timer: null };
      listEl.replaceChildren();
      listEl.hidden = true;
      listTitleEl.textContent = "Sign in with Google";
      emptyEl.hidden = true;
      signinEl.hidden = false;
      signinUrlEl.textContent = start.verificationUrl.replace(/^https?:\/\/(www\.)?/, "");
      signinCodeEl.textContent = start.userCode;
      signinNoteEl.textContent = "Waiting for you to approve… · back to cancel";
      setStatus("");
      document.activeElement?.blur();
      scheduleSignInPoll();
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  function scheduleSignInPoll() {
    if (!signIn) return;
    signIn.timer = setTimeout(pollSignIn, signIn.interval * 1000);
  }

  async function pollSignIn() {
    if (!signIn) return;
    if (Date.now() > signIn.until) {
      signinNoteEl.textContent = "The code expired. Back, then try again.";
      return;
    }
    try {
      const r = await api("api/auth/poll", { method: "POST", body: JSON.stringify({ deviceCode: signIn.deviceCode }) });
      if (!signIn) return;
      if (r.session) {
        signIn = null;
        signinEl.hidden = true;
        session = r.session;
        store.set("googleSession", session);
        api("api/me").then(({ name }) => { accountName = name; store.set("accountName", name); }).catch(() => {});
        await loadTab("subs", { focusList: true });
        setStatus("Signed in ✓");
        return;
      }
      if (r.denied) { signinNoteEl.textContent = "Sign-in was declined. Back to return."; return; }
      if (r.expired) { signinNoteEl.textContent = `${r.error || "Sign-in failed"}. Back, then try again.`; return; }
      if (r.slowDown) signIn.interval += 5;
    } catch (err) {
      signinNoteEl.textContent = `${err.message} · retrying…`;
    }
    scheduleSignInPoll();
  }

  function cancelSignIn() {
    if (signIn) clearTimeout(signIn.timer);
    signIn = null;
    signinEl.hidden = true;
    listEl.hidden = false;
  }

  function signOutLocally() {
    for (const k of ["list:api/me/subs", "list:api/me/liked", "list:api/foryou"]) store.set(k, null);
    session = "";
    accountName = "";
    store.set("googleSession", "");
    store.set("accountName", "");
  }

  async function signOut() {
    await api("api/auth/signout", { method: "POST", body: "{}" }).catch(() => {});
    signOutLocally();
    setStatus("Signed out");
    showLibrary(true);
  }

  // --- List ------------------------------------------------------------------

  function showList(list, label, emptyText, focusFirst) {
    videos = list;
    menu = null;
    signinEl.hidden = true;
    listEl.hidden = false;
    listTitleEl.textContent = label;
    emptyEl.hidden = list.length > 0 || !emptyText;
    emptyEl.textContent = emptyText;
    listEl.replaceChildren(...list.map(renderItem));
    if (focusFirst && list.length) listEl.children[0].focus();
  }

  let lastMenuIndex = 0;
  function showMenu(label, entries, focusFirst, focusIndex = 0) {
    videos = [];
    menu = entries;
    signinEl.hidden = true;
    listEl.hidden = false;
    listTitleEl.textContent = label;
    emptyEl.hidden = true;
    listEl.replaceChildren(...entries.map(renderEntry));
    if (focusFirst && entries.length) {
      const el = listEl.children[Math.min(focusIndex, entries.length - 1)];
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function renderEntry(entry, i) {
    const item = document.createElement("button");
    item.className = "focusable item entry";
    const icon = document.createElement("span");
    icon.className = "icon-box";
    icon.textContent = entry.icon;
    const text = document.createElement("span");
    text.className = "text";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = entry.title;
    const c = document.createElement("span");
    c.className = "c";
    c.textContent = entry.sub || "";
    text.append(t, c);
    item.append(icon, text);
    item.addEventListener("focus", () => setStatus(""));
    item.addEventListener("blur", () => {
      if (entry.confirm) { item.classList.remove("confirm"); c.textContent = entry.sub || ""; }
    });
    item.addEventListener("click", () => {
      if (!entry.run) return;
      if (entry.confirm && !item.classList.contains("confirm")) {
        item.classList.add("confirm");
        c.textContent = "Pinch again to confirm";
        return;
      }
      lastMenuIndex = i;
      entry.run();
    });
    return item;
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
    item.addEventListener("focus", () => {
      setStatus(isSaved(v.id) ? "→ unsave" : "→ save");
      precue(v);
    });
    return item;
  }

  function toggleSave(i) {
    const v = videos[i];
    if (!v) return;
    const nowSaved = !isSaved(v.id);
    saved = nowSaved ? [v, ...saved].slice(0, 100) : saved.filter((s) => s.id !== v.id);
    store.set("saved", saved);
    listEl.children[i].replaceWith(renderItem(v, i));
    listEl.children[i].focus();
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

  // YouTube's embed API no longer lets apps pick a resolution; the player chooses one
  // from its own pixel size. So the iframe is rendered at the size for the wanted
  // quality and scaled to fit the 600x338 frame.
  const QUALITIES = [
    { key: "saver", label: "Data saver", note: "~240p · least data", w: 426, h: 240 },
    { key: "auto", label: "Auto", note: "~360p", w: 600, h: 338 },
    { key: "hd", label: "HD", note: "~720p · more data", w: 1280, h: 720 },
    { key: "fhd", label: "Full HD", note: "~1080p · most data", w: 1920, h: 1080 },
  ];
  let qualityKey = store.get("quality", "auto");
  const quality = () => QUALITIES.find((q) => q.key === qualityKey) || QUALITIES[1];

  function applyQuality() {
    const q = quality();
    const frame = player && playerReady ? player.getIframe() : null;
    if (!frame) return;
    frame.style.width = `${q.w}px`;
    frame.style.height = `${q.h}px`;
    frame.style.transformOrigin = "0 0";
    frame.style.transform = `scale(${600 / q.w})`;
    // Never let a sizing problem stop playback from starting.
    try { player.setSize?.(q.w, q.h); } catch { /* keep the CSS size */ }
  }

  function cycleQuality() {
    const i = QUALITIES.findIndex((q) => q.key === qualityKey);
    qualityKey = QUALITIES[(i + 1) % QUALITIES.length].key;
    store.set("quality", qualityKey);
    applyQuality();
  }

  const QUALITY_NAMES = { tiny: "144p", small: "240p", medium: "360p", large: "480p", hd720: "720p", hd1080: "1080p", hd1440: "1440p", hd2160: "4K", highres: "4K+" };

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
    const res = QUALITY_NAMES[player.getPlaybackQuality?.()] || "";
    metaEl.textContent = notice || `${icon}  ${fmtTime(cur)} / ${fmtTime(dur)}   ·   Vol ${volume}${res ? `   ·   ${res}` : ""}`;
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

  // Creates the (hidden) player once. Called at launch so the first pinch is fast.
  let playerPromise = null;
  let cuedId = null;
  function ensurePlayer() {
    if (!playerPromise) {
      playerPromise = loadYouTubeApi().then(
        (YT) =>
          new Promise((resolve) => {
            player = new YT.Player("ytPlayer", {
              width: quality().w,
              height: quality().h,
              playerVars: { playsinline: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, origin: location.origin },
              events: {
                onReady: (e) => {
                  playerReady = true;
                  const frame = e.target.getIframe();
                  frame.setAttribute("tabindex", "-1");
                  frame.setAttribute("allow", "autoplay; encrypted-media");
                  applyQuality();
                  e.target.setVolume(volume);
                  resolve(e.target);
                },
                onStateChange: (e) => {
                  // Autoplay the next video in the list when one ends.
                  if (e.data === 0 && view === "player" && current + 1 < videos.length) play(current + 1);
                },
                onError: (e) => {
                  if (view !== "player") return; // a failed pre-load while browsing is harmless
                  flash(e.data === 101 || e.data === 150 ? "This video can't play here" : "Couldn't play this video", 3000);
                },
              },
            });
          }),
      );
      playerPromise.catch(() => { playerPromise = null; });
    }
    return playerPromise;
  }

  // While browsing, pre-load the video you're resting on so a pinch starts it at once.
  let cueTimer = null;
  function precue(v) {
    clearTimeout(cueTimer);
    if (!v || v.live) return;
    cueTimer = setTimeout(() => {
      if (view !== "home" || !playerReady || cuedId === v.id) return;
      try {
        player.cueVideoById(v.id);
        cuedId = v.id;
      } catch { /* ignore */ }
    }, 600);
  }

  async function play(i) {
    const v = videos[i];
    if (!v) return;
    clearTimeout(cueTimer);
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
    renderMeta();

    try {
      const p = await ensurePlayer();
      if (view !== "player" || videos[current]?.id !== v.id) return; // user moved on while it loaded
      if (cuedId === v.id) p.playVideo();
      else p.loadVideoById(v.id);
      cuedId = null;
      playerEl.focus();
      // If the browser blocked autoplay with sound, ask for a pinch.
      setTimeout(() => {
        if (view === "player" && videos[current]?.id === v.id && ![1, 3].includes(p.getPlayerState())) flash("Pinch to play", 4000);
      }, 2500);
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
          if (e.key === "ArrowRight" && !menu) toggleSave(itemIndex);
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
      case "Escape":
        // Back gesture: leave the sign-in screen or a sub-list; at the top level, exit as usual.
        if (signIn || !signinEl.hidden) {
          e.preventDefault();
          cancelSignIn();
          loadTab(tab === "subs" ? "subs" : "library", { focusList: true });
        } else if (back) {
          e.preventDefault();
          back();
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
  fetch("api/health")
    .then((r) => r.json())
    .then((h) => { signInAvailable = Boolean(h.signIn); if (tab !== "hot" && menu) loadTab(tab); })
    .catch(() => {});
  loadTab(forYouSeeds().length || session ? "foryou" : "hot");
  searchEl.focus();
  // Load YouTube's player in the background so the first video starts quickly.
  setTimeout(() => ensurePlayer().catch(() => {}), 1200);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
