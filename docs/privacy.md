---
title: Scribe privacy policy
---

# Scribe privacy policy

Last updated: 2026-10-18

Scribe is a browser extension that copies, exports and lets you chat with the transcripts of
YouTube and Bilibili videos. It has no server of its own, no accounts, no analytics and no ads.
The developer receives no data from it.

## What the extension reads

- **Video pages you open on youtube.com and bilibili.com.** When you use Scribe on a video, it
  reads the video's title, address and caption tracks from the site so it can show and copy the
  transcript. Caption requests go to YouTube or Bilibili, the same way the site's own player
  fetches them.
- **Your existing Bilibili sign-in.** Bilibili only serves subtitles to signed-in users, so caption
  requests on bilibili.com are sent from the page with the cookies your browser already has for
  that site. Scribe does not read, copy or store those cookies.

## What is stored, and where

| Data | Where | Why |
|---|---|---|
| Settings and presets | Chrome sync storage (synced by Chrome to your Google account if Chrome sync is on) | Remember your format and button choices |
| History: video title, address, transcript, chat messages | Local storage on this device | "Copy again" and re-opening chats; you can delete entries or turn history off |
| AI provider settings, including your API key | Local storage on this device | Call the AI provider you chose |

Removing the extension deletes its local data.

## What is sent elsewhere, and only when you ask

- **AI chat.** When you send a message in the chat panel, Scribe sends the video's title, address,
  transcript and the conversation directly from your browser to the AI provider you configured
  (Anthropic by default, or the OpenAI-compatible endpoint you entered), authenticated with your
  own API key. That provider's privacy policy applies to that request. Nothing is sent until you
  add a key and send a message.
- **Opening an AI site after copying** (off by default) opens the site you picked in a new tab. If
  you set a custom address containing `{transcript}`, the beginning of the transcript is placed in
  that address.

Scribe does not sell or share data, does not use it for advertising or credit decisions, and does
not transfer it for any purpose other than the features above.

## Contact

Questions and requests: <https://github.com/xingfanxia/yt-scribe/issues>
