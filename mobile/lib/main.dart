import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

void main() {
  runApp(const DhandaAiApp());
}

class DhandaAiApp extends StatelessWidget {
  const DhandaAiApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Dhanda AI',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xff0e7c66),
          brightness: Brightness.light,
        ),
        scaffoldBackgroundColor: const Color(0xfff6f5ef),
        useMaterial3: true,
      ),
      home: const ScriptFeedPage(),
    );
  }
}

class ApiClient {
  static const String baseUrl = 'https://dhanda-ai-api.sundarful.workers.dev';

  Future<List<VideoScript>> fetchLatestScripts() async {
    final uri = Uri.parse('$baseUrl/scripts/latest');
    try {
      final request = await HttpClient().getUrl(uri);
      final response = await request.close().timeout(
            const Duration(seconds: 12),
          );
      if (response.statusCode != 200) {
        throw HttpException('Unexpected status ${response.statusCode}');
      }
      final body = await response.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      final items = decoded['items'] as List<dynamic>? ?? <dynamic>[];
      return items
          .map((item) => VideoScript.fromJson(item as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return sampleScripts;
    }
  }

  Future<String> uploadRecording({
    required String videoId,
    required RecordingItem recording,
    ValueChanged<double>? onProgress,
  }) async {
    final file = File(recording.path);
    final fileName = recording.path.split(Platform.pathSeparator).last;
    final fileLength = await file.length();
    final uri = Uri.parse(
      '$baseUrl/audio-uploads?videoId=${Uri.encodeComponent(videoId)}&fileName=${Uri.encodeComponent(fileName)}',
    );
    final request = await HttpClient().postUrl(uri);
    request.headers.contentType = ContentType('audio', 'mp4');
    request.headers.set('x-dhanda-recording-id', recording.id);
    request.contentLength = fileLength;
    var uploadedBytes = 0;
    await for (final chunk in file.openRead()) {
      request.add(chunk);
      uploadedBytes += chunk.length;
      if (fileLength > 0) {
        onProgress?.call(uploadedBytes / fileLength);
      }
    }
    final response = await request.close().timeout(const Duration(minutes: 2));
    final body = await response.transform(utf8.decoder).join();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw HttpException(body.isEmpty ? 'Upload failed' : body);
    }
    final decoded = jsonDecode(body) as Map<String, dynamic>;
    return decoded['downloadUrl'] as String;
  }
}

class NativeAudioStore {
  static const MethodChannel _channel = MethodChannel('dhanda_ai/audio');

  Future<void> start(String videoId) {
    return _channel.invokeMethod('startRecording', {'videoId': videoId});
  }

  Future<void> pause() {
    return _channel.invokeMethod('pauseRecording');
  }

  Future<void> resume() {
    return _channel.invokeMethod('resumeRecording');
  }

  Future<RecordingItem> stop(String videoId) async {
    final result = await _channel.invokeMethod<Map<dynamic, dynamic>>(
      'stopRecording',
      {'videoId': videoId},
    );
    return RecordingItem.fromNative(result ?? <dynamic, dynamic>{});
  }

  Future<void> delete(String path) {
    return _channel.invokeMethod('deleteRecording', {'path': path});
  }

  Future<void> saveLink({
    required String videoId,
    required String url,
  }) {
    return _channel.invokeMethod('saveCombinedLink', {
      'videoId': videoId,
      'url': url,
    });
  }

  Future<String?> combinedLink(String videoId) {
    return _channel
        .invokeMethod<String>('getCombinedLink', {'videoId': videoId});
  }

  Future<RecordingItem> merge(String videoId) async {
    final result = await _channel.invokeMethod<Map<dynamic, dynamic>>(
      'mergeRecordings',
      {'videoId': videoId},
    );
    return RecordingItem.fromNative(result ?? <dynamic, dynamic>{});
  }

  Future<void> play(String path) {
    return _channel.invokeMethod('playRecording', {'path': path});
  }

  Future<void> notifyUploadStarted({required String title}) {
    return _channel.invokeMethod('showUploadStarted', {'title': title});
  }

  Future<void> notifyUploadProgress({
    required String title,
    required int progress,
  }) {
    return _channel.invokeMethod('showUploadProgress', {
      'title': title,
      'progress': progress,
    });
  }

