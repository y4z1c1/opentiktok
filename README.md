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
- **The rest of TikTok works with the remote.** ◀ opens TikTok's menu (Following, Explore, LIVE, your profile…).
  A focus ring moves over its buttons and pop-ups, the way a TV app works.
- **Your own account.** Press the remote's Menu key to sign in: TikTok's QR page opens, and you scan it with
  the TikTok app on your phone. Your session stays in the app on your TV, like a browser. Nothing is sent
  anywhere but TikTok.
- Ads in the feed are TikTok's and are shown as they are, labeled "Sponsored". Nothing is blocked.

## Remote

| Key | On the feed | Elsewhere |
| --- | --- | --- |
| ▲ ▼ | previous / next video | move the focus ring |
| OK | pause / play | press what the ring is on |
| Hold OK | like | |
| ◀ | TikTok's menu | move the focus ring |
| ▶ | the like button | move the focus ring |
| Back | leave the like button, or exit | close the pop-up, menu or page |
| Menu | sign in (QR code) | sign in (QR code) |
| ⏯ ⏭ ⏮ | pause, next, previous | |

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
  three `<video>` elements of its own, in a shadow root over the page. A like is TikTok's own like request.
  Anywhere other than the feed, and for sign-in, pop-ups and checks, it steps aside for TikTok's page.
- [`tv.js`](app/src/main/assets/tv.js): makes TikTok's page usable with a remote. It hides the header and mouse
  controls, moves a focus ring over buttons, menus and pop-ups, and works around H.265 videos that stall on some
  TV chips.

The app itself ([`TikTokActivity.kt`](app/src/main/java/dev/yusuf/opentiktok/TikTokActivity.kt)) is the WebView,
the remote's keys, a loading screen and a first-run tip.

## Known limits

- The first ~15 s after launch, switching takes 2-4 s: TikTok's page is still loading and keeps the TV's
  processor busy.
- The feed player has no comments, follow, share or profile buttons yet. Use ◀ (TikTok's menu) for those.
- Following, Explore and LIVE use TikTok's own player, which is slower on a TV.
- If TikTok shows a "drag the slider" check, a remote can't drag it. Press Back to close it and try again
  later, or plug in a mouse.
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

Debug builds (`./gradlew installDebug`) can be inspected from desktop Chrome at `chrome://inspect`, and
`falconLean.debug()` in the console shows the player's state.

## License

[MIT](LICENSE)
