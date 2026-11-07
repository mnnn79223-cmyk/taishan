const NOTE_HOSTS = new Set(["www.xiaohongshu.com", "xiaohongshu.com", "www.rednote.com", "rednote.com"]);
const PAGE_HOSTS = new Set([...NOTE_HOSTS, "xhslink.com", "www.xhslink.com"]);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export class ParseError extends Error {
  constructor(message, code = "PARSE_FAILED", sourceUrl = "") {
    super(message);
    this.name = "ParseError";
    this.code = code;
    this.sourceUrl = sourceUrl;
  }
}

export function extractLink(text) {
  if (typeof text !== "string" || text.length > 10000) throw new Error("请粘贴完整的小红书分享链接或分享文案。");
  const matches = text.match(/https?:\/\/[^\s<>"'，。；）]+/g) || [];
  for (const match of matches) {
    try {
      const url = new URL(match);
      if (PAGE_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port) {
        url.protocol = "https:";
        url.hash = "";
        if (NOTE_HOSTS.has(url.hostname) && !/^\/(explore|discovery\/item)\/[a-f0-9]{24}(?:\/|$)/i.test(url.pathname)) continue;
        return url.href;
      }
    } catch {}
  }
  throw new Error("未找到有效的笔记链接。请使用小红书的“分享 → 复制链接”，并粘贴完整内容。");
}

export function mediaUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (!(url.hostname.endsWith(".xhscdn.com") || url.hostname.endsWith(".rednotecdn.com") || url.hostname === "ci.xiaohongshu.com")) return null;
    url.protocol = "https:";
    return url.href;
  } catch { return null; }
}

export async function checkedFetch(value, mode = "page", options = {}) {
  let url = value;
  for (let hop = 0; hop < 6; hop++) {
    const parsed = new URL(url);
    if (mode === "page" ? !PAGE_HOSTS.has(parsed.hostname) : !mediaUrl(url)) throw new Error("链接跳转到不支持的地址。");
    const referer = parsed.hostname === "rednote.com" || parsed.hostname === "www.rednote.com" || parsed.hostname.endsWith(".rednotecdn.com") ? "https://www.rednote.com/" : "https://www.xiaohongshu.com/";
    const response = await fetch(url, { ...options, redirect: "manual", signal: options.signal || AbortSignal.timeout(20000), headers: { "User-Agent": UA, "Referer": referer, ...options.headers } });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location"), url);
      if (!["https:", "http:"].includes(next.protocol) || next.username || next.password || next.port) throw new Error("不支持此跳转地址。");
      next.protocol = "https:"; url = next.href; continue;
    }
    return { response, url };
  }
  throw new Error("分享链接跳转次数过多，请重新复制笔记链接。");
}

export async function readLimited(response, limit = 5 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("无法读取笔记内容。");
  const decoder = new TextDecoder(); let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("笔记内容过大，请换一个链接重试。");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}

// Parse serialized data only; never execute JavaScript from a remote page.
export function initialState(html) {
  const marker = /(?:window\.)?__INITIAL_STATE__\s*=\s*/g.exec(html);
  if (!marker) throw new Error("小红书未返回可解析的笔记数据，可能要求登录或验证。请重新复制完整分享链接后重试。");
  const start = marker.index + marker[0].length;
  if (html[start] !== "{") throw new Error("笔记数据格式暂不支持。");
  let depth = 0, quoted = false, escaped = false, json = "";
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      json += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (html.slice(i, i + 9) === "undefined" && !/[\w$]/.test(html[i - 1] || "") && !/[\w$]/.test(html[i + 9] || "")) { json += "null"; i += 8; }
    else json += char;
    if (!depth) {
      try { return JSON.parse(json); } catch { throw new Error("笔记数据格式已变化，暂时无法解析。"); }
    }
  }
  throw new Error("笔记数据不完整。");
}

