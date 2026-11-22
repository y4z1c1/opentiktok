# OpenTikTok: a TikTok TV app for Android TV and Google TV

**Watch TikTok on your TV with the remote.** An open-source TikTok app for Android TV, Google TV and other
smart TVs that run Android: ▲▼ for the next video, OK to pause, hold OK to like. Sign in with your phone by
scanning a QR code. Free, no ads of its own, under 400 KB.

**[⬇ Download the APK](../../releases/latest)**

> Unofficial. Not affiliated with, endorsed by, or connected to TikTok or ByteDance. "TikTok" is their trademark.

## Looking for the TikTok TV app?

TikTok shut its own TV app (TikTok TV) down on June 15, 2025, and took it off Google TV, Android TV and Fire TV
app stores. TikTok's website still plays the feed, but a TV can't use it well: it expects a mouse, and on a TV
chip each move to the next video freezes the picture for a second or more.

OpenTikTok opens TikTok's website full screen and turns it into a TV app: a player of its own for the For You
feed, and a focus ring for everything else. You sign in to your own TikTok account, and your For You page,
likes and Following are the same as on your phone.

## What it does

- **A player built for the TV.** On the For You feed, the videos play in OpenTikTok's own lightweight player,
  over TikTok's page, which stays loaded behind it to keep your session. The next video is already loaded and
  paused on its first frame, so ▲▼ switches in about 0.2 s (after the first ~15 s, while TikTok's page loads).
- **Starts fast.** The next few videos you haven't seen are saved for the next launch, so the first one plays
  in a few seconds instead of waiting for TikTok's page.
- **Comments.** Open them from the button beside the video: they come up beside it while it plays on, with
  each comment's replies a press away.
- **Creators' pages.** Their face beside the video opens who they are and their videos in a grid. Play one and
  ▲▼ go through theirs; Back takes you to their page, then to your feed where you were.
- **Send a video to friends.** The share button beside the video opens TikTok's own share panel, on "Send to
  friends", and you pick who gets it with the remote. When the panel closes, you're back in your feed.
- **No ads.** Ads in the feed are left out as they arrive, so they never play.
- **hatun modu: a second feed of your own picking.** Hold OK on its button beside a video to add that video's
  creator. Pressing the button switches between For You and a feed of the creators you added, plus the accounts
  TikTok suggests as similar to them (those suggested for several of yours come first). A like there adds that
  creator too. What you add stays on your TV. Videos whose caption or creator's bio suggests someone under 18 are
  left out.
- **Plays on by itself.** When a video ends, the next one starts, so the feed runs hands-free. The last button
  beside the video turns that off (the video then starts over, as on TikTok), and the app remembers the choice.
- **The rest of TikTok works with the remote.** ◀ opens TikTok's menu (Following, Explore, LIVE, your profile…).
  A focus ring moves over its buttons and pop-ups, the way a TV app works.
- **TikTok's checks, with the remote.** When TikTok asks you to drag a slider or tap a picture to show you're a
  person, the arrows move a pointer over it and OK taps, or takes hold of the slider until the next OK.
- **Your own account.** Press the remote's Menu key to sign in: TikTok's QR page opens, and you scan it with
  the TikTok app on your phone. Your session stays in the app on your TV, like a browser. Nothing is sent
  anywhere but TikTok.

## Remote

| Key | On the feed | Comments | A creator's page | Elsewhere |
| --- | --- | --- | --- | --- |
| ▲ ▼ | previous / next video (on the buttons: move between them) | move through them | move in the grid | move the focus ring |
| OK | pause / play (on a button: press it) | show or hide the replies | play the video | press what the ring is on |
| Hold OK | like (on hatun modu's button: add the creator to it) | | | |
| ◀ | TikTok's menu (on the buttons: back to the video) | close | move in the grid | move the focus ring |
| ▶ | the buttons beside the video: creator, like, comments, share, hatun modu, auto next | | move in the grid | move the focus ring |
| Back | leave the buttons, or exit | close | back to the feed | close the pop-up, menu or page |
| Menu | sign in (QR code) | | | sign in (QR code) |
| ⏯ ⏭ ⏮ | pause, next, previous | | | |

On one of TikTok's checks, the arrows move a pointer (faster while held), OK taps, OK on the slider holds it
until the next OK, and Back closes the check.

## Install

Get `OpenTikTok-<version>.apk` from [Releases](../../releases) and sideload it. Any of these works:

- **adb:** turn on *Developer options › USB debugging* (or *Wireless debugging*) on the TV, then
  `adb connect <tv-ip>` and `adb install OpenTikTok-<version>.apk`.
- **Downloader** (by AFTVnews) on the TV: type in the APK's link.
- **Send Files to TV** on your phone and on the TV, then open the APK with a file manager.

It needs Android 11 (API 30) or newer and an up-to-date Android System WebView.

### Devices

Tested on a TCL / iFFALCON 55U95A (Google TV, Android 14). It should work on any Android TV or Google TV
device with Android 11 or newer: Chromecast with Google TV, Google TV Streamer, Nvidia Shield, Xiaomi Mi Box
and TV Stick, and TVs from Sony, TCL, Philips, Hisense, Xiaomi and others. Amazon Fire TV is untested. If you
try it on another device, please open an issue and say how it went.

## FAQ

**Is there still an official TikTok app for TV?** No. TikTok TV was discontinued on June 15, 2025, on every
platform, including copies that were sideloaded.

**Do I need to root my TV?** No. It installs like any other APK.

**Do I need a TikTok account?** No, the feed plays without one, though TikTok asks you to sign in now and then
(Back closes it). Sign in (Menu key, then scan the QR code with your phone) to get your own For You page and to
like videos.

**Can I cast TikTok from my phone instead?** You can mirror your phone's screen, but then the TV shows your
whole phone screen, in portrait, and your phone is tied up. OpenTikTok plays on the TV itself.

## How it works

TikTok's web requests and video links only work from inside a real browser page: its own scripts sign every
request, and its video servers turn other clients away. So OpenTikTok doesn't talk to TikTok on its own. It's
a WebView that presents itself as desktop Chrome, with two scripts injected at the start of each tiktok.com page:

- [`lean.js`](app/src/main/assets/lean.js): the player. It reads the videos from what TikTok's page already
  loads (the page's own data, then TikTok's own feed requests, which TikTok's scripts sign) and plays them in
  three `<video>` elements of its own, in a shadow root over the page. A like is TikTok's own like request, and
  comments and creators' pages come from TikTok's own requests for them. Ads are dropped from the list. Anywhere
  other than the feed, and for sign-in, pop-ups and checks, it steps aside for TikTok's page.
- [`tv.js`](app/src/main/assets/tv.js): makes TikTok's page usable with a remote. It hides the header and mouse
  controls, moves a focus ring over buttons, menus and pop-ups, moves a pointer over TikTok's checks, and works
  around H.265 videos that stall on some TV chips.

The app itself ([`TikTokActivity.kt`](app/src/main/java/dev/yusuf/opentiktok/TikTokActivity.kt)) is the WebView,
the remote's keys, a loading screen and a first-run tip. It also turns the taps and drags tv.js sends on a check
into touches on the page, as a finger would make them.

## Known limits

- The first ~15 s after launch, switching takes 2-4 s: TikTok's page is still loading and keeps the TV's
  processor busy.
- The feed player has no follow or save buttons yet, and comments can be read but not written.
- Following, Explore and LIVE use TikTok's own player, which is slower on a TV.
- TikTok sometimes won't hand a creator's videos to the app. The creator's page then says so, and OK opens
  TikTok's own profile page instead (where TikTok may ask for a check first).
- TikTok can change its website at any time and break things. Issues and pull requests are welcome.

Tested on a TCL / iFFALCON 55U95A (Google TV, Android 14).

## Building

Android Studio, or JDK 17 and the Android SDK:

```bash
./gradlew assembleRelease
```

The APK is at `app/build/outputs/apk/release/`. It's signed with your debug key unless there's a
`keystore.properties` at the root:

```properties
storeFile=/path/to/release.jks
storePassword=…
keyAlias=…
keyPassword=…
```

To start hatun modu with creators already in it, put a `hatun-seed.json` in `app/src/main/assets/`:
`{"version": "…", "creators": [{"handle": "…", "secUid": "…"}], "blocked": ["<secUid>", …]}`. It's ignored by
git, and the app adds what's in it once for each new `version`.

Debug builds (`./gradlew installDebug`) can be inspected from desktop Chrome at `chrome://inspect`, and
`falconLean.debug()` in the console shows the player's state.

## License

[MIT](LICENSE)
