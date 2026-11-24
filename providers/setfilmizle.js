/**
 * SetFilmizle.ltd provider — Nuvio
 *
 * Site: https://www.setfilmizle.ltd/
 * Film zinciri:
 *   /?s=<sorgu> -> /film/<slug>/ veya /dizi/<slug>/ -> /bolum/... SxEy
 *   -> POST /wp-admin/admin-ajax.php (action=get_video_url, nonce)
 *   -> bridge https://setplay.sbs/player/stfplay.php?...
 *   -> STF_KOPRU.src = manifest.php?t=<token>  (X-Sp kaniti gerekir)
 *   -> HLS master + STF_KOPRU.subtitles (VTT)
 *
 * Cikti:
 *   - Dublaj / altyazi bilgisi (sayfa etiketi + VTT listesi)
 *   - HLS kalite, ses/altyazi rendisyonlari
 *   - Kodek: master CODECS varsa oradan, yoksa ilk TS segmentinin PMT/SPS'sinden
 *
 * Hermes/QuickJS uyumu: ES5 + Promise. const/let, arrow, async/await,
 * template literal, Buffer, URL ve URLSearchParams KULLANILMAZ.
 */
(function () {
  "use strict";

  var BASE = "https://www.setfilmizle.ltd";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  var TMDB_API_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 12000;
  var TAG = "[setfilmizle]";

  var TR_MAP = {
    "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g",
    "ü": "u", "Ü": "u", "ö": "o", "Ö": "o", "ç": "c", "Ç": "c",
    "â": "a", "Â": "a", "î": "i", "Î": "i", "û": "u", "Û": "u",
    "é": "e", "è": "e", "ê": "e", "á": "a", "à": "a", "ä": "a",
    "å": "a", "ñ": "n", "ø": "o", "æ": "ae", "ß": "ss"
  };

  // ---------------------------------------------------------------- helpers

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_API_KEY_FALLBACK;
  }

  function decodeEntities(s) {
    s = String(s || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
    s = s.replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); });
    return s.replace(/&quot;/gi, '\"').replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&");
  }

  // atob yoksa / bozsa kullanilacak ES5 base64 cozucu (sinemacc ile ayni).
  function atobSafe(str) {
    if (typeof atob === "function") {
      try { return atob(str); } catch (e) {}
    }
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var output = "";
    str = String(str).replace(/[^A-Za-z0-9\+\/=]/g, "");
    function val(c) {
      if (!c || c === "=") return 64;
      return chars.indexOf(c);
    }
    for (var i = 0; i < str.length;) {
      var e1 = val(str.charAt(i++));
      var e2 = val(str.charAt(i++));
      if (e1 < 0 || e2 < 0) break;
      output += String.fromCharCode((e1 << 2) | (e2 >> 4));
      var e3 = val(str.charAt(i++));
      if (e3 < 0) break;
      if (e3 !== 64) output += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
      var e4 = val(str.charAt(i++));
      if (e4 < 0) break;
      if (e4 !== 64) output += String.fromCharCode(((e3 & 3) << 6) | e4);
    }
    return output;
  }

  // SPG.cerceve("<iframe id>", "<base64>", "<base64 key>") -> URL.
  function decodeCerceve(encoded, key) {
    try {
      var a = atobSafe(encoded);
      var b = atobSafe(key || "");
      if (!a || !b) return "";
      var out = "";
      for (var i = 0; i < a.length; i++) {
        out += String.fromCharCode(a.charCodeAt(i) ^ b.charCodeAt(i % b.length));
      }
      return out.split("|")[0];
    } catch (e) {
      return "";
    }
  }

  function parseCerceveUrl(html) {
    var src = String(html || "");
    var m = src.match(/SPG\.cerceve\(\s*"([^"]+)"\s*,\s*"([^"]+)"(?:\s*,\s*"([^"]*)")?\s*\)/);
    if (!m || !m[2]) return "";
    return decodeCerceve(m[2], m[3] || "");
  }

  function stripTags(s) {
    return decodeEntities(String(s || "").replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ").trim();
  }

  function stripMarks(s) {
    return String(s || "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
  }

  function normTitle(s) {
    var src = stripMarks(decodeEntities(s)).toLowerCase().replace(/[\u0300-\u036f]/g, "");
    var out = "";
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (TR_MAP[ch] !== undefined) out += TR_MAP[ch];
      else if (/[a-z0-9]/.test(ch)) out += ch;
      else out += " ";
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function unique(arr) {
    var out = [], seen = {};
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    }
    return out;
  }

  function isBlocked(html) {
    return /just a moment|cf-challenge|checking your browser|attention required|cloudflare ray|captcha/i
      .test(String(html || "").slice(0, 8000));
  }

  function resolveUrl(base, rel) {
    rel = String(rel || "");
    if (/^https?:\/\//i.test(rel)) return rel;
    if (/^\/\//.test(rel)) return "https:" + rel;
    var schemeIdx = base.indexOf("://");
    var hostStart = schemeIdx === -1 ? 0 : schemeIdx + 3;
    var pathStart = base.indexOf("/", hostStart);
    if (pathStart === -1) return base + "/" + rel.replace(/^\//, "");
    if (rel.charAt(0) === "/") return base.slice(0, pathStart) + rel;
    var clean = base.split("#")[0].split("?")[0];
    return clean.slice(0, clean.lastIndexOf("/") + 1) + rel;
  }

  // `window.X = {...};` icindeki JSON'u dengelemis suslu parantezle cikarir.
  function extractJsonObject(html, marker) {
    var src = String(html || "");
    var i = src.indexOf(marker);
    if (i < 0) return null;
    var start = src.indexOf("{", i + marker.length);
    if (start < 0) return null;
    var depth = 0, inStr = false, esc = false;
    for (var j = start; j < src.length; j++) {
      var c = src.charAt(j);
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          var raw = src.slice(start, j + 1);
          try { return JSON.parse(raw); } catch (e) {}
          // STF_KOPRU kimi zaman JS object literal (tirnaksiz anahtar) olur.
          try {
            var fixed = raw
              .replace(/,\s*([}\]])/g, "$1")
              .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
            return JSON.parse(fixed);
          } catch (e2) { return null; }
        }
      }
    }
    return null;
  }

  function fetchRaw(url, opts, timeout) {
    if (typeof setTimeout !== "function") return fetch(url, opts || {});
    var timer = null;
    var to = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("timeout")); }, timeout || TIMEOUT);
    });
    return Promise.race([fetch(url, opts || {}), to]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function wait(ms) {
    if (typeof setTimeout !== "function") return Promise.resolve();
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function fetchRawRetry(url, opts, timeout, retries) {
    var attempts = retries || 0;
    function run(n) {
      return fetchRaw(url, opts, timeout).catch(function (err) {
        if (n < attempts) return wait(400 * (n + 1)).then(function () { return run(n + 1); });
        throw err;
      });
    }
    return run(0);
  }

  function requestText(url, opts, retries) {
    return fetchRawRetry(url, opts, TIMEOUT, retries === undefined ? 1 : retries)
      .then(function (res) {
        if (!res || !res.ok) return null;
        return res.text();
      })
      .catch(function () { return null; });
  }

  function requestBuffer(url, opts, retries) {
    return fetchRawRetry(url, opts, 10000, retries === undefined ? 0 : retries)
      .then(function (res) {
        if (!res || !res.ok) return null;
        if (typeof res.arrayBuffer !== "function") return null;
        return res.arrayBuffer();
      })
      .catch(function () { return null; });
  }

  function fetchJson(url, headers, attempt) {
    var n = attempt || 0;
    return requestText(url, { headers: headers || { "User-Agent": UA } }, 0).then(function (txt) {
      if (!txt) throw new Error("empty response");
      try { return JSON.parse(txt); } catch (e) { throw new Error("invalid json"); }
    }).catch(function () {
      if (n < 2) return wait(600 * (n + 1)).then(function () { return fetchJson(url, headers, n + 1); });
      return null;
    });
  }

  // -------------------------------------------------------------- TMDB

  function fetchTmdbInfo(apiKey, tmdbId, isTv) {
    var kind = isTv ? "tv" : "movie";
    var url = function (lang) {
      return "https://api.themoviedb.org/3/" + kind + "/" + encodeURIComponent(tmdbId) +
        "?api_key=" + encodeURIComponent(apiKey) +
        "&language=" + lang + "&append_to_response=alternative_titles";
    };
    return Promise.all([fetchJson(url("tr-TR")), fetchJson(url("en-US"))]).then(function (arr) {
      var tr = arr[0], en = arr[1];
      var d = en || tr;
      if (!d) return null;

      var titles = [];
      function add(value) {
        var clean = stripMarks(value);
        if (!normTitle(clean)) return;
        for (var i = 0; i < titles.length; i++) {
          if (normTitle(titles[i]) === normTitle(clean)) return;
        }
        titles.push(clean);
      }
      add(d.original_title || d.original_name);
      add(en && (en.title || en.name));
      add(tr && (tr.title || tr.name));
      var sources = [en, tr];
      for (var s = 0; s < sources.length; s++) {
        var list = sources[s] && sources[s].alternative_titles && sources[s].alternative_titles.results;
        if (!list) continue;
        for (var j = 0; j < list.length && titles.length < 20; j++) add(list[j].title);
      }
      return {
        titles: titles,
        year: String((d.release_date || d.first_air_date || "").toString()).slice(0, 4),
        originalLanguage: d.original_language || ""
      };
    });
  }

  // IMDb id -> TMDB id (sayfa TMDB id vermedigi icin ek dogrulama)
  function verifyImdb(apiKey, imdbId, tmdbId) {
    if (!imdbId) return Promise.resolve(true);
    var url = "https://api.themoviedb.org/3/find/" + encodeURIComponent(imdbId) +
      "?api_key=" + encodeURIComponent(apiKey) + "&external_source=imdb_id";
    return fetchJson(url, { "User-Agent": UA }).then(function (j) {
      if (!j) return true; // dogrulama yapilamiyorsa engellemeyelim
      var results = (j.movie_results || []).concat(j.tv_results || []);
      for (var i = 0; i < results.length; i++) {
        if (String(results[i].id) === String(tmdbId)) return true;
      }
      return false;
    });
  }

  // -------------------------------------------------------------- arama

  function parseSearch(html) {
    var out = [], seen = {};
    var chunks = String(html || "").split(/<a\s+class="card-link"/i);
    for (var i = 1; i < chunks.length; i++) {
      var c = chunks[i].slice(0, 9000);
      var href = (c.match(/href="([^"]+)"/i) || [])[1];
      var title = stripTags((c.match(/<h2[^>]*class="card-ad"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1]);
      var meta = stripTags((c.match(/<p[^>]*class="meta"[^>]*>([\s\S]*?)<\/p>/i) || [])[1]);
      var year = (meta.match(/((?:19|20)\d{2})/) || [])[1] || "";
      var lang = stripTags((c.match(/badge-lang[^>]*>([^<]+)</i) || [])[1]);
      if (!href || !/\/(?:film|dizi)\//.test(href)) continue;
      href = decodeEntities(href);
      if (seen[href]) continue;
      seen[href] = 1;
      out.push({
        url: resolveUrl(BASE + "/", href),
        title: title,
        year: year,
        isTv: /\/dizi\//.test(href),
        dub: /DUB|DUAL|Dublaj/i.test(lang),
        sub: /SUB|DUAL|Altyazı/i.test(lang)
      });
    }
    return out;
  }

  function searchSite(query) {
    var url = BASE + "/?s=" + encodeURIComponent(query);
    return requestText(url, {
      headers: {
        "User-Agent": UA,
        "Referer": BASE + "/",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"
      }
    }, 1).then(function (html) {
      if (!html || isBlocked(html)) return [];
      return parseSearch(html);
    });
  }

  // -------------------------------------------------------------- sayfa

  function parsePage(html, pageUrl, label) {
    var h1 = stripTags((html.match(/<h1[^>]*class="fbox-title"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
    var title = stripTags((html.match(/<span[^>]*class="fbox-title-tx"[^>]*>([\s\S]*?)<\/span>/i) || [])[1]) || h1;
    var year = (html.match(/class="fbox-date"[^>]*>\s*\(?((?:19|20)\d{2})/i) || [])[1] ||
      (html.match(/Yıl:<\/b>\s*<a[^>]*>((?:19|20)\d{2})<\/a>/i) || [])[1] || "";
    var langText = stripTags((html.match(/<span[^>]*class="fbox-lang[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1]);
    var imdbId = (html.match(/imdb\.com\/title\/(tt\d+)/i) || [])[1] || "";
    var postId = (html.match(/id="stfPlayer"\s+data-post-id="(\d+)"/i) || [])[1] || "";
    var ajaxUrl = decodeEntities((html.match(/STF_AJAX\s*=\s*\{[^}]*url:\s*"([^"]+)"/i) || [])[1]) ||
      BASE + "/wp-admin/admin-ajax.php";
    var nonce = (html.match(/video\s*:\s*"([a-f0-9]+)"/i) || [])[1] || "";

    var sources = [], re = /<button[^>]*data-player-name="([^"]+)"[^>]*data-part-key="([^"]*)"[^>]*>([\s\S]*?)<\/button>/gi, m;
    while ((m = re.exec(html)) !== null) {
      sources.push({
        name: decodeEntities(m[1]),
        part: m[2] || "",
        label: label || stripTags(m[3])
      });
    }

    return {
      url: pageUrl,
      title: title,
      year: year,
      dub: /Dublaj|DUAL|DUB/i.test(langText),
      sub: /Altyazı|SUB|DUAL/i.test(langText),
      imdbId: imdbId,
      postId: postId,
      ajaxUrl: ajaxUrl,
      nonce: nonce,
      sources: sources
    };
  }

  function fetchPage(url, label) {
    return requestText(url, {
      headers: {
        "User-Agent": UA,
        "Referer": BASE + "/",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"
      }
    }, 1).then(function (html) {
      if (!html || isBlocked(html)) return null;
      return parsePage(html, url, label);
    });
  }

  function findEpisodePage(seriesUrl, season, episode) {
    return requestText(seriesUrl, { headers: { "User-Agent": UA, "Referer": BASE + "/" } }, 1)
      .then(function (html) {
        if (!html) return null;
        var wanted = season + "-sezon-" + episode + "-bolum";
        var links = [], re = /href="([^"]*\/bolum\/[^"]+)"/gi, m;
        while ((m = re.exec(html)) !== null) {
          var u = decodeEntities(m[1]);
          if (links.indexOf(u) < 0) links.push(u);
        }
        var target = null;
        for (var i = 0; i < links.length; i++) {
          if (links[i].indexOf(wanted) >= 0) { target = links[i]; break; }
        }
        if (!target && links.length) target = links[0];
        if (!target) return null;
        return fetchPage(resolveUrl(BASE + "/", target), "S" + season + "E" + episode);
      });
  }

  // -------------------------------------------------------------- eslesme

  function score(candidate, info) {
    if (!candidate.year || !info.year) return 0;
    var diff = Math.abs(parseInt(candidate.year, 10) - parseInt(info.year, 10));
    if (diff > 1) return -1;
    var a = normTitle(candidate.title);
    var best = 0;
    for (var i = 0; i < info.titles.length; i++) {
      var b = normTitle(info.titles[i]);
      if (!b) continue;
      if (a === b) { best = Math.max(best, 100); continue; }
      if (a.indexOf(b) === 0 || b.indexOf(a) === 0) { best = Math.max(best, 70); continue; }
      var ta = a.split(" "), tb = b.split(" "), common = 0;
      for (var j = 0; j < ta.length; j++) {
        if (ta[j].length > 2 && tb.indexOf(ta[j]) >= 0) common++;
      }
      best = Math.max(best, Math.round((50 * common) / Math.max(ta.length, tb.length, 1)));
    }
    return best;
  }

  function findPage(info, apiKey, tmdbId, isTv, season, episode) {
    var queries = info.titles.slice(0, 4);
    var found = [];
    function nextQuery(i) {
      if (i >= queries.length) return Promise.resolve(found);
      return searchSite(queries[i]).then(function (list) {
        for (var k = 0; k < list.length; k++) {
          var s = score(list[k], info);
          if (s < 0) continue;
          list[k].score = s;
          found.push(list[k]);
        }
        return nextQuery(i + 1);
      });
    }
    return nextQuery(0).then(function (list) {
      if (!list.length) return null;
      var seen = {}, uniq = [];
      list.sort(function (x, y) { return y.score - x.score; });
      for (var i = 0; i < list.length; i++) {
        if (!seen[list[i].url]) { seen[list[i].url] = 1; uniq.push(list[i]); }
      }
      uniq = uniq.slice(0, 6);

      var best = null;
      function nextPage(j) {
        if (j >= uniq.length) return Promise.resolve(best);
        var cand = uniq[j];
        if (isTv && !/\/dizi\//.test(cand.url)) return nextPage(j + 1);
        if (!isTv && /\/dizi\//.test(cand.url)) return nextPage(j + 1);
        return fetchPage(cand.url).then(function (page) {
          if (!page) return nextPage(j + 1);
          return verifyImdb(apiKey, page.imdbId, tmdbId).then(function (ok) {
            if (!ok) return nextPage(j + 1);
            var ps = score({ title: page.title, year: page.year }, info);
            if (ps >= 50 && (!best || ps > best._score)) {
              page._score = ps;
              best = page;
            }
            return nextPage(j + 1);
          });
        });
      }
      return nextPage(0).then(function (page) {
        if (!page) return null;
        if (!isTv) return page;
        return findEpisodePage(page.url, season, episode);
      });
    });
  }

  // -------------------------------------------------------------- X-Sp kaniti

  function imul32(a, b) {
    if (typeof Math.imul === "function") return Math.imul(a, b);
    var a16 = a & 0xffff;
    return ((a16 * b) + ((((a >>> 16) * b) & 0xffff) << 16)) | 0;
  }

  function hashFn(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = imul32(h, 16777619) >>> 0;
    }
    return h.toString(16);
  }

  function makeXSp(sp, spT, capturedAt, buffer) {
    var n = Number(spT) || 0;
    // Sitein kendi koruma scripti de spT'yi ilk okundugu andan itibaren
    // gecen sureyle artirir; ara bridge hop'lari birkac saniye suriyor.
    if (capturedAt) n += Math.max(0, Math.floor((Date.now() - capturedAt) / 1000));
    n += buffer || 0;
    var r = Math.floor(2176782336 * Math.random()).toString(36);
    return n + "." + r + "." + hashFn(sp + "|" + n + "|" + r);
  }

  // -------------------------------------------------------------- player / HLS

  function getBridgeUrl(page, source) {
    if (!page.postId || !page.nonce) return Promise.resolve(null);
    var body = "action=get_video_url" +
      "&nonce=" + encodeURIComponent(page.nonce) +
      "&post_id=" + encodeURIComponent(page.postId) +
      "&player_name=" + encodeURIComponent(source.name) +
      "&part_key=" + encodeURIComponent(source.part || "");
    var headers = {
      "User-Agent": UA,
      "Referer": page.url,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json, text/javascript, */*; q=0.01"
    };
    return requestText(page.ajaxUrl, { method: "POST", headers: headers, body: body }, 1).then(function (txt) {
      if (!txt) return null;
      var j = null;
      try { j = JSON.parse(txt); } catch (e) { return null; }
      if (!j || !j.success || !j.data) return null;
      var st = j.data.stream || {};
      if (st.src && /^https?:\/\//i.test(st.src)) return { direct: st.src, subtitles: st.subtitles || [] };
      if (st.url && /^https?:\/\//i.test(st.url)) return { bridge: st.url, subtitles: st.subtitles || [] };
      return null;
    });
  }

  function normalizeSubtitles(list, baseUrl) {
    var subs = [];
    list = list || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {};
      if (s.kind === "thumbnails" || !s.file) continue;
      subs.push({
        url: resolveUrl(baseUrl, s.file),
        language: langName(s.lang || s.language || ""),
        name: s.label || s.name || s.lang || "Altyazı",
        forced: !!s.forced,
        headers: { "User-Agent": UA, "Referer": baseUrl }
      });
    }
    return subs;
  }

  // setplay.sbs bazen dogrudan STF_KOPRU verir, bazen de SPG.cerceve ile
  // sifrelenmis bir fastplay.mom iframe adresi dondurur. Ikisi de cozulur.
  function parseBridge(html, bridgeUrl) {
    var kopru = extractJsonObject(html, "STF_KOPRU");
    if (kopru && kopru.src) {
      var spg = extractJsonObject(html, "SPG_A") || {};
      return {
        manifestUrl: resolveUrl(bridgeUrl, kopru.src),
        subs: normalizeSubtitles(kopru.subtitles, bridgeUrl),
        sp: spg.sp || "",
        spT: spg.spT || 0,
        capturedAt: Date.now()
      };
    }
    var nested = parseCerceveUrl(html);
    if (nested) return { nested: resolveUrl(bridgeUrl, nested) };
    return null;
  }

  function resolveBridge(url, html, directSubs, depth) {
    var n = depth || 0;
    if (n > 3) return Promise.resolve(null);
    var p = html ? Promise.resolve(html) : requestText(url, {
      headers: { "User-Agent": UA, "Referer": BASE + "/" }
    }, 1);
    return p.then(function (doc) {
      if (!doc) return null;
      var b = parseBridge(doc, url);
      if (!b) return null;
      if (b.nested) {
        return requestText(b.nested, {
          headers: { "User-Agent": UA, "Referer": url }
        }, 1).then(function (nextHtml) {
          return resolveBridge(b.nested, nextHtml, directSubs, n + 1);
        });
      }
      b.bridgeUrl = url;
      var extra = normalizeSubtitles(directSubs, url);
      if (extra.length) b.subs = extra.concat(b.subs || []);
      return b;
    });
  }

  function parseAttribs(s) {
    var out = {};
    var re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi, m;
    while ((m = re.exec(String(s || ""))) !== null) {
      out[m[1].toUpperCase()] = m[3] !== undefined ? m[3] : m[4];
    }
    return out;
  }

  function parseMedia(line, kind) {
    var a = parseAttribs(line.replace(/^#EXT-X-MEDIA:TYPE=[^,]*,?/i, ""));
    return {
      kind: kind,
      language: a.LANGUAGE || "und",
      name: a.NAME || a.LANGUAGE || kind,
      url: a.URI ? String(a.URI).replace(/^"|"$/g, "") : "",
      def: /YES/i.test(a.DEFAULT || ""),
      forced: /YES/i.test(a.FORCED || "")
    };
  }

  function parseMaster(txt, url) {
    var variants = [], audio = [], subtitles = [], pending = null;
    var lines = String(txt || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (/^#EXT-X-MEDIA:TYPE=AUDIO/i.test(line)) audio.push(parseMedia(line, "audio"));
      else if (/^#EXT-X-MEDIA:TYPE=SUBTITLES/i.test(line)) subtitles.push(parseMedia(line, "sub"));
      else if (/^#EXT-X-STREAM-INF:/i.test(line)) pending = parseAttribs(line.replace(/^#EXT-X-STREAM-INF:/i, ""));
      else if (pending && line && line.charAt(0) !== "#") {
        pending.url = resolveUrl(url, line);
        variants.push(pending);
        pending = null;
      }
    }
    return { variants: variants, audio: audio, subtitles: subtitles };
  }

  function qualityFrom(height, bandwidth) {
    if (height >= 2160) return "4K";
    if (height >= 1080) return "1080p";
    if (height >= 720) return "720p";
    if (height >= 480) return "480p";
    if (bandwidth >= 5000000) return "1080p";
    if (bandwidth >= 2500000) return "720p";
    return "Auto";
  }

  var STREAM_TYPES = {
    "2": "MPEG-2 Video", "3": "MP3", "4": "MPEG-2 Audio", "11": "AAC",
    "15": "AAC", "17": "AAC", "27": "H.264", "36": "HEVC",
    "129": "AC-3", "135": "E-AC3", "138": "DTS", "234": "VC-1"
  };

  function levelName(levelIdc) {
    if (!levelIdc) return "";
    return String(levelIdc / 10).replace(/\.0$/, "");
  }

  function parseTsCodec(buffer) {
    try {
      if (!buffer) return null;
      var a = new Uint8Array(buffer);
      var i;
      var max = Math.min(a.length, 188 * 700);
      for (i = 0; i + 188 <= max; i += 188) {
        if (a[i] !== 0x47) continue;
        var pid = ((a[i + 1] & 0x1f) << 8) | a[i + 2];
        if (pid !== 0 && pid !== 0x1000) continue;
        var afc = (a[i + 3] >> 4) & 3;
        var st = i + 4;
        if (afc & 2) st = i + 5 + a[i + 4];
        if (!(afc & 1) || st >= i + 188 || st + 2 >= i + 188) continue;
        var s = st + 1 + a[st];
        if (s + 12 >= i + 188 || a[s] !== 0x02) continue; // PMT
        var sectionLen = ((a[s + 1] & 0x0f) << 8) | a[s + 2];
        var end = Math.min(s + 3 + sectionLen, i + 188);
        var progLen = ((a[s + 10] & 0x0f) << 8) | a[s + 11];
        var p = s + 12 + progLen;
        var video = "", audio = "", profile = "", level = "", langs = [];
        while (p + 5 <= end) {
          var type = a[p];
          var esPid = ((a[p + 1] & 0x1f) << 8) | a[p + 2];
          var esLen = ((a[p + 3] & 0x0f) << 8) | a[p + 4];
          var name = STREAM_TYPES[String(type)] || "";
          if (type === 0x1b || type === 0x24) {
            if (!video) video = name;
            var d = p + 5, dEnd = Math.min(p + 5 + esLen, end);
            while (d + 2 <= dEnd) {
              if (a[d] === 0x28 && a[d + 1] >= 4) {
                profile = a[d + 2];
                level = levelName(a[d + 3]);
              }
              d += 2 + a[d + 1];
            }
          } else if (/Audio|AAC|AC-3|DTS|MP3/i.test(name)) {
            if (!audio) audio = name;
            var q = p + 5, qEnd = Math.min(p + 5 + esLen, end);
            while (q + 2 <= qEnd) {
              if (a[q] === 0x0a && a[q + 1] >= 2) {
                var lg = String.fromCharCode(a[q + 2], a[q + 3], a[q + 4]).replace(/[^\w]/g, "");
                if (lg && langs.indexOf(lg) < 0) langs.push(lg);
              }
              q += 2 + a[q + 1];
            }
          }
          if (esPid === 0) break;
          p += 5 + esLen;
        }
        // SPS'ten profile@level (PMT descriptor yoksa).
        for (i = 0; i + 6 <= max; i++) {
          if (a[i] === 0x00 && a[i + 1] === 0x00 && a[i + 2] === 0x01 && a[i + 3] === 0x67) {
            if (!profile) profile = a[i + 4];
            if (!level) level = levelName(a[i + 6]);
            break;
          }
        }
        var profileName = "";
        if (profile === 0x42) profileName = "Baseline";
        else if (profile === 0x4d) profileName = "Main";
        else if (profile === 0x64) profileName = "High";
        else if (profile === 0x6f) profileName = "High10";
        var vLabel = video || "";
        if (profileName) vLabel += " " + profileName;
        if (level) vLabel += "@" + level;
        var parts = [];
        if (vLabel) parts.push(vLabel.trim());
        if (audio) parts.push(audio);
        return {
          video: video, audio: audio, profile: profileName, level: level,
          languages: langs, tag: parts.join(" | ")
        };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function probeCodec(variantUrl, headers) {
    return requestText(variantUrl, { headers: headers }, 0).then(function (pl) {
      if (!pl) return null;
      var lines = pl.split(/\r?\n/), seg = "";
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (/^https?:\/\//i.test(l)) { seg = l; break; }
        if (l.charAt(0) === "/") { seg = resolveUrl(variantUrl, l); break; }
      }
      if (!seg) return null;
      var h = {};
      for (var k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) h[k] = headers[k];
      h.Range = "bytes=0-131071";
      return requestBuffer(seg, { headers: h }, 0).then(parseTsCodec);
    }).catch(function () { return null; });
  }

  function langName(code) {
    var map = { tur: "tr", tr: "tr", eng: "en", en: "en", und: "und" };
    return map[String(code || "").toLowerCase()] || String(code || "").toLowerCase();
  }

  // -------------------------------------------------------------- stream uretimi

  function buildStream(variant, info, master, codec, subs, source, proof) {
    var h = variant.height ? parseInt(variant.height, 10) : 0;
    var bw = variant.bandwidth ? parseInt(variant.bandwidth, 10) : 0;
    var quality = qualityFrom(h, bw);

    var codecTag = codec && codec.tag ? codec.tag : "";
    if (!codecTag && variant.codecs) {
      var cd = String(variant.codecs).toLowerCase();
      var v = /hvc1|hev1|hevc/.test(cd) ? "HEVC" : (/av01/.test(cd) ? "AV1" : (/avc1|avc3|avc/.test(cd) ? "H.264" : ""));
      var au = /ec-3|eac3/.test(cd) ? "E-AC3" : (/ac-3/.test(cd) ? "AC-3" : (/mp4a|aac/.test(cd) ? "AAC" : ""));
      codecTag = [v, au].filter(function (x) { return !!x; }).join(" | ");
    }

    var audioLangs = [];
    for (var i = 0; i < master.audio.length; i++) audioLangs.push(langName(master.audio[i].language));
    audioLangs = unique(audioLangs);
    audioLangs.sort(function (a, b) {
      if (a === "tr") return -1;
      if (b === "tr") return 1;
      return 0;
    });
    var subLangs = [];
    for (var j = 0; j < subs.length; j++) subLangs.push(subs[j].language);
    subLangs = unique(subLangs);

    var tags = [];
    if (info.dub) tags.push("TR Dublaj");
    if (subLangs.length) tags.push("Alt: " + subLangs.join("/"));
    if (audioLangs.length) tags.push("Ses: " + audioLangs.join("/"));
    if (codecTag) tags.push(codecTag);
    if (quality && quality !== "Auto") tags.push(quality);
    if (source && source.label && !/^SetPlay$/i.test(source.label)) tags.push(source.label);

    var baseTitle = (info.titles[0] || info.title || "") +
      (info.year ? " (" + info.year + ")" : "") +
      (info.episodeLabel ? " " + info.episodeLabel : "");
    var title = baseTitle + " [" + tags.join(" | ") + "]";
    var streamHeaders = { "User-Agent": UA, "Referer": info.bridgeUrl || BASE + "/" };
    if (proof) streamHeaders["X-Sp"] = proof;

    return {
      name: "SetFilmizle " + (codecTag || quality),
      title: title,
      url: variant.url,
      quality: quality,
      isM3u8: true,
      type: "hls",
      language: "tr",
      provider: "setfilmizle",
      headers: streamHeaders,
      subtitles: subs,
      _dub: !!info.dub,
      _sub: subLangs.length > 0,
      _audioLangs: audioLangs,
      _captionLangs: subLangs,
      _codec: codecTag,
      _quality: quality
    };
  }

  function buildStreams(page, info, bridge, source) {
    var masterProof = bridge.sp ? makeXSp(bridge.sp, bridge.spT, bridge.capturedAt) : "";
    var streamProof = bridge.sp ? makeXSp(bridge.sp, bridge.spT, bridge.capturedAt, 8) : "";
    var manifestHeaders = {
      "User-Agent": UA,
      "Referer": bridge.bridgeUrl || bridge.manifestUrl,
      "Accept": "*/*"
    };
    if (masterProof) manifestHeaders["X-Sp"] = masterProof;

    return requestText(bridge.manifestUrl, { headers: manifestHeaders }, 1).then(function (txt) {
      if (!txt || !/^#EXTM3U/.test(txt.trim())) return [];
      var master = parseMaster(txt, bridge.manifestUrl);
      if (!master.variants.length) return [];

      // En yuksek kaliteyi sec; Nuvio tek oynatabilir URL bekliyor.
      var v = null, bestBw = -1;
      for (var j = 0; j < master.variants.length; j++) {
        var bw = parseInt(master.variants[j].BANDWIDTH || master.variants[j].BW || "0", 10) || 0;
        if (bw > bestBw) { bestBw = bw; v = master.variants[j]; }
      }
      if (!v) v = master.variants[0];
      v.height = (v.RESOLUTION.match(/\d+x(\d+)/i) || [])[1] || "";
      v.bandwidth = v.BANDWIDTH || v.BW || "";
      v.codecs = v.CODECS || "";

      var codecProof = bridge.sp ? makeXSp(bridge.sp, bridge.spT, bridge.capturedAt) : "";
      var codecHeaders = { "User-Agent": UA, "Referer": bridge.bridgeUrl || bridge.manifestUrl };
      if (codecProof) codecHeaders["X-Sp"] = codecProof;
      return probeCodec(v.url, codecHeaders).then(function (codec) {
        var streamInfo = {
          titles: info.titles,
          year: info.year,
          title: page.title,
          dub: page.dub,
          episodeLabel: page.label || "",
          bridgeUrl: bridge.bridgeUrl || bridge.manifestUrl
        };
        return [buildStream(v, streamInfo, master, codec, bridge.subs, source, streamProof)];
      });
    });
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var apiKey = getTmdbKey(settings);
    var isTv = mediaType === "tv" || mediaType === "series";
    if (!apiKey) return Promise.resolve([]);
    season = parseInt(season, 10) || 1;
    episode = parseInt(episode, 10) || 1;

    return fetchTmdbInfo(apiKey, tmdbId, isTv).then(function (info) {
      if (!info || !info.titles.length) {
        console.log(TAG + " TMDB bilgisi alinamadi");
        return [];
      }
      console.log(TAG + " Araniyor: " + info.titles[0] + (info.year ? " (" + info.year + ")" : ""));
      return findPage(info, apiKey, tmdbId, isTv, season, episode).then(function (page) {
        if (!page) {
          console.log(TAG + " Uygun sayfa bulunamadi");
          return [];
        }
        info.titles.push(page.title);
        console.log(TAG + " Sayfa: " + page.url + " | kaynak: " + page.sources.length);
        var out = [];
        function next(i) {
          if (i >= page.sources.length) return Promise.resolve(out);
          return getBridgeUrl(page, page.sources[i]).then(function (res) {
            if (!res) return next(i + 1);
            function withBridge(bridge) {
              if (!bridge) return next(i + 1);
              return buildStreams(page, info, bridge, page.sources[i]).then(function (streams) {
                out = out.concat(streams);
                return next(i + 1);
              });
            }
            if (res.bridge) {
              return resolveBridge(res.bridge, null, res.subtitles, 0).then(withBridge);
            }
            return withBridge({
              manifestUrl: res.direct,
              bridgeUrl: page.url,
              subs: [],
              sp: "",
              spT: 0
            });
          });
        }
        return next(0);
      });
    }).catch(function (err) {
      console.log(TAG + " Hata: " + (err && err.message));
      return [];
    });
  }

  function onSettings() { return []; }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      getStreams: getStreams,
      onSettings: onSettings,
      // Sadece Node regresyon testleri icin.
      _test: {
        normTitle: normTitle,
        parseSearch: parseSearch,
        parsePage: parsePage,
        parseMaster: parseMaster,
        parseBridge: parseBridge,
        parseCerceveUrl: parseCerceveUrl,
        decodeCerceve: decodeCerceve,
        resolveBridge: resolveBridge,
        parseTsCodec: parseTsCodec,
        score: score,
        qualityFrom: qualityFrom,
        makeXSp: makeXSp,
        hashFn: hashFn,
        extractJsonObject: extractJsonObject
      }
    };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
