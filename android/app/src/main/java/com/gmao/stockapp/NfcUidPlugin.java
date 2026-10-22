package com.gmao.stockapp;

import android.app.Activity;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.os.Bundle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Minimal NFC plugin: reports the UID of any tag held against the phone while
 * the app is in front. Nothing is read from or written to the tag itself.
 *
 *   status()  -> { status: "ENABLED" | "DISABLED" | "NOT_SUPPORTED" }
 *   start()   -> begins listening; each tag fires the "tag" event { uid: "04A1B2C3" }
 *   stop()    -> stops listening
 */
@CapacitorPlugin(name = "NfcUid")
public class NfcUidPlugin extends Plugin implements NfcAdapter.ReaderCallback {

    private boolean wanted = false;

    private NfcAdapter adapter() {
        Activity a = getActivity();
        return a == null ? null : NfcAdapter.getDefaultAdapter(a);
    }

    @PluginMethod
    public void status(PluginCall call) {
        NfcAdapter nfc = adapter();
        JSObject ret = new JSObject();
        ret.put("status", nfc == null ? "NOT_SUPPORTED" : (nfc.isEnabled() ? "ENABLED" : "DISABLED"));
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        NfcAdapter nfc = adapter();
        if (nfc == null) {
            call.reject("NOT_SUPPORTED");
            return;
        }
        if (!nfc.isEnabled()) {
            call.reject("DISABLED");
            return;
        }
        wanted = true;
        enable();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        wanted = false;
        disable();
        call.resolve();
    }

    // Reader mode must be (re)armed from the UI thread's activity; Android drops
    // it when the app goes to the background, so pause/resume re-apply it.
    private void enable() {
        final Activity activity = getActivity();
        final NfcAdapter nfc = adapter();
        if (activity == null || nfc == null) return;
        activity.runOnUiThread(() -> {
            try {
                int flags = NfcAdapter.FLAG_READER_NFC_A
                        | NfcAdapter.FLAG_READER_NFC_B
                        | NfcAdapter.FLAG_READER_NFC_F
                        | NfcAdapter.FLAG_READER_NFC_V
                        | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK;
                nfc.enableReaderMode(activity, this, flags, new Bundle());
            } catch (Exception ignored) {
                // Activity not ready / NFC just switched off: the next resume retries.
            }
        });
    }

    private void disable() {
        final Activity activity = getActivity();
        final NfcAdapter nfc = adapter();
        if (activity == null || nfc == null) return;
        activity.runOnUiThread(() -> {
            try {
                nfc.disableReaderMode(activity);
            } catch (Exception ignored) {
            }
        });
    }

    @Override
    public void onTagDiscovered(Tag tag) {
        byte[] id = tag.getId();
        if (id == null || id.length == 0) return;
        StringBuilder hex = new StringBuilder();
        for (byte b : id) hex.append(String.format("%02X", b));
        JSObject data = new JSObject();
        data.put("uid", hex.toString());
        notifyListeners("tag", data);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (wanted) disable();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (wanted) enable();
    }
}
