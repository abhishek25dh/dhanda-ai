package com.dhanda.ai;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
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

    private MediaRecorder recorder;
    private MediaPlayer player;
    private File currentFile;
    private String currentVideoId;

    @Override
    public void configureFlutterEngine(FlutterEngine flutterEngine) {
        super.configureFlutterEngine(flutterEngine);
        new MethodChannel(flutterEngine.getDartExecutor().getBinaryMessenger(), CHANNEL)
                .setMethodCallHandler(this::handleAudioCall);
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

    private Map<String, Object> payloadForFile(String videoId, File file) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("id", videoId + ":" + file.getName());
        payload.put("path", file.getAbsolutePath());
        payload.put("createdAt", file.lastModified());
        String link = readLinks().optString(file.getAbsolutePath(), null);
        if (link != null && !link.isEmpty()) {
            payload.put("downloadUrl", link);
        }
        return payload;
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

    private String sanitize(String value) {
        if (value == null || value.trim().isEmpty()) {
            return "unknown";
        }
        return value.replaceAll("[^A-Za-z0-9_-]", "_");
    }
}
