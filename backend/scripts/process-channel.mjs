import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { rewriteTranscriptWithOpenRouter } from './rewrite-utils.mjs';

const execFileAsync = promisify(execFile);

const channels = [
  {
    channelId: 'UC9rCl1z3dAVSPzbjq0yaaOA',
    channelName: 'My Marathi',
    channelUrl: 'https://www.youtube.com/@MyMarathi-m5g/videos',
    feedUrl:
      'https://www.youtube.com/feeds/videos.xml?channel_id=UC9rCl1z3dAVSPzbjq0yaaOA',
    seedVideoIds: ['55p8qD_9_p8', 'MxQLRdLRUc0'],
    includePublishedAfter: '2026-06-21T00:00:00+05:30',
  },
  {
    channelId: 'UCj1EVyyFGQShXu6qMbRlfGQ',
    channelName: 'Suranjan Marathi',
    channelUrl: 'https://www.youtube.com/@SuranjanMarathi/videos',
    feedUrl:
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCj1EVyyFGQShXu6qMbRlfGQ',
    seedVideoIds: ['WJqmh1AEX9w', '613ak4tW8rk'],
    includePublishedAfter: '2026-06-21T00:00:00+05:30',
  },
];

const rootDir = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runDir = resolve(rootDir, 'runs', 'transcripts');
const apiBase = process.env.DHANDA_API_BASE;
const adminKey = process.env.DHANDA_ADMIN_API_KEY;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const rewriteModel =
  process.env.OPENROUTER_MODEL ?? 'qwen/qwen3-next-80b-a3b-instruct:free';
const forceRewrite = process.env.FORCE_REWRITE === '1';

await mkdir(runDir, { recursive: true });

const readyVideoIds = await fetchReadyVideoIds();

for (const channel of channels) {
  const videos = await latestVideos(channel);
  for (const video of videos.filter((item) => shouldProcess(channel, item))) {
    if (!forceRewrite && readyVideoIds.has(video.id)) {
      console.log(`skipped ${video.id}; server already has a ready script`);
      continue;
    }

    const outputPath = join(runDir, `${video.id}.json`);
    if (await fileExists(outputPath)) {
      const payload = await ensureRewrite(
        JSON.parse(await readFile(outputPath, 'utf8')),
        outputPath,
      );
      if (apiBase && adminKey) {
        await postJson(`${apiBase.replace(/\/$/, '')}/admin/videos/upsert`, payload);
        console.log(`uploaded existing ${video.id}`);
      } else {
        console.log(`skipped ${video.id}; local transcript JSON already exists`);
      }
      continue;
    }

    const transcript = await assemblyAiTranscript(video.id);
    const payload = {
      id: video.id,
      channelId: channel.channelId,
      channelName: channel.channelName,
      title: video.title,
      videoUrl: video.url,
      publishedAt: video.publishedAt,
      transcript: transcript.text,
      transcriptSource: transcript.source,
    };
    await ensureRewrite(payload, outputPath);

    if (apiBase && adminKey) {
      await postJson(`${apiBase.replace(/\/$/, '')}/admin/videos/upsert`, payload);
    }

    console.log(`processed ${video.id} via ${transcript.source}`);
  }
}