  Future<void> notifyUploadFinished({
    required String title,
    required String url,
  }) {
    return _channel.invokeMethod('showUploadFinished', {
      'title': title,
      'url': url,
    });
  }

  Future<void> notifyUploadFailed({
    required String title,
    required String error,
  }) {
    return _channel.invokeMethod('showUploadFailed', {
      'title': title,
      'error': error,
    });
  }

  Future<void> share(String message) {
    return _channel.invokeMethod('shareText', {'text': message});
  }

  Future<List<RecordingItem>> list(String videoId) async {
    final result = await _channel.invokeMethod<List<dynamic>>(
      'listRecordings',
      {'videoId': videoId},
    );
    return (result ?? <dynamic>[])
        .map((item) => RecordingItem.fromNative(item as Map<dynamic, dynamic>))
        .toList();
  }
}

class VideoScript {
  const VideoScript({
    required this.id,
    required this.channelName,
    required this.title,
    required this.videoUrl,
    required this.publishedAt,
    required this.script,
  });

  factory VideoScript.fromJson(Map<String, dynamic> json) {
    return VideoScript(
      id: json['id'] as String,
      channelName: json['channelName'] as String? ?? 'Dhanda AI',
      title: json['title'] as String? ?? 'Untitled video',
      videoUrl: json['videoUrl'] as String? ?? '',
      publishedAt: DateTime.tryParse(json['publishedAt'] as String? ?? '') ??
          DateTime.now(),
      script: json['script'] as String? ?? '',
    );
  }

  final String id;
  final String channelName;
  final String title;
  final String videoUrl;
  final DateTime publishedAt;
  final String script;
}

class RecordingItem {
  const RecordingItem({
    required this.id,
    required this.path,
    required this.createdAt,
    this.downloadUrl,
  });

  factory RecordingItem.fromNative(Map<dynamic, dynamic> native) {
    final path = native['path'] as String? ?? '';
    final fallbackId = path.hashCode.toString();
    return RecordingItem(
      id: native['id'] as String? ?? fallbackId,
      path: path,
      createdAt: DateTime.fromMillisecondsSinceEpoch(
        native['createdAt'] as int? ?? DateTime.now().millisecondsSinceEpoch,
      ),
      downloadUrl: native['downloadUrl'] as String?,
    );
  }

  final String id;
  final String path;
  final DateTime createdAt;
  final String? downloadUrl;
}

class ScriptFeedPage extends StatefulWidget {
  const ScriptFeedPage({super.key});

  @override
  State<ScriptFeedPage> createState() => _ScriptFeedPageState();
}

class _ScriptFeedPageState extends State<ScriptFeedPage> {
  final ApiClient _api = ApiClient();
  late Future<List<VideoScript>> _scripts;

  @override
  void initState() {
    super.initState();
    _scripts = _api.fetchLatestScripts();
  }

  Future<void> _refresh() async {
    setState(() {
      _scripts = _api.fetchLatestScripts();
    });
    await _scripts;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Dhanda AI'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: FutureBuilder<List<VideoScript>>(
        future: _scripts,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          final scripts = snapshot.data ?? sampleScripts;
          final sections = FeedSection.fromScripts(scripts);
          return RefreshIndicator(
            onRefresh: _refresh,
            child: ListView.builder(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 24),
              itemBuilder: (context, index) {
                return DateSectionView(section: sections[index]);
              },
              itemCount: sections.length,
            ),
          );
        },
      ),
    );
  }
}

class FeedSection {
  const FeedSection({required this.date, required this.channels});

  final DateTime date;
  final List<ChannelVideoGroup> channels;

  static List<FeedSection> fromScripts(List<VideoScript> scripts) {
    final sorted = [...scripts]
      ..sort((left, right) => right.publishedAt.compareTo(left.publishedAt));
    final byDate = <DateTime, Map<String, List<VideoScript>>>{};

    for (final script in sorted) {
      final date = DateTime(
        script.publishedAt.year,
        script.publishedAt.month,
        script.publishedAt.day,
      );
      final channels = byDate.putIfAbsent(
        date,
        () => <String, List<VideoScript>>{},
      );
      channels
          .putIfAbsent(script.channelName, () => <VideoScript>[])
          .add(script);
    }

    final sections = byDate.entries.map((entry) {
      final groups = entry.value.entries.map((channelEntry) {
        final videos = channelEntry.value
          ..sort(
              (left, right) => right.publishedAt.compareTo(left.publishedAt));
        return ChannelVideoGroup(name: channelEntry.key, videos: videos);
      }).toList()
        ..sort((left, right) => left.name.compareTo(right.name));
      return FeedSection(date: entry.key, channels: groups);
    }).toList()
      ..sort((left, right) => right.date.compareTo(left.date));

    return sections;
  }
}

