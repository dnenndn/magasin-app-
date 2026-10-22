package com.gmao.stockapp;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before super.onCreate builds the bridge.
        registerPlugin(NfcUidPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
