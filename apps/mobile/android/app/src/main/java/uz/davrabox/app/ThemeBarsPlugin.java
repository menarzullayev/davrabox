package uz.davrabox.app;

import android.content.res.Configuration;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Makes the system bars match the page theme. The hosted web client sits below the status bar and above the navigation bar,
 * so what shows around it is the window background: it must be the page colour, and the icons must contrast with it. The
 * built-in SystemBars plugin only knows one window colour (dark), so a light page got a dark band with dark icons.
 * Only the two theme names are accepted: nothing from the page is used as a colour.
 */
@CapacitorPlugin(name = "ThemeBars")
public class ThemeBarsPlugin extends Plugin {
    private static final int DARK_BG = 0xFF0A0D21; // same as THEME_COLOR.dark in the web client
    private static final int LIGHT_BG = 0xFFF4F5FB; // same as THEME_COLOR.light

    private boolean light = false;

    @PluginMethod
    public void setTheme(final PluginCall call) {
        final String theme = call.getString("theme", "dark");
        if (!"dark".equals(theme) && !"light".equals(theme)) {
            call.reject("theme must be 'dark' or 'light'");
            return;
        }
        light = "light".equals(theme);
        getBridge().executeOnMainThread(() -> {
            apply();
            call.resolve();
        });
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        // The SystemBars plugin re-applies its own colour on a configuration change; apply ours right after it.
        getBridge().getWebView().post(this::apply);
    }

    private void apply() {
        Window window = getActivity().getWindow();
        window.getDecorView().setBackgroundColor(light ? LIGHT_BG : DARK_BG);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(light);
        controller.setAppearanceLightNavigationBars(light);
    }
}