// Live photos carry their own video streams on each image, not on note.video.
function liveMotion(image) {
  const streams = Object.values(image.stream || {}).flat().filter(stream =>
    stream && mediaUrl(stream.masterUrl) &&
    !/\.m3u8(?:\?|$)/i.test(stream.masterUrl) &&
    (!stream.format || /^(mp4|mov)$/i.test(stream.format))
  );
  streams.sort((a, b) => {
    const compatible = stream => /h264|avc/i.test(String(stream.videoCodec || "")) ? 1 : 0;
    return compatible(b) - compatible(a) || (b.height || 0) - (a.height || 0) || (b.avgBitrate || 0) - (a.avgBitrate || 0);
  });
  const stream = streams[0];
  if (!stream) return null;
  return {
    url: mediaUrl(stream.masterUrl),
    alternatives: (Array.isArray(stream.backupUrls) ? stream.backupUrls : []).map(mediaUrl).filter(Boolean).slice(0, 2),
    width: stream.width, height: stream.height,
    duration: Number.isFinite(stream.duration) ? stream.duration / 1000 : undefined,
  };
}

export function resourceData(state, pageUrl) {
  const id = new URL(pageUrl).pathname.match(/(?:explore|discovery\/item)\/([a-f0-9]{24})/i)?.[1];
  const map = state?.note?.noteDetailMap || {};
  const mobileNote = state?.noteData?.data?.noteData;
  const note = map[id]?.note || (mobileNote?.noteId === id ? mobileNote : undefined);
  if (!note) throw new Error("没有找到笔记内容，笔记可能已删除或不可公开访问。");
  const items = [];
  if (note.type === "video") {
    const streams = Object.values(note.video?.media?.stream || {}).flat().filter(s => s && mediaUrl(s.masterUrl) && !/\.m3u8(?:\?|$)/i.test(s.masterUrl)).sort((a,b) => (b.height || 0) - (a.height || 0));
    const playable = streams.filter(s => !s.videoCodec || /h264|avc/i.test(String(s.videoCodec)));
    const stream = playable[0] || streams[0];
    const key = note.video?.consumer?.originVideoKey;
    if (typeof key === "string" && /^[a-zA-Z0-9_./-]+$/.test(key)) {
      items.push({ type: "video", url: mediaUrl("https://sns-video-bd.xhscdn.com/" + key), preview: mediaUrl(stream?.masterUrl), alternatives: [mediaUrl("https://sns-video-qc.xhscdn.com/" + key)], label: "无平台水印原视频", original: true, width: stream?.width, height: stream?.height });
    } else {
      if (stream) items.push({ type: "video", url: mediaUrl(stream.masterUrl), alternatives: (stream.backupUrls || []).map(mediaUrl).filter(Boolean).slice(0,2), label: "视频 " + (stream.height ? stream.height + "p" : ""), original: false, width: stream.width, height: stream.height });
    }
  } else {
    for (const [index, image] of (note.imageList || []).slice(0, 100).entries()) {
      const preview = mediaUrl(image.urlDefault || image.url);
      const raw = preview?.match(/\/\d+\/[a-z0-9]+\/(.+?)(?:!|\?|$)/i)?.[1];
      const key = raw || image.fileId;
      const original = typeof key === "string" && /^[a-zA-Z0-9_./-]+$/.test(key) ? mediaUrl("https://ci.xiaohongshu.com/" + key + "?imageView2/format/jpeg") : null;
      const motion = liveMotion(image);
      const live = image.livePhoto === true || image.livePhoto === 1 || !!motion;
      if (original || preview || motion) items.push({
        type: live ? "live" : "image", url: original || preview || motion.url,
        preview, original: !!original, label: (live ? "Live 图 " : "图片 ") + (index + 1),
        width: image.width, height: image.height,
        ...(live ? { still: original || preview, motion } : {}),
      });
    }
  }
  const valid = items.filter(item => item.url);
  if (!valid.length) throw new Error("笔记中没有找到可下载的图片或视频。");
  return { title: String(note.title || "小红书笔记").slice(0, 200), author: String(note.user?.nickname || note.user?.nickName || "").slice(0, 100), pageUrl, items: valid, warning: (valid.some(item => !item.original) ? "部分资源仅提供网页版本，可能带有平台水印；原作者嵌入的水印也会保留。" : "提取平台提供的原始媒体文件；原作者嵌入画面的水印会保留。") + (valid.some(item => item.type === "live" && !item.motion) ? " 部分 Live 图未返回动态资源，目前只能保存静态图片。" : "") };
}

