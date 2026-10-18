// Bilibili subtitle retrieval. Runs in the content script on www.bilibili.com so requests to
// api.bilibili.com carry the user's login cookies — Bilibili only serves subtitles to signed-in users.
(function () {
  "use strict";
  const Y = globalThis.YTS;
  const { TranscriptError } = Y.extract;
  const API = "https://api.bilibili.com";

  async function getJson(url, { credentials = "include", ms = 10000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    let res;
    try {
      res = await fetch(url, { credentials, signal: ctrl.signal });
    } catch (e) {
      throw new TranscriptError("network", e.message);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new TranscriptError(res.status === 412 ? "rate_limited" : "network", `HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new TranscriptError("network", "invalid JSON");
    }
  }

  // ref -> {bvid, aid, cid, title}
  async function resolveVideo(ref) {
    if (ref.ep) {
      const json = await getJson(`${API}/pgc/view/web/season?ep_id=${ref.ep}`);
      const season = json.result;
      const episodes = [...(season?.episodes || []), ...(season?.section || []).flatMap((s) => s.episodes || [])];
      const ep = episodes.find((e) => String(e.ep_id ?? e.id) === ref.ep);
      if (!ep) throw new TranscriptError(json.code === -404 ? "unavailable" : "network", json.message);
      const label = [ep.show_title || ep.title, ep.long_title].filter(Boolean).join(" ");
      return { bvid: ep.bvid, aid: ep.aid, cid: ep.cid, title: [season.season_title || season.title, label].filter(Boolean).join(" · ") };
    }
    const query = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`;
    const json = await getJson(`${API}/x/web-interface/view?${query}`);
    if (json.code !== 0) {
      throw new TranscriptError([-404, 62002, 62004].includes(json.code) ? "unavailable" : json.code === -403 ? "restricted" : "network", json.message);
    }
    const data = json.data;
    const pages = data.pages || [];
    const page = pages[ref.p - 1] || pages[0] || { cid: data.cid };
    const title = pages.length > 1 && page.part ? `${data.title} · P${page.page} ${page.part}` : data.title;
    return { bvid: data.bvid, aid: data.aid, cid: page.cid, title };
  }

  let wbiCache = null;
  async function wbiKeys() {
    if (wbiCache && Date.now() - wbiCache.at < 30 * 60 * 1000) return wbiCache;
    const nav = await getJson(`${API}/x/web-interface/nav`);
    const img = nav?.data?.wbi_img;
    wbiCache = {
      at: Date.now(),
      img: Y.wbiKeyFromUrl(img?.img_url),
      sub: Y.wbiKeyFromUrl(img?.sub_url),
      loggedIn: Boolean(nav?.data?.isLogin),
    };
    return wbiCache;
  }

  async function playerInfo(video) {
    const keys = await wbiKeys();
    const params = video.bvid ? { bvid: video.bvid, cid: video.cid } : { aid: video.aid, cid: video.cid };
    let data = null;
    if (keys.img && keys.sub) {
      try {
        const json = await getJson(`${API}/x/player/wbi/v2?${Y.signWbi(params, keys.img, keys.sub, Math.floor(Date.now() / 1000))}`);
        if (json.code === 0) data = json.data;
      } catch {
        /* fall through to the unsigned endpoint */
      }
    }
    if (!data) {
      const json = await getJson(`${API}/x/player/v2?${new URLSearchParams(params)}`);
      if (json.code !== 0) throw new TranscriptError("network", json.message);
      data = json.data;
    }
    return { data, loggedIn: keys.loggedIn };
  }

  async function tracksFor(video) {
    const { data, loggedIn } = await playerInfo(video);
    const tracks = Y.normalizeBilibiliTracks(data?.subtitle?.subtitles);
    return { tracks, needLogin: !loggedIn && (data?.need_login_subtitle || !tracks.length) };
  }

  async function getTranscript(ref, preferredLanguage = "") {
    const video = await resolveVideo(ref);
    const { tracks, needLogin } = await tracksFor(video);
    if (!tracks.length) throw new TranscriptError(needLogin ? "login_needed" : "no_captions");
    // Automatic mode keeps the original language: Bilibili lists it first, and its other AI
    // tracks are machine translations of it. Uploader (non-AI) tracks still win.
    const track = preferredLanguage ? Y.chooseTrack(tracks, preferredLanguage, []) : Y.rankTracks(tracks)[0];
    const payload = await getJson(track.baseUrl, { credentials: "omit" });
    const segments = Y.segmentsFromBilibili(payload);
    if (!segments.length) throw new TranscriptError("no_captions");
    return { videoId: ref.key, title: video.title, segments, source: "bilibili", track, tracks };
  }

  async function listTracks(ref) {
    return (await tracksFor(await resolveVideo(ref))).tracks;
  }

  Y.extractBilibili = { getTranscript, listTracks };
})();
