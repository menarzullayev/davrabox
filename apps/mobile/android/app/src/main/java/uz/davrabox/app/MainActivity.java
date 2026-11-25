package uz.davrabox.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * The web client is loaded from server.url. An Android App Link (https://HOST/app?join=CODE#k=KEY) must land on that
 * exact page, so the activity forwards it to the WebView. Only the configured host and only paths under /app are
 * accepted; anything else is ignored (the WebView keeps its current page).
 */
public class MainActivity extends BridgeActivity {

    /** The launch screen is released after at most this long even if the page never paints (offline, slow network). */
    private static final long SPLASH_MAX_MS = 8000;

    private volatile boolean pageVisible = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Keep the branded launch screen up until the hosted page paints its first frame, so there is no empty window in between.
        registerPlugin(ThemeBarsPlugin.class); // system bars follow the page theme
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        splash.setKeepOnScreenCondition(() -> !pageVisible);
        new Handler(Looper.getMainLooper()).postDelayed(() -> pageVisible = true, SPLASH_MAX_MS);
        super.onCreate(savedInstanceState);
        // The app starts dark: light status-bar icons from the first frame; the web client changes this with its theme (SystemBars plugin).
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(false);
        if (getBridge() != null) {
            getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    super.onPageCommitVisible(view, url);
                    pageVisible = true;
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    super.onPageFinished(view, url);
                    pageVisible = true;
                }
            });
        }
        // Back. This callback is added after the App plugin's, so it runs first. On the web client's own pages the press goes
        // on to the App plugin, whose listener in the page decides (close a menu or panel, ask before leaving a call, go back,
        // leave the app). Pages without that listener (the sign-in pages under /auth/) go back in the WebView history, and
        // the app closes when there is nothing left to go back to.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web != null && isWebClientPage(web.getUrl())) {
                    setEnabled(false);
                    try {
                        getOnBackPressedDispatcher().onBackPressed();
                    } finally {
                        setEnabled(true);
                    }
                } else if (web != null && web.canGoBack()) {
                    web.goBack();
                } else {
                    finish();
                }
            }
        });
        routeAppLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        routeAppLink(intent);
    }

    /** True for pages of the hosted web client, which handle Back themselves; false for the sign-in pages under /auth/. */
    static boolean isWebClientPage(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        String path = u.getPath();
        return "https".equals(u.getScheme()) && path != null && !path.startsWith("/auth/");
    }

    private void routeAppLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data == null || !"https".equals(data.getScheme())) return;
        String host = data.getHost();
        if (host == null || !host.equalsIgnoreCase(BuildConfig.APP_HOST)) return;
        String path = data.getPath();
        if (path == null || !(path.equals("/app") || path.startsWith("/app/"))) return;
        if (getBridge() == null) return;
        final WebView webView = getBridge().getWebView();
        final String target = data.toString();
        webView.post(() -> webView.loadUrl(target));
    }
}