async function fetchReadyVideoIds() {
  if (!apiBase) {
    return new Set();
  }

  try {
    const response = await fetch(`${apiBase.replace(/\/$/, '')}/scripts/latest`);
    if (!response.ok) {
      console.warn(`Could not check existing server scripts: ${response.status}`);
      return new Set();
    }
    const data = await response.json();
    return new Set(
      (data.items ?? [])
        .filter((item) => item.status === 'ready')
        .map((item) => item.id),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not check existing server scripts: ${message}`);
    return new Set();
  }
}

async function ensureRewrite(payload, outputPath) {
  if (
    !forceRewrite &&
    payload.rewrittenScript &&
    payload.rewrittenScript.length >= 10000 &&
    payload.rewrittenScript.length <= 14000
  ) {
    return payload;
  }
  if (!openRouterKey) {
    await writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
    return payload;
  }

  console.log(`rewriting ${payload.id} with ${rewriteModel}`);
  payload.rewrittenScript = await rewriteTranscriptWithOpenRouter({
    apiKey: openRouterKey,
    model: rewriteModel,
    title: payload.title,
    transcript: payload.transcript,
    targetChars: 10000,
    maxTargetChars: 14000,
  });
  payload.rewriteModel = rewriteModel;
  payload.rewrittenAt = new Date().toISOString();
  await writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function latestVideos(channel) {
  const xml = await fetchTextWithRetry(channel.feedUrl, 'channel feed');
  return (xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [])
    .slice(0, 10)
    .map((entry) => {
      const id = readXml(entry, 'yt:videoId');
      return {
        id,
        title: decodeXml(readXml(entry, 'title')),
        url: `https://www.youtube.com/watch?v=${id}`,
        publishedAt: readXml(entry, 'published'),
      };
    });
}

async function fetchTextWithRetry(url, label) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.text();
      }
      lastError = new Error(`Could not fetch ${label}: ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1500 * attempt);
  }
  throw lastError;
}

function shouldProcess(channel, video) {
  if (channel.seedVideoIds.includes(video.id)) {
    return true;
  }
  return Date.parse(video.publishedAt) >= Date.parse(channel.includePublishedAfter);
}

async function assemblyAiTranscript(videoId) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new Error('ASSEMBLYAI_API_KEY is required');
  }

  let audioPath = await existingAudioPath(videoId);
  if (!audioPath) {
    await execFileAsync(
      'yt-dlp',
      [
        '-f',
        'bestaudio',
        '-o',
        join(runDir, `${videoId}.%(ext)s`),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    audioPath = await existingAudioPath(videoId);
  }
  if (!audioPath) {
    throw new Error(`Could not download audio for ${videoId}`);
  }

  const upload = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { authorization: apiKey },
    body: await readFile(audioPath),
  });
  const uploadJson = await upload.json();
  if (!upload.ok || !uploadJson.upload_url) {
    throw new Error(uploadJson.error ?? 'AssemblyAI upload failed');
  }

  const submit = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: uploadJson.upload_url,
      language_detection: true,
      punctuate: true,
      format_text: true,
    }),
  });
  const submitted = await submit.json();
  if (!submit.ok || !submitted.id) {
    throw new Error(submitted.error ?? 'AssemblyAI transcript submit failed');
  }

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(3000);
    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${submitted.id}`, {
      headers: { authorization: apiKey },
    });
    const transcript = await poll.json();
    if (transcript.status === 'completed' && transcript.text) {
      await rm(audioPath, { force: true });
      return { text: transcript.text, source: `assemblyai:${submitted.id}` };
    }
    if (transcript.status === 'error') {
      throw new Error(transcript.error ?? 'AssemblyAI transcription failed');
    }
  }

  throw new Error('AssemblyAI transcription timed out');
}

async function existingAudioPath(videoId) {
  const entries = await readdir(runDir);
  const candidates = entries.filter(
    (entry) =>
      entry.startsWith(`${videoId}.`) &&
      !entry.endsWith('.json') &&
      !entry.endsWith('.vtt'),
  ).sort((left, right) => audioPreference(left) - audioPreference(right));
  for (const candidate of candidates) {
    const fullPath = join(runDir, candidate);
    const info = await stat(fullPath);
    if (info.size > 1024) {
      return fullPath;
    }
  }
  return null;
}

function audioPreference(fileName) {
  if (fileName.endsWith('.webm')) {
    return 0;
  }
  if (fileName.endsWith('.m4a')) {
    return 1;
  }
  return 2;
}

async function postJson(url, payload) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(
        `Worker update failed: ${response.status} ${await response.text()}`,
      );
    } catch (error) {
      lastError = error;
    }
    await sleep(1500 * attempt);
  }
  throw lastError;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readXml(xml, tag) {
  const escapedTag = tag.replace(':', '\\:');
  const match = xml.match(new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`));
  return match?.[1]?.trim() ?? '';
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