class ChannelVideoGroup {
  const ChannelVideoGroup({required this.name, required this.videos});

  final String name;
  final List<VideoScript> videos;
}

class DateSectionView extends StatelessWidget {
  const DateSectionView({required this.section, super.key});

  final FeedSection section;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xffdedbd2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: const Color(0xff173f35),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Center(
                  child: Text(
                    section.date.day.toString(),
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          color: Colors.white,
                          fontWeight: FontWeight.w800,
                        ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  _formatSectionDate(section.date),
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w900,
                      ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          ...section.channels.map(
            (channel) => ChannelShelf(group: channel),
          ),
        ],
      ),
    );
  }
}

class ChannelShelf extends StatelessWidget {
  const ChannelShelf({required this.group, super.key});

  final ChannelVideoGroup group;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.video_library_rounded, size: 18),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  group.name,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                ),
              ),
              Text(
                '${group.videos.length}',
                style: Theme.of(context).textTheme.labelMedium,
              ),
            ],
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 212,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemBuilder: (context, index) {
                return ScriptCard(script: group.videos[index]);
              },
              separatorBuilder: (_, __) => const SizedBox(width: 10),
              itemCount: group.videos.length,
            ),
          ),
        ],
      ),
    );
  }
}

class ScriptCard extends StatefulWidget {
  const ScriptCard({required this.script, super.key});

  final VideoScript script;

  @override
  State<ScriptCard> createState() => _ScriptCardState();
}

class _ScriptCardState extends State<ScriptCard> {
  final NativeAudioStore _audio = NativeAudioStore();
  bool _done = false;

  @override
  void initState() {
    super.initState();
    _loadStatus();
  }

  Future<void> _loadStatus() async {
    final link = await _audio.combinedLink(widget.script.id);
    if (!mounted) {
      return;
    }
    setState(() {
      _done = link != null && link.isNotEmpty;
    });
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 260,
      child: Card(
        elevation: 0,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        child: InkWell(
          onTap: () {
            Navigator.of(context)
                .push(
                  MaterialPageRoute<void>(
                    builder: (_) => ScriptDetailPage(script: widget.script),
                  ),
                )
                .then((_) => _loadStatus());
          },
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      width: 34,
                      height: 34,
                      decoration: BoxDecoration(
                        color: const Color(0xff173f35),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: const Icon(
                        Icons.play_arrow_rounded,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            _formatTime(widget.script.publishedAt),
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    _StatusPill(done: _done),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  widget.script.title,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(
                    context,
                  ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 8),
                Expanded(
                  child: Text(
                    widget.script.script,
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.done});

  final bool done;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: done ? const Color(0xffdff3ea) : const Color(0xfffff0d6),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        done ? 'Done' : 'Pending',
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: done ? const Color(0xff0e6656) : const Color(0xff8a5a00),
              fontWeight: FontWeight.w800,
            ),
      ),
    );
  }
}

class ScriptDetailPage extends StatefulWidget {
  const ScriptDetailPage({required this.script, super.key});

  final VideoScript script;

  @override
  State<ScriptDetailPage> createState() => _ScriptDetailPageState();
}

class _ScriptDetailPageState extends State<ScriptDetailPage> {
  final NativeAudioStore _audio = NativeAudioStore();
  final ApiClient _api = ApiClient();
  List<RecordingItem> _recordings = <RecordingItem>[];
  RecordingItem? _pending;
  bool _recording = false;
  bool _paused = false;
  bool _loading = true;
  bool _uploadingCombined = false;
  bool _scriptExpanded = false;
  double? _uploadProgress;
  String? _uploadStage;
  int _lastUploadNotificationProgress = -1;
  String? _combinedLink;

  @override
  void initState() {
    super.initState();
    _loadRecordings();
  }

  Future<void> _loadRecordings() async {
    final items = await _audio.list(widget.script.id);
    final link = await _audio.combinedLink(widget.script.id);
    if (!mounted) {
      return;
    }
    setState(() {
      _recordings = items;
      _combinedLink = link;
      _loading = false;
    });
  }

