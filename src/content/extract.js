// Transcript retrieval for the current YouTube page. Runs in the content-script world;
// page-JS values (live player response, PoToken) come from the background via MAIN-world calls.
(function () {
  "use strict";
  const Y = globalThis.YTS;

  class TranscriptError extends Error {
    constructor(code, detail = "") {
      super(code);
      this.code = code;
      this.detail = String(detail || "");
    }
  }

  const MOBILE_CLIENTS = [
    {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      androidSdkVersion: 35,
      osName: "Android",
      osVersion: "15",
    },
    {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iOS",
      osVersion: "18.3.2",
    },
  ];

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchWithTimeout(url, init = {}, ms = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { credentials: "include", ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function playabilityError(player) {
    const ps = player && player.playabilityStatus;
    if (!ps) return null;
    const status = String(ps.status || "").toUpperCase();
    const reason = [ps.reason, Y.runsText(ps.errorScreen?.playerErrorMessageRenderer?.reason)]
      .filter(Boolean)
      .join(" ");
    const live = player.videoDetails?.isLive || player.videoDetails?.isLiveContent;
    if (live && player.videoDetails?.isLive) return new TranscriptError("live", reason);
    if (!status || status === "OK") return null;
    if (status === "LOGIN_REQUIRED" || /sign in|private|members|age/i.test(reason))
      return new TranscriptError("restricted", reason || status);
    if (status === "LIVE_STREAM_OFFLINE") return new TranscriptError("live", reason || status);
    if (status === "UNPLAYABLE" || status === "ERROR")
      return new TranscriptError("unavailable", reason || status);
    return null;
  }

  async function pageContext(videoId) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "yts:pageContext", videoId });
      return res && res.ok ? res.context : null;
    } catch {
      return null;
    }
  }

  async function capturePoToken(videoId) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "yts:poToken", videoId });
      return (res && res.pot) || "";
    } catch {
      return "";
    }
  }

  async function fetchWatchPage(videoId) {
    let res;
    try {
      res = await fetchWithTimeout(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`);
    } catch (e) {
      throw new TranscriptError("network", e.message);
    }
    if (!res.ok) throw new TranscriptError(res.status === 403 ? "restricted" : "network", `HTTP ${res.status}`);
    const html = await res.text();
    return {
      player: Y.extractJsonAssignment(html, "ytInitialPlayerResponse"),
      initialData: Y.extractJsonAssignment(html, "ytInitialData"),
      cfg: {
        apiKey: (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || "",
        clientVersion: (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || "",
        visitorData: (html.match(/"VISITOR_DATA":"([^"]+)"/) || [])[1] || "",
        hl: (html.match(/"HL":"([^"]+)"/) || [])[1] || "en",
      },
    };
  }

  async function timedText(baseUrl, pot) {
    const url = new URL(baseUrl, location.origin);
    url.searchParams.set("fmt", "json3");
    if (pot) {
      url.searchParams.set("pot", pot);
      url.searchParams.set("c", "WEB");
    }
    let res;
    try {
      res = await fetchWithTimeout(url.toString());
    } catch {
      return { segments: [], status: 0 };
    }
    if (!res.ok) return { segments: [], status: res.status };
    const body = await res.text();
    if (!body.trim()) return { segments: [], status: res.status };
    try {
      return { segments: Y.segmentsFromJson3(JSON.parse(body)), status: res.status };
    } catch {
      return { segments: [], status: res.status };
    }
  }

  async function mobilePlayerTracks(videoId, apiKey) {
    for (const client of MOBILE_CLIENTS) {
      try {
        const keyParam = apiKey ? `key=${encodeURIComponent(apiKey)}&` : "";
        const res = await fetchWithTimeout(`/youtubei/v1/player?${keyParam}prettyPrint=false`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context: { client: { ...client, hl: "en", gl: "US" } },
            videoId,
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        });
        if (!res.ok) continue;
        const json = await res.json();
        const tracks = Y.normalizeTracks(json?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
        if (tracks.length) return tracks;
      } catch {
        /* try next client */
      }
    }
    return [];
  }

  function transcriptParams(initialData) {
    for (const panel of initialData?.engagementPanels || []) {
      const params =
        panel.engagementPanelSectionListRenderer?.content?.continuationItemRenderer?.continuationEndpoint
          ?.getTranscriptEndpoint?.params;
      if (params) return params;
    }
    return "";
  }

  async function transcriptEndpoint(params, cfg) {
    if (!params) return [];
    try {
      const keyParam = cfg.apiKey ? `key=${encodeURIComponent(cfg.apiKey)}&` : "";
      const res = await fetchWithTimeout(`/youtubei/v1/get_transcript?${keyParam}prettyPrint=false`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: cfg.clientVersion || "2.20260101.00.00",
              hl: cfg.hl || "en",
              visitorData: cfg.visitorData || undefined,
            },
          },
          params,
        }),
      });
      if (!res.ok) return [];
      const json = await res.json();
      const list =
        json?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content
          ?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments || [];
      return list
        .map((item) => item.transcriptSegmentRenderer)
        .filter(Boolean)
        .map((r) => ({ start: Number(r.startMs) || 0, text: Y.cleanText(Y.runsText(r.snippet)) }))
        .filter((s) => s.text);
    } catch {
      return [];
    }
  }

  // Last resort: open YouTube's own transcript panel and read it from the DOM.
  async function transcriptFromPanel() {
    const opener = document.querySelector(
      "ytd-video-description-transcript-section-renderer button, button[aria-label='Show transcript']",
    );
    if (!opener) return [];
    opener.click();
    const selector = "ytd-transcript-segment-renderer, transcript-segment-view-model";
    for (let i = 0; i < 30 && !document.querySelector(selector); i++) await wait(150);
    await wait(250);
    return [...document.querySelectorAll(selector)]
      .map((row) => {
        const stamp = row.querySelector(".segment-timestamp, [class*='timestamp']")?.textContent || "";
        const text = row.querySelector("yt-formatted-string.segment-text, .segment-text, [role='text']")
          ?.textContent;
        const seconds = Y.parseTimestamp(stamp);
        return { start: Number.isFinite(seconds) ? seconds * 1000 : 0, text: Y.cleanText(text) };
      })
      .filter((s) => s.text);
  }

  async function resolvePlayer(videoId) {
    const ctx = await pageContext(videoId);
    if (ctx && ctx.player && ctx.player.videoDetails?.videoId === videoId) {
      return { player: ctx.player, cfg: ctx.cfg, initialData: null, fromPage: true };
    }
    const page = await fetchWatchPage(videoId);
    return { ...page, cfg: { ...(ctx?.cfg || {}), ...page.cfg }, fromPage: false };
  }

  async function loadTranscript(videoId, preferredLanguage) {
    const state = await resolvePlayer(videoId);
    const player = state.player;
    if (!player) throw new TranscriptError("network", "player response missing");
    const blocked = playabilityError(player);
    if (blocked) throw blocked;

    const title = player.videoDetails?.title || "";
    let tracks = Y.normalizeTracks(player.captions?.playerCaptionsTracklistRenderer?.captionTracks);
    const langs = [...(navigator.languages || [navigator.language])];
    let track = Y.chooseTrack(tracks, preferredLanguage, langs);
    const result = (segments, source, t = track) => ({ videoId, title, segments, source, track: t, tracks });

    let lastStatus = 0;
    if (track) {
      const direct = await timedText(track.baseUrl);
      if (direct.segments.length) return result(direct.segments, "timedtext");
      lastStatus = direct.status;
      const pot = await capturePoToken(videoId);
      if (pot) {
        const withPot = await timedText(track.baseUrl, pot);
        if (withPot.segments.length) return result(withPot.segments, "timedtext+pot");
        lastStatus = withPot.status || lastStatus;
      }
    }

    const mobileTracks = await mobilePlayerTracks(videoId, state.cfg?.apiKey);
    if (mobileTracks.length) {
      const mTrack = Y.chooseTrack(mobileTracks, preferredLanguage, langs);
      const viaMobile = await timedText(mTrack.baseUrl);
      if (viaMobile.segments.length) {
        if (!tracks.length) tracks = mobileTracks;
        return result(viaMobile.segments, "mobile-player", mTrack);
      }
    }

    let initialData = state.initialData;
    if (!initialData) initialData = (await fetchWatchPage(videoId).catch(() => ({}))).initialData;
    const fromEndpoint = await transcriptEndpoint(transcriptParams(initialData), state.cfg || {});
    if (fromEndpoint.length) return result(fromEndpoint, "get_transcript", null);

    if (Y.videoIdFromUrl(location.href) === videoId) {
      const fromPanel = await transcriptFromPanel();
      if (fromPanel.length) return result(fromPanel, "panel", null);
    }

    if (lastStatus === 429) throw new TranscriptError("rate_limited", "timedtext HTTP 429");
    if (player.videoDetails?.isLive) throw new TranscriptError("live");
    throw new TranscriptError(Y.isShortsUrl(location.href) ? "no_captions_short" : "no_captions");
  }

  const cache = new Map();
  const CACHE_MS = 5 * 60 * 1000;

  async function getTranscript(videoId, preferredLanguage = "") {
    const key = `${videoId}|${preferredLanguage}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const data = await loadTranscript(videoId, preferredLanguage);
    cache.set(key, { at: Date.now(), data });
    return data;
  }

  async function listTracks(videoId) {
    const state = await resolvePlayer(videoId);
    let tracks = Y.normalizeTracks(state.player?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
    if (!tracks.length) tracks = await mobilePlayerTracks(videoId, state.cfg?.apiKey);
    return tracks;
  }

  globalThis.YTS.extract = { getTranscript, listTracks, TranscriptError };
})();
