// Streaming chat client for the side panel. Calls the provider directly with the
// user's own key: Anthropic Messages API (default) or any OpenAI-compatible endpoint.
(function () {
  "use strict";
  const Y = globalThis.YTS;

  // Models that accept server-side refusal fallbacks ("default" routing).
  const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

  function systemPrompt(video, transcript) {
    return [
      "You help the user understand and reuse a video through its transcript.",
      "Each transcript line starts with a [m:ss] or [h:mm:ss] timestamp.",
      "When you refer to a specific moment, cite its timestamp in square brackets exactly as it appears, e.g. [4:05], so the user can click to jump there.",
      "Ground every claim in the transcript; say so when the transcript does not cover something.",
      "Reply in the language the user writes in unless they ask for another. Use Markdown headings, lists and bold sparingly for scannability.",
      "",
      `Video title: ${video.title || "(untitled)"}`,
      `Video URL: ${video.url}`,
      "",
      "<transcript>",
      transcript,
      "</transcript>",
    ].join("\n");
  }

  async function* sseEvents(response, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      if (signal && signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let event = "message";
        const data = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  }

  async function failure(res) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.message || JSON.stringify(body);
    } catch {
      detail = res.statusText;
    }
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    return err;
  }

  async function streamAnthropic(ai, system, messages, onText, signal) {
    const headers = {
      "content-type": "application/json",
      "x-api-key": ai.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    const body = {
      model: ai.model,
      max_tokens: 32000,
      stream: true,
      // The transcript is resent every turn; caching the system block makes follow-ups cheap.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (ai.effort) body.output_config = { effort: ai.effort };
    if (FALLBACK_MODELS.has(ai.model)) {
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
      body.fallbacks = "default";
    }
    const base = (ai.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    const res = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw await failure(res);
    let stop = "";
    for await (const { event, data } of sseEvents(res, signal)) {
      if (event === "error") throw new Error(JSON.parse(data)?.error?.message || "stream error");
      if (event === "content_block_delta") {
        const delta = JSON.parse(data).delta;
        if (delta && delta.type === "text_delta") onText(delta.text);
      } else if (event === "message_delta") {
        stop = JSON.parse(data)?.delta?.stop_reason || stop;
      }
    }
    return { stop };
  }

  async function streamOpenAI(ai, system, messages, onText, signal) {
    const base = ai.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({
        model: ai.model,
        stream: true,
        messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
      }),
      signal,
    });
    if (!res.ok) throw await failure(res);
    let stop = "";
    for await (const { data } of sseEvents(res, signal)) {
      if (data === "[DONE]") break;
      const choice = JSON.parse(data)?.choices?.[0];
      if (choice?.delta?.content) onText(choice.delta.content);
      if (choice?.finish_reason) stop = choice.finish_reason;
    }
    return { stop };
  }

  // messages: [{role: "user"|"assistant", content}]; resolves when the stream ends.
  async function streamChat({ ai, video, segments, messages, onText, signal }) {
    if (!ai.apiKey) {
      const err = new Error("missing key");
      err.code = "no_key";
      throw err;
    }
    const system = systemPrompt(video, Y.transcriptForModel(segments));
    if (ai.provider === "openai") return streamOpenAI(ai, system, messages, onText, signal);
    return streamAnthropic(ai, system, messages, onText, signal);
  }

  Y.ai = { streamChat };
})();