  Future<void> _start() async {
    try {
      await _audio.start(widget.script.id);
      setState(() {
        _recording = true;
        _paused = false;
        _pending = null;
      });
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Recording could not start: $error')),
        );
      }
    }
  }

  Future<void> _pauseOrResume() async {
    if (_paused) {
      await _audio.resume();
    } else {
      await _audio.pause();
    }
    setState(() {
      _paused = !_paused;
    });
  }

  Future<void> _stop() async {
    final item = await _audio.stop(widget.script.id);
    setState(() {
      _pending = item;
      _recording = false;
      _paused = false;
    });
  }

  Future<void> _discardPending() async {
    final pending = _pending;
    if (pending != null) {
      await _audio.delete(pending.path);
    }
    setState(() {
      _pending = null;
    });
  }

  Future<void> _savePending() async {
    setState(() {
      _pending = null;
      _loading = true;
    });
    await _loadRecordings();
  }

  Future<void> _delete(RecordingItem item) async {
    await _audio.delete(item.path);
    await _loadRecordings();
  }

  Future<void> _uploadCombined() async {
    if (_recordings.isEmpty) {
      return;
    }
    setState(() {
      _uploadingCombined = true;
      _uploadProgress = 0;
      _uploadStage = 'Preparing audio';
      _lastUploadNotificationProgress = -1;
    });
    try {
      await _audio.notifyUploadStarted(title: widget.script.title);
      _setUploadProgress('Stitching recordings', 0.08);
      final item = await _audio.merge(widget.script.id);
      _setUploadProgress('Uploading audio', 0.25, notify: true);
      final link = await _api.uploadRecording(
        videoId: widget.script.id,
        recording: item,
        onProgress: (progress) {
          final overall = 0.25 + (progress.clamp(0, 1) * 0.7);
          _setUploadProgress('Uploading audio', overall, notify: true);
        },
      );
      _setUploadProgress('Saving link', 0.96, notify: true);
      await _audio.saveLink(
        videoId: widget.script.id,
        url: link,
      );
      _setUploadProgress('Upload complete', 1, notify: true);
      await _audio.notifyUploadFinished(
        title: widget.script.title,
        url: link,
      );
      await _loadRecordings();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Recording uploaded')));
      }
    } catch (error) {
      await _audio.notifyUploadFailed(
        title: widget.script.title,
        error: error.toString(),
      );
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Upload failed: $error')));
      }
    } finally {
      if (mounted) {
        setState(() {
          _uploadingCombined = false;
          _uploadProgress = null;
          _uploadStage = null;
        });
      }
    }
  }

  void _setUploadProgress(
    String stage,
    double progress, {
    bool notify = false,
  }) {
    final cleanProgress = progress.clamp(0, 1).toDouble();
    if (mounted) {
      setState(() {
        _uploadStage = stage;
        _uploadProgress = cleanProgress;
      });
    }
    if (!notify) {
      return;
    }
    final percent = (cleanProgress * 100).round();
    if (percent == 100 || percent - _lastUploadNotificationProgress >= 5) {
      _lastUploadNotificationProgress = percent;
      unawaited(
        _audio.notifyUploadProgress(
          title: widget.script.title,
          progress: percent,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final canAddRecording = !_recording && _pending == null;
    return Scaffold(
      appBar: AppBar(title: Text(widget.script.channelName)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                widget.script.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context)
                    .textTheme
                    .titleLarge
                    ?.copyWith(fontWeight: FontWeight.w900),
              ),
              const SizedBox(height: 6),
              Text(
                widget.script.videoUrl,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 10),
              Expanded(
                child: _ScriptPanel(
                  script: widget.script.script,
                  expanded: _scriptExpanded,
                  onToggleExpanded: () {
                    setState(() {
                      _scriptExpanded = !_scriptExpanded;
                    });
                  },
                ),
              ),
              const SizedBox(height: 10),
              _RecordingControls(
                recording: _recording,
                paused: _paused,
                pending: _pending,
                canAddRecording: canAddRecording,
                hasRecordings: _recordings.isNotEmpty,
                onStart: _start,
                onPauseOrResume: _pauseOrResume,
                onStop: _stop,
                onSave: _savePending,
                onDiscard: _discardPending,
              ),
              if (_recordings.isNotEmpty || _combinedLink != null) ...[
                const SizedBox(height: 10),
                CombinedUploadPanel(
                  link: _combinedLink,
                  busy: _uploadingCombined,
                  progress: _uploadProgress,
                  stage: _uploadStage,
                  onUpload: _uploadCombined,
                  onShare: _combinedLink == null
                      ? null
                      : () => _audio.share(_shareMessage(_combinedLink!)),
                ),
              ],
              if (!_scriptExpanded) ...[
                const SizedBox(height: 8),
                Text(
                  'Recordings',
                  style: Theme.of(context)
                      .textTheme
                      .titleSmall
                      ?.copyWith(fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 4),
                SizedBox(
                  height: 94,
                  child: _RecordingsList(
                    loading: _loading,
                    recordings: _recordings,
                    onPlay: (item) => _audio.play(item.path),
                    onDelete: _delete,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  String _shareMessage(String audioLink) {
    return [
      'Namaste, here is my recorded audio.',
      '',
      'Title: ${widget.script.title}',
      'Original YouTube video: ${widget.script.videoUrl}',
      'Audio download link: $audioLink',
    ].join('\n');
  }
}

class _RecordingsList extends StatelessWidget {
  const _RecordingsList({
    required this.loading,
    required this.recordings,
    required this.onPlay,
    required this.onDelete,
  });

  final bool loading;
  final List<RecordingItem> recordings;
  final ValueChanged<RecordingItem> onPlay;
  final ValueChanged<RecordingItem> onDelete;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (recordings.isEmpty) {
      return const _EmptyRecordings();
    }
    return ListView.builder(
      itemBuilder: (context, index) {
        final item = recordings[index];
        return RecordingTile(
          item: item,
          onPlay: () => onPlay(item),
          onDelete: () => onDelete(item),
        );
      },
      itemCount: recordings.length,
    );
  }
}

class _ScriptPanel extends StatelessWidget {
  const _ScriptPanel({
    required this.script,
    required this.expanded,
    required this.onToggleExpanded,
  });

  final String script;
  final bool expanded;
  final VoidCallback onToggleExpanded;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xffdedbd2)),
      ),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Script',
                  style: Theme.of(context)
                      .textTheme
                      .titleSmall
                      ?.copyWith(fontWeight: FontWeight.w800),
                ),
              ),
              IconButton(
                tooltip: expanded ? 'Collapse script' : 'Expand script',
                onPressed: onToggleExpanded,
                icon: Icon(
                  expanded
                      ? Icons.close_fullscreen_rounded
                      : Icons.open_in_full_rounded,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Expanded(
            child: Scrollbar(
              thumbVisibility: true,
              child: SingleChildScrollView(
                padding: const EdgeInsets.only(right: 10),
                child: Text(
                  script,
                  style: Theme.of(context)
                      .textTheme
                      .bodyLarge
                      ?.copyWith(height: 1.45),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RecordingControls extends StatelessWidget {
  const _RecordingControls({
    required this.recording,
    required this.paused,
    required this.pending,
    required this.canAddRecording,
    required this.hasRecordings,
    required this.onStart,
    required this.onPauseOrResume,
    required this.onStop,
    required this.onSave,
    required this.onDiscard,
  });

  final bool recording;
  final bool paused;
  final RecordingItem? pending;
  final bool canAddRecording;
  final bool hasRecordings;
  final VoidCallback onStart;
  final VoidCallback onPauseOrResume;
  final VoidCallback onStop;
  final VoidCallback onSave;
  final VoidCallback onDiscard;

  @override
  Widget build(BuildContext context) {
    if (pending != null) {
      return Row(
        children: [
          Expanded(
            child: FilledButton.icon(
              onPressed: onSave,
              icon: const Icon(Icons.save_alt_rounded),
              label: const Text('Save'),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: OutlinedButton.icon(
              onPressed: onDiscard,
              icon: const Icon(Icons.delete_outline_rounded),
              label: const Text('Discard'),
            ),
          ),
        ],
      );
    }
    if (recording) {
      return Row(
        children: [
          Expanded(
            child: FilledButton.icon(
              onPressed: onPauseOrResume,
              icon: Icon(
                paused ? Icons.play_arrow_rounded : Icons.pause_rounded,
              ),
              label: Text(paused ? 'Resume' : 'Pause'),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: FilledButton.tonalIcon(
              onPressed: onStop,
              icon: const Icon(Icons.stop_rounded),
              label: const Text('Stop'),
            ),
          ),
        ],
      );
    }
    return FilledButton.icon(
      onPressed: canAddRecording ? onStart : null,
      icon: Icon(
        hasRecordings ? Icons.add_circle_outline_rounded : Icons.mic_rounded,
      ),
      label: Text(hasRecordings ? 'Add recording' : 'Record'),
    );
  }
}

class RecordingTile extends StatelessWidget {
  const RecordingTile({
    required this.item,
    required this.onPlay,
    required this.onDelete,
    super.key,
  });

  final RecordingItem item;
  final VoidCallback onPlay;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.graphic_eq_rounded),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    _formatDateTime(item.createdAt),
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                IconButton(
                  tooltip: 'Play',
                  onPressed: onPlay,
                  icon: const Icon(Icons.play_arrow_rounded),
                ),
                IconButton(
                  tooltip: 'Delete',
                  onPressed: onDelete,
                  icon: const Icon(Icons.delete_outline_rounded),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class CombinedUploadPanel extends StatelessWidget {
  const CombinedUploadPanel({
    required this.link,
    required this.busy,
    required this.progress,
    required this.stage,
    required this.onUpload,
    required this.onShare,
    super.key,
  });

  final String? link;
  final bool busy;
  final double? progress;
  final String? stage;
  final VoidCallback onUpload;
  final VoidCallback? onShare;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: const Color(0xffdedbd2)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.merge_type_rounded),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Final stitched audio',
                  style: Theme.of(
                    context,
                  ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
                ),
              ),
              IconButton(
                tooltip: link == null ? 'Upload stitched audio' : 'Share link',
                onPressed: busy ? null : (link == null ? onUpload : onShare),
                icon: busy
                    ? const SizedBox.square(
                        dimension: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Icon(
                        link == null
                            ? Icons.cloud_upload_outlined
                            : Icons.share_rounded,
                      ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'Parts are joined in the order you recorded them.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          if (busy) ...[
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: LinearProgressIndicator(
                minHeight: 7,
                value: progress,
                backgroundColor: const Color(0xffe7e2d7),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              '${stage ?? 'Uploading'}'
              '${progress == null ? '' : ' ${(progress! * 100).round()}%'}',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: const Color(0xff0e6656),
                    fontWeight: FontWeight.w700,
                  ),
            ),
          ],
          if (link != null) ...[
            const SizedBox(height: 8),
            SelectableText(
              link!,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: const Color(0xff0e6656)),
            ),
          ],
        ],
      ),
    );
  }
}

class _EmptyRecordings extends StatelessWidget {
  const _EmptyRecordings();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        border: Border.all(color: const Color(0xffdedbd2)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: const Text('No saved recordings for this video yet.'),
    );
  }
}

String _formatDate(DateTime value) {
  return '${value.day.toString().padLeft(2, '0')}/${value.month.toString().padLeft(2, '0')}/${value.year}';
}

String _formatSectionDate(DateTime value) {
  return '${_ordinal(value.day)} ${_monthName(value.month)} ${value.year}';
}

String _formatTime(DateTime value) {
  final hour = value.hour.toString().padLeft(2, '0');
  final minute = value.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}

String _formatDateTime(DateTime value) {
  final hour = value.hour.toString().padLeft(2, '0');
  final minute = value.minute.toString().padLeft(2, '0');
  return '${_formatDate(value)} at $hour:$minute';
}

String _ordinal(int day) {
  if (day >= 11 && day <= 13) {
    return '${day}th';
  }
  return switch (day % 10) {
    1 => '${day}st',
    2 => '${day}nd',
    3 => '${day}rd',
    _ => '${day}th',
  };
}

String _monthName(int month) {
  const months = <String>[
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return months[month - 1];
}

final List<VideoScript> sampleScripts = <VideoScript>[
  VideoScript(
    id: 'sample-video-1',
    channelName: 'Sample Channel',
    title: 'Latest business update rewritten for Dhanda AI',
    videoUrl: 'https://www.youtube.com/watch?v=sample',
    publishedAt: DateTime(2026, 6, 21),
    script:
        'Namaste dosto. Aaj hum baat karenge ek practical business idea ke baare mein. Pehle problem ko simple language mein samjho, phir uska solution explain karo, aur end mein audience ko ek clear action do. Yeh script server se ready aayegi, taki app khulte hi recording start ho sake.',
  ),
];
