package com.dhanda.ai;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.media.MediaMuxer;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.os.Build;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import io.flutter.embedding.android.FlutterActivity;
import io.flutter.embedding.engine.FlutterEngine;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;

public class MainActivity extends FlutterActivity {
    private static final String CHANNEL = "dhanda_ai/audio";
    private static final String PREFS = "dhanda_ai_recordings";
    private static final String LINKS_KEY = "recording_links";
    private static final String COMBINED_LINKS_KEY = "combined_links";
    private static final int RECORD_AUDIO_REQUEST = 1207;
    private static final int NOTIFICATION_REQUEST = 1208;
    private static final String UPLOAD_CHANNEL_ID = "dhanda_ai_uploads";
    private static final int UPLOAD_PROGRESS_ID = 2201;
    private static final int UPLOAD_DONE_ID = 2202;
    private static final int UPLOAD_FAILED_ID = 2203;

    private MediaRecorder recorder;
    private MediaPlayer player;
    private File currentFile;
    private String currentVideoId;

    @Override
    public void configureFlutterEngine(FlutterEngine flutterEngine) {
        super.configureFlutterEngine(flutterEngine);
        new MethodChannel(flutterEngine.getDartExecutor().getBinaryMessenger(), CHANNEL)
                .setMethodCallHandler(this::handleAudioCall);
        createUploadNotificationChannel();
    }

    @Override
    protected void onResume() {
        super.onResume();
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.cancel(UPLOAD_DONE_ID);
        manager.cancel(UPLOAD_FAILED_ID);
    }

    private void handleAudioCall(MethodCall call, MethodChannel.Result result) {
        try {
            switch (call.method) {
                case "startRecording":
                    startRecording(call.argument("videoId"), result);
                    break;
                case "pauseRecording":
                    pauseRecording(result);
                    break;
                case "resumeRecording":
                    resumeRecording(result);
                    break;
                case "recordingAmplitude":
                    recordingAmplitude(result);
                    break;
                case "stopRecording":
                    stopRecording(result);
                    break;
                case "deleteRecording":
                    deleteRecording(call.argument("path"), result);
                    break;
                case "listRecordings":
                    listRecordings(call.argument("videoId"), result);
                    break;
                case "mergeRecordings":
                    mergeRecordings(call.argument("videoId"), result);
                    break;
                case "playRecording":
                    playRecording(call.argument("path"), result);
                    break;
                case "saveCombinedLink":
                    saveCombinedLink(
                            call.argument("videoId"),
                            call.argument("url"),
                            result
                    );
                    break;
                case "getCombinedLink":
                    getCombinedLink(call.argument("videoId"), result);
                    break;
                case "shareText":
                    shareText(call.argument("text"), result);
                    break;
                case "showUploadStarted":
                    showUploadStarted(call.argument("title"), result);
                    break;
                case "showUploadProgress":
                    showUploadProgress(
                            call.argument("title"),
                            call.argument("progress"),
                            result
                    );
                    break;
                case "showUploadFinished":
                    showUploadFinished(
                            call.argument("title"),
                            call.argument("url"),
                            result
                    );
                    break;
                case "showUploadFailed":
                    showUploadFailed(
                            call.argument("title"),
                            call.argument("error"),
                            result
                    );
                    break;
                default:
                    result.notImplemented();
            }
        } catch (Exception error) {
            result.error("AUDIO_ERROR", error.getMessage(), null);
        }
    }

