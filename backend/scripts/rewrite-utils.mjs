const targetStyle = `
You are writing an original Marathi/Hinglish narration script for a YouTube creator.
The input is a raw Marathi episode-review transcript from another narrator.
Rewrite it as our own script, not as a summary.

Rules:
- Keep the same episode events and character relationships.
- Do not copy the narrator's phrasing sentence-for-sentence.
- Write in natural spoken Marathi with simple Hindi/English words only when natural.
- Be direct and to the point, but keep enough detail for a full voiceover.
- Avoid intros like "here is the rewritten script".
- Avoid timestamps, bullets, markdown, asterisks, headings, and meta commentary.
- Make it sound like a human creator narrating the story.
- Preserve names, twists, conflicts, and sequence of events.
`;

export const defaultRewriteModels = [
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-oss-120b:free',
  'google/gemma-4-31b-it:free',
];

export function splitTranscript(text, chunkSize = 5200) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const target = Math.min(cursor + chunkSize, clean.length);
    let end = target;
    if (target < clean.length) {
      const window = clean.slice(cursor, target + 500);
      const sentenceBreak = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('? '),
        window.lastIndexOf('! '),
        window.lastIndexOf('। '),
      );
      if (sentenceBreak > chunkSize * 0.6) {
        end = cursor + sentenceBreak + 1;
      }
    }
    chunks.push(clean.slice(cursor, end).trim());
    cursor = end;
  }
  return chunks.filter(Boolean);
}

export async function rewriteTranscriptWithOpenRouter({
  apiKey,
  model,
  title,
  transcript,
  targetChars = 10000,
  maxTargetChars = 14000,
  chunkSize = 7000,
}) {
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required for rewriting');
  }

  const chunks = splitTranscript(transcript, chunkSize);
  const targetPerChunk = Math.max(1400, Math.ceil(targetChars / chunks.length));
  const rewrittenChunks = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const content = await callOpenRouter({
      apiKey,
      model,
      temperature: 0.55,
      maxTokens: 1500,
      messages: [
        {
          role: 'system',
          content: targetStyle,
        },
        {
          role: 'user',
          content:
            `Video title: ${title}\n` +
            `Part ${index + 1} of ${chunks.length}.\n` +
            `Rewrite this part into ${targetPerChunk} to ${targetPerChunk + 500} Marathi characters. ` +
            `Keep it flowing as the middle of one continuous narration.\n\n` +
            chunks[index],
        },
      ],
    });
    rewrittenChunks.push(cleanModelText(content));
  }

  let script = cleanModelText(rewrittenChunks.join('\n\n'));
  if (script.length < targetChars) {
    script = await expandToTarget({
      apiKey,
      model,
      title,
      script,
      targetChars,
    });
  }
  if (script.length > maxTargetChars) {
    script = await condenseToRange({
      apiKey,
      model,
      title,
      script,
      targetChars,
      maxTargetChars,
    });
  }

  return cleanModelText(script);
}

export async function evaluateRewriteModel({
  apiKey,
  model,
  title,
  transcript,
}) {
  const sample = splitTranscript(transcript, 4200)[0];
  const startedAt = Date.now();
  const output = await callOpenRouter({
    apiKey,
    model,
    temperature: 0.55,
    maxTokens: 1800,
    messages: [
      { role: 'system', content: targetStyle },
      {
        role: 'user',
        content:
          `Video title: ${title}\n` +
          'Rewrite this sample as our own Marathi narration. Keep detail, avoid summary, and make it ready to record.\n\n' +
          sample,
      },
    ],
  });
  const text = cleanModelText(output);
  return {
    model,
    chars: text.length,
    seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    score: scoreRewrite(text),
    text,
  };
}

async function expandToTarget({ apiKey, model, title, script, targetChars }) {
  const missing = targetChars - script.length;
  if (missing <= 0) {
    return script;
  }
  const output = await callOpenRouter({
    apiKey,
    model,
    temperature: 0.5,
    maxTokens: 2200,
    messages: [
      { role: 'system', content: targetStyle },
      {
        role: 'user',
        content:
          `Video title: ${title}\n` +
          `This rewritten script is ${script.length} characters. Expand it by at least ${missing + 800} characters ` +
          'by adding natural narration detail, emotional transitions, and clearer setup. Do not add fake events.\n\n' +
          script,
      },
    ],
  });
  return output;
}

async function condenseToRange({
  apiKey,
  model,
  title,
  script,
  targetChars,
  maxTargetChars,
}) {
  const output = await callOpenRouter({
    apiKey,
    model,
    temperature: 0.45,
    maxTokens: 5200,
    messages: [
      { role: 'system', content: targetStyle },
      {
        role: 'user',
        content:
          `Video title: ${title}\n` +
          `This rewrite is too long at ${script.length} characters. ` +
          `Condense it into one complete Marathi narration between ${targetChars} and ${maxTargetChars} characters. ` +
          'Keep the episode sequence and important twists. Remove repetition, filler, and over-explanation. Do not add fake events.\n\n' +
          script,
      },
    ],
  });
  return output;
}

async function callOpenRouter({
  apiKey,
  model,
  messages,
  temperature = 0.55,
  maxTokens = 2000,
}) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'http-referer': 'https://dhanda.ai',
          'x-title': 'Dhanda AI',
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        lastError = new Error(
          payload.error?.message ?? `OpenRouter failed for ${model}`,
        );
      } else {
        return payload.choices?.[0]?.message?.content ?? '';
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  throw lastError;
}

function cleanModelText(text) {
  return text
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```$/g, '')
    .replace(/\*/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function scoreRewrite(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (text.length >= 1200) score += 2;
  if (text.length >= 1800) score += 1;
  if (!lower.includes('here is') && !text.includes('```')) score += 1;
  if (!/^\s*[-*#]/m.test(text)) score += 1;
  if (/[अ-ह]/.test(text)) score += 3;
  if ((text.match(/[.?!।]/g) ?? []).length >= 12) score += 1;
  if (!lower.includes('summary')) score += 1;
  return score;
}
