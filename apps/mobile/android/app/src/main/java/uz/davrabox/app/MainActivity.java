package uz.davrabox.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * The web client is loaded from server.url. An Android App Link (https://HOST/app?join=CODE#k=KEY) must land on that
 * exact page, so the activity forwards it to the WebView. Only the configured host and only paths under /app are
 * accepted; anything else is ignored (the WebView keeps its current page).
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        routeAppLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        routeAppLink(intent);
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
