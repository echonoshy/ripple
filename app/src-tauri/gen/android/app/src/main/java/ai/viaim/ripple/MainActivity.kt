package ai.viaim.ripple

import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var rippleWebView: WebView? = null
  private var chatBackGestureEnabled = false
  private val chatBackGestureExclusionWidthPx: Int
    get() = (32 * resources.displayMetrics.density).toInt()
  private val chatBackGestureLayoutListener =
    View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
      updateChatBackGestureExclusion()
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    rippleWebView = webView
    webView.addJavascriptInterface(RippleAndroidGestureBridge(), "RippleAndroidGesture")
    webView.addOnLayoutChangeListener(chatBackGestureLayoutListener)
    updateChatBackGestureExclusion()
  }

  override fun onDestroy() {
    rippleWebView?.removeOnLayoutChangeListener(chatBackGestureLayoutListener)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      rippleWebView?.systemGestureExclusionRects = emptyList()
    }
    rippleWebView = null
    super.onDestroy()
  }

  private fun updateChatBackGestureExclusion() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val webView = rippleWebView ?: return

    if (!chatBackGestureEnabled || webView.width <= 0 || webView.height <= 0) {
      webView.systemGestureExclusionRects = emptyList()
      return
    }

    val width = minOf(chatBackGestureExclusionWidthPx, webView.width)
    webView.systemGestureExclusionRects = listOf(Rect(0, 0, width, webView.height))
  }

  private inner class RippleAndroidGestureBridge {
    @JavascriptInterface
    fun setChatBackGestureEnabled(enabled: Boolean) {
      runOnUiThread {
        chatBackGestureEnabled = enabled
        updateChatBackGestureExclusion()
      }
    }
  }
}
