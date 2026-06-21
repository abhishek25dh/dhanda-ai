import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRewriteModels, evaluateRewriteModel } from './rewrite-utils.mjs';

const rootDir = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const runDir = resolve(rootDir, 'runs', 'rewrite-evals');
const transcriptPath =
  process.argv[2] ?? join(rootDir, 'runs', 'transcripts', '55p8qD_9_p8.json');
const apiKey = process.env.OPENROUTER_API_KEY;
const models = (process.env.OPENROUTER_MODELS?.split(',') ?? defaultRewriteModels)
  .map((model) => model.trim())
  .filter(Boolean);

if (!apiKey) {
  throw new Error('OPENROUTER_API_KEY is required');
}

await mkdir(runDir, { recursive: true });
const payload = JSON.parse(await readFile(transcriptPath, 'utf8'));
const results = [];

for (const model of models) {
  try {
    console.log(`evaluating ${model}`);
    const result = await evaluateRewriteModel({
      apiKey,
      model,
      title: payload.title,
      transcript: payload.transcript,
    });
    results.push(result);
    await writeFile(
      join(runDir, `${safeName(model)}.txt`),
      result.text,
      'utf8',
    );
  } catch (error) {
    results.push({
      model,
      error: error instanceof Error ? error.message : String(error),
      score: -1,
      chars: 0,
      seconds: 0,
    });
  }
}

results.sort((left, right) => right.score - left.score || right.chars - left.chars);
await writeFile(
  join(runDir, 'results.json'),
  JSON.stringify(results.map(({ text, ...rest }) => rest), null, 2),
  'utf8',
);

console.log(JSON.stringify(results.map(({ text, ...rest }) => rest), null, 2));

function safeName(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}
