interface Env {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  ASSEMBLYAI_API_KEY?: string;
  ADMIN_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  APP_VERSION_CODE?: string;
  APP_VERSION_NAME?: string;
  APP_RELEASE_NOTES?: string;
  APP_APK_KEY?: string;
}

type ChannelConfig = {
  channelId: string;
  name: string;
  url: string;
  seedVideoIds: string[];
  includePublishedAfter: string;
};

type FeedEntry = {
  id: string;
  title: string;
  videoUrl: string;
  publishedAt: string;
};

const CHANNELS: ChannelConfig[] = [
  {
    channelId: 'UC9rCl1z3dAVSPzbjq0yaaOA',
    name: 'My Marathi',
    url: 'https://www.youtube.com/@MyMarathi-m5g',
    seedVideoIds: ['55p8qD_9_p8', 'MxQLRdLRUc0'],
    includePublishedAfter: '2026-06-21T00:00:00+05:30',
  },
  {
    channelId: 'UCj1EVyyFGQShXu6qMbRlfGQ',
    name: 'Suranjan Marathi',
    url: 'https://www.youtube.com/@SuranjanMarathi',
    seedVideoIds: ['WJqmh1AEX9w', '613ak4tW8rk'],
    includePublishedAfter: '2026-06-21T00:00:00+05:30',
  },
];

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers':
    'authorization,content-type,x-dhanda-recording-id',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/scripts/latest') {
        return getLatestScripts(env);
      }
      if (request.method === 'GET' && url.pathname === '/app/latest') {
        return getLatestApp(env, url);
      }
      if (request.method === 'GET' && url.pathname === '/app/apk') {
        return getAppApk(env);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/audio/')) {
        return getAudio(env, url);
      }
      if (request.method === 'POST' && url.pathname === '/admin/poll') {
        requireAdmin(request, env);
        ctx.waitUntil(pollChannels(env, ctx));
        return json({ queued: true });
      }
      if (request.method === 'POST' && url.pathname === '/admin/videos/upsert') {
        requireAdmin(request, env);
        return upsertAdminVideo(request, env);
      }
      if (
        request.method === 'POST' &&
        url.pathname.startsWith('/admin/videos/') &&
        url.pathname.endsWith('/transcript')
      ) {
        requireAdmin(request, env);
        const videoId = url.pathname
          .replace('/admin/videos/', '')
          .replace('/transcript', '');
        return updateAdminTranscript(request, env, decodeURIComponent(videoId));
      }
      if (request.method === 'POST' && url.pathname === '/audio-uploads') {
        return uploadAudio(request, env, url);
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return json({ error: message }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pollChannels(env, ctx));
  },
};

