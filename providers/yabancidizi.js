/**
 * YabanciDizi — Nuvio provider
 *
 * Kaynak: https://github.com/falsisdev/anthology :: providers/yabancidizi.js
 * Site:   https://yabancidizi.news/
 *
 * Anthology surumu esbuild ciktilari (arrow, generator, globalThis) kullandigi
 * icin birebir kopyalanmadi; ayni akis ES5 + Promise ile yeniden yazildi.
 *
 * Akis:
 *   TMDB baslik -> POST /search?qr= -> /dizi/<slug>/sezon-S/bolum-E
 *   -> VidMoly dl/embed -> file: "...m3u8"
 *
 * Cikti: diger provider'larla ayni sozlesme (getStreams), dil/kalite
 * etiketleri title/name icinde.
 */

var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML like Gecko) Chrome/120.0.0.0 Safari/537.36";
var BASE = "https://yabancidizi.news";
var VIDMOLY = "https://vidmoly.biz";
var TMDB_KEY = "500330721680edb6d5f7f12ba7cd9023";
var NET_TIMEOUT = 8000;

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      if (!done) { done = true; reject(new Error("timeout")); }
    }, ms || NET_TIMEOUT);
    promise.then(function (value) {
      if (!done) { done = true; clearTimeout(timer); resolve(value); }
    }, function (err) {
      if (!done) { done = true; clearTimeout(timer); reject(err); }
    });
  });
}

function request(url, opts) {
  var o = opts || {};
  var headers = { "User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8" };
  var k;
  if (o.headers) for (k in o.headers) headers[k] = o.headers[k];
  return withTimeout(fetch(url, {
    method: o.method || "GET",
    headers: headers,
    body: o.body
  }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    return r.text();
  }));
}

function parseJson(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

function arrayOf(v) {
  return Object.prototype.toString.call(v) === "[object Array]";
}

function has(list, value) {
  for (var i = 0; i < list.length; i++) if (list[i] === value) return true;
  return false;
}

function ultraClean(str) {
  if (!str) return "";
  return String(str).toLowerCase()
    .replace(/[ıİ]/g, "i").replace(/[üÜ]/g, "u").replace(/[öÖ]/g, "o")
    .replace(/[şŞ]/g, "s").replace(/[ğĞ]/g, "g").replace(/[çÇ]/g, "c")
    .replace(/[^a-z0-9]/g, "");
}

function isTv(mediaType) {
  return mediaType === "tv" || mediaType === "series";
}

// ---------------------------------------------------------------- TMDB

function tmdbByNumeric(numericId, tv) {
  var kind = tv ? "tv" : "movie";
  var url = "https://api.themoviedb.org/3/" + kind + "/" + encodeURIComponent(numericId) +
    "?api_key=" + TMDB_KEY + "&language=tr-TR";
  return request(url).then(function (body) {
    var d = parseJson(body) || {};
    return {
      title: d.name || d.title || "",
      origTitle: d.original_name || d.original_title || "",
      numericId: numericId
    };
  }).catch(function () {
    return { title: "", origTitle: "", numericId: numericId };
  });
}

function tmdbInfo(id, mediaType) {
  var raw = String(id || "").trim();
  if (raw.indexOf(":") !== -1) raw = raw.split(":")[0];
  var tv = isTv(mediaType);

  if (raw.indexOf("tt") !== 0) return tmdbByNumeric(raw, tv);

  var findUrl = "https://api.themoviedb.org/3/find/" + encodeURIComponent(raw) +
    "?api_key=" + TMDB_KEY + "&external_source=imdb_id";
  return request(findUrl).then(function (body) {
    var d = parseJson(body) || {};
    var list = tv ? (d.tv_results || []) : (d.movie_results || []);
    var item = list[0];
    if (!item) return { title: "", origTitle: "", numericId: null };
    return {
      title: item.name || item.title || "",
      origTitle: item.original_name || item.original_title || "",
      numericId: item.id
    };
  }).then(function (info) {
    if (info.numericId && (!info.title || !info.origTitle)) {
      return tmdbByNumeric(info.numericId, tv).then(function (extra) {
        return {
          title: info.title || extra.title,
          origTitle: info.origTitle || extra.origTitle,
          numericId: info.numericId
        };
      });
    }
    return info;
  }).catch(function () {
    return { title: "", origTitle: "", numericId: null };
  });
}

// --------------------------------------------------------------- arama

function searchSite(query) {
  var url = BASE + "/search?qr=" + encodeURIComponent(query);
  return request(url, {
    method: "POST",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Referer": BASE + "/"
    }
  }).then(function (body) {
    var d = parseJson(body);
    return (d && d.data && arrayOf(d.data.result)) ? d.data.result : [];
  }).catch(function () { return []; });
}

// Arama JSON donmezse ana sayfadaki dizi kartlarindan sonuc uret.
function homeResults() {
  return request(BASE + "/", { headers: { "Referer": BASE + "/" } }).then(function (html) {
    var re = /<a[^>]+href=["'](?:https?:\/\/[^"'/]+)?\/?dizi\/([^"'/]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    var out = [], seen = {}, m, slug, name;
    while ((m = re.exec(html)) !== null) {
      slug = m[1];
      if (!slug || slug.indexOf("tur/") === 0 || seen[slug]) continue;
      seen[slug] = 1;
      name = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (name) out.push({ s_name: name, s_link: slug });
    }
    return out;
  }).catch(function () { return []; });
}