export async function parseLink(text) {
  const link = extractLink(text);
  const candidates = [link];
  const signal = AbortSignal.timeout(25000);
  let sawLogin = false;
  const diagnostics = [];
  function addPublicVariants(value) {
    let source;
    try {
      source = new URL(value);
      if (/^\/(?:login|website-login)(?:\/|$)/i.test(source.pathname)) {
        source = new URL(extractLink(source.searchParams.get("redirectPath") || ""));
      }
      if (!NOTE_HOSTS.has(source.hostname)) return;
      const id = source.pathname.match(/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i)?.[1];
      if (!id) return;
      source.pathname = "/discovery/item/" + id;
      // Desktop-only share hints can select a login-gated rendering even for a public note.
      source.searchParams.delete("xhsshare");
      source.searchParams.delete("source");
      for (const host of [source.hostname, source.hostname.includes("rednote") ? "www.xiaohongshu.com" : "www.rednote.com"]) {
        source.hostname = host;
        const candidate = extractLink(source.href);
        if (!candidates.includes(candidate)) candidates.push(candidate);
      }
    } catch {}
  }
  addPublicVariants(link);
  // Public desktop shares can select a different rendering than mobile shares.
  // Keep the original signed query intact for a desktop fallback.
  const attempts = [];
  for (let index = 0; index < 6; index++) {
    if (index < 3 && index >= candidates.length) continue;
    let candidate = candidates[index];
    const desktop = index >= 3;
    if (desktop) {
      const source = candidates[index - 3];
      if (!source) continue;
      const parsed = new URL(source);
      if (NOTE_HOSTS.has(parsed.hostname)) parsed.pathname = parsed.pathname.replace('/discovery/item/', '/explore/');
      candidate = parsed.href;
    }
    if (attempts.includes(candidate + desktop)) continue;
    attempts.push(candidate + desktop);
    try {
      const { response, url } = await checkedFetch(candidate, "page", {signal,headers:{"User-Agent":desktop ? UA : MOBILE_UA,"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Accept-Language":"zh-CN,zh;q=0.9,en;q=0.5"}});
      addPublicVariants(url);
      const diagnostic = {client:desktop ? 'desktop' : 'mobile',host:new URL(url).hostname,status:response.status,result:'no_data'};
      diagnostics.push(diagnostic);
      if (/^\/(?:login|website-login)(?:\/|$)/i.test(new URL(url).pathname)) {
        diagnostic.result = 'login_redirect';
        sawLogin = true; await response.body?.cancel(); continue;
      }
      if (!response.ok) { await response.body?.cancel(); continue; }
      const html = await readLimited(response);
      const result = resourceData(initialState(html), url);
      diagnostic.result = 'success';
      console.info('xhs_parse', JSON.stringify(diagnostics));
      return result;
    } catch (error) {
      if (signal.aborted) break;
      // Only try other documented public page forms; do not forward login cookies.
      if (error instanceof Error && /跳转到不支持|不支持此跳转/.test(error.message)) throw error;
    }
  }
  // Never log the share URL, query token, HTML, or media URLs.
  console.warn('xhs_parse', JSON.stringify(diagnostics));
  throw new ParseError(
    sawLogin ? "小红书本次返回了登录页面，暂时没有获取到笔记媒体。请稍后重试，或从小红书 App 重新复制分享链接。" : "小红书本次没有返回笔记媒体，可能要求登录或验证。请稍后重试，或从 App 重新复制分享链接。",
    "UPSTREAM_UNAVAILABLE", link);
}