async function getLatestScripts(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, channel_name, title, video_url, published_at, rewritten_script, status
     FROM video_scripts
     WHERE status IN ('ready', 'processing', 'pending')
     ORDER BY published_at DESC
     LIMIT 30`,
  ).all<{
    id: string;
    channel_name: string;
    title: string;
    video_url: string;
    published_at: string;
    rewritten_script: string | null;
    status: string;
  }>();

  return json({
    items: results.map((row) => ({
      id: row.id,
      channelName: row.channel_name,
      title: row.title,
      videoUrl: row.video_url,
      publishedAt: row.published_at,
      status: row.status,
      script:
        row.rewritten_script ??
        'Script is being prepared on the server. Pull to refresh in a little while.',
    })),
  });
}

async function getLatestApp(env: Env, url: URL): Promise<Response> {
  const versionCode = Number.parseInt(env.APP_VERSION_CODE ?? '1', 10);
  return json({
    platform: 'android',
    versionCode: Number.isFinite(versionCode) ? versionCode : 1,
    versionName: env.APP_VERSION_NAME ?? '0.1.0',
    apkUrl: `${url.origin}/app/apk`,
    releaseNotes:
      env.APP_RELEASE_NOTES ??
      'New Dhanda AI build is available with UI and recording improvements.',
  });
}

async function getAppApk(env: Env): Promise<Response> {
  const objectKey = env.APP_APK_KEY ?? 'app/dhanda-ai.apk';
  const object = await env.AUDIO_BUCKET.get(objectKey);
  if (!object) {
    return json({ error: 'App APK has not been uploaded yet' }, 404);
  }

  const headers = new Headers(corsHeaders);
  headers.set('content-type', 'application/vnd.android.package-archive');
  headers.set('content-disposition', 'attachment; filename="dhanda-ai.apk"');
  headers.set('cache-control', 'no-store');
  headers.set('etag', object.httpEtag);
  return new Response(object.body, { headers });
}

async function uploadAudio(request: Request, env: Env, url: URL): Promise<Response> {
  const videoId = url.searchParams.get('videoId');
  const fileName = url.searchParams.get('fileName') ?? 'recording.m4a';
  if (!videoId) {
    return json({ error: 'videoId is required' }, 400);
  }
  if (!request.body) {
    return json({ error: 'Audio body is required' }, 400);
  }

  const safeFileName = fileName.replace(/[^A-Za-z0-9_.-]/g, '_');
  const recordingId =
    request.headers.get('x-dhanda-recording-id') ?? crypto.randomUUID();
  const objectKey = `recordings/${videoId}/${Date.now()}-${safeFileName}`;
  const contentType = request.headers.get('content-type') ?? 'audio/mp4';

  const object = await env.AUDIO_BUCKET.put(objectKey, request.body, {
    httpMetadata: { contentType },
    customMetadata: { videoId, recordingId },
  });
  const downloadUrl = `${url.origin}/audio/${objectKey}`;

  await env.DB.prepare(
    `INSERT INTO audio_uploads
      (id, video_id, file_name, object_key, download_url, content_type, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      videoId,
      safeFileName,
      objectKey,
      downloadUrl,
      contentType,
      object?.size ?? null,
    )
    .run();

  return json({ downloadUrl, objectKey });
}

async function getAudio(env: Env, url: URL): Promise<Response> {
  const objectKey = decodeURIComponent(url.pathname.replace('/audio/', ''));
  if (!objectKey || objectKey.includes('..')) {
    return json({ error: 'Invalid audio key' }, 400);
  }

  const object = await env.AUDIO_BUCKET.get(objectKey);
  if (!object) {
    return json({ error: 'Audio not found' }, 404);
  }

  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, max-age=86400');
  return new Response(object.body, { headers });
}

async function pollChannels(env: Env, ctx: ExecutionContext): Promise<void> {
  for (const channel of CHANNELS) {
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`;
    const response = await fetch(feedUrl, {
      headers: { 'user-agent': 'DhandaAI/0.1 channel watcher' },
    });
    if (!response.ok) {
      throw new Error(`Could not fetch ${channel.name} feed: ${response.status}`);
    }
    const entries = parseFeedEntries(await response.text())
      .filter((entry) => shouldIngestEntry(channel, entry))
      .slice(0, 10);
    for (const entry of entries) {
      const existing = await env.DB.prepare(
        'SELECT id, status FROM video_scripts WHERE id = ?',
      )
        .bind(entry.id)
        .first<{ id: string; status: string }>();
      if (existing) {
        continue;
      }

      await env.DB.prepare(
        `INSERT INTO video_scripts
          (id, channel_id, channel_name, title, video_url, published_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      )
        .bind(
          entry.id,
          channel.channelId,
          channel.name,
          entry.title,
          entry.videoUrl,
          entry.publishedAt,
        )
        .run();
    }
  }
}

async function rewriteTranscript(
  env: Env,
  transcript: string,
  title: string,
): Promise<string> {
  if (!env.OPENROUTER_API_KEY) {
    return transcript;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
      'http-referer': 'https://dhanda.ai',
      'x-title': 'Dhanda AI',
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content:
            'Rewrite transcripts into a clear, original creator script. Keep the same facts, avoid plagiarism, use simple Indian English or Hinglish where natural, and make it ready to read aloud.',
        },
        {
          role: 'user',
          content: `Video title: ${title}\n\nTranscript:\n${transcript}`,
        },
      ],
    }),
  });
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? 'OpenRouter rewrite failed');
  }
  return payload.choices?.[0]?.message?.content?.trim() || transcript;
}

