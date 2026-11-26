package uz.davrabox.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the hosted web client whether the phone's battery saver is on, and when that changes. The liquid-glass style uses it
 * to switch from refracting glass to the cheaper CSS glass while the saver is on (apps/web/src/glass/runtime.ts). Only one
 * boolean leaves the app; nothing from the page is used.
 */
@CapacitorPlugin(name = "PowerSave")
public class PowerSavePlugin extends Plugin {
    private BroadcastReceiver receiver;

    private boolean isOn() {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isPowerSaveMode();
    }

    @PluginMethod
    public void isOn(final PluginCall call) {
        JSObject r = new JSObject();
        r.put("on", isOn());
        call.resolve(r);
    }

    @Override
    public void load() {
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                JSObject d = new JSObject();
                d.put("on", isOn());
                notifyListeners("change", d);
            }
        };
        getContext().registerReceiver(receiver, new IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED));
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            try {
                getContext().unregisterReceiver(receiver);
            } catch (IllegalArgumentException ignored) {
                // already unregistered
            }
            receiver = null;
        }
        super.handleOnDestroy();
    }
}