    private void startRecording(String videoId, MethodChannel.Result result) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, RECORD_AUDIO_REQUEST);
            result.error("PERMISSION_REQUIRED", "Microphone permission is required.", null);
            return;
        }
        if (recorder != null) {
            result.error("ALREADY_RECORDING", "A recording is already active.", null);
            return;
        }

        currentVideoId = sanitize(videoId);
        File folder = new File(getFilesDir(), "recordings/" + currentVideoId);
        if (!folder.exists() && !folder.mkdirs()) {
            result.error("STORAGE_ERROR", "Could not create recordings folder.", null);
            return;
        }
        currentFile = new File(folder, "dhanda_" + System.currentTimeMillis() + ".m4a");

        recorder = new MediaRecorder();
        recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
        recorder.setAudioEncodingBitRate(96000);
        recorder.setAudioSamplingRate(44100);
        recorder.setOutputFile(currentFile.getAbsolutePath());
        recorder.prepare();
        recorder.start();
        result.success(null);
    }

    private void pauseRecording(MethodChannel.Result result) {
        if (recorder == null) {
            result.error("NOT_RECORDING", "No recording is active.", null);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            recorder.pause();
        }
        result.success(null);
    }

    private void resumeRecording(MethodChannel.Result result) {
        if (recorder == null) {
            result.error("NOT_RECORDING", "No recording is active.", null);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            recorder.resume();
        }
        result.success(null);
    }

    private void recordingAmplitude(MethodChannel.Result result) {
        if (recorder == null) {
            result.success(0);
            return;
        }
        try {
            result.success(recorder.getMaxAmplitude());
        } catch (RuntimeException error) {
            result.success(0);
        }
    }

    private void stopRecording(MethodChannel.Result result) {
        if (recorder == null || currentFile == null) {
            result.error("NOT_RECORDING", "No recording is active.", null);
            return;
        }
        try {
            recorder.stop();
        } finally {
            recorder.release();
            recorder = null;
        }
        Map<String, Object> payload = payloadForFile(currentVideoId, currentFile);
        currentFile = null;
        currentVideoId = null;
        result.success(payload);
    }

    private void deleteRecording(String path, MethodChannel.Result result) {
        if (path == null) {
            result.error("BAD_PATH", "Recording path is required.", null);
            return;
        }
        File file = new File(path);
        if (file.exists() && !file.delete()) {
            result.error("DELETE_FAILED", "Could not delete recording.", null);
            return;
        }
        removeLink(path);
        result.success(null);
    }

    private void listRecordings(String videoId, MethodChannel.Result result) {
        String safeVideoId = sanitize(videoId);
        File folder = new File(getFilesDir(), "recordings/" + safeVideoId);
        File[] files = folder.listFiles((dir, name) -> name.endsWith(".m4a"));
        List<Map<String, Object>> items = new ArrayList<>();
        if (files != null) {
            Arrays.sort(files, Comparator.comparingLong(File::lastModified));
            for (File file : files) {
                if (file.getName().startsWith("stitched_")) {
                    continue;
                }
                items.add(payloadForFile(safeVideoId, file));
            }
        }
        result.success(items);
    }

    private void mergeRecordings(String videoId, MethodChannel.Result result) throws IOException {
        String safeVideoId = sanitize(videoId);
        File folder = new File(getFilesDir(), "recordings/" + safeVideoId);
        File[] files = folder.listFiles(
                (dir, name) -> name.endsWith(".m4a") && !name.startsWith("stitched_")
        );
        if (files == null || files.length == 0) {
            result.error("NO_RECORDINGS", "No recordings are saved for this video.", null);
            return;
        }
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));

        File output = new File(folder, "stitched_" + System.currentTimeMillis() + ".m4a");
        muxAudioFiles(files, output);
        result.success(payloadForFile(safeVideoId, output));
    }

    private void playRecording(String path, MethodChannel.Result result) throws IOException {
        if (path == null) {
            result.error("BAD_PATH", "Recording path is required.", null);
            return;
        }
        if (player != null) {
            player.stop();
            player.release();
            player = null;
        }
        player = new MediaPlayer();
        player.setDataSource(path);
        player.setOnCompletionListener(done -> {
            done.release();
            if (player == done) {
                player = null;
            }
        });
        player.prepare();
        player.start();
        result.success(null);
    }

    private void saveCombinedLink(
            String videoId,
            String url,
            MethodChannel.Result result
    ) {
        if (videoId == null || url == null) {
            result.error("BAD_LINK", "Video ID and URL are required.", null);
            return;
        }
        JSONObject links = readCombinedLinks();
        try {
            links.put(sanitize(videoId), url);
            prefs().edit().putString(COMBINED_LINKS_KEY, links.toString()).apply();
            result.success(null);
        } catch (JSONException error) {
            result.error("LINK_SAVE_FAILED", error.getMessage(), null);
        }
    }

    private void getCombinedLink(String videoId, MethodChannel.Result result) {
        if (videoId == null) {
            result.success(null);
            return;
        }
        String link = readCombinedLinks().optString(sanitize(videoId), null);
        result.success(link == null || link.isEmpty() ? null : link);
    }

    private void shareText(String text, MethodChannel.Result result) {
        if (text == null || text.trim().isEmpty()) {
            result.error("BAD_SHARE", "Share text is required.", null);
            return;
        }
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TEXT, text);
        startActivity(Intent.createChooser(intent, "Share recording link"));
        result.success(null);
    }

    private void showUploadStarted(String title, MethodChannel.Result result) {
        if (!canShowNotifications()) {
            result.success(null);
            return;
        }
        Notification notification = uploadNotificationBuilder(
                "Uploading recording",
                shortTitle(title),
                true
        )
                .setOngoing(true)
                .setProgress(0, 0, true)
                .build();
        notificationManager().notify(UPLOAD_PROGRESS_ID, notification);
        result.success(null);
    }

    private void showUploadProgress(
            String title,
            Integer progress,
            MethodChannel.Result result
    ) {
        if (!canShowNotifications()) {
            result.success(null);
            return;
        }
        int cleanProgress = progress == null ? 0 : Math.max(0, Math.min(100, progress));
        Notification notification = uploadNotificationBuilder(
                "Uploading recording",
                shortTitle(title) + " - " + cleanProgress + "%",
                true
        )
                .setOngoing(true)
                .setProgress(100, cleanProgress, false)
                .build();
        notificationManager().notify(UPLOAD_PROGRESS_ID, notification);
        result.success(null);
    }

    private void showUploadFinished(String title, String url, MethodChannel.Result result) {
        notificationManager().cancel(UPLOAD_PROGRESS_ID);
        if (!canShowNotifications()) {
            result.success(null);
            return;
        }
        String message = shortTitle(title) + "\n" + (url == null ? "" : url);
        Notification notification = uploadNotificationBuilder(
                "Recording uploaded",
                "Tap to open Dhanda AI",
                false
        )
                .setStyle(new Notification.BigTextStyle().bigText(message))
                .setOngoing(false)
                .setAutoCancel(true)
                .build();
        notificationManager().notify(UPLOAD_DONE_ID, notification);
        result.success(null);
    }

    private void showUploadFailed(String title, String error, MethodChannel.Result result) {
        notificationManager().cancel(UPLOAD_PROGRESS_ID);
        if (!canShowNotifications()) {
            result.success(null);
            return;
        }
        String message = shortTitle(title) + "\n" + (error == null ? "Upload failed" : error);
        Notification notification = uploadNotificationBuilder(
                "Upload failed",
                "Open Dhanda AI and try again",
                false
        )
                .setStyle(new Notification.BigTextStyle().bigText(message))
                .setOngoing(false)
                .setAutoCancel(true)
                .build();
        notificationManager().notify(UPLOAD_FAILED_ID, notification);
        result.success(null);
    }

    private Map<String, Object> payloadForFile(String videoId, File file) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("id", videoId + ":" + file.getName());
        payload.put("path", file.getAbsolutePath());
        payload.put("createdAt", file.lastModified());
        payload.put("durationMs", durationMs(file));
        String link = readLinks().optString(file.getAbsolutePath(), null);
        if (link != null && !link.isEmpty()) {
            payload.put("downloadUrl", link);
        }
        return payload;
    }

    private long durationMs(File file) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(file.getAbsolutePath());
            String raw = retriever.extractMetadata(
                    MediaMetadataRetriever.METADATA_KEY_DURATION
            );
            if (raw == null || raw.isEmpty()) {
                return 0L;
            }
            return Long.parseLong(raw);
        } catch (Exception error) {
            return 0L;
        } finally {
            try {
                retriever.release();
            } catch (IOException ignored) {
                // Nothing to clean up.
            }
        }
    }

    private void removeLink(String path) {
        JSONObject links = readLinks();
        links.remove(path);
        prefs().edit().putString(LINKS_KEY, links.toString()).apply();
    }

    private JSONObject readLinks() {
        String raw = prefs().getString(LINKS_KEY, "{}");
        return readJson(raw);
    }

    private JSONObject readCombinedLinks() {
        String raw = prefs().getString(COMBINED_LINKS_KEY, "{}");
        return readJson(raw);
    }

    private JSONObject readJson(String raw) {
        try {
            JSONObject compact = new JSONObject();
            JSONObject saved = new JSONObject(raw);
            Iterator<String> keys = saved.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                compact.put(key, saved.optString(key));
            }
            return compact;
        } catch (JSONException error) {
            return new JSONObject();
        }
    }

    private void muxAudioFiles(File[] files, File output) throws IOException {
        MediaMuxer muxer = null;
        int outputTrack = -1;
        long presentationOffsetUs = 0L;
        boolean started = false;

        try {
            muxer = new MediaMuxer(
                    output.getAbsolutePath(),
                    MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4
            );

            for (File file : files) {
                MediaExtractor extractor = new MediaExtractor();
                extractor.setDataSource(file.getAbsolutePath());
                int inputTrack = selectAudioTrack(extractor);
                if (inputTrack < 0) {
                    extractor.release();
                    continue;
                }

                extractor.selectTrack(inputTrack);
                MediaFormat format = extractor.getTrackFormat(inputTrack);
                if (!started) {
                    outputTrack = muxer.addTrack(format);
                    muxer.start();
                    started = true;
                }

                int bufferSize = format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)
                        ? format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
                        : 1024 * 1024;
                ByteBuffer buffer = ByteBuffer.allocate(bufferSize);
                MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
                long lastSampleTimeUs = 0L;

                while (true) {
                    buffer.clear();
                    int sampleSize = extractor.readSampleData(buffer, 0);
                    if (sampleSize < 0) {
                        break;
                    }
                    long sampleTimeUs = Math.max(0L, extractor.getSampleTime());
                    info.offset = 0;
                    info.size = sampleSize;
                    info.presentationTimeUs = presentationOffsetUs + sampleTimeUs;
                    info.flags = extractor.getSampleFlags();
                    muxer.writeSampleData(outputTrack, buffer, info);
                    lastSampleTimeUs = sampleTimeUs;
                    extractor.advance();
                }

                presentationOffsetUs += lastSampleTimeUs + 100_000L;
                extractor.release();
            }

            if (!started) {
                throw new IOException("No audio tracks were found to stitch.");
            }
        } finally {
            if (muxer != null && started) {
                muxer.stop();
                muxer.release();
            } else if (muxer != null) {
                muxer.release();
            }
        }
    }

    private int selectAudioTrack(MediaExtractor extractor) {
        for (int index = 0; index < extractor.getTrackCount(); index++) {
            MediaFormat format = extractor.getTrackFormat(index);
            String mime = format.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("audio/")) {
                return index;
            }
        }
        return -1;
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void createUploadNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                UPLOAD_CHANNEL_ID,
                "Recording uploads",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Shows Dhanda AI recording upload status.");
        notificationManager().createNotificationChannel(channel);
    }

    private boolean canShowNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return true;
        }
        requestPermissions(
                new String[]{Manifest.permission.POST_NOTIFICATIONS},
                NOTIFICATION_REQUEST
        );
        return false;
    }

    private Notification.Builder uploadNotificationBuilder(
            String title,
            String text,
            boolean ongoing
    ) {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent == null) {
            launchIntent = new Intent(this, MainActivity.class);
        }
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                flags
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, UPLOAD_CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setSmallIcon(notificationIcon())
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(pendingIntent)
                .setOngoing(ongoing)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis());
    }

    private int notificationIcon() {
        int icon = getApplicationInfo().icon;
        return icon == 0 ? android.R.drawable.stat_sys_upload : icon;
    }

    private NotificationManager notificationManager() {
        return (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private String shortTitle(String value) {
        if (value == null || value.trim().isEmpty()) {
            return "Dhanda AI recording";
        }
        String trimmed = value.trim();
        return trimmed.length() <= 90 ? trimmed : trimmed.substring(0, 87) + "...";
    }

    private String sanitize(String value) {
        if (value == null || value.trim().isEmpty()) {
            return "unknown";
        }
        return value.replaceAll("[^A-Za-z0-9_-]", "_");
    }
}
