# Dhanda AI

Dhanda AI is an Android-first app for turning selected YouTube channel uploads into ready-to-record Hindi/English scripts.

The project is split into two parts:

- `mobile/` - Flutter Android app.
- `backend/` - Cloudflare Worker API for channel polling, script preparation, and audio uploads.

## Current Flow

1. Backend watches hard-coded YouTube channels using the channel RSS feed:
   `https://www.youtube.com/feeds/videos.xml?channel_id=<CHANNEL_ID>`
2. `My Marathi` is configured as the first source. The seed videos are the current latest two videos from June 21, 2026, and newer videos from that date onward are eligible.
3. The transcript processor extracts high-quality audio with `yt-dlp`/`ffmpeg`, uploads it to AssemblyAI, and stores that transcript as the single source of truth.
4. OpenRouter can rewrite the transcript when `OPENROUTER_API_KEY` is configured.
5. The app opens with ready scripts, lets the user record one or more audio parts, plays saved parts locally, stitches all parts in recording order, uploads one final audio file, and stores the generated download link on the phone.

## App

```powershell
cd mobile
flutter pub get
flutter run
```

Set your deployed API URL in `mobile/lib/main.dart` by changing `ApiClient.baseUrl`.

## Backend

```powershell
cd backend
npm install
npm run typecheck
npm run deploy
```

Configure secrets before deploying:

```powershell
wrangler secret put ASSEMBLYAI_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put ADMIN_API_KEY
```

Run the AssemblyAI processor:

```powershell
cd backend
$env:ASSEMBLYAI_API_KEY="your-key"
$env:DHANDA_API_BASE="https://your-worker-url"
$env:DHANDA_ADMIN_API_KEY="your-admin-key"
npm run process:channel
```

If `DHANDA_API_BASE` is not set, the processor writes transcript JSON files under `runs/transcripts/`.
