package com.kappamanager.soloplayer;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.util.Log;
import android.webkit.JavascriptInterface;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import java.io.File;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    private static final int REQ_POST_NOTIFICATIONS = 2001;
    private static final int REQ_MUSIC_FOLDER = 2002;

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
        bridge.getWebView().addJavascriptInterface(new FolderBridge(), "AndroidFolders");
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

    private void sendToJs(String method, String jsonArgument) {
        runOnUiThread(() -> bridge.getWebView().evaluateJavascript(
            "window.SoloPlayerNative && window.SoloPlayerNative." + method + "(" + jsonArgument + ")", null));
    }

    @Override
    public void onBackPressed() {
        // Return to Android only when SoloPlayer has no in-app screen to dismiss.
        bridge.getWebView().evaluateJavascript(
            "!!(window.SoloPlayerNative && window.SoloPlayerNative.onBack())",
            handled -> {
                if (!"true".equals(handled)) MainActivity.super.onBackPressed();
            });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_MUSIC_FOLDER) return;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            sendToJs("onFolderSelected", "null");
            return;
        }
        Uri tree = data.getData();
        try {
            int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContentResolver().takePersistableUriPermission(tree, flags & Intent.FLAG_GRANT_READ_URI_PERMISSION);
            sendToJs("onFolderSelected", JSONObject.quote(tree.toString()));
        } catch (Exception e) {
            Log.e("SoloPlayerFolders", "Cannot retain selected folder permission", e);
            sendToJs("onFolderSelected", "null");
        }
    }

    public class FolderBridge {
        @JavascriptInterface
        public void chooseFolder(String previousTreeUri) {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    // This is a hint only; the provider decides the actual initial screen.
                    Uri initial = previousTreeUri != null && !previousTreeUri.isEmpty()
                        ? Uri.parse(previousTreeUri)
                        : Uri.parse("content://com.android.externalstorage.documents/document/primary%3AMusic");
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, initial);
                    }
                    startActivityForResult(intent, REQ_MUSIC_FOLDER);
                } catch (Exception e) {
                    Log.e("SoloPlayerFolders", "Folder picker unavailable", e);
                    sendToJs("onFolderSelected", "null");
                }
            });
        }

        @JavascriptInterface
        public void listDocuments(String treeUriString, String parentId, int requestId) {
            new Thread(() -> {
                JSONObject result = new JSONObject();
                JSONArray entries = new JSONArray();
                try {
                    Uri tree = Uri.parse(treeUriString);
                    String id = parentId.isEmpty() ? DocumentsContract.getTreeDocumentId(tree) : parentId;
                    Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id);
                    String[] columns = {
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE,
                        DocumentsContract.Document.COLUMN_FLAGS
                    };
                    try (Cursor cursor = getContentResolver().query(children, columns, null, null, null)) {
                        if (cursor == null) throw new IllegalStateException("Provider returned no directory cursor");
                        while (cursor.moveToNext()) {
                            String documentId = cursor.getString(0);
                            String name = cursor.getString(1);
                            String mime = cursor.getString(2);
                            Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId);
                            JSONObject entry = new JSONObject();
                            entry.put("id", documentId);
                            entry.put("name", name);
                            entry.put("mime", mime);
                            entry.put("flags", cursor.getInt(3));
                            entry.put("uri", uri.toString());
                            entry.put("directory", DocumentsContract.Document.MIME_TYPE_DIR.equals(mime));
                            entries.put(entry);
                            Log.d("SoloPlayerFolders", "document name=" + name + " id=" + documentId
                                + " mime=" + mime + " flags=" + cursor.getInt(3) + " uri=" + uri);
                        }
                    }
                    result.put("entries", entries);
                } catch (Exception e) {
                    Log.e("SoloPlayerFolders", "Document enumeration failed", e);
                    try { result.put("error", e.toString()); } catch (Exception ignored) {}
                }
                sendToJs("onFolderEntries", requestId + "," + JSONObject.quote(result.toString()));
            }, "SoloPlayerDocumentScan").start();
        }

        @JavascriptInterface
        public boolean isDirectory(String uriString) {
            try {
                Uri uri = Uri.parse(uriString);
                if ("content".equals(uri.getScheme())) {
                    return DocumentsContract.Document.MIME_TYPE_DIR.equals(getContentResolver().getType(uri));
                }
                return new File(uri.getPath() != null ? uri.getPath() : uriString).isDirectory();
            } catch (Exception e) {
                Log.d("SoloPlayerFolders", "Cannot classify " + uriString, e);
                return false;
            }
        }

        @JavascriptInterface
        public void releaseFolder(String uriString) {
            try {
                getContentResolver().releasePersistableUriPermission(Uri.parse(uriString),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception e) {
                Log.d("SoloPlayerFolders", "Previous folder permission was already released", e);
            }
        }
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
