// Runs at the start of every tiktok.com page: turns the desktop site into a TV app.
//
// The remote arrives as arrow keys and Enter. While watching, Up/Down go to TikTok itself (next and
// previous video) and OK pauses. Everything else is moved with a focus ring, the way TV apps work: Right
// steps into the buttons beside the video (Down past the last one reaches the bar under it: auto-scroll,
// speed, captions…), Left opens TikTok's menu, and any pop-up (cookies, sign-in,
// interests, comments) takes the ring until it closes. OK presses what the ring is on.
//
// On the For You feed, lean.js plays the videos in a layer of its own and takes the remote while it's up.
// This script then only runs TikTok's menu and pop-ups, which the layer steps aside for.
(() => {
  if (window.falconTv) return;

  // TikTok's player tests H.265 (HEVC) once, passes on this TV, and saves "HEVC works" for a week; real H.265
  // videos then stall after a few frames ("having trouble playing this video"). Saying the codec is missing
  // makes it stream H.264, which plays fine. This runs before TikTok's own scripts.
  // The saved test result goes too. Answering the test in advance (either way) was tried: the first video
  // then took about 10 s to start instead of 4.5, so the player keeps running its test.
  const HEVC = /hvc1|hev1|hevc|h\.?265/i;
  try {
    localStorage.removeItem('hevc_support_key_temporary');
    localStorage.removeItem('ttplayer_hevc_result');
  } catch (_) {}
  const isTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
  MediaSource.isTypeSupported = type => !HEVC.test(type) && isTypeSupported(type);
  const canPlayType = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) { return HEVC.test(type) ? '' : canPlayType.call(this, type); };
  const decodingInfo = navigator.mediaCapabilities?.decodingInfo?.bind(navigator.mediaCapabilities);
  if (decodingInfo) {
    navigator.mediaCapabilities.decodingInfo = config => HEVC.test(config?.video?.contentType || '')
      ? Promise.resolve({ supported: false, smooth: false, powerEfficient: false })
      : decodingInfo(config);
  }

  const css = `
    /* No header, no side menu, no mouse arrows: the video column takes the whole width. */
    #app-header, #fixed-top-container, [data-e2e^="feed-navigation"], [data-e2e="anchoring-scroll-controls"],
    [class*="DivFeedNavigationContainer"] { display: none !important; }
    /* The page itself is main#main-content-… on the feed, a div#main-content-… elsewhere (Explore). */
    [class*="BaseBodyContainer"] > :not(main):not([id^="main-content"]) { display: none !important; }
    [id^="main-content"] { flex: 1 1 auto !important; max-width: none !important; }
    ::-webkit-scrollbar { display: none; }

    /* Light enough for a TV. The glow behind the video repaints the whole background as the colors shift,
       and the bar under the video animates its progress every frame: together most of the page's CPU.
       The bar shows when the remote moves to the controls; while watching, a thin line stands in for it. */
    [data-e2e="anchoring-ambient"] { display: none !important; }
    html:not(.falcon-controls) [data-e2e="anchoring-playback-chrome"] { display: none !important; }
    html.falcon-controls [data-e2e="anchoring-playback-chrome"] { animation: falcon-fade 160ms ease-out; }
    @keyframes falcon-fade { from { opacity: 0; } }
    #falcon-progress {
      position: fixed; z-index: 2147483000; left: 24px; right: 24px; bottom: 14px; height: 3px; border-radius: 2px;
      background: rgba(255, 255, 255, 0.22); pointer-events: none; overflow: hidden; display: none;
    }
    #falcon-progress > div { height: 100%; background: #fff; transform-origin: 0 0; transform: scaleX(0); }
    html.falcon-watching:not(.falcon-controls) #falcon-progress { display: block; }

    /* Left opens TikTok's own menu over the video. */
    html.falcon-menu [class*="BaseBodyContainer"] > [class*="SideNavPlaceholder"] {
      display: block !important; position: fixed !important; inset: 0 auto 0 0 !important; z-index: 2147483000 !important;
      background: rgba(18, 18, 18, 0.96) !important; box-shadow: 32px 0 80px rgba(0, 0, 0, 0.7) !important;
      animation: falcon-slide 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @keyframes falcon-slide { from { transform: translateX(-24px); opacity: 0; } }

    /* The focus ring: a white outline that hugs the control's shape, gliding from one control to the next. */
    #falcon-ring {
      position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box;
      border: 2.5px solid #fff; opacity: 0;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.18), 0 0 18px rgba(255, 255, 255, 0.28);
      transition: left 160ms cubic-bezier(0.2, 0.8, 0.2, 1), top 160ms cubic-bezier(0.2, 0.8, 0.2, 1),
        width 160ms cubic-bezier(0.2, 0.8, 0.2, 1), height 160ms cubic-bezier(0.2, 0.8, 0.2, 1),
        border-radius 160ms ease-out, opacity 120ms ease-out;
    }
    #falcon-ring.on { opacity: 1; }
  `;

  /** Things a mouse could click: real controls, plus whatever TikTok gives a pointer cursor. */
  const CONTROLS = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="option"], ' +
    '[role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"]';
  /** The buttons beside the video, in the order Up/Down walks them: who posted it, then the actions. */
  const SIDE = ['video-author-avatar', 'cinema-video-info-follow', 'feed-follow',
    'like-icon', 'comment-icon', 'favorite-icon', 'share-icon'];
  /** The controls under the video, left to right. */
  const BAR = ['anchoring-playback-control-play', 'cinema-playback-control-autoscroll', 'cinema-playback-control-speed',
    'cinema-playback-control-captions', 'cinema-playback-control-volume', 'more-menu-icon'];
  const POPUPS = '[class*="DivModalContainer"], [class*="tux-modal__container--open"], [role="dialog"], ' +
    '[aria-modal="true"], [class*="DivCommentSidebarTransitionWrapper"]';
  const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok' };
  /** Ring gap around a control, in CSS pixels. */
  const GAP = 5;

  /** 'video' (watching), 'side' (the buttons beside it), 'bar' (the controls under it) or 'menu' (TikTok's side menu). */
  let mode = 'video';
  let focused = null;
  let ring = null;

  /** The feed, or a single video's page (where comments open): both are watched the same way. */
  const isWatching = () => /^\/(foryou|following)?\/?$/.test(location.pathname) || /\/(video|photo)\//.test(location.pathname);

  /** Drawn at all: has a size and isn't hidden. Lists can scroll it into view. */
  const rendered = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.opacity !== '0';
  };
  /** Drawn and on screen. */
  const visible = el => {
    const r = el.getBoundingClientRect();
    return rendered(el) && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };

  /** Clickable things inside [root], outermost only (a button's icon isn't a stop of its own). */
  const clickables = (root, onScreen = false) => {
    const all = [...root.querySelectorAll('*')].filter(el =>
      el.matches(CONTROLS) || getComputedStyle(el).cursor === 'pointer');
    const set = new Set(all);
    return all.filter(el => {
      for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (set.has(p)) return false;
      return (onScreen ? visible(el) : rendered(el)) && !el.matches('[disabled], [aria-disabled="true"]');
    });
  };

  /** The pop-up on top, if any: the cookie banner first, then the last one open. */
  const popup = () => {
    // The banner element itself has no size; its buttons do.
    const banner = document.querySelector('tiktok-cookie-banner')?.shadowRoot;
    if (banner && [...banner.querySelectorAll('button')].some(visible)) return banner;
    // One on its way out (TikTok's captions dialog opens and closes itself after a while) doesn't count.
    const open = [...document.querySelectorAll(POPUPS)].filter(el => visible(el) && !el.closest('[class*="--exiting"]'));
    return open[open.length - 1] || null;
  };

  /**
   * A panel the menu opened beside itself (search, notifications, messages, more): it sits just right of the
   * menu's icons.
   */
  const menuPanel = () => {
    const nav = mode === 'menu' && document.querySelector('[class*="SideNavPlaceholder"]');
    if (!nav) return null;
    return [...nav.querySelectorAll('div')].find(el => {
      const r = el.getBoundingClientRect();
      return r.left >= 60 && r.left < 120 && r.width >= 240 && r.height >= 200 && visible(el);
    }) || null;
  };
  /** The menu entry whose panel is open. */
  let panelOpener = null;

  const sideButtons = () => SIDE.map(e2e => [...document.querySelectorAll(`[data-e2e="${e2e}"]`)].find(visible))
    .filter(Boolean);

  const barButtons = () => {
    const bar = [...document.querySelectorAll('[data-e2e="anchoring-playback-chrome"]')].find(visible);
    return bar ? BAR.map(e2e => [...bar.querySelectorAll(`[data-e2e="${e2e}"]`)].find(visible)).filter(Boolean) : [];
  };

  const isClose = el => /close|kapat|schlie|fermer|cerrar/i.test(
    `${el.getAttribute('aria-label')} ${el.dataset?.e2e} ${el.className} ${el.parentElement?.className}`);

  /** Where the ring can go right now, and where it starts. */
  const stops = () => {
    const layer = popup();
    if (layer) {
      // A pop-up starts on its first real choice (a cookie button, the first comment), not its close button.
      const items = clickables(layer);
      const start = (layer instanceof ShadowRoot && items.find(el => el.matches('button'))) ||
        items.find(el => !isClose(el)) || items[0];
      return { layer, items, start };
    }
    if (!isWatching()) return { layer: document, items: clickables(document.body, true) };
    if (mode === 'menu') {
      const panel = menuPanel();
      if (panel) {
        const items = clickables(panel);
        return { items, start: items.find(el => !isClose(el)) || items[0] };
      }
      // The menu scrolls: entries below the screen's edge (More) count too. (It also slides in from a little
      // to the left, so an entry can start just off the screen.)
      const menu = document.querySelector('[class*="SideNavPlaceholder"]');
      const items = menu ? clickables(menu).filter(el => {
        const r = el.getBoundingClientRect();
        return r.right > 0 && r.left < innerWidth;
      }) : [];
      return { items, start: items.find(el => el.matches('[data-e2e="nav-foryou"]')) };
    }
    if (mode === 'side') {
      const items = sideButtons();
      return { items, ordered: true, start: items.find(el => el.matches('[data-e2e="like-icon"]')) };
    }
    if (mode === 'bar') {
      const items = barButtons();
      return { items, start: items.find(el => el.matches('[data-e2e="cinema-playback-control-autoscroll"]')) };
    }
    return null;
  };

  /**
   * What the ring outlines: the control, or for an icon with its count underneath (like, comment…) just
   * the round icon, so the ring is a circle rather than a tall box.
   */
  const shapeOf = el => {
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - r.height) > 4) {
      const icon = [...el.querySelectorAll('*')].find(c => {
        const b = c.getBoundingClientRect();
        return b.width >= 16 && Math.abs(b.width - b.height) <= 2 && b.top - r.top < 4;
      });
      if (icon) return { rect: icon.getBoundingClientRect(), round: true };
    }
    const radius = getComputedStyle(el).borderTopLeftRadius;
    const half = Math.min(r.width, r.height) / 2;
    const round = radius.endsWith('%') ? parseFloat(radius) >= 50 : parseFloat(radius) >= half - 1;
    return { rect: r, round, radius: parseFloat(radius) || 0 };
  };

  const showRing = () => {
    if (!ring) {
      ring = document.createElement('div');
      ring.id = 'falcon-ring';
      document.documentElement.appendChild(ring);
    }
    if (!focused || !focused.isConnected || !visible(focused)) {
      ring.classList.remove('on');
      return;
    }
    const { rect: r, round, radius } = shapeOf(focused);
    // Small controls get a little more room, so the ring never crowds them.
    const gap = Math.min(r.width, r.height) < 32 ? GAP + 3 : GAP;
    const w = r.width + gap * 2, h = r.height + gap * 2;
    const place = `${r.left - gap}|${r.top - gap}|${w}|${h}|${round}|${radius}`;
    // Restyling an unchanged ring several times a second would still cost a style pass each time.
    if (ring.dataset.place !== place) {
      ring.dataset.place = place;
      Object.assign(ring.style, {
        left: `${r.left - gap}px`, top: `${r.top - gap}px`, width: `${w}px`, height: `${h}px`,
        borderRadius: round ? `${Math.max(w, h)}px` : `${Math.max(radius, 6) + gap}px`,
      });
    }
    ring.classList.add('on');
  };

  const focus = el => {
    focused = el;
    if (el && popup()) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    // In the menu at once, so the ring lands where the entry ends up.
    else if (el && mode === 'menu') el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    showRing();
  };

  /** The nearest stop in a direction, preferring ones in line with the current one. */
  const next = (from, items, dir) => {
    const a = from.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === from) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      const vertical = dir === 'up' || dir === 'down';
      const ahead = { up: ay - by, down: by - ay, left: ax - bx, right: bx - ax }[dir];
      if (ahead < 2) continue;
      const gap = vertical
        ? Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right))
        : Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
      const score = ahead + gap * 3 + Math.abs(vertical ? bx - ax : by - ay) * 0.3;
      if (score < bestScore) { best = el; bestScore = score; }
    }
    return best;
  };

  const press = el => {
    if (el.matches('input, textarea')) el.focus();
    // The auto-scroll stop is the label and switch together; the switch is what toggles. A tile on Explore is
    // a wrapper with the link inside; the link is what opens the video.
    (el.matches(CONTROLS) ? el : el.querySelector('input, button, a[href]') || el).click();
    // Whatever opens or closes next, the ring follows.
    setTimeout(showRing, 250);
  };

  const setMode = m => {
    mode = m;
    document.documentElement.classList.toggle('falcon-menu', m === 'menu');
    document.documentElement.classList.toggle('falcon-controls', m === 'side' || m === 'bar');
    const s = stops();
    focus(s ? (s.start || s.items[0] || null) : null);
  };

  /** Covers the middle of the screen: the video being watched, not the edge of the one before or after it. */
  const centered = v => {
    const r = v.getBoundingClientRect();
    return r.width > 4 && r.top < innerHeight / 2 && r.bottom > innerHeight / 2;
  };
  const currentVideo = () => {
    const videos = [...document.querySelectorAll('video')];
    return videos.find(v => centered(v) && !v.paused) || videos.find(centered) ||
      videos.find(v => visible(v) && !v.paused) || videos.find(visible);
  };

  const playPause = () => {
    const v = currentVideo();
    if (!v) return;
    if (v.paused) v.play(); else v.pause();
  };

  // Moving to the next video (a key press or auto-scroll), TikTok smooth-scrolls the feed, but on this TV
  // its re-render of the new video lands mid-scroll and freezes the picture for most of a second, and it
  // only starts the video once the scroll has ended. A cut instead: the next video's first frame is there
  // at once and it starts sooner. The old video goes quiet straight away too, rather than playing on under
  // the new picture; TikTok sets the sound of each video itself when it starts it.
  // TikTok must not hear about that mute, or it takes it for the viewer's and mutes every video after it.
  const quiet = new WeakSet();
  addEventListener('volumechange', e => {
    if (quiet.delete(e.target)) e.stopImmediatePropagation();
  }, true);
  const scrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...args) {
    const top = typeof args[0] === 'object' ? args[0]?.top : args[1];
    if (typeof top === 'number' && Math.abs(top - this.scrollTop) > 50 && /DivColumnListContainer/.test(this.className)) {
      const now = currentVideo();
      if (now && !now.paused && !now.muted) {
        quiet.add(now);
        now.muted = true;
      }
      if (typeof args[0] === 'object') args[0] = { ...args[0], behavior: 'instant' };
    }
    return scrollTo.apply(this, args);
  };

  // TikTok redraws its progress bar and clock on every timeupdate (several a second), each time re-running
  // its translations. With the bar hidden that work shows nothing, so its listeners hear at most one a second
  // until the remote brings the controls up.
  const throttled = new WeakMap();
  const addListener = EventTarget.prototype.addEventListener;
  const removeListener = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'timeupdate' && this instanceof HTMLMediaElement && typeof listener === 'function') {
      let last = 0;
      const wrapped = throttled.get(listener) || function (e) {
        const now = performance.now();
        if (mode !== 'side' && mode !== 'bar' && now - last < 1000) return;
        last = now;
        return listener.call(this, e);
      };
      throttled.set(listener, wrapped);
      return addListener.call(this, type, wrapped, options);
    }
    return addListener.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    return removeListener.call(this, type, (type === 'timeupdate' && throttled.get(listener)) || listener, options);
  };

  addEventListener('keydown', e => {
    const key = KEYS[e.key];
    if (!key) return;
    // In a text field, Left/Right move the caret and OK submits; Up/Down leave it.
    if (e.target?.matches?.('input, textarea')) {
      if (key !== 'up' && key !== 'down') return;
      e.target.blur();
    }
    const s = stops();
    if (!s) {
      // Watching: Up/Down belong to TikTok; Left/Right/OK are ours.
      if (key === 'up' || key === 'down') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (key === 'ok') playPause();
      else setMode(key === 'left' ? 'menu' : 'side');
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!focused || !s.items.includes(focused)) return focus(s.start || s.items[0] || null);
    if (key === 'ok') return press(focused);
    if (s.ordered) {
      // The side buttons go in a fixed order, though the profile sits apart from the like button and co.
      const i = s.items.indexOf(focused);
      const to = s.items[i + (key === 'down' ? 1 : -1)];
      if (key === 'down' && !to) return setMode('bar');
      if (key === 'up' || key === 'down') return focus(to || focused);
      if (key === 'left') return setMode('video');
      return;
    }
    const to = next(focused, s.items, key);
    if (to) return focus(to);
    // Up from the bar goes back to the buttons beside the video, landing on the last one.
    if (!s.layer && mode === 'bar' && key === 'up') {
      setMode('side');
      return focus(stops().items.at(-1) || null);
    }
    // Off the right edge of the menu: back to the video.
    if (!s.layer && mode === 'menu' && key === 'right') setMode('video');
  }, true);

  /** Sound off by the viewer's choice: TikTok saves its volume button's state. */
  const mutedByViewer = () => {
    try { return JSON.parse(localStorage.getItem('webapp-video-mute') || '{}').muted === true; } catch (_) { return false; }
  };
  let mutedTicks = 0;

  // Pop-ups can appear on their own (sign-in nags, the cookie banner): put the ring on them. The ring also
  // follows its control while the page moves underneath.
  // The same timer moves the progress line.
  let progress = null;
  setInterval(() => {
    const s = stops();
    if (s?.layer && s.layer !== document && (!focused || !s.items.includes(focused))) focus(s.start || null);
    else if (!s && focused) focus(null);
    else if (focused) showRing();

    // Explore's tiles play a preview with sound (of the tile under the mouse, which here is the first one):
    // kept quiet, and TikTok doesn't take that for the viewer's mute.
    if (!isWatching()) {
      for (const v of document.querySelectorAll('video')) {
        if (!v.paused && !v.muted && v.getBoundingClientRect().width < innerWidth * 0.4) { quiet.add(v); v.muted = true; }
      }
    }

    // While lean.js's layer is up (or waiting behind the menu or a pop-up), its own player is what's watched.
    const lean = window.falconLean?.state;
    const watching = isWatching() && (!lean || lean === 'off');
    document.documentElement.classList.toggle('falcon-watching', watching);
    if (!watching) return;
    const v = currentVideo();
    // The video on screen playing without sound for over a second, though the viewer hasn't muted: a
    // switch's mute stuck to it, or TikTok lost track. Sound back on, quietly as above.
    if (v && !v.paused && v.muted && !mutedByViewer()) {
      if (++mutedTicks >= 5) {
        mutedTicks = 0;
        quiet.add(v);
        v.muted = false;
      }
    } else mutedTicks = 0;

    if (mode === 'side' || mode === 'bar') return;
    if (!progress) {
      progress = document.createElement('div');
      progress.id = 'falcon-progress';
      progress.appendChild(document.createElement('div'));
      document.documentElement.appendChild(progress);
    }
    const scale = v && v.duration ? (v.currentTime / v.duration).toFixed(3) : '0';
    if (progress.dataset.scale !== scale) {
      progress.dataset.scale = scale;
      progress.firstChild.style.transform = `scaleX(${scale})`;
    }
  }, 250);

  // The app shows a loading screen until the feed plays, or until a page without videos (sign-in, a
  // check) has loaded.
  const ready = () => { try { window.falconApp?.postMessage('ready'); } catch (_) {} };
  document.addEventListener('playing', ready, { capture: true, once: true });
  addEventListener('load', () => setTimeout(() => { if (!isWatching() || popup()) ready(); }, 1200));

  // Moving to another page from the menu goes back to watching. An entry that opens a panel instead (search,
  // notifications, messages, more) keeps the menu up, with the ring in the panel; when the panel closes
  // again, the ring is back on its entry. While TikTok's app is still loading, a panel can take a second.
  addEventListener('click', e => {
    if (mode !== 'menu') return;
    if (e.target.closest?.('a[href]')) {
      panelOpener = null;
      setTimeout(() => setMode('video'), 50);
      return;
    }
    const opener = e.target.closest?.('[data-e2e^="nav-"]');
    const closing = !!opener && opener === panelOpener;
    const from = location.href;
    let tries = 0;
    const check = () => {
      if (mode !== 'menu') return;
      const panel = menuPanel();
      if (location.href !== from) {
        panelOpener = null;
        setMode('video');
      } else if (panel && !closing) {
        if (opener) panelOpener = opener;
        const s = stops();
        if (!s.items.includes(focused)) focus(s.start || s.items[0] || null);
      } else if (!panel && closing) {
        panelOpener = null;
        const s = stops();
        focus(s.items.find(el => el === opener || el.contains(opener) || opener.contains(el)) || s.start || null);
      } else if (++tries < 10) {
        setTimeout(check, 150);
      } else if (!panel) {
        panelOpener = null;
        setMode('video');
      }
    };
    setTimeout(check, 150);
  }, true);

  window.falconTv = {
    /** Back: closes a pop-up or leaves the side buttons and menu. False if there's nothing to close. */
    back() {
      if (window.falconLean?.back()) return true;
      const layer = popup();
      if (layer && !(layer instanceof ShadowRoot)) {
        const close = [...layer.querySelectorAll('[aria-label], [data-e2e], [class*="Close"]')].find(el => isClose(el) && visible(el));
        // The handler can sit on a button inside the close wrapper (the comments panel's does).
        if (close) { (close.querySelector('button, [role="button"]') || close).click(); focus(null); return true; }
      }
      // A panel beside the menu closes back to the menu (its entry toggles it).
      if (mode === 'menu' && menuPanel()) {
        if (panelOpener?.isConnected) panelOpener.click(); else setMode('video');
        return true;
      }
      if (mode !== 'video' && isWatching()) { setMode('video'); return true; }
      return false;
    },
    playPause() {
      if (!window.falconLean?.playPause()) playPause();
    },
    /** The pop-up on top, if any: lean.js steps aside for it. */
    popup,
    /** Opens TikTok's menu (Left from lean.js's player). */
    menu() { setMode('menu'); },
    get mode() { return mode; },
  };

  const add = () => {
    const style = document.createElement('style');
    style.id = 'falcon-tv';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.documentElement) add();
  else document.addEventListener('DOMContentLoaded', add);
})();
