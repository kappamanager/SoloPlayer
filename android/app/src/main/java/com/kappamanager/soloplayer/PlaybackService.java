package com.kappamanager.soloplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

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
    private MediaSession mediaSession;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SoloPlayer:Playback");
        wakeLock.setReferenceCounted(false);
        mediaSession = new MediaSession(this, "SoloPlayer");
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MainActivity.dispatchAction("play"); }
            @Override public void onPause() { MainActivity.dispatchAction("pause"); }
            @Override public void onSkipToNext() { MainActivity.dispatchAction("next"); }
            @Override public void onSkipToPrevious() { MainActivity.dispatchAction("prev"); }
        });
        mediaSession.setActive(true);
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

        updateMediaSession();
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
        if (mediaSession != null) mediaSession.setActive(false);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void updateMediaSession() {
        if (mediaSession == null) return;
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        mediaSession.setPlaybackState(new PlaybackState.Builder()
            .setActions(actions)
            .setState(isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                PlaybackState.PLAYBACK_POSITION_UNKNOWN, isPlaying ? 1f : 0f)
            .build());
        mediaSession.setMetadata(new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .build());
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

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        b.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title != null && title.length() > 0 ? title : "SoloPlayer")
            .setContentText(artist != null ? artist : "")
            .setContentIntent(contentPi)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setPriority(Notification.PRIORITY_LOW);

        b.addAction(new Notification.Action.Builder(
            android.R.drawable.ic_media_previous, "Prev", servicePi(ACTION_PREV, 1)).build());
        b.addAction(new Notification.Action.Builder(
            isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
            isPlaying ? "Pause" : "Play", servicePi(ACTION_PLAYPAUSE, 2)).build());
        b.addAction(new Notification.Action.Builder(
            android.R.drawable.ic_media_next, "Next", servicePi(ACTION_NEXT, 3)).build());

        // Associate the existing notification with the session so Android's media
        // controls and headset transport buttons target this player.
        b.setStyle(new Notification.MediaStyle()
            .setMediaSession(mediaSession.getSessionToken())
            .setShowActionsInCompactView(0, 1, 2));

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
        if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
