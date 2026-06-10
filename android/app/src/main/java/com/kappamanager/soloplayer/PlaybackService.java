package com.kappamanager.soloplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Foreground service that keeps the app process alive (and the CPU awake) while
 * music is playing in the WebView. Without this, Android treats the Capacitor
 * WebView app as a plain background app and stops playback far more eagerly than
 * dedicated music apps. The actual audio still plays via the WebView's
 * HTML5 <audio> element; this service only owns the ongoing notification,
 * a partial wake lock, and the media-control buttons that call back into JS.
 */
public class PlaybackService extends Service {

    public static final String CHANNEL_ID = "soloplayer_playback";
    public static final int NOTIF_ID = 1001;

    public static final String ACTION_START = "com.kappamanager.soloplayer.action.START";
    public static final String ACTION_UPDATE = "com.kappamanager.soloplayer.action.UPDATE";
    public static final String ACTION_STOP = "com.kappamanager.soloplayer.action.STOP";
    public static final String ACTION_PREV = "com.kappamanager.soloplayer.action.PREV";
    public static final String ACTION_PLAYPAUSE = "com.kappamanager.soloplayer.action.PLAYPAUSE";
    public static final String ACTION_NEXT = "com.kappamanager.soloplayer.action.NEXT";

    private PowerManager.WakeLock wakeLock;
    private String title = "SoloPlayer";
    private String artist = "";
    private boolean isPlaying = true;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SoloPlayer:Playback");
        wakeLock.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = (intent != null && intent.getAction() != null) ? intent.getAction() : ACTION_START;

        switch (action) {
            case ACTION_STOP:
                stopPlayback();
                return START_NOT_STICKY;
            case ACTION_PREV:
                MainActivity.dispatchAction("prev");
                break;
            case ACTION_PLAYPAUSE:
                MainActivity.dispatchAction("playpause");
                break;
            case ACTION_NEXT:
                MainActivity.dispatchAction("next");
                break;
            default: // START or UPDATE
                if (intent != null) {
                    if (intent.hasExtra("title")) title = intent.getStringExtra("title");
                    if (intent.hasExtra("artist")) artist = intent.getStringExtra("artist");
                    if (intent.hasExtra("isPlaying")) isPlaying = intent.getBooleanExtra("isPlaying", true);
                }
                break;
        }

        startForegroundWithNotification();

        if (isPlaying) {
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
        } else {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        }
        return START_STICKY;
    }

    private void stopPlayback() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void startForegroundWithNotification() {
        Notification notif = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this, NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIF_ID, notif);
        }
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentPi = PendingIntent.getActivity(this, 0, openIntent, piFlags());

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title != null && title.length() > 0 ? title : "SoloPlayer")
            .setContentText(artist != null ? artist : "")
            .setContentIntent(contentPi)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW);

        b.addAction(android.R.drawable.ic_media_previous, "Prev", servicePi(ACTION_PREV, 1));
        b.addAction(
            isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
            isPlaying ? "Pause" : "Play",
            servicePi(ACTION_PLAYPAUSE, 2));
        b.addAction(android.R.drawable.ic_media_next, "Next", servicePi(ACTION_NEXT, 3));

        return b.build();
    }

    private PendingIntent servicePi(String action, int requestCode) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, i, piFlags());
    }

    private int piFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return flags;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            ch.enableVibration(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
