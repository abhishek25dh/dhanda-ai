import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteTranscriptWithOpenRouter } from './rewrite-utils.mjs';

const rootDir = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runDir = resolve(rootDir, 'runs', 'transcripts');
const apiBase = process.env.DHANDA_API_BASE;
const adminKey = process.env.DHANDA_ADMIN_API_KEY;
const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL ?? 'openai/gpt-oss-120b:free';
const ids = process.argv.slice(2);

if (!apiKey) {
  throw new Error('OPENROUTER_API_KEY is required');
}
if (ids.length === 0) {
  throw new Error('Pass one or more video IDs');
}

for (const id of ids) {
  const path = join(runDir, `${id}.json`);
  const payload = JSON.parse(await readFile(path, 'utf8'));
  if (payload.rewrittenScript?.length >= 10000) {
    console.log(`skipped ${id}; already ${payload.rewrittenScript.length}`);
  } else {
    console.log(`expanding ${id} from ${payload.rewrittenScript?.length ?? 0}`);
    payload.rewrittenScript = await rewriteTranscriptWithOpenRouter({
      apiKey,
      model,
      title: payload.title,
      transcript:
        `${payload.rewrittenScript ?? ''}\n\nOriginal transcript for missing details:\n${payload.transcript}`,
      targetChars: 10500,
      maxTargetChars: 13500,
      chunkSize: 9000,
    });
    payload.rewriteModel = model;
    payload.rewrittenAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
  }

  if (apiBase && adminKey) {
    await postJson(`${apiBase.replace(/\/$/, '')}/admin/videos/upsert`, payload);
    console.log(`uploaded ${id}; ${payload.rewrittenScript.length}`);
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Worker update failed: ${response.status} ${await response.text()}`);
  }
}