function pickShow(results, query) {
  var clean = ultraClean(query);
  var i, cleanRow;
  for (i = 0; i < results.length; i++) {
    cleanRow = ultraClean(results[i].s_name);
    if (cleanRow && cleanRow === clean) return results[i];
  }
  for (i = 0; i < results.length; i++) {
    cleanRow = ultraClean(results[i].s_name);
    if (cleanRow && (cleanRow.indexOf(clean) !== -1 || clean.indexOf(cleanRow) !== -1)) return results[i];
  }
  return results.length ? results[0] : null;
}

// --------------------------------------------------------------- akislar

function langFromLabel(label) {
  if (/dublaj/i.test(label)) return "TR Dublaj";
  if (/ingilizce|english/i.test(label)) return "EN Altyazi";
  return "TR Altyazi";
}

function m3u8FromEmbed(embedUrl, lang) {
  return request(embedUrl, { headers: { "Referer": "https://vidmoly.biz/" } }).then(function (html) {
    var m = /file\s*:\s*['"](https?:\/\/[^'"<>]+\.m3u8[^'"<>]*)['"]/i.exec(html);
    if (!m) return null;
    var headers = { "User-Agent": UA, "Referer": "https://vidmoly.biz/", "Accept": "*/*" };
    return {
      name: "YabanciDizi " + lang,
      title: "YabanciDizi [" + lang + " | VidMoly | 1080p]",
      url: m[1],
      quality: "1080p",
      isM3u8: true,
      type: "hls",
      language: "tr",
      provider: "yabancidizi",
      headers: headers,
      subtitles: [],
      _dub: lang === "TR Dublaj",
      _sub: lang !== "TR Dublaj",
      _quality: "1080p"
    };
  }).catch(function () { return null; });
}

function extractStreams(epUrl) {
  return request(epUrl, { headers: { "Referer": BASE + "/" } }).then(function (html) {
    var dlRe = /<a[^>]+href=["'](https?:\/\/vidmoly\.[a-z0-9]+\/dl\/([a-zA-Z0-9_-]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
    var vmRe = /vidmoly\.[a-z0-9]+\/(?:dl\/|embed-)([a-zA-Z0-9_-]+)/gi;
    var ids = [], langs = {}, seenIds = {}, seenUrls = {}, m;

    while ((m = dlRe.exec(html)) !== null) {
      if (seenIds[m[2]]) continue;
      seenIds[m[2]] = 1;
      ids.push(m[2]);
      langs[m[2]] = langFromLabel(m[3].replace(/<[^>]+>/g, ""));
    }
    while ((m = vmRe.exec(html)) !== null) {
      if (seenIds[m[1]]) continue;
      seenIds[m[1]] = 1;
      ids.push(m[1]);
      langs[m[1]] = "TR Altyazi";
    }

    function next(i, out) {
      if (i >= ids.length) return Promise.resolve(out);
      var id = ids[i];
      return m3u8FromEmbed(VIDMOLY + "/embed-" + id + ".html", langs[id]).then(function (stream) {
        if (stream && !seenUrls[stream.url]) {
          seenUrls[stream.url] = 1;
          out.push(stream);
        }
        return next(i + 1, out);
      });
    }
    return next(0, []);
  }).catch(function () { return []; });
}

// ------------------------------------------------------------- getStreams

function getStreams(tmdbId, mediaType, season, episode) {
  var raw = tmdbId;
  if (raw && typeof raw === "object" && raw.id) {
    return getStreams(raw.id, mediaType || raw.type, season || raw.season, episode || raw.episode);
  }

  var id = String(raw || "");
  var s = parseInt(season, 10) || 1;
  var e = parseInt(episode, 10) || 1;

  // Anthology katalog id'leri: yabancidizi:ep:<slug>:<S>:<E> / :show:<slug>
  if (id.indexOf("yabancidizi:ep:") === 0) {
    var parts = id.slice("yabancidizi:ep:".length).split(":");
    return extractStreams(BASE + "/dizi/" + parts[0] + "/sezon-" + (parts[1] || "1") + "/bolum-" + (parts[2] || "1"));
  }
  if (id.indexOf("yabancidizi:show:") === 0) {
    var slug = id.slice("yabancidizi:show:".length);
    return request(BASE + "/dizi/" + slug, { headers: { "Referer": BASE + "/" } }).then(function (html) {
      var m = /sezon-(\d+)\/bolum-(\d+)/i.exec(html);
      var epUrl = m
        ? BASE + "/dizi/" + slug + "/sezon-" + m[1] + "/bolum-" + m[2]
        : BASE + "/dizi/" + slug;
      return extractStreams(epUrl);
    }).catch(function () { return []; });
  }

  return tmdbInfo(id, mediaType).then(function (info) {
    var titles = [];
    if (info.origTitle) titles.push(info.origTitle);
    if (info.title && !has(titles, info.title)) titles.push(info.title);
    if (!titles.length) return [];

    function tryTitle(i) {
      if (i >= titles.length) return Promise.resolve([]);
      var query = titles[i];
      return searchSite(query).then(function (results) {
        return results.length ? results : homeResults();
      }).then(function (results) {
        if (!results.length) return tryTitle(i + 1);
        var show = pickShow(results, query);
        if (!show || !show.s_link) return tryTitle(i + 1);
        var epUrl = BASE + "/dizi/" + show.s_link + "/sezon-" + s + "/bolum-" + e;
        return extractStreams(epUrl).then(function (streams) {
          return streams.length ? streams : tryTitle(i + 1);
        });
      });
    }
    return tryTitle(0);
  }).catch(function () { return []; });
}

function onSettings() { return []; }

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams, onSettings: onSettings };
} else {
  this.getStreams = getStreams;
  this.onSettings = onSettings;
}