async function upsertAdminVideo(request: Request, env: Env): Promise<Response> {
  const payload = (await request.json()) as {
    id?: string;
    channelId?: string;
    channelName?: string;
    title?: string;
    videoUrl?: string;
    publishedAt?: string;
    transcript?: string;
    transcriptSource?: string;
    rewrittenScript?: string;
  };
  if (!payload.id || !payload.videoUrl || !payload.title || !payload.publishedAt) {
    return json({ error: 'id, title, videoUrl, and publishedAt are required' }, 400);
  }

  const script = payload.transcript
    ? payload.rewrittenScript ??
      (await rewriteTranscript(env, payload.transcript, payload.title))
    : null;
  const status = payload.transcript ? 'ready' : 'pending';

  await env.DB.prepare(
    `INSERT INTO video_scripts
      (id, channel_id, channel_name, title, video_url, published_at,
       original_transcript, transcript_source, rewritten_script, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       channel_id = excluded.channel_id,
       channel_name = excluded.channel_name,
       title = excluded.title,
       video_url = excluded.video_url,
       published_at = excluded.published_at,
       original_transcript = COALESCE(excluded.original_transcript, video_scripts.original_transcript),
       transcript_source = COALESCE(excluded.transcript_source, video_scripts.transcript_source),
       rewritten_script = COALESCE(excluded.rewritten_script, video_scripts.rewritten_script),
       status = excluded.status,
       error = NULL,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      payload.id,
      payload.channelId ?? 'UC9rCl1z3dAVSPzbjq0yaaOA',
      payload.channelName ?? 'My Marathi',
      payload.title,
      payload.videoUrl,
      payload.publishedAt,
      payload.transcript ?? null,
      payload.transcriptSource ?? null,
      script,
      status,
    )
    .run();

  return json({ ok: true, id: payload.id, status });
}

async function updateAdminTranscript(
  request: Request,
  env: Env,
  videoId: string,
): Promise<Response> {
  const payload = (await request.json()) as {
    transcript?: string;
    transcriptSource?: string;
    rewrittenScript?: string;
    title?: string;
  };
  if (!payload.transcript) {
    return json({ error: 'transcript is required' }, 400);
  }
  const title =
    payload.title ??
    ((await env.DB.prepare('SELECT title FROM video_scripts WHERE id = ?')
      .bind(videoId)
      .first<{ title: string }>())?.title ??
      videoId);
  const rewritten =
    payload.rewrittenScript ?? (await rewriteTranscript(env, payload.transcript, title));

  await env.DB.prepare(
    `UPDATE video_scripts
     SET original_transcript = ?, transcript_source = ?, rewritten_script = ?,
         status = 'ready', error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(payload.transcript, payload.transcriptSource ?? 'external', rewritten, videoId)
    .run();

  return json({ ok: true, id: videoId, status: 'ready' });
}

function shouldIngestEntry(channel: ChannelConfig, entry: FeedEntry): boolean {
  if (channel.seedVideoIds.includes(entry.id)) {
    return true;
  }
  return Date.parse(entry.publishedAt) >= Date.parse(channel.includePublishedAfter);
}

function requireAdmin(request: Request, env: Env): void {
  if (!env.ADMIN_API_KEY) {
    throw new Error('ADMIN_API_KEY is not configured');
  }
  const expected = `Bearer ${env.ADMIN_API_KEY}`;
  if (request.headers.get('authorization') !== expected) {
    throw new Error('Unauthorized');
  }
}

function parseFeedEntries(xml: string): FeedEntry[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entries.map((entry) => {
    const videoId = readXml(entry, 'yt:videoId');
    return {
      id: videoId,
      title: decodeXml(readXml(entry, 'title')),
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt: readXml(entry, 'published') || new Date().toISOString(),
    };
  }).filter((entry) => entry.id);
}

function readXml(xml: string, tag: string): string {
  const escapedTag = tag.replace(':', '\\:');
  const match = xml.match(new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`));
  return match?.[1]?.trim() ?? '';
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}
