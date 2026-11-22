// Runs at the start of every tiktok.com page, before tv.js: a lean player for the For You feed.
//
// TikTok's own feed page is heavy for this TV: each move to the next video re-renders it, freezing the
// picture and the remote for up to 1.5 s, and the first video takes about 11 s to appear. So on the feed,
// TikTok's page stays loaded but out of sight (it keeps the session and signs requests) and the videos play
// in a layer of our own: three <video> elements, our own text and buttons, and little else.
//
// The videos are TikTok's own feed: the first few come with the page itself, the next ones from TikTok's
// own feed request, and later ones from the same request again, which TikTok's security script signs.
// A like is TikTok's like request with its CSRF token. Comments open beside the video and a creator's page
// over it, both from TikTok's own requests too, so the feed stays where it was. Everything else (the menu,
// sign-in, pop-ups and checks) is TikTok's page, run by tv.js; the layer steps aside for it.
(() => {
  if (window.falconLean) return;

  const FEED = /^\/(foryou)?\/?$/;
  const onFeed = () => FEED.test(location.pathname);
  /** Added to each request by TikTok's security script; a request without them is signed afresh. */
  const SIGNED = ['X-Bogus', 'X-Gnarly', 'X-Dynosaur', 'msToken'];
  /** What every TikTok web request carries; the like request needs only these. */
  const COMMON = ['WebIdLastTime', 'aid', 'app_language', 'app_name', 'browser_language', 'browser_name',
    'browser_online', 'browser_platform', 'browser_version', 'channel', 'cookie_enabled', 'data_collection_enabled',
    'device_id', 'device_platform', 'focus_state', 'history_len', 'is_fullscreen', 'is_page_visible', 'odinId', 'os',
    'priority_region', 'region', 'screen_height', 'screen_width', 'tz_name', 'user_is_login', 'verifyFp',
    'webcast_language'];
  /** No video by then: TikTok's own player gets the feed back. */
  const GIVE_UP_MS = 20_000;
  /** How long the name, caption and buttons stay up after a new video or a key. */
  const AWAKE_MS = 5_000;
  /** Holding OK this long likes the video, like a double tap on the phone. */
  const HOLD_MS = 450;
  /** Sharing: how long TikTok's page for the video has to show its share button. */
  const SHARE_WAIT_MS = 15_000;

  /** The For You feed. */
  const feed = [];
  /** What the player plays: the feed, hatun modu, or the videos of a creator whose page it was opened from. */
  let items = feed;
  /** The feed ▲▼ come back to from a creator's videos: For You (feed) or hatun modu. */
  let home = feed;
  const seen = new Set();
  /** TikTok's own feed request, reused for more videos and for the like request's parameters. */
  let feedUrl = null;
  /** Any other of TikTok's own API requests, for their parameters until the feed request has been seen. */
  let apiFrom = null;
  let watched = 0;
  let index = -1;
  let current = null;
  /** 'off' (not the feed), 'on' (our layer has the screen), 'menu' (TikTok's menu over it), 'under' (a pop-up). */
  let state = 'off';
  let failed = false;
  let backgrounded = false;
  /** When the first video got where (ms since the page started loading), for debug(). */
  const marks = {};
  const switches = [];
  let keyAt = 0;
  const mark = name => { if (!(name in marks)) marks[name] = Math.round(performance.now()); };
  let userPaused = false;
  let started = false;
  const bornAt = performance.now();

  // ---- The feed ----------------------------------------------------------------------------------------

  const toItem = raw => {
    const v = raw?.video;
    if (!raw?.id || !v || raw.imagePost || raw.liveRoomInfo) return null;
    // The sharpest H.264 up to 1080p. H.265 isn't used: the page's player stalls on it on this TV.
    const best = (v.bitrateInfo || [])
      .filter(b => b.CodecType === 'h264' && b.PlayAddr?.UrlList?.length && (b.PlayAddr.Width || 0) * (b.PlayAddr.Height || 0) <= 1080 * 1920)
      .sort((a, b) => b.PlayAddr.Width * b.PlayAddr.Height - a.PlayAddr.Width * a.PlayAddr.Height)[0];
    const srcs = [...new Set([...(best?.PlayAddr.UrlList || []), v.playAddr].filter(Boolean))];
    if (!srcs.length) return null;
    const s = raw.statsV2 || raw.stats || {};
    const music = raw.music?.title ? `${raw.music.title}${raw.music.authorName ? ` · ${raw.music.authorName}` : ''}` : '';
    const a = raw.author || {};
    const as = raw.authorStatsV2 || raw.authorStats || {};
    return {
      id: String(raw.id), srcs, cover: v.cover || v.originCover || '',
      wide: (v.width || 0) >= (v.height || 1) * 1.3,
      name: a.nickname || a.uniqueId || '', handle: a.uniqueId || '',
      avatar: a.avatarThumb || '', verified: !!a.verified,
      // For the creator's page, before TikTok has said more: who they are and their numbers, as of this video.
      author: { secUid: a.secUid || '', uid: a.id ? String(a.id) : '', avatar: a.avatarMedium || a.avatarLarger || '', bio: a.signature || '',
        following: Number(as.followingCount) || 0, followers: Number(as.followerCount) || 0,
        hearts: Number(as.heartCount ?? as.heart) || 0 },
      desc: raw.desc || '', music,
      likes: Number(s.diggCount) || 0, comments: Number(s.commentCount) || 0, saves: Number(s.collectCount) || 0,
      shares: Number(s.shareCount) || 0,
      plays: Number(s.playCount) || 0, pinned: !!raw.isPinnedItem,
      // What it's about, by TikTok's own labels: its hashtags and its sound.
      tags: [...new Set([...(raw.textExtra || []).map(t => t.hashtagName), ...(raw.challenges || []).map(c => c.title)]
        .filter(Boolean).map(t => t.toLowerCase()))].slice(0, 12),
      musicId: raw.music?.id ? String(raw.music.id) : '',
      liked: !!raw.digged, ad: !!raw.isAd,
    };
  };

  /** TikTok's ads, left out of the feed as they arrive: they're never loaded, let alone played. */
  let adsSkipped = 0;
  const addItems = list => {
    let added = 0;
    for (const it of list) {
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      if (it.ad) { adsSkipped++; continue; }
      feed.push(it);
      added++;
    }
    if (added) onItems();
  };
  const add = list => addItems((list || []).map(toItem));

  // The next few unwatched videos are kept for the next start, which begins with them before TikTok's page
  // has even arrived. The page itself comes with videos only now and then; without either, the first one
  // waits for TikTok's app to load (about 15 s).
  const CACHE = 'falcon-lean-next';
  /** The furthest video reached: after going back up, the ones after it are still the unwatched ones. */
  let furthest = -1;
  const saveNext = () => {
    if (items !== feed) return;
    furthest = Math.max(furthest, index);
    try { localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), items: feed.slice(furthest + 1, furthest + 7) })); } catch (_) {}
  };
  const fromCache = () => {
    try {
      const { at = 0, items: list = [] } = JSON.parse(localStorage.getItem(CACHE) || '{}');
      // TikTok's video links say when they expire (two days on); one that doesn't is trusted for six hours.
      const now = Date.now() / 1000;
      if (list.length) mark('cache');
      addItems(list.filter(it => {
        const expires = Number(new URL(it.srcs[0]).searchParams.get('expire')) || at / 1000 + 6 * 3600;
        return expires - now > 600;
      }));
    } catch (_) {}
  };

  // TikTok's feed request: its answer becomes our next videos, and the request itself a template.
  // TikTok's own player downloads the same videos again to play them nowhere, competing with ours for
  // the network and this thread while the page loads: on the feed, its downloads wait (for good, unless
  // our player gives up, when they go ahead).
  const fetch0 = window.fetch;
  const held = [];
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (onFeed() && !failed && /\/video\/tos\//.test(url)) {
      return new Promise((resolve, reject) => held.push(() => fetch0.call(window, input, init).then(resolve, reject)));
    }
    const result = fetch0.call(window, input, init);
    if (url.includes('/api/') && url.includes('aid=')) apiFrom = new URL(url, location.href).toString();
    if (url.includes('/api/recommend/item_list/')) {
      feedUrl = new URL(url, location.href).toString();
      // Read before TikTok does: once it has read the body, it can't be cloned.
      result.then(r => r.clone().json()).then(j => add(j.itemList)).catch(() => {});
    }
    return result;
  };

  // The first videos come with the page, long before TikTok's app has loaded: they're read as soon as the
  // page's data has been parsed, ahead of TikTok's own scripts.
  const DATA = '__UNIVERSAL_DATA_FOR_REHYDRATION__';
  let fromPageDone = false;
  const fromPage = () => {
    if (fromPageDone) return;
    try {
      const data = JSON.parse(document.getElementById(DATA).textContent);
      fromPageDone = true;
      mark('pageData');
      add(data.__DEFAULT_SCOPE__['webapp.updated-items']);
    } catch (_) {}
  };
  const parsing = new MutationObserver(() => {
    // Videos from the last time start as soon as there's a page to put them on.
    if (!started && items.length) tick();
    // Past the data's script (something follows it), its text is complete.
    if (document.getElementById(DATA)?.nextSibling) { parsing.disconnect(); fromPage(); tick(); }
  });
  if (onFeed()) parsing.observe(document, { childList: true, subtree: true });

  let asking = null;
  /** More videos, the way TikTok asks: its own request again, without the old signatures. */
  const more = () => !feedUrl ? Promise.resolve() : asking ||= new Promise(resolve => {
    const u = new URL(feedUrl);
    SIGNED.forEach(k => u.searchParams.delete(k));
    for (const k of ['vv_count', 'vv_count_fyp']) {
      if (u.searchParams.has(k)) u.searchParams.set(k, String(Number(u.searchParams.get(k)) + watched));
    }
    const x = new XMLHttpRequest();
    x.open('GET', u.toString());
    x.withCredentials = true;
    x.onloadend = () => {
      const before = items.length;
      try { add(JSON.parse(x.responseText).itemList); } catch (_) {}
      // Nothing new (refused, or a check to pass): wait before asking again.
      setTimeout(() => { asking = null; }, items.length > before ? 0 : 5000);
      resolve();
    };
    x.send();
  });

  let context = null;
  const appContext = () => {
    if (!context) {
      try { context = JSON.parse(document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__').textContent).__DEFAULT_SCOPE__['webapp.app-context']; } catch (_) {}
    }
    return context;
  };

  /** TikTok's language (the viewer's choice there), kept for the next start, before the page has said. */
  const LANG = 'falcon-lean-lang';
  const language = () => {
    const now = appContext()?.language;
    try {
      if (!now) return localStorage.getItem(LANG) || navigator.language;
      if (localStorage.getItem(LANG) !== now) localStorage.setItem(LANG, now);
    } catch (_) {}
    return now || navigator.language;
  };

  /** Once TikTok's app has made a request of its own (and so has loaded the script that signs them). */
  const apiReady = () => new Promise(resolve => {
    const from = performance.now();
    const check = () => {
      if (feedUrl || apiFrom) resolve(true);
      else if (performance.now() - from > GIVE_UP_MS) resolve(false);
      else setTimeout(check, 250);
    };
    check();
  });

  /**
   * A request to TikTok's web API the way its own app makes one: with the parameters its requests carry,
   * signed on the way out by TikTok's security script, and for a change, its CSRF token. The answer, or null.
   * Reading comments and creators' pages, TikTok answers nothing at all when our request names the device
   * platform (web_pc), signed or not; without it, it answers. The like request has always had it.
   */
  const api = (path, params, post = false) => apiReady().then(ok => new Promise(resolve => {
    const csrf = appContext()?.csrfToken;
    if (!ok || (post && !csrf)) return resolve(null);
    const from = new URL(feedUrl || apiFrom).searchParams;
    const u = new URL(path, location.origin);
    for (const k of COMMON) if (from.has(k) && (post || k !== 'device_platform')) u.searchParams.set(k, from.get(k));
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    const x = new XMLHttpRequest();
    x.open(post ? 'POST' : 'GET', u.toString());
    x.withCredentials = true;
    if (post) x.setRequestHeader('tt-csrf-token', csrf);
    x.onloadend = () => {
      try { resolve(JSON.parse(x.responseText)); } catch (_) { resolve(null); }
    };
    x.send();
  }));

  /** TikTok's like request (type 1 likes, 0 takes it back). True if TikTok took it. */
  const sendLike = (id, on) => api('/api/commit/item/digg/', { aweme_id: id, type: on ? 1 : 0 }, true)
    .then(j => j?.status_code === 0);

  // ---- TikTok's own player stays quiet on the feed ------------------------------------------------------

  const ours = new WeakSet();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!ours.has(this) && onFeed() && !failed) {
      this.muted = true;
      return Promise.resolve();
    }
    return play.call(this);
  };
  const silenceTikTok = () => {
    for (const v of document.querySelectorAll('video')) if (!v.paused) { v.muted = true; v.pause(); }
  };

  // ---- The layer -------------------------------------------------------------------------------------

  const ICON = {
    heart: 'M12 20.6s-7.4-4.5-9.8-9.1C.6 8.4 2.5 4.4 6.4 4.4c2.3 0 3.9 1.3 5.6 3.4 1.7-2.1 3.3-3.4 5.6-3.4 3.9 0 5.8 4 4.2 7.1-2.4 4.6-9.8 9.1-9.8 9.1z',
    comment: 'M12 3.5c-5.3 0-9.5 3.6-9.5 8.1 0 2.5 1.3 4.7 3.4 6.2l-.6 3.2 3.8-2c.9.2 1.9.3 2.9.3 5.3 0 9.5-3.6 9.5-8.1S17.3 3.5 12 3.5z',
    save: 'M6.5 3h11c.6 0 1 .4 1 1v17l-6.5-4.2L5.5 21V4c0-.6.4-1 1-1z',
    share: 'M13.6 3.8v4.4C7.2 8.9 3.4 13.3 2.8 20c2.3-3.3 5.6-4.9 10.8-5v4.4L21.4 12z',
    play: 'M7 4.2v15.6L20 12z',
    next: 'M5 4.5v15l11-7.5zM17.5 4.5H20v15h-2.5z',
    spark: 'M10 3l1.9 5.6L17.5 10.5l-5.6 1.9L10 18l-1.9-5.6L2.5 10.5l5.6-1.9zM18 13.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z',
    note: 'M9 18.5a2.5 2.5 0 1 1-2.5-2.5c.4 0 .7.1 1 .2V5.5L19 3.5v12a2.5 2.5 0 1 1-2.5-2.5c.4 0 .7.1 1 .2V7.6L9 9.2z',
    tick: 'M12 2.5l2.4 1.8 3-.1.9 2.9 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.9-3-.1L12 21.5l-2.4-1.8-3 .1-.9-2.9-2.4-1.8 1-2.8-1-2.8 2.4-1.8.9-2.9 3 .1zM10.6 15.2l5.6-5.6-1.3-1.3-4.3 4.3-2-2-1.3 1.3z',
  };
  const svg = (d, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

  const CSS = `
    :host { all: initial; }
    .root {
      position: absolute; inset: 0; overflow: hidden; background: #000; color: #fff;
      font-family: system-ui, sans-serif; -webkit-font-smoothing: antialiased;
    }
    .root.tiktok-font { font-family: TikTokFont, system-ui, sans-serif; }
    /* The cover, tiny and stretched: a soft glow around portrait videos, drawn once per video. */
    canvas.glow { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 3; opacity: 0; transition: opacity 400ms ease-out; }
    canvas.glow.on { opacity: 0.55; }
    .backing { position: absolute; inset: 0; z-index: 2; background: #000; }
    /* The previous and next videos sit under the backing: still "on screen" for the browser, so the next one
       keeps its decoder ready, but out of sight. */
    video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; z-index: 1; }
    video.now { z-index: 4; }

    .chrome { position: absolute; z-index: 6; opacity: 0; transition: opacity 450ms ease; pointer-events: none; }
    .root.awake .chrome { opacity: 1; transition-duration: 160ms; }
    .scrim { position: absolute; z-index: 5; left: 0; right: 0; bottom: 0; height: 46%; pointer-events: none;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.62)); opacity: 0; transition: opacity 450ms ease; }
    .root.awake .scrim { opacity: 1; transition-duration: 160ms; }

    .info { left: 32px; bottom: 30px; width: min(46%, 440px); }
    .who { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .avatar { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; background: #333; flex: none;
      box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.85); }
    .name { font-size: 16px; font-weight: 700; letter-spacing: 0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tick { width: 15px; height: 15px; fill: #20d5ec; vertical-align: -2px; margin-left: 4px; }
    .handle { font-size: 12.5px; color: rgba(255, 255, 255, 0.7); margin-top: 1px; }
    .desc { font-size: 14px; line-height: 1.38; color: rgba(255, 255, 255, 0.94); text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
    .music { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12.5px; color: rgba(255, 255, 255, 0.85);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .music svg { width: 14px; height: 14px; fill: currentColor; flex: none; }
    .music:empty, .desc:empty { display: none; }

    .rail { right: 30px; bottom: 34px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
    .act { display: flex; flex-direction: column; align-items: center; gap: 5px; }
    .bubble { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center;
      background: rgba(255, 255, 255, 0.14); transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 160ms ease; }
    .bubble svg { width: 24px; height: 24px; fill: #fff; transition: fill 160ms ease; }
    .count { font-size: 12px; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5); }
    .face { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: #333; display: block;
      box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.85); transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 160ms ease; }
    .like.liked svg { fill: #fe2c55; }
    .auto.off .bubble svg { fill: rgba(255, 255, 255, 0.38); }
    .root.mine .act.mine .bubble { background: #fe2c55; }
    .feedname { left: 32px; top: 26px; padding: 6px 12px; border-radius: 999px; background: rgba(254, 44, 85, 0.9);
      font-size: 13px; font-weight: 700; display: none; }
    .root.mine .feedname { display: block; }
    .toast { position: absolute; z-index: 9; left: 50%; top: 28px; transform: translate(-50%, -8px); max-width: 70%;
      padding: 10px 18px; border-radius: 12px; background: rgba(22, 22, 22, 0.92); font-size: 15px; font-weight: 600;
      text-align: center; opacity: 0; transition: opacity 200ms ease, transform 200ms ease; pointer-events: none; }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    .auto.off .count { opacity: 0.6; }
    .act.focused .bubble, .act.focused .face { transform: scale(1.12); box-shadow: 0 0 0 2.5px #fff, 0 0 18px rgba(255, 255, 255, 0.35); }
    .like.pop svg { animation: pop 380ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    @keyframes pop { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }

    .progress { position: absolute; z-index: 6; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255, 255, 255, 0.18); }
    .progress > div { height: 100%; background: rgba(255, 255, 255, 0.92); transform-origin: 0 0; transform: scaleX(0); }
    .progress > div.run { transition: transform 260ms linear; }

    .center { position: absolute; z-index: 7; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none; }
    .paused { width: 92px; height: 92px; border-radius: 50%; background: rgba(0, 0, 0, 0.38); display: grid; place-items: center;
      opacity: 0; transform: scale(0.85); transition: opacity 180ms ease, transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    .paused svg { width: 50px; height: 50px; fill: rgba(255, 255, 255, 0.95); margin-left: 5px; }
    .root.is-paused .paused { opacity: 1; transform: scale(1); }
    .dots { position: absolute; left: 50%; top: 50%; width: 44px; height: 20px; margin: -10px 0 0 -22px; opacity: 0; transition: opacity 200ms ease; }
    .root.buffering .dots { opacity: 1; }
    .dots i, .wait i { position: absolute; top: 3px; width: 14px; height: 14px; border-radius: 50%; }
    .dots i:first-child, .wait i:first-child { background: #25f4ee; animation: orbit 900ms linear infinite; }
    .dots i:last-child, .wait i:last-child { background: #fe2c55; animation: orbit 900ms linear infinite reverse; }
    .wait { position: relative; width: 44px; height: 20px; margin: 36px auto; }
    @keyframes orbit { 0%, 100% { left: 4px; } 50% { left: 26px; } }
    .burst { position: absolute; z-index: 7; left: 50%; top: 50%; width: 120px; height: 120px; margin: -60px 0 0 -60px;
      fill: #fe2c55; opacity: 0; pointer-events: none; filter: drop-shadow(0 4px 18px rgba(254, 44, 85, 0.5)); }
    .burst.go { animation: burst 760ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    @keyframes burst { 0% { opacity: 0; transform: scale(0.4) rotate(-12deg); } 25% { opacity: 1; transform: scale(1.1) rotate(-4deg); }
      60% { opacity: 1; transform: scale(1) rotate(0); } 100% { opacity: 0; transform: scale(1.25) translateY(-30px); } }

    /* Comments, beside the video: it moves over to make room and plays on. */
    .comments-panel { position: absolute; z-index: 8; top: 0; right: 0; bottom: 0; width: 380px; display: none;
      flex-direction: column; background: #161616; box-shadow: -24px 0 60px rgba(0, 0, 0, 0.5); }
    .root.side .comments-panel { display: flex; animation: slide-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    @keyframes slide-in { from { transform: translateX(40px); opacity: 0; } }
    .root.side video { width: calc(100% - 380px); }
    .root.side .rail { display: none; }
    .root.side .center, .root.side .dots, .root.side .burst { left: calc((100% - 380px) / 2); }
    .panel-head { padding: 18px 22px 14px; font-size: 15px; font-weight: 700; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
    .clist { position: relative; flex: 1; overflow-y: auto; padding: 8px 10px 40px; scrollbar-width: none; }
    .clist::-webkit-scrollbar, .pscroll::-webkit-scrollbar { display: none; }
    .c { display: flex; gap: 10px; padding: 9px 10px; border-radius: 10px; }
    .c.reply { margin-left: 42px; }
    .c.focused, .more.focused { background: rgba(255, 255, 255, 0.1); box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.9); }
    .cav { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: #333; flex: none; }
    .c.reply .cav { width: 24px; height: 24px; }
    .cbody { min-width: 0; flex: 1; }
    .cname { font-size: 12.5px; font-weight: 600; color: rgba(255, 255, 255, 0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cname .tag { color: #fe2c55; margin-left: 6px; }
    .ctext { font-size: 14px; line-height: 1.36; margin-top: 2px; overflow-wrap: anywhere; white-space: pre-wrap; }
    .ctext:empty { display: none; }
    .cimg { display: block; max-width: 120px; max-height: 120px; border-radius: 8px; margin-top: 6px; }
    .cmeta { display: flex; gap: 14px; margin-top: 5px; font-size: 12px; color: rgba(255, 255, 255, 0.5); }
    .cmeta svg { width: 12px; height: 12px; fill: currentColor; vertical-align: -1.5px; margin-right: 4px; }
    .creplies { margin-top: 6px; font-size: 12.5px; font-weight: 600; color: rgba(255, 255, 255, 0.62); }
    .more { margin: 0 0 4px 52px; padding: 7px 10px; border-radius: 10px; font-size: 12.5px; font-weight: 600; color: rgba(255, 255, 255, 0.62); }
    .note { padding: 40px 20px; text-align: center; font-size: 14px; color: rgba(255, 255, 255, 0.55); }
    .note:empty { display: none; }

    /* A creator's page, over the video. */
    .profile { position: absolute; z-index: 9; inset: 0; background: #121212; display: none; }
    .root.on-profile .profile { display: block; animation: fade-in 180ms ease-out; }
    @keyframes fade-in { from { opacity: 0; } }
    .pscroll { position: absolute; inset: 0; overflow-y: auto; scrollbar-width: none; padding: 40px 44px 60px; box-sizing: border-box; }
    .phead { display: flex; gap: 24px; align-items: center; margin-bottom: 28px; }
    .pav { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; background: #333; flex: none; }
    .pname { font-size: 24px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pname .tick { width: 20px; height: 20px; vertical-align: -3px; margin-left: 6px; }
    .phandle { font-size: 14px; color: rgba(255, 255, 255, 0.65); margin-top: 2px; }
    .pstats { display: flex; gap: 22px; margin-top: 12px; font-size: 13.5px; color: rgba(255, 255, 255, 0.65); }
    .pstats b { color: #fff; font-size: 16px; margin-right: 5px; }
    .pbio { margin-top: 10px; max-width: 560px; font-size: 13.5px; line-height: 1.4; white-space: pre-wrap; color: rgba(255, 255, 255, 0.9);
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .pbio:empty { display: none; }
    .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
    .tile { position: relative; aspect-ratio: 3 / 4; border-radius: 8px; overflow: hidden; background: #222;
      transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 160ms ease; }
    .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .tile .plays { position: absolute; left: 7px; bottom: 6px; display: flex; align-items: center; gap: 3px;
      font-size: 12px; font-weight: 600; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8); }
    .tile .plays svg { width: 12px; height: 12px; fill: #fff; }
    .tile .pin { position: absolute; left: 6px; top: 6px; padding: 2px 6px; border-radius: 4px; background: #fe2c55; font-size: 11px; font-weight: 600; }
    .tile.focused { transform: scale(1.06); box-shadow: 0 0 0 3px #fff, 0 8px 24px rgba(0, 0, 0, 0.6); z-index: 1; }
  `;

  let host = null, root = null, glow = null, bar = null, likeEl = null, burstEl = null;
  const slots = [];
  const $ = sel => root.querySelector(sel);

  const build = () => {
    host = document.createElement('div');
    host.id = 'falcon-lean';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:none;contain:strict;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="root">
        <canvas class="glow" width="64" height="36"></canvas>
        <div class="backing"></div>
        <div class="scrim"></div>
        <div class="chrome info">
          <div class="who"><img class="avatar" alt=""><div style="min-width:0"><div class="name"></div><div class="handle"></div></div></div>
          <div class="desc"></div>
          <div class="music"></div>
        </div>
        <div class="chrome rail">
          <div class="act author"><img class="face" alt=""></div>
          <div class="act like"><div class="bubble">${svg(ICON.heart)}</div><div class="count"></div></div>
          <div class="act comments"><div class="bubble">${svg(ICON.comment)}</div><div class="count"></div></div>
          <div class="act share"><div class="bubble">${svg(ICON.share)}</div><div class="count"></div></div>
          <div class="act mine"><div class="bubble">${svg(ICON.spark)}</div><div class="count"></div></div>
          <div class="act auto"><div class="bubble">${svg(ICON.next)}</div><div class="count"></div></div>
        </div>
        <div class="chrome feedname"></div>
        <div class="toast"></div>
        <div class="progress"><div></div></div>
        <div class="center"><div class="paused">${svg(ICON.play)}</div></div>
        <div class="dots"><i></i><i></i></div>
        ${svg(ICON.heart, 'burst')}
        <div class="comments-panel"><div class="panel-head"></div><div class="clist"></div></div>
        <div class="profile"><div class="pscroll">
          <div class="phead"><img class="pav" alt="">
            <div style="min-width:0"><div class="pname"></div><div class="phandle"></div><div class="pstats"></div><div class="pbio"></div></div>
          </div>
          <div class="grid"></div>
          <div class="note pnote"></div>
        </div></div>
      </div>`;
    root = shadow.querySelector('.root');
    glow = $('canvas.glow');
    bar = $('.progress > div');
    likeEl = $('.like');
    burstEl = $('.burst');
    for (let i = 0; i < 3; i++) {
      const v = document.createElement('video');
      ours.add(v);
      v.playsInline = true;
      v.preload = 'auto';
      v.muted = true;
      v.addEventListener('playing', () => { if (v === current) { failsInRow = 0; ready(); } });
      v.addEventListener('ended', () => ended(v));
      for (const e of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing']) {
        v.addEventListener(e, () => { if (index === 0 && v === current) mark(e); });
      }
      v.addEventListener('waiting', () => { if (v === current) untilMoving(v); });
      v.addEventListener('error', () => failover(v));
      root.insertBefore(v, glow);
      slots.push(v);
    }
    document.documentElement.appendChild(host);
  };

  // TikTok writes counts the same way in every language: 26.5K, 1.2M.
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const count = n => (n > 0 ? compact.format(n) : '');

  const renderLike = it => {
    likeEl.classList.toggle('liked', !!it?.liked);
    likeEl.querySelector('.count').textContent = count(it?.likes || 0);
  };

  /**
   * TikTok's typeface, once the page has loaded every weight the layer uses. Until then the TV's own: text
   * in a typeface still loading isn't drawn at all, and while TikTok's app loads that lasts seconds.
   */
  const tiktokFont = () => {
    const loaded = new Set([...document.fonts]
      .filter(f => f.family.replace(/["']/g, '') === 'TikTokFont' && f.status === 'loaded').map(f => String(f.weight)));
    return ['400', '600', '700'].every(w => loaded.has(w));
  };

  const render = it => {
    // Switched with a new video, never under one being watched.
    if (!root.classList.contains('tiktok-font') && tiktokFont()) root.classList.add('tiktok-font');
    renderAuto();
    renderMine();
    for (const img of [$('.avatar'), $('.face')]) {
      if (it.avatar) img.src = it.avatar; else img.removeAttribute('src');
    }
    $('.name').innerHTML = '';
    $('.name').append(it.name || it.handle);
    if (it.verified) $('.name').insertAdjacentHTML('beforeend', svg(ICON.tick, 'tick'));
    $('.handle').textContent = it.handle && it.name !== it.handle ? `@${it.handle}` : '';
    $('.desc').textContent = it.desc.trim();
    $('.music').innerHTML = it.music ? svg(ICON.note) : '';
    if (it.music) $('.music').append(it.music);
    renderLike(it);
    $('.comments .count').textContent = count(it.comments);
    $('.share .count').textContent = count(it.shares || 0);
    // The glow: the cover drawn small and blurred once, then stretched. Nothing to redraw while it plays.
    glow.classList.remove('on');
    if (!it.wide && it.cover) {
      const img = new Image();
      img.onload = () => {
        if (items[index] !== it) return;
        const g = glow.getContext('2d');
        const h = img.width * 36 / 64;
        g.filter = 'blur(3px) saturate(1.3)';
        g.drawImage(img, 0, Math.max(0, (img.height - h) / 2), img.width, Math.min(h, img.height), -4, -4, 72, 44);
        glow.classList.add('on');
      };
      img.src = it.cover;
    }
  };

  let awakeTimer = 0;
  const wake = () => {
    if (!root) return;
    root.classList.add('awake');
    clearTimeout(awakeTimer);
    awakeTimer = setTimeout(() => {
      if (!userPaused && railAt < 0) root.classList.remove('awake');
    }, AWAKE_MS);
  };

  let bufferTimer = 0;
  const buffering = on => {
    clearTimeout(bufferTimer);
    if (!on) root.classList.remove('buffering');
    else bufferTimer = setTimeout(() => root.classList.add('buffering'), 450);
  };
  /**
   * The dots, until the video's picture moves. Not until it says it plays: while TikTok's app loads, this
   * thread is so busy that a video "plays" for seconds on its first frame.
   */
  const untilMoving = v => {
    buffering(true);
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { if (v === current) buffering(false); });
    else v.addEventListener('playing', () => buffering(false), { once: true });
  };

  let firstPlayAt = 0;
  const ready = () => { if (!firstPlayAt) firstPlayAt = performance.now(); };
  /**
   * The app's loading screen comes down as the first video starts. Said when it's handed to the player, not
   * when it plays: TikTok's app is still loading then and keeps this thread busy for seconds, so a
   * "playing" event arrives long after the picture does. The app waits a moment on its own clock instead.
   */
  const starting = () => { try { window.falconApp?.postMessage('starting'); } catch (_) {} };

  // ---- Playing --------------------------------------------------------------------------------------

  const slotOf = i => slots[((i % 3) + 3) % 3];

  /** Puts video [i] in its slot (if it isn't there yet, or didn't load last time). */
  const load = i => {
    const it = items[i];
    const v = slotOf(i);
    if (it && (v.dataset.id !== it.id || v.dataset.failed)) {
      v.dataset.id = it.id;
      v.dataset.src = '0';
      delete v.dataset.failed;
      delete v.dataset.warm;
      v.poster = it.cover || '';
      v.src = it.srcs[0];
    }
    return v;
  };

  /** Videos skipped in a row because they wouldn't play. */
  let failsInRow = 0;
  let retryTimer = 0;
  /**
   * A link that won't play: the next one for the same video. With none left, a video on screen is skipped,
   * as TikTok does. Not when the TV is offline, or after two in a row (the network is the likelier trouble
   * then): it waits on the video instead and tries again every few seconds, and as soon as it's back online.
   */
  const failover = v => {
    const it = items.find(x => x.id === v.dataset.id);
    const n = Number(v.dataset.src || 0) + 1;
    if (it && n < it.srcs.length) {
      v.dataset.src = String(n);
      v.src = it.srcs[n];
      if (v === current && state === 'on' && !userPaused) v.play().catch(() => {});
      return;
    }
    v.dataset.failed = '1';
    if (v !== current) return;
    clearTimeout(retryTimer);
    if (navigator.onLine && failsInRow < 2) {
      failsInRow++;
      retryTimer = setTimeout(() => { if (v === current) show(index + 1); }, 800);
    } else {
      retryTimer = setTimeout(retry, 4000);
    }
  };
  /** The video on screen again, from the start of its links. */
  const retry = () => {
    clearTimeout(retryTimer);
    if (current?.dataset.failed) show(index);
  };
  addEventListener('online', retry);

  const viewerSound = () => {
    try {
      const s = JSON.parse(localStorage.getItem('webapp-video-mute') || '{}');
      return { muted: s.muted === true, volume: typeof s.volume === 'number' ? Math.min(1, Math.max(0, s.volume)) : 1 };
    } catch (_) { return { muted: false, volume: 1 }; }
  };

  /**
   * Starts the next video's decoder: it plays a moment, muted, behind the screen, then holds. Making a
   * decoder takes about 2 s on this TV's chip; with one ready, the switch is about 0.1 s.
   */
  const warm = v => {
    if (!v.dataset.id || v.dataset.warm === v.dataset.id) return;
    v.dataset.warm = v.dataset.id;
    v.muted = true;
    // Held at its first frame. While the page is busy "a moment" can run long; only then is it rewound,
    // as a seek costs the switch about 0.4 s.
    const hold = () => { if (v !== current) { v.pause(); if (v.currentTime > 0.3) v.currentTime = 0; } };
    v.play().then(() => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(hold) : hold()), () => {});
  };

  const show = i => {
    const it = items[i];
    if (i < 0 || !it) return false;
    const before = current;
    index = i;
    current = load(i);
    if (before && before !== current) {
      before.pause();
      before.muted = true;
      before.classList.remove('now');
      if (items === feed) watched++;
    }
    current.classList.add('now');
    const sound = viewerSound();
    current.muted = sound.muted;
    current.volume = sound.volume;
    // Coming back to a video starts it over, as TikTok does.
    if (current.currentTime > 1) current.currentTime = 0;
    userPaused = false;
    root.classList.remove('is-paused');
    const playing = state === 'on' && !backgrounded;
    if (playing) current.play().catch(() => {});
    // For debug(): key press to the new video's first frame on screen, both timed outside this thread.
    if (keyAt && current.requestVideoFrameCallback) {
      const from = keyAt, v = current, handled = Math.round(performance.now() - keyAt);
      v.requestVideoFrameCallback((_, frame) => {
        if (v === current) switches.push(`${handled}/${Math.round(frame.presentationTime - from)}`);
        if (switches.length > 30) switches.shift();
      });
    }
    keyAt = 0;
    bar.classList.remove('run');
    bar.style.transform = 'scaleX(0)';
    if (playing) untilMoving(current); else buffering(false);
    render(it);
    wake();
    const next = load(i + 1);
    if (state === 'on') warm(next);
    load(i - 1);
    if (items.length - i < 5) moreOf();
    saveNext();
    return true;
  };

  /** More of what's playing: the feed, or the creator's videos. */
  const moreOf = () => (items === feed ? more() : items === mine.items ? moreMine() : morePosts());

  let pendingStep = 0;
  const step = dir => {
    if (show(index + dir)) return;
    // At the end: as soon as more videos arrive.
    if (dir > 0) { pendingStep = 1; buffering(true); moreOf(); }
  };

  // ---- Auto next -----------------------------------------------------------------------------------------
  // A video that ends goes on to the next one, unless the viewer turned that off (the last button beside the
  // video). With the comments open it starts over instead, so they stay with the video being read about.

  const AUTO = 'falcon-auto-next';
  let autoNext = true;
  try { autoNext = localStorage.getItem(AUTO) !== '0'; } catch (_) {}
  const renderAuto = () => {
    const a = $('.act.auto');
    a.classList.toggle('off', !autoNext);
    a.querySelector('.count').textContent = autoNext ? text().autoOn : text().autoOff;
  };
  const setAuto = on => {
    autoNext = on;
    try { localStorage.setItem(AUTO, on ? '1' : '0'); } catch (_) {}
    renderAuto();
    wake();
  };
  const ended = v => {
    if (v !== current) return;
    if (autoNext && state === 'on' && view === 'player') return step(1);
    v.currentTime = 0;
    if (state === 'on' || state === 'menu') v.play().catch(() => {});
  };

  let toastTimer = 0;
  const toast = message => {
    const t = $('.toast');
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  };

  // ---- Hatun modu ----------------------------------------------------------------------------------------
  // A second feed, of creators the viewer picked and the creators TikTok finds like them, kept on this TV only.
  // The button beside the video switches between it and For You; holding OK on it adds the video's creator, and
  // so does a like in it. The videos come from TikTok's own lists: each picked creator's latest, and the latest
  // of the accounts TikTok suggests on a picked creator's profile, those suggested for several of them first.
  // (Not hashtags: they brought in a whole genre rather than more of what was picked.)

  const MINE = 'falcon-my-feed';
  const mine = { items: [], seen: new Set(), picked: [], found: [], asked: new Set(), shown: {},
    loading: null, at: 0, fyAt: 0 };
  const stored = () => { try { return JSON.parse(localStorage.getItem(MINE) || '{}'); } catch (_) { return {}; } };
  const store = change => { try { localStorage.setItem(MINE, JSON.stringify({ ...stored(), ...change })); } catch (_) {} };
  /** The creators picked for it, and the ones never to show in it. */
  const seeds = () => stored().creators || [];
  const blocked = () => new Set(stored().blocked || []);
  const saveSeeds = creators => store({ creators });
  /** Creators and blocks a build can carry (an untracked asset, see TikTokActivity), added once per version. */
  (given => {
    if (!given?.version || stored().given === given.version) return;
    const creators = seeds().slice();
    const known = new Set(creators.map(c => c.secUid));
    for (const c of given.creators || []) if (c.secUid && !known.has(c.secUid)) { known.add(c.secUid); creators.push(c); }
    store({ creators, blocked: [...new Set([...blocked(), ...(given.blocked || [])])], given: given.version });
  })(window.falconSeeds);
  /** Signs, in a caption or a bio, that the person may be under 18: those videos and accounts are left out. */
  const YOUNG = [
    /\b(1[0-7]|[5-9])\s*(yo|y\/o|yrs?|years?\s*old)\b/i, /\b(1[0-7]|[5-9])\s*ya[sş]/i, /\b(i'?m|i am|ben)\s+(1[0-7]|[5-9])\b/i,
    /\b(teens?|teenager|minor|middle\s*school|high\s*school|highschool|freshman|sophomore|([5-9]|1[0-2])th\s*grade)\b/i,
    /\b(lise|ortaokul|ilkokul)/i, /\b([5-9]|1[0-2])\s*\.\s*s[ıi]n[ıi]f/i, /^\s*(1[0-7])\s*$/m,
  ];
  const BORN = /\b(200[89]|201\d)\b|['’](0[89]|1\d)\b/;
  const youngBio = bio => YOUNG.some(r => r.test(bio)) || BORN.test(bio);
  const young = it => YOUNG.some(r => r.test(it.desc)) || youngBio(it.author?.bio || '');

  const source = (secUid, uid = '') => ({ secUid, uid, buf: [], cursor: 0, more: true, votes: 1 });
  /** The picked creators as sources, any added since included. */
  const syncPicked = () => {
    const no = blocked();
    mine.picked = mine.picked.filter(p => !no.has(p.secUid));
    mine.found = mine.found.filter(f => !no.has(f.secUid));
    for (const c of seeds()) if (!no.has(c.secUid) && !mine.picked.some(p => p.secUid === c.secUid)) mine.picked.push(source(c.secUid, c.uid || ''));
  };
  /** A creator's next page of videos, into its buffer, asked as TikTok's profile page asks. */
  const fill = src => api('/api/post/item_list/', { secUid: src.secUid, count: 16, cursor: src.cursor, coverFormat: 2,
    post_item_list_request_type: 0, needPinnedItemIds: true, device_platform: 'web_pc', from_page: 'user' }).then(j => {
    if (!j) { src.retryAt = performance.now() + RETRY_MS; return; }
    if (!Array.isArray(j.itemList)) { src.more = false; return; }
    src.cursor = j.cursor || src.cursor;
    src.more = !!j.hasMore;
    const list = j.itemList.map(toItem).filter(Boolean);
    src.uid ||= list[0]?.author.uid || '';
    src.buf.push(...list);
  });
  /** TikTok answering nothing usually means it wants a check first: that source waits this long. */
  const RETRY_MS = 60000;
  const resting = src => src.retryAt > performance.now();
  /** The accounts TikTok suggests on a picked creator's profile, as sources. One suggested again gets a vote. */
  /**
   * TikTok's "similar accounts" are partly about the viewer, not the creator: famous accounts (verified, or
   * followed by millions) come up beside almost anyone, and so would win on votes. They're left out.
   */
  const FAMOUS = 3e6;
  const famous = (u, st) => !!u.verified || Number(st?.followerCount ?? u.followerCount ?? 0) > FAMOUS;
  const discover = src => api('/api/user/list/', { count: 30, maxCursor: 0, minCursor: 0, scene: 151, targetUserId: src.uid,
    isNonPersonalized: false, device_platform: 'web_pc', from_page: 'user' }).then(j => {
    if (!j) return false;
    mine.asked.add(src.secUid);
    const no = blocked();
    for (const { user: u, stats: st } of j?.userList || []) {
      if (!u?.secUid || u.privateAccount || famous(u, st) || no.has(u.secUid) || youngBio(u.signature || '') || mine.picked.some(p => p.secUid === u.secUid)) continue;
      const known = mine.found.find(f => f.secUid === u.secUid);
      if (known) known.votes++; else mine.found.push(source(u.secUid, u.id || ''));
    }
    mine.found.sort((a, b) => b.votes - a.votes);
    return true;
  });

  /** Videos of one creator in a session, at most: so it isn't the same few accounts over and over. */
  const PER_CREATOR = 3;
  const tired = src => (mine.shown[src.secUid] || 0) >= PER_CREATOR;
  // Never the same twice: which creator comes next, whose suggestions are asked for and which of a creator's
  // videos plays are all left to chance, with creators suggested for more picked ones likelier (votes²).
  const any = list => list[Math.floor(Math.random() * list.length)];
  const likely = list => {
    let r = Math.random() * list.reduce((sum, x) => sum + x.votes * x.votes, 0);
    return list.find(x => (r -= x.votes * x.votes) < 0) || list[list.length - 1];
  };
  /** One unseen video from a source, any of the ones it has. */
  const takeFrom = (src, got) => {
    while (src.buf.length && !tired(src)) {
      const it = src.buf.splice(Math.floor(Math.random() * src.buf.length), 1)[0];
      if (mine.seen.has(it.id) || it.ad || young(it)) continue;
      mine.seen.add(it.id);
      mine.shown[src.secUid] = (mine.shown[src.secUid] || 0) + 1;
      got.push(it);
      return;
    }
  };
  /** At most this many of TikTok's requests per batch, a moment apart: a burst of them gets a check. */
  const ASKS = 5;
  const moreMine = () => mine.loading ||= (async () => {
    syncPicked();
    const got = [];
    let asked = 0;
    const ask = async request => {
      if (asked++) await new Promise(r => setTimeout(r, 400));
      await request();
    };
    // Suggestions for one more creator: the picked ones first, then the suggested ones with most votes, so the
    // circle keeps widening. (A creator's id comes with their videos.)
    const fresh = mine.found.filter(f => !tired(f)).length;
    const unasked = mine.picked.filter(p => !mine.asked.has(p.secUid) && !resting(p));
    const wider = fresh < 20 && mine.found.filter(f => !mine.asked.has(f.secUid) && f.uid && !resting(f));
    const next = unasked.length ? any(unasked) : wider?.length ? likely(wider) : null;
    if (next) {
      if (!next.uid) await ask(() => fill(next));
      if (next.uid) { if (!await discover(next)) next.retryAt = performance.now() + RETRY_MS; }
      else if (!resting(next)) mine.asked.add(next.secUid);
    }
    // Then one video each from a run of creators: about two suggested ones for every picked one.
    for (let n = 0; n < 30 && got.length < 10; n++) {
      const fromFound = mine.found.length > 0 && Math.random() < 0.65;
      const list = (fromFound ? mine.found : mine.picked).filter(x => !tired(x) && (x.buf.length || x.more && !resting(x)));
      if (!list.length) continue;
      const src = fromFound ? likely(list) : any(list);
      if (!src.buf.length && asked < ASKS) await ask(() => fill(src));
      takeFrom(src, got);
    }
    // Not one creator twice in a row, where that can be helped.
    for (let i = 1; i < got.length; i++) {
      if (got[i].handle !== got[i - 1].handle) continue;
      const j = got.findIndex((x, k) => k > i && x.handle !== got[i].handle);
      if (j > 0) [got[i], got[j]] = [got[j], got[i]];
    }
    mine.loading = null;
    if (got.length) { mine.items.push(...got); onItems(); }
    else if (items === mine.items && pendingStep) {
      // Nothing came (TikTok wanting a check, most likely): back to For You rather than a spinner.
      pendingStep = 0;
      buffering(false);
      if (!mine.items.length) toggleMine();
      toast(text().mineNothing);
    }
  })();

  /** Adds a video's creator to hatun modu. False if they're in it already. */
  const addSeed = it => {
    const secUid = it?.author?.secUid;
    if (!secUid) return false;
    const creators = seeds();
    if (creators.some(c => c.secUid === secUid)) return false;
    creators.push({ handle: it.handle, secUid, uid: it.author.uid || '' });
    saveSeeds(creators);
    mine.found = mine.found.filter(f => f.secUid !== secUid);
    syncPicked();
    return true;
  };

  /** Takes the video's creator out of hatun modu for good (not picked, never suggested again) and moves on. */
  const dropCreator = it => {
    const secUid = it?.author?.secUid;
    if (!secUid) return;
    store({ creators: seeds().filter(c => c.secUid !== secUid), blocked: [...new Set([...blocked(), secUid])] });
    syncPicked();
    for (let i = mine.items.length - 1; i > index; i--) if (mine.items[i].author?.secUid === secUid) mine.items.splice(i, 1);
    toast(text().dropped);
    step(1);
  };

  const renderMine = () => {
    $('.act.mine .count').textContent = text().mine;
    $('.feedname').textContent = text().mine;
  };
  /** For You to hatun modu and back, each where it was left. */
  const toggleMine = () => {
    const at = items === home ? index : homeAt;
    homeAt = -1;
    if (home === feed) {
      if (!seeds().length) return toast(text().mineEmpty);
      mine.fyAt = at;
      home = items = mine.items;
      root.classList.add('mine');
      toast(text().mine);
      if (mine.items[mine.at]) show(mine.at);
      else { current?.pause(); index = mine.items.length - 1; step(1); }
    } else {
      mine.at = Math.max(0, at);
      home = items = feed;
      root.classList.remove('mine');
      toast(text().forYou);
      show(Math.max(0, mine.fyAt));
    }
  };

  const onItems = () => {
    if (pendingStep && items[index + 1]) { pendingStep = 0; show(index + 1); }
    else if (started && items[index + 1] && slotOf(index + 1).dataset.id !== items[index + 1].id) {
      load(index + 1);
      if (state === 'on' && view !== 'profile') warm(slotOf(index + 1));
    }
    tick();
  };

  const setPaused = paused => {
    if (!current) return;
    userPaused = paused;
    root.classList.toggle('is-paused', paused);
    if (paused) { current.pause(); buffering(false); } else { current.play().catch(() => {}); untilMoving(current); }
    wake();
  };

  const like = (fromHold = false) => {
    const it = items[index];
    if (!it) return;
    if (fromHold) {
      burstEl.classList.remove('go');
      void burstEl.getBoundingClientRect();
      burstEl.classList.add('go');
      if (it.liked) return;
    }
    const want = !it.liked;
    if (want && home === mine.items) addSeed(it);
    it.liked = want;
    it.likes = Math.max(0, it.likes + (want ? 1 : -1));
    renderLike(it);
    likeEl.classList.remove('pop');
    void likeEl.getBoundingClientRect();
    if (want) likeEl.classList.add('pop');
    sendLike(it.id, want).then(ok => {
      if (ok || it.liked !== want) return;
      // TikTok didn't take it: back as it was.
      it.liked = !want;
      it.likes = Math.max(0, it.likes + (want ? -1 : 1));
      if (items[index] === it) renderLike(it);
    });
  };

  // ---- The buttons beside the video ----------------------------------------------------------------------
  // ▶ puts the ring on the like button, ▲▼ move it to the creator's face, the comments, sharing and auto next,
  // OK presses.

  const RAIL = ['author', 'like', 'comments', 'share', 'mine', 'auto'];
  /** Where the ring is on them, or -1 for not there. */
  let railAt = -1;
  const focusRail = i => {
    railAt = i;
    RAIL.forEach((name, j) => $(`.act.${name}`).classList.toggle('focused', j === i));
    wake();
  };
  const pressRail = () => {
    const what = RAIL[railAt];
    if (what === 'like') like();
    else if (what === 'comments') openComments();
    else if (what === 'author') openProfile();
    else if (what === 'share') share();
    else if (what === 'mine') toggleMine();
    else if (what === 'auto') setAuto(!autoNext);
  };

  // ---- Sharing -------------------------------------------------------------------------------------------
  // TikTok's own share panel, straight on "Send to friends" (its friend list, and TikTok's messages to send it
  // with). It belongs to TikTok's page for the video, which opens inside TikTok's app without a reload, so
  // when the panel closes, the feed is back where it was.

  /** One of TikTok's pages, opened inside TikTok's app without a reload, so Back finds the feed as it was. */
  const goTo = path => {
    history.pushState(history.state, '', path);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    tick();
  };

  /** While sharing: when it started, and how far it got. */
  let sharing = null;
  const share = () => {
    const it = items[index];
    if (!it?.handle) return;
    focusRail(-1);
    sharing = { at: performance.now(), panel: false, friends: false, quietSince: 0 };
    goTo(`/@${encodeURIComponent(it.handle)}/video/${it.id}`);
  };
  const doneSharing = () => {
    sharing = null;
    if (!onFeed()) history.back();
  };
  const shareTick = () => {
    if (!sharing) return;
    if (onFeed()) { sharing = null; return; }
    // TikTok's page plays the video too; the panel is what's wanted.
    for (const v of document.querySelectorAll('video')) if (!v.paused) v.pause();
    const open = window.falconTv?.popup?.();
    if (!sharing.panel) {
      const button = [...document.querySelectorAll('[data-e2e="share-icon"]')].find(el => el.getBoundingClientRect().width > 0);
      if (button && !open) {
        (button.closest('button') || button).click();
        sharing.panel = true;
      } else if (!open && performance.now() - sharing.at > SHARE_WAIT_MS) {
        // TikTok's page didn't come (or wanted a check, now closed): back to the feed.
        doneSharing();
      }
      return;
    }
    if (open) {
      sharing.quietSince = 0;
      const friends = !sharing.friends && open.querySelector?.('[data-e2e="share-message"]');
      if (friends) { friends.click(); sharing.friends = true; }
      return;
    }
    // Closed (sent, or Back): the feed again. A moment's grace, while one of TikTok's panels gives way to the next.
    sharing.quietSince ||= performance.now();
    if (performance.now() - sharing.quietSince > 1200) doneSharing();
  };

  /** What the layer shows: 'player', 'comments' (beside the player) or 'profile' (a creator's page). */
  let view = 'player';

  const TEXT = {
    en: { comments: n => `${n} comments`, replies: n => `View ${n} ${n === '1' ? 'reply' : 'replies'}`, hide: 'Hide',
      more: 'View more', none: 'No comments yet', failed: "Couldn't load. Try again later.", creator: 'Creator',
      following: 'Following', followers: 'Followers', likes: 'Likes', noVideos: 'No videos yet',
      private: 'This account is private', pinned: 'Pinned', autoOn: 'Auto: on', autoOff: 'Auto: off',
      mine: 'hatun modu', forYou: 'For You', added: 'Added to hatun modu', already: 'Already in hatun modu',
      dropped: 'Taken out of hatun modu',
      mineEmpty: "hatun modu is empty. Hold OK on this button to add the video's creator.",
      mineNothing: "TikTok didn't send hatun modu's videos. It may want a check first: open a creator's page and press OK.",
      noPosts: "Couldn't load the videos here. Press OK to open this profile on TikTok's page." },
    tr: { comments: n => `${n} yorum`, replies: n => `${n} yanıtı görüntüle`, hide: 'Gizle',
      more: 'Daha fazla görüntüle', none: 'Henüz yorum yok', failed: 'Yüklenemedi. Daha sonra tekrar dene.', creator: 'Üretici',
      following: 'Takip edilen', followers: 'Takipçi', likes: 'Beğeni', noVideos: 'Henüz video yok',
      private: 'Bu hesap gizli', pinned: 'Sabitlendi', autoOn: 'Oto: açık', autoOff: 'Oto: kapalı',
      mine: 'hatun modu', forYou: 'Senin İçin', added: 'hatun moduna eklendi', already: 'Zaten hatun modunda',
      dropped: 'hatun modundan çıkarıldı',
      mineEmpty: 'hatun modu boş. Videonun hesabını eklemek için bu düğmede OK\'a basılı tut.',
      mineNothing: 'TikTok hatun modunun videolarını göndermedi. Önce doğrulama istiyor olabilir: bir hesabın sayfasını açıp OK\'a bas.',
      noPosts: 'Videolar burada yüklenemedi. Profili TikTok\'un sayfasında açmak için OK\'a bas.' },
  };
  const text = () => TEXT[language().slice(0, 2)] || TEXT.en;
  const el = (tag, cls, content) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (content) e.textContent = content;
    return e;
  };
  const ago = seconds => {
    const d = Date.now() / 1000 - seconds;
    try {
      const rtf = new Intl.RelativeTimeFormat(language(), { numeric: 'auto', style: 'narrow' });
      for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
        if (d >= size) return rtf.format(-Math.floor(d / size), unit);
      }
      return rtf.format(0, 'second');
    } catch (_) { return ''; }
  };

  // ---- Comments ------------------------------------------------------------------------------------------
  // Beside the video, as on TikTok's site, with the video playing on. ▲▼ go through them, OK opens a
  // comment's replies (and closes them again), ◀ or Back closes the comments.

  const thread = { id: null, cursor: 0, more: true, loading: null, total: 0 };
  const cdata = new WeakMap();
  let cFocus = null;
  const clist = () => $('.clist');
  const cstops = () => [...clist().querySelectorAll('.c, .more')];

  const commentEl = (c, reply = false) => {
    const u = c.user || {};
    const row = el('div', reply ? 'c reply' : 'c');
    const face = el('img', 'cav');
    face.alt = '';
    face.decoding = 'async';
    const faceSrc = u.avatar_thumb?.url_list?.[0];
    if (faceSrc) face.src = faceSrc;
    const body = el('div', 'cbody');
    const name = el('div', 'cname', u.nickname || u.unique_id || '');
    if (u.unique_id && u.unique_id === items[index]?.handle) name.append(el('span', 'tag', text().creator));
    body.append(name, el('div', 'ctext', c.text || ''));
    const pic = c.image_list?.[0]?.crop_url?.url_list?.[0] || c.image_list?.[0]?.origin_url?.url_list?.[0];
    if (pic) {
      const img = el('img', 'cimg');
      img.alt = '';
      img.src = pic;
      body.append(img);
    }
    const meta = el('div', 'cmeta');
    if (c.create_time) meta.append(el('span', '', ago(Number(c.create_time))));
    const hearts = el('span');
    hearts.innerHTML = svg(ICON.heart);
    hearts.append(count(Number(c.digg_count) || 0) || '0');
    meta.append(hearts);
    body.append(meta);
    const replies = Number(c.reply_comment_total) || 0;
    if (!reply && replies) body.append(el('div', 'creplies', text().replies(compact.format(replies))));
    row.append(face, body);
    cdata.set(row, { c, replies, open: false, cursor: 0, nodes: [], loading: null });
    return row;
  };

  const focusComment = row => {
    cFocus?.classList.remove('focused');
    cFocus = row;
    if (!row) return;
    row.classList.add('focused');
    // In view, with a little of what comes before and after it.
    const list = clist();
    const top = row.offsetTop, bottom = top + row.offsetHeight;
    if (top - 40 < list.scrollTop) list.scrollTo({ top: Math.max(0, top - 40), behavior: 'smooth' });
    else if (bottom + 60 > list.scrollTop + list.clientHeight) list.scrollTo({ top: bottom + 60 - list.clientHeight, behavior: 'smooth' });
  };

  const setNote = (box, words) => {
    box.querySelector(':scope > .note')?.remove();
    if (words) box.append(el('div', 'note', words));
  };
  const waiting = (box, on) => {
    box.querySelector(':scope > .wait')?.remove();
    if (on) box.append(Object.assign(el('div', 'wait'), { innerHTML: '<i></i><i></i>' }));
  };

  const loadComments = () => {
    if (thread.loading || !thread.more) return thread.loading || Promise.resolve();
    const id = thread.id;
    waiting(clist(), true);
    return thread.loading = api('/api/comment/list/', { aweme_id: id, count: 20, cursor: thread.cursor }).then(j => {
      if (thread.id !== id) return;
      thread.loading = null;
      waiting(clist(), false);
      if (!j || (j.status_code !== 0 && !Array.isArray(j.comments))) {
        // Refused, or a check to pass: ▼ at the end asks again.
        if (!cstops().length) setNote(clist(), text().failed);
        return;
      }
      setNote(clist(), '');
      thread.cursor = Number(j.cursor) || thread.cursor + 20;
      thread.more = !!j.has_more;
      if (Number(j.total) > 0) {
        thread.total = Number(j.total);
        $('.panel-head').textContent = text().comments(compact.format(thread.total));
      }
      for (const c of j.comments || []) clist().append(commentEl(c));
      if (!cstops().length) setNote(clist(), text().none);
      else if (!cFocus) focusComment(cstops()[0]);
    });
  };

  const openComments = () => {
    const it = items[index];
    if (!it) return;
    focusRail(-1);
    view = 'comments';
    root.classList.add('side');
    if (thread.id !== it.id) {
      Object.assign(thread, { id: it.id, cursor: 0, more: true, loading: null, total: it.comments });
      clist().textContent = '';
      clist().scrollTop = 0;
      cFocus = null;
      $('.panel-head').textContent = text().comments(compact.format(it.comments));
      loadComments();
    }
  };
  const closeComments = () => {
    view = 'player';
    root.classList.remove('side');
    wake();
  };

  const loadReplies = (row, d, moreRow = null) => {
    if (d.loading) return;
    const id = thread.id;
    d.loading = api('/api/comment/list/reply/', { item_id: id, comment_id: d.c.cid, count: 10, cursor: d.cursor }).then(j => {
      d.loading = null;
      if (thread.id !== id || !d.open) return;
      if (!j || !Array.isArray(j.comments)) {
        if (!d.nodes.length) closeReplies(row, d);
        return;
      }
      const wasFocused = moreRow && cFocus === moreRow;
      if (moreRow) { moreRow.remove(); d.nodes = d.nodes.filter(n => n !== moreRow); }
      let after = d.nodes.at(-1) || row;
      const fresh = [];
      for (const c of j.comments) {
        const r = commentEl(c, true);
        after.after(r);
        after = r;
        fresh.push(r);
      }
      d.nodes.push(...fresh);
      d.cursor = Number(j.cursor) || d.cursor + j.comments.length;
      if (j.has_more && j.comments.length) {
        const m = el('div', 'more', text().more);
        cdata.set(m, { parent: row });
        after.after(m);
        d.nodes.push(m);
      }
      if (wasFocused) focusComment(fresh[0] || d.nodes.at(-1) || row);
    });
  };
  const closeReplies = (row, d) => {
    d.nodes.forEach(n => n.remove());
    if (d.nodes.includes(cFocus)) focusComment(row);
    Object.assign(d, { open: false, cursor: 0, nodes: [] });
    row.querySelector('.creplies').textContent = text().replies(compact.format(d.replies));
  };
  const toggleReplies = row => {
    const d = cdata.get(row);
    if (!d) return;
    if (d.parent) return loadReplies(d.parent, cdata.get(d.parent), row);
    if (!d.replies) return;
    if (d.open) return closeReplies(row, d);
    d.open = true;
    row.querySelector('.creplies').textContent = text().hide;
    loadReplies(row, d);
  };

  const commentsKey = (key, e) => {
    if (key === 'ArrowLeft') return closeComments();
    if (key === 'Enter') { if (!e.repeat && cFocus) toggleReplies(cFocus); return; }
    if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
    const down = key === 'ArrowDown';
    const stops = cstops();
    const i = stops.indexOf(cFocus);
    const to = stops[i + (down ? 1 : -1)];
    if (to) focusComment(to);
    if (!down) return;
    // The next page, a little before the end; at the end, the ring follows as it arrives.
    if (stops.length - i < 6) loadComments();
    if (!to && thread.loading) {
      const from = cFocus;
      thread.loading.then(() => {
        const now = cstops();
        if (cFocus === from && now[now.indexOf(from) + 1]) focusComment(now[now.indexOf(from) + 1]);
      });
    }
    if (!stops.length && !thread.loading) { thread.more = true; loadComments(); }
  };

  // ---- A creator's page ----------------------------------------------------------------------------------
  // OK on their face beside the video: who they are, and their videos in a grid. OK plays one, and ▲▼ then
  // go through their videos. Back goes back to the grid, then to the feed, where it was.

  const COLS = 6;
  const creator = { handle: null, secUid: '', items: [], cursor: 0, more: true, loading: null, detail: null, at: 0 };
  /** Where For You or hatun modu was, while a creator's videos play. */
  let homeAt = -1;
  let tileAt = -1;
  const tiles = () => $('.grid').children;

  const paintHead = (who, stats) => {
    const pav = $('.pav');
    if (who.avatar) pav.src = who.avatar; else pav.removeAttribute('src');
    $('.pname').textContent = who.name || who.handle;
    if (who.verified) $('.pname').insertAdjacentHTML('beforeend', svg(ICON.tick, 'tick'));
    $('.phandle').textContent = `@${who.handle}`;
    const box = $('.pstats');
    box.textContent = '';
    const words = text();
    // Not known yet (a video saved by an older version): left out until TikTok says.
    if (stats.following || stats.followers || stats.hearts) for (const [n, label] of [[stats.following, words.following], [stats.followers, words.followers], [stats.hearts, words.likes]]) {
      const s = el('span');
      s.append(el('b', '', compact.format(n || 0)), label);
      box.append(s);
    }
    $('.pbio').textContent = (who.bio || '').trim();
  };

  const addTile = it => {
    const tile = el('div', 'tile');
    const img = el('img');
    img.alt = '';
    img.decoding = 'async';
    if (it.cover) img.src = it.cover;
    tile.append(img);
    if (it.plays) {
      const plays = el('span', 'plays');
      plays.innerHTML = svg(ICON.play);
      plays.append(compact.format(it.plays));
      tile.append(plays);
    }
    if (it.pinned) tile.append(el('span', 'pin', text().pinned));
    $('.grid').append(tile);
  };

  const focusTile = i => {
    const all = tiles();
    if (!all.length) return;
    i = Math.max(0, Math.min(all.length - 1, i));
    all[tileAt]?.classList.remove('focused');
    tileAt = creator.at = i;
    const tile = all[i];
    tile.classList.add('focused');
    // The first row shows the creator above it; the others stay in view as the ring moves.
    const sc = $('.pscroll');
    const top = tile.offsetTop, bottom = top + tile.offsetHeight;
    if (i < COLS) sc.scrollTo({ top: 0, behavior: 'smooth' });
    else if (top - 24 < sc.scrollTop) sc.scrollTo({ top: top - 24, behavior: 'smooth' });
    else if (bottom + 24 > sc.scrollTop + sc.clientHeight) sc.scrollTo({ top: bottom + 24 - sc.clientHeight, behavior: 'smooth' });
    if (all.length - i <= COLS * 2) morePosts();
  };

  /** Who they are, from TikTok: their numbers now, their bio, and the id their videos are asked for by. */
  const loadDetail = () => {
    const handle = creator.handle;
    return creator.detail ||= api('/api/user/detail/', { uniqueId: handle, secUid: creator.secUid }).then(j => {
      const u = j?.userInfo?.user;
      if (!u || creator.handle !== handle) return;
      const st = j.userInfo.statsV2 || j.userInfo.stats || {};
      creator.secUid ||= u.secUid || '';
      creator.private = !!u.privateAccount;
      paintHead({ name: u.nickname, handle: u.uniqueId || handle, avatar: u.avatarMedium || u.avatarLarger || u.avatarThumb,
        verified: !!u.verified, bio: u.signature },
      { following: Number(st.followingCount), followers: Number(st.followerCount), hearts: Number(st.heartCount ?? st.heart) });
    });
  };

  const morePosts = () => {
    if (creator.loading || !creator.more) return creator.loading || Promise.resolve();
    const handle = creator.handle;
    if (!tiles().length) waiting($('.pscroll'), true);
    return creator.loading = (creator.secUid ? Promise.resolve() : loadDetail()).then(() => creator.secUid
      // As TikTok's profile page asks: without the platform and the page it comes from, an empty answer.
      ? api('/api/post/item_list/', { secUid: creator.secUid, count: 16, cursor: creator.cursor, coverFormat: 2,
        post_item_list_request_type: 0, needPinnedItemIds: true, device_platform: 'web_pc', from_page: 'user' })
      : null).then(j => {
      if (creator.handle !== handle) return;
      creator.loading = null;
      waiting($('.pscroll'), false);
      if (!j || !Array.isArray(j.itemList)) {
        if (!j || j.statusCode !== 0) {
          // TikTok can still answer nothing here, wanting a check first. Its own profile page then asks for that
          // check, which the remote can do (tv.js), and shows them.
          creator.failed = !creator.private;
          if (!tiles().length) $('.pnote').textContent = creator.private ? text().private : text().noPosts;
          return;
        }
      }
      creator.failed = false;
      creator.cursor = j.cursor || creator.cursor;
      creator.more = !!j.hasMore;
      const fresh = (j.itemList || []).map(toItem).filter(it => it && !creator.items.some(x => x.id === it.id));
      creator.items.push(...fresh);
      fresh.forEach(addTile);
      $('.pnote').textContent = creator.items.length ? '' : creator.private ? text().private : text().noVideos;
      if (view === 'profile' && tileAt < 0) focusTile(0);
      if (items === creator.items) onItems();
    });
  };

  const openProfile = () => {
    const it = items[index];
    if (!it?.handle) return;
    focusRail(-1);
    if (items === creator.items) creator.at = index;
    current?.pause();
    buffering(false);
    view = 'profile';
    root.classList.add('on-profile');
    if (creator.handle === it.handle) return focusTile(creator.at);
    const a = it.author || {};
    Object.assign(creator, { handle: it.handle, secUid: a.secUid || '', items: [], cursor: 0, more: true, loading: null,
      detail: null, private: false, failed: false, at: 0 });
    tileAt = -1;
    $('.grid').textContent = '';
    $('.pnote').textContent = '';
    $('.pscroll').scrollTop = 0;
    paintHead({ name: it.name, handle: it.handle, avatar: a.avatar || it.avatar, verified: it.verified, bio: a.bio }, a);
    loadDetail();
    morePosts();
  };

  /** Back to the feed: the video it was on, playing again (from the start, if the creator's videos played). */
  const closeProfile = () => {
    view = 'player';
    root.classList.remove('on-profile');
    if (items !== home) {
      items = home;
      const i = homeAt;
      homeAt = -1;
      show(i);
    } else if (current && !userPaused && state === 'on' && !backgrounded) {
      current.play().catch(() => {});
      untilMoving(current);
    }
    wake();
  };

  /** Plays the creator's video [i], then the rest of theirs with ▲▼. */
  const playCreator = i => {
    if (!creator.items[i]) return;
    if (items === home) homeAt = index;
    items = creator.items;
    view = 'player';
    root.classList.remove('on-profile');
    show(i);
  };

  const profileKey = (key, e) => {
    const n = tiles().length;
    if (key === 'Enter') {
      if (e.repeat) return;
      if (n) playCreator(tileAt);
      else if (creator.failed) goTo(`/@${encodeURIComponent(creator.handle)}`);
      return;
    }
    if (!n) return;
    const col = tileAt % COLS;
    if (key === 'ArrowLeft') { if (col > 0) focusTile(tileAt - 1); return; }
    if (key === 'ArrowRight') { if (col < COLS - 1 && tileAt + 1 < n) focusTile(tileAt + 1); return; }
    if (key === 'ArrowUp') { if (tileAt >= COLS) focusTile(tileAt - COLS); else $('.pscroll').scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (key === 'ArrowDown') {
      if (tileAt + COLS < n) focusTile(tileAt + COLS);
      // A shorter last row: its last video.
      else if (Math.floor((n - 1) / COLS) > Math.floor(tileAt / COLS)) focusTile(n - 1);
      else morePosts();
    }
  };

  // ---- The layer's place --------------------------------------------------------------------------------

  const setState = next => {
    if (next === state) return;
    state = next;
    if (Object.keys(marks).length < 40) {
      const why = next === 'under' ? window.falconTv?.popup?.() : null;
      marks[`${Object.keys(marks).length}:${next}`] = `${Math.round(performance.now())}${why ? ` ${why.className || why.host?.tagName || why.nodeName}`.slice(0, 80) : ''}`;
    }
    if (!host) build();
    host.style.display = next === 'off' ? 'none' : 'block';
    // The menu goes over the video, and TikTok's pop-ups over everything.
    host.style.zIndex = next === 'on' ? '2147483600' : next === 'menu' ? '2147482000' : '0';
    document.documentElement.classList.toggle('falcon-lean', next !== 'off');
    if (next === 'on') {
      if (!started) { started = true; mark('show'); show(0); starting(); }
      else if (current && !userPaused && !backgrounded && view !== 'profile') { current.play().catch(() => {}); untilMoving(current); warm(slotOf(index + 1)); }
      wake();
    } else {
      // The video plays on behind the menu; a pop-up, or another page, stops it.
      if (next !== 'menu') { slots.forEach(v => v.pause()); buffering(false); }
      root.classList.remove('awake');
      if (railAt >= 0) focusRail(-1);
    }
  };

  /** Without our own videos for too long: TikTok's own player takes the feed back. */
  const giveUp = () => {
    failed = true;
    setState('off');
    held.splice(0).forEach(go => go());
    const v = [...document.querySelectorAll('video')].find(x => {
      const r = x.getBoundingClientRect();
      return r.width > 4 && r.top < innerHeight / 2 && r.bottom > innerHeight / 2;
    });
    if (v) { v.muted = false; v.play().catch(() => {}); }
  };

  function tick() {
    if (failed || !document.documentElement) return;
    shareTick();
    if (onFeed() && !feed.length && performance.now() - bornAt > GIVE_UP_MS) return giveUp();
    const tv = window.falconTv;
    setState(!onFeed() || !items.length && !(items === mine.items && mine.loading) ? 'off' : tv?.popup?.() ? 'under' : tv?.mode === 'menu' ? 'menu' : 'on');
    if (state === 'off') return;
    silenceTikTok();
    if (current?.duration) {
      bar.classList.add('run');
      bar.style.transform = `scaleX(${(current.currentTime / current.duration).toFixed(3)})`;
    }
  }
  setInterval(tick, 250);

  // ---- The remote ----------------------------------------------------------------------------------------

  // OK acts when it's let go (holding it likes), so a press that started elsewhere (the grid's OK, which
  // starts a video) doesn't also pause the video it started.
  let okDownAt = 0, okHeld = false, okArmed = false, lastStep = 0;
  addEventListener('keydown', e => {
    if (state !== 'on') return;
    const key = e.key;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (view === 'profile') return profileKey(key, e);
    if (view === 'comments') return commentsKey(key, e);
    if (key === 'Enter') {
      if (!e.repeat) { okDownAt = performance.now(); okHeld = false; okArmed = true; }
      else if (okArmed && !okHeld && (railAt < 0 || RAIL[railAt] === 'like' || RAIL[railAt] === 'mine') && performance.now() - okDownAt >= HOLD_MS) {
        okHeld = true;
        // On hatun modu's button: in For You it adds the creator, in hatun modu it takes them out.
        if (RAIL[railAt] === 'mine' && items === mine.items) dropCreator(items[index]);
        else if (RAIL[railAt] === 'mine') toast(addSeed(items[index]) ? text().added : text().already);
        else like(true);
        wake();
      }
      return;
    }
    wake();
    if (railAt >= 0) {
      if (key === 'ArrowUp' || key === 'ArrowDown') focusRail(Math.max(0, Math.min(RAIL.length - 1, railAt + (key === 'ArrowDown' ? 1 : -1))));
      else if (key === 'ArrowLeft') focusRail(-1);
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      // Holding the button skims, but not faster than the videos can start.
      const now = performance.now();
      if (e.repeat && now - lastStep < 320) return;
      lastStep = now;
      keyAt = e.timeStamp;
      step(key === 'ArrowDown' ? 1 : -1);
    } else if (key === 'ArrowRight') {
      focusRail(RAIL.indexOf('like'));
    } else {
      window.falconTv?.menu?.();
      tick();
    }
  }, true);
  addEventListener('keyup', e => {
    if (state !== 'on' || e.key !== 'Enter') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const armed = okArmed;
    okArmed = false;
    if (armed && view === 'player' && !okHeld) {
      if (railAt >= 0) pressRail();
      else setPaused(!userPaused);
    }
    okHeld = false;
  }, true);

  document.addEventListener('DOMContentLoaded', () => { parsing.disconnect(); fromPage(); tick(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) window.falconLean.pause(); else window.falconLean.resume();
  });

  if (onFeed()) fromCache();

  window.falconLean = {
    get active() { return state === 'on'; },
    get state() { return state; },
    /**
     * Back: leaves the buttons, closes the comments, goes from a creator's video to their page and from
     * their page to the feed. False if there's nothing of ours to close.
     */
    back() {
      // Sharing, with TikTok's panel already closed: straight back to the feed.
      if (sharing && !window.falconTv?.popup?.()) { doneSharing(); return true; }
      if (state !== 'on') return false;
      if (railAt >= 0) focusRail(-1);
      else if (view === 'comments') closeComments();
      else if (view === 'profile') closeProfile();
      else if (items !== home) openProfile();
      else return false;
      return true;
    },
    /** The remote's play/pause key. False if our layer isn't up. */
    playPause() {
      if (state !== 'on') return false;
      if (view !== 'profile') setPaused(!userPaused);
      return true;
    },
    /** The app going to the background, and coming back. */
    pause() { backgrounded = true; slots.forEach(v => v.pause()); if (root) buffering(false); },
    resume() {
      backgrounded = false;
      if (view === 'profile') return;
      if (state === 'on' && current && !userPaused) { current.play().catch(() => {}); untilMoving(current); }
      // In the background the next video's decoder may have gone: started again.
      const next = slotOf(index + 1);
      if (state === 'on' && next.dataset.id) { delete next.dataset.warm; warm(next); }
    },
    debug: () => ({ state, view, index, items: items.length, feed: feed.length, feedUrl: !!feedUrl, apiFrom: !!apiFrom,
      failed, watched, marks, switches, ui: root?.className, userPaused, railAt, liked: items[index]?.liked,
      likes: items[index]?.likes, adsSkipped, autoNext,
      mine: { on: home === mine.items, items: mine.items.length, at: mine.at, seeds: seeds().length, picked: mine.picked.length,
        asked: mine.asked.size, found: mine.found.length, votes: mine.found.slice(0, 8).map(f => f.votes),
        blocked: blocked().size },
      font: root?.classList.contains('tiktok-font'),
      thread: { id: thread.id, shown: root ? cstops().length : 0, more: thread.more, total: thread.total },
      creator: { handle: creator.handle, secUid: creator.secUid, videos: creator.items.length, more: creator.more, at: creator.at },
      now: items[index] && (({ id, name, handle, desc, music, musicId, tags, likes }) => ({ id, name, handle, desc, music, musicId, tags, likes }))(items[index]),
      slots: slots.map(v => ({ id: v.dataset.id?.slice(-4), now: v === current, rs: v.readyState, paused: v.paused, t: +v.currentTime.toFixed(2) })) }),
  };
})();
