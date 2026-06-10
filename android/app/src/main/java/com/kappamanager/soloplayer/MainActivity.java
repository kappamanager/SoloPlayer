package com.kappamanager.soloplayer;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final int REQ_POST_NOTIFICATIONS = 2001;

    // Weak-ish static handle used by PlaybackService to forward notification
    // button taps back into the WebView. Cleared in onDestroy.
    private static MainActivity instance;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        // Expose small JS bridges for storage permission + background playback.
        bridge.getWebView().addJavascriptInterface(new StorageBridge(), "AndroidStorage");
        bridge.getWebView().addJavascriptInterface(new PlaybackBridge(), "AndroidPlayback");
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    /** Called from PlaybackService (any thread) to run a media action in JS. */
    public static void dispatchAction(final String action) {
        final MainActivity a = instance;
        if (a == null) return;
        a.runOnUiThread(() -> {
            try {
                a.bridge.getWebView().evaluateJavascript(
                    "window.SoloPlayerNative && window.SoloPlayerNative.onAction('" + action + "')",
                    null);
            } catch (Exception ignored) {}
        });
    }

    public class StorageBridge {
        @JavascriptInterface
        public boolean hasAllFilesAccess() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return Environment.isExternalStorageManager();
            }
            return true;
        }

        @JavascriptInterface
        public void openAllFilesAccessSettings() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    intent.setData(Uri.parse("package:" + getPackageName()));
                    intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                }
            } catch (Exception e) {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                    intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Exception ignored) {}
            }
        }
    }

    public class PlaybackBridge {
        @JavascriptInterface
        public void start(String title, String artist, boolean isPlaying) {
            sendToService(PlaybackService.ACTION_START, title, artist, isPlaying);
        }

        @JavascriptInterface
        public void update(String title, String artist, boolean isPlaying) {
            sendToService(PlaybackService.ACTION_UPDATE, title, artist, isPlaying);
        }

        @JavascriptInterface
        public void stop() {
            try {
                Intent i = new Intent(MainActivity.this, PlaybackService.class)
                    .setAction(PlaybackService.ACTION_STOP);
                startService(i);
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        REQ_POST_NOTIFICATIONS);
                }
            }
        }

        private void sendToService(String action, String title, String artist, boolean isPlaying) {
            try {
                Intent i = new Intent(MainActivity.this, PlaybackService.class)
                    .setAction(action)
                    .putExtra("title", title)
                    .putExtra("artist", artist)
                    .putExtra("isPlaying", isPlaying);
                ContextCompat.startForegroundService(MainActivity.this, i);
            } catch (Exception ignored) {
                // ForegroundServiceStartNotAllowedException can occur if called
                // from the background; safe to ignore (playback already stopping).
            }
        }
    }
}
