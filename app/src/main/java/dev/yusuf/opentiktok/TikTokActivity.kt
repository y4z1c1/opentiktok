package dev.yusuf.opentiktok

import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * TikTok on the TV: the desktop website, full screen, driven by the remote.
 *
 * TikTok shut its own TV app down in 2025, but its desktop site already plays the feed in a landscape
 * layout and takes Up/Down for the next and previous video. So this is a WebView that passes as desktop
 * Chrome, and assets/tv.js makes the page work like a TV app: no header or mouse controls, and a focus
 * ring the remote moves over buttons, pop-ups and TikTok's menu. Signing in uses TikTok's QR page,
 * scanned with the phone.
 */
class TikTokActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var hint: TextView
    private lateinit var loading: View

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WebView.setWebContentsDebuggingEnabled(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)

        web = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            passAsDesktopChrome(settings)
            webViewClient = TikTokClient()
            webChromeClient = WebChromeClient()
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, true)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // lean.js first: on the feed it takes the remote before tv.js sees it.
            for (name in listOf("lean.js", "tv.js")) {
                val script = assets.open(name).bufferedReader().use { it.readText() }
                WebViewCompat.addDocumentStartJavaScript(web, script, setOf("https://*.tiktok.com"))
            }
        }
        // The scripts say when the feed is playing (or a page without videos has loaded). lean.js says
        // "starting" as it hands the first video to the player, with its first frame due a moment later.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "falconApp", setOf("https://*.tiktok.com")) { _, message, _, _, _ ->
                if (message.data == "starting") loading.postDelayed(::ready, FIRST_FRAME_MS) else ready()
            }
        }

        // A frosted pill at the top, like a TV app's first-run tip: the bottom has the video's caption.
        hint = TextView(this).apply {
            text = getString(R.string.hint)
            setTextColor(Color.WHITE)
            textSize = 14f
            letterSpacing = 0.02f
            background = GradientDrawable().apply {
                cornerRadius = 999f
                setColor(0xCC161616.toInt())
                setStroke(2, 0x33FFFFFF)
            }
            setPadding(44, 20, 44, 20)
            alpha = 0f
        }
        // Until the first video plays: the logo and two circling dots, instead of a blank page loading.
        loading = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            addView(ImageView(this@TikTokActivity).apply { setImageResource(R.drawable.logo) })
            addView(LoadingDots(this@TikTokActivity), LinearLayout.LayoutParams(dp(72), dp(28)).apply { topMargin = dp(36) })
        }
        setContentView(FrameLayout(this).apply {
            addView(web)
            addView(hint, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.CENTER_HORIZONTAL,
            ).apply { topMargin = 48 })
            addView(loading)
        })
        loading.postDelayed(::ready, LOADING_MAX_MS)

        web.requestFocus()
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(FEED_URL)
    }

    /** Lifts the loading screen (once), then shows the remote tips for a few seconds. */
    private fun ready() {
        if (loading.visibility != View.VISIBLE || loading.tag != null) return
        loading.tag = "leaving"
        loading.animate().alpha(0f).setDuration(220).withEndAction {
            loading.visibility = View.GONE
            (loading as LinearLayout).removeAllViews()
        }
        hint.animate().alpha(1f).setStartDelay(400)
        hint.postDelayed({ hint.animate().alpha(0f).withEndAction { hint.visibility = View.GONE } }, HINT_MS)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    /**
     * Desktop Chrome on Windows, at the WebView's own Chrome version, in the user agent and in its client
     * hints alike. As an Android WebView, TikTok serves the mobile site, which only pushes the app.
     */
    private fun passAsDesktopChrome(settings: WebSettings) {
        val full = CHROME_VERSION.find(settings.userAgentString)?.groupValues?.get(1) ?: "130.0.0.0"
        val major = full.substringBefore('.')
        settings.userAgentString = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36"
        if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
            fun brand(name: String, version: String) =
                UserAgentMetadata.BrandVersion.Builder().setBrand(name).setMajorVersion(version.substringBefore('.'))
                    .setFullVersion(version).build()
            WebSettingsCompat.setUserAgentMetadata(settings, UserAgentMetadata.Builder()
                .setBrandVersionList(listOf(brand("Chromium", full), brand("Google Chrome", full), brand("Not.A/Brand", "99.0.0.0")))
                .setFullVersion(full)
                .setPlatform("Windows")
                .setPlatformVersion("15.0.0")
                .setArchitecture("x86")
                .setBitness(64)
                .setModel("")
                .setMobile(false)
                .setWow64(false)
                .build())
        }
    }

    /** The arrows and OK go to the page as they are; assets/tv.js decides what they do. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        when (event.keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                if (event.action == KeyEvent.ACTION_UP) web.evaluateJavascript("window.falconTv?.playPause()", null)
                return true
            }
            KeyEvent.KEYCODE_MEDIA_NEXT -> return web.dispatchKeyEvent(remap(event, KeyEvent.KEYCODE_DPAD_DOWN))
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> return web.dispatchKeyEvent(remap(event, KeyEvent.KEYCODE_DPAD_UP))
            KeyEvent.KEYCODE_MENU -> {
                if (event.action == KeyEvent.ACTION_UP) web.loadUrl(LOGIN_URL)
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                if (event.action == KeyEvent.ACTION_UP) back()
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /**
     * Back closes the page's pop-up or menu first (assets/tv.js), then leaves the sign-in page or anything
     * opened from the feed, then the app.
     */
    private fun back() {
        web.evaluateJavascript("window.falconTv ? falconTv.back() : false") { handled ->
            if (handled != "true") leave()
        }
    }

    private fun leave() {
        when {
            isLoginPage() -> web.loadUrl(FEED_URL)
            web.canGoBack() && !isFeed() -> web.goBack()
            else -> finish()
        }
    }

    private fun path(): String = web.url?.let { Uri.parse(it).path }.orEmpty()
    private fun isLoginPage() = path().startsWith("/login")
    private fun isFeed() = path().let { it.isEmpty() || it == "/" || it.startsWith("/foryou") }

    private fun remap(event: KeyEvent, keyCode: Int) =
        KeyEvent(event.downTime, event.eventTime, event.action, keyCode, event.repeatCount, event.metaState)

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        web.evaluateJavascript("window.falconLean?.resume()", null)
    }

    /**
     * Leaving the app stops the sound; WebView alone keeps the video playing in the background. lean.js's
     * videos are out of the page's reach, so it pauses them itself.
     */
    override fun onPause() {
        web.evaluateJavascript("window.falconLean?.pause(); document.querySelectorAll('video').forEach(v => v.pause())", null)
        web.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** Keeps TikTok inside the app. Anything else (other sites, "open in app" links) is ignored. */
    private class TikTokClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val host = request.url.host.orEmpty()
            val tiktok = request.url.scheme == "https" && (host == "tiktok.com" || host.endsWith(".tiktok.com"))
            return !tiktok
        }
    }

    companion object {
        private const val FEED_URL = "https://www.tiktok.com/foryou"
        private const val LOGIN_URL = "https://www.tiktok.com/login/qrcode"
        private const val HINT_MS = 6_000L
        private const val LOADING_MAX_MS = 15_000L
        private const val FIRST_FRAME_MS = 900L
        private val CHROME_VERSION = Regex("Chrome/([0-9.]+)")
    }
}
