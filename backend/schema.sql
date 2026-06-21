CREATE TABLE IF NOT EXISTS video_scripts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  title TEXT NOT NULL,
  video_url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  original_transcript TEXT,
  transcript_source TEXT,
  rewritten_script TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_scripts_video_url
  ON video_scripts(video_url);

CREATE INDEX IF NOT EXISTS idx_video_scripts_latest
  ON video_scripts(status, published_at DESC);

CREATE TABLE IF NOT EXISTS audio_uploads (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  download_url TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audio_uploads_video_id
  ON audio_uploads(video_id, created_at DESC);
