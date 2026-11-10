package dev.yusuf.opentiktok

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** Two dots circling each other, the one in front a little larger: the logo's cyan and pink. */
class LoadingDots(context: Context) : View(context) {
    private val front = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF25F4EE.toInt() }
    private val back = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFE2C55.toInt() }
    private var phase = 0f
    private val spin = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 900
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener { phase = it.animatedValue as Float; invalidate() }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        spin.start()
    }

    override fun onDetachedFromWindow() {
        spin.cancel()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val a = phase * 2 * PI
        val r = height / 3.2f
        val reach = width / 2f - r * 1.2f
        val cx = width / 2f
        val cy = height / 2f
        // Depth: sin > 0 means the cyan dot is in front.
        val depth = sin(a).toFloat()
        val frontX = cx - reach * cos(a).toFloat()
        val backX = cx + reach * cos(a).toFloat()
        val frontR = r * (1 + 0.18f * depth)
        val backR = r * (1 - 0.18f * depth)
        if (depth > 0) {
            canvas.drawCircle(backX, cy, backR, back)
            canvas.drawCircle(frontX, cy, frontR, front)
        } else {
            canvas.drawCircle(frontX, cy, frontR, front)
            canvas.drawCircle(backX, cy, backR, back)
        }
    }
}
