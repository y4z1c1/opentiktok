// Runs at the start of every tiktok.com page, before tv.js: a lean player for the For You feed.
//
// TikTok's own feed page is heavy for this TV: each move to the next video re-renders it, freezing the
// picture and the remote for up to 1.5 s, and the first video takes about 11 s to appear. So on the feed,
// TikTok's page stays loaded but out of sight (it keeps the session and signs requests) and the videos play
// in a layer of our own: three <video> elements, our own text and buttons, and little else.
//
// The videos are TikTok's own feed: the first few come with the page itself, the next ones from TikTok's
// own feed request, and later ones from the same request again, which TikTok's security script signs.
// A like is TikTok's like request with its CSRF token. Everything else (the menu, sign-in, profiles,
// pop-ups and checks) is TikTok's page, run by tv.js; the layer steps aside for it.
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

  const items = [];
  const seen = new Set();
  /** TikTok's own feed request, reused for more videos and for the like request's parameters. */
  let feedUrl = null;
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
  let likeFocused = false;
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
    return {
      id: String(raw.id), srcs, cover: v.cover || v.originCover || '',
      wide: (v.width || 0) >= (v.height || 1) * 1.3,
      name: raw.author?.nickname || raw.author?.uniqueId || '', handle: raw.author?.uniqueId || '',
      avatar: raw.author?.avatarThumb || '', verified: !!raw.author?.verified,
      desc: raw.desc || '', music,
      likes: Number(s.diggCount) || 0, comments: Number(s.commentCount) || 0, saves: Number(s.collectCount) || 0,
      liked: !!raw.digged, ad: !!raw.isAd,
    };
  };

  const addItems = list => {
    let added = 0;
    for (const it of list) {
      if (it && !seen.has(it.id)) { seen.add(it.id); items.push(it); added++; }
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
    furthest = Math.max(furthest, index);
    try { localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), items: items.slice(furthest + 1, furthest + 7) })); } catch (_) {}
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

  /** TikTok's like request (type 1 likes, 0 takes it back). True if TikTok took it. */
  const sendLike = (id, on) => new Promise(resolve => {
    const csrf = appContext()?.csrfToken;
    if (!feedUrl || !csrf) return resolve(false);
    const from = new URL(feedUrl).searchParams;
    const u = new URL('/api/commit/item/digg/', location.origin);
    for (const k of COMMON) if (from.has(k)) u.searchParams.set(k, from.get(k));
    u.searchParams.set('aweme_id', id);
    u.searchParams.set('type', on ? '1' : '0');
    const x = new XMLHttpRequest();
    x.open('POST', u.toString());
    x.withCredentials = true;
    x.setRequestHeader('tt-csrf-token', csrf);
    x.onloadend = () => {
      try { resolve(JSON.parse(x.responseText).status_code === 0); } catch (_) { resolve(false); }
    };
    x.send();
  });

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
    play: 'M7 4.2v15.6L20 12z',
    note: 'M9 18.5a2.5 2.5 0 1 1-2.5-2.5c.4 0 .7.1 1 .2V5.5L19 3.5v12a2.5 2.5 0 1 1-2.5-2.5c.4 0 .7.1 1 .2V7.6L9 9.2z',
    tick: 'M12 2.5l2.4 1.8 3-.1.9 2.9 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.9-3-.1L12 21.5l-2.4-1.8-3 .1-.9-2.9-2.4-1.8 1-2.8-1-2.8 2.4-1.8.9-2.9 3 .1zM10.6 15.2l5.6-5.6-1.3-1.3-4.3 4.3-2-2-1.3 1.3z',
  };
  /** TikTok marks its ads; so does the layer. */
  const SPONSORED = { en: 'Sponsored', tr: 'Sponsorlu', de: 'Gesponsert', fr: 'Sponsorisé', es: 'Patrocinado', it: 'Sponsorizzato',
    pt: 'Patrocinado', nl: 'Gesponsord', ru: 'Реклама', ar: 'مُموَّل' };
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
    .ad { display: inline-block; margin-bottom: 8px; padding: 3px 8px; border-radius: 4px; font-size: 11.5px; font-weight: 600;
      background: rgba(255, 255, 255, 0.2); color: rgba(255, 255, 255, 0.92); }
    .ad[hidden] { display: none; }

    .rail { right: 30px; bottom: 34px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
    .act { display: flex; flex-direction: column; align-items: center; gap: 5px; }
    .bubble { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center;
      background: rgba(255, 255, 255, 0.14); transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 160ms ease; }
    .bubble svg { width: 24px; height: 24px; fill: #fff; transition: fill 160ms ease; }
    .count { font-size: 12px; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5); }
    .like.liked svg { fill: #fe2c55; }
    .like.focused .bubble { transform: scale(1.12); box-shadow: 0 0 0 2.5px #fff, 0 0 18px rgba(255, 255, 255, 0.35); }
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
    .dots i { position: absolute; top: 3px; width: 14px; height: 14px; border-radius: 50%; }
    .dots i:first-child { background: #25f4ee; animation: orbit 900ms linear infinite; }
    .dots i:last-child { background: #fe2c55; animation: orbit 900ms linear infinite reverse; }
    @keyframes orbit { 0%, 100% { left: 4px; } 50% { left: 26px; } }
    .burst { position: absolute; z-index: 7; left: 50%; top: 50%; width: 120px; height: 120px; margin: -60px 0 0 -60px;
      fill: #fe2c55; opacity: 0; pointer-events: none; filter: drop-shadow(0 4px 18px rgba(254, 44, 85, 0.5)); }
    .burst.go { animation: burst 760ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    @keyframes burst { 0% { opacity: 0; transform: scale(0.4) rotate(-12deg); } 25% { opacity: 1; transform: scale(1.1) rotate(-4deg); }
      60% { opacity: 1; transform: scale(1) rotate(0); } 100% { opacity: 0; transform: scale(1.25) translateY(-30px); } }
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
          <div class="ad" hidden></div>
          <div class="desc"></div>
          <div class="music"></div>
        </div>
        <div class="chrome rail">
          <div class="act like"><div class="bubble">${svg(ICON.heart)}</div><div class="count"></div></div>
          <div class="act comments"><div class="bubble">${svg(ICON.comment)}</div><div class="count"></div></div>
          <div class="act saves"><div class="bubble">${svg(ICON.save)}</div><div class="count"></div></div>
        </div>
        <div class="progress"><div></div></div>
        <div class="center"><div class="paused">${svg(ICON.play)}</div></div>
        <div class="dots"><i></i><i></i></div>
        ${svg(ICON.heart, 'burst')}
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
      v.loop = true;
      v.muted = true;
      v.addEventListener('playing', () => { if (v === current) { failsInRow = 0; ready(); } });
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
    if (it.avatar) $('.avatar').src = it.avatar; else $('.avatar').removeAttribute('src');
    $('.name').innerHTML = '';
    $('.name').append(it.name || it.handle);
    if (it.verified) $('.name').insertAdjacentHTML('beforeend', svg(ICON.tick, 'tick'));
    $('.handle').textContent = it.handle && it.name !== it.handle ? `@${it.handle}` : '';
    $('.ad').hidden = !it.ad;
    $('.ad').textContent = SPONSORED[language().slice(0, 2)] || SPONSORED.en;
    $('.desc').textContent = it.desc.trim();
    $('.music').innerHTML = it.music ? svg(ICON.note) : '';
    if (it.music) $('.music').append(it.music);
    renderLike(it);
    $('.comments .count').textContent = count(it.comments);
    $('.saves .count').textContent = count(it.saves);
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
      if (!userPaused && !likeFocused) root.classList.remove('awake');
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
      watched++;
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
    if (items.length - i < 5) more();
    saveNext();
    return true;
  };

  let pendingStep = 0;
  const step = dir => {
    if (show(index + dir)) return;
    // At the end: as soon as more videos arrive.
    if (dir > 0) { pendingStep = 1; buffering(true); more(); }
  };

  const onItems = () => {
    if (pendingStep && items[index + 1]) { pendingStep = 0; show(index + 1); }
    else if (started && items[index + 1] && slotOf(index + 1).dataset.id !== items[index + 1].id) {
      load(index + 1);
      if (state === 'on') warm(slotOf(index + 1));
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

  const focusLike = on => {
    likeFocused = on;
    likeEl.classList.toggle('focused', on);
    wake();
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
      else if (current && !userPaused && !backgrounded) { current.play().catch(() => {}); untilMoving(current); warm(slotOf(index + 1)); }
      wake();
    } else {
      // The video plays on behind the menu; a pop-up, or another page, stops it.
      if (next !== 'menu') { slots.forEach(v => v.pause()); buffering(false); }
      root.classList.remove('awake');
      if (likeFocused) focusLike(false);
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
    if (onFeed() && !items.length && performance.now() - bornAt > GIVE_UP_MS) return giveUp();
    const tv = window.falconTv;
    setState(!onFeed() || !items.length ? 'off' : tv?.popup?.() ? 'under' : tv?.mode === 'menu' ? 'menu' : 'on');
    if (state === 'off') return;
    silenceTikTok();
    if (current?.duration) {
      bar.classList.add('run');
      bar.style.transform = `scaleX(${(current.currentTime / current.duration).toFixed(3)})`;
    }
  }
  setInterval(tick, 250);

  // ---- The remote ----------------------------------------------------------------------------------------

  let okDownAt = 0, okHeld = false, lastStep = 0;
  addEventListener('keydown', e => {
    if (state !== 'on') return;
    const key = e.key;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (key === 'Enter') {
      if (!e.repeat) { okDownAt = performance.now(); okHeld = false; }
      else if (!okHeld && performance.now() - okDownAt >= HOLD_MS) { okHeld = true; like(true); wake(); }
      return;
    }
    wake();
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      // Holding the button skims, but not faster than the videos can start.
      const now = performance.now();
      if (e.repeat && now - lastStep < 320) return;
      lastStep = now;
      keyAt = e.timeStamp;
      step(key === 'ArrowDown' ? 1 : -1);
    } else if (key === 'ArrowRight') {
      focusLike(true);
    } else if (likeFocused) {
      focusLike(false);
    } else {
      window.falconTv?.menu?.();
      tick();
    }
  }, true);
  addEventListener('keyup', e => {
    if (state !== 'on' || e.key !== 'Enter') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!okHeld) {
      if (likeFocused) like();
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
    /** Back: leaves the like button. False if there's nothing of ours to close. */
    back() {
      if (state === 'on' && likeFocused) { focusLike(false); return true; }
      return false;
    },
    /** The remote's play/pause key. False if our layer isn't up. */
    playPause() {
      if (state !== 'on') return false;
      setPaused(!userPaused);
      return true;
    },
    /** The app going to the background, and coming back. */
    pause() { backgrounded = true; slots.forEach(v => v.pause()); if (root) buffering(false); },
    resume() {
      backgrounded = false;
      if (state === 'on' && current && !userPaused) { current.play().catch(() => {}); untilMoving(current); }
      // In the background the next video's decoder may have gone: started again.
      const next = slotOf(index + 1);
      if (state === 'on' && next.dataset.id) { delete next.dataset.warm; warm(next); }
    },
    debug: () => ({ state, index, items: items.length, feedUrl: !!feedUrl, failed, watched, marks, switches,
      ui: root?.className, userPaused, likeFocused, liked: items[index]?.liked, likes: items[index]?.likes,
      ads: items.flatMap((it, i) => (it.ad ? [i] : [])), font: root?.classList.contains('tiktok-font'),
      now: items[index] && (({ name, handle, desc, music, likes }) => ({ name, handle, desc, music, likes }))(items[index]),
      slots: slots.map(v => ({ id: v.dataset.id?.slice(-4), now: v === current, rs: v.readyState, paused: v.paused, t: +v.currentTime.toFixed(2) })) }),
  };
})();
