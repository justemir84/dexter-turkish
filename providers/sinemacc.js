/**
 * Sinema.cc provider — Nuvio
 *
 * Site: https://sinemacc.com/
 * Film kaynagi: /arama/?s=... -> /film/slug-yil/ -> base64 `rel` ->
 *   https://player.filmizle.in/{embed,video}/<id> ->
 *   POST /player/index.php?data=<id>&do=getVideo -> HLS master.txt
 *
 * Cikti:
 *   - Dublaj / altyazi bilgisi (sayfa part button etiketleri + player defaultAudio)
 *   - HLS kalite, ses/altyazi rendisyonlari
 *   - Kodek: master CODECS varsa oradan, yoksa ilk TS segmentinin PMT'sinden
 *     (H.264/HEVC/AAC/AC-3/E-AC3) ve SPS'ten (profile@level) okunur.
 *
 * Hermes/QuickJS uyumu:
 *   ES5 + Promise. const/let, arrow, async/await, template literal, Buffer,
 *   URL ve URLSearchParams KULLANILMAZ.
 */
(function () {
  "use strict";

  var BASE = "https://sinemacc.com";
  var PLAYER = "https://player.filmizle.in";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  var TMDB_API_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 12000;
  var TAG = "[sinemacc]";

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
    return s.replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&");
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
    return fetchRawRetry(url, opts, 8000, retries === undefined ? 0 : retries)
      .then(function (res) {
        if (!res || !res.ok) return null;
        if (typeof res.arrayBuffer !== "function") return null;
        return res.arrayBuffer();
      })
      .catch(function () { return null; });
  }

  // TMDB bazen 429 verir: artan gecikmeyle 3 deneme yapilir.
  function fetchJson(url, headers, attempt) {
    var n = attempt || 0;
    return requestText(url, { headers: headers || { "User-Agent": UA } }, 0).then(function (txt) {
      if (!txt) throw new Error("empty response");
      try { return JSON.parse(txt); } catch (e) { throw new Error("invalid json"); }
    }).catch(function () {
      if (n < 2) {
        return wait(600 * (n + 1)).then(function () { return fetchJson(url, headers, n + 1); });
      }
      return null;
    });
  }

  // -------------------------------------------------------------- TMDB bilgisi

  function fetchTmdbInfo(apiKey, tmdbId) {
    var url = function (lang) {
      return "https://api.themoviedb.org/3/movie/" + encodeURIComponent(tmdbId) +
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
      add(d.original_title);
      add(en && en.title);
      add(tr && tr.title);
      var sources = [en, tr];
      for (var s = 0; s < sources.length; s++) {
        var list = sources[s] && sources[s].alternative_titles && sources[s].alternative_titles.results;
        if (!list) continue;
        for (var j = 0; j < list.length && titles.length < 20; j++) add(list[j].title);
      }
      return {
        titles: titles,
        year: String(d.release_date || "").slice(0, 4),
        originalLanguage: d.original_language || ""
      };
    });
  }

  // -------------------------------------------------------------- arama

  function parseSearch(html) {
    var out = [], seen = {};
    var chunks = String(html || "").split(/<div[^>]*class="[^"]*film_kutusu/i);
    for (var i = 1; i < chunks.length; i++) {
      var c = chunks[i].slice(0, 9000);
      var href = (c.match(/<a[^>]+href="([^"]+)"/i) || [])[1];
      var title = stripTags((c.match(/<span[^>]*class="text"[^>]*>([\s\S]*?)<\/span>/i) || [])[1]);
      var yearsRaw = stripTags((c.match(/<span[^>]*class="years"[^>]*>([\s\S]*?)<\/span>/i) || [])[1]);
      var year = (yearsRaw.match(/\b(?:19|20)\d{2}\b/) || [])[0] || "";
      var typeHtml = (c.match(/<span[^>]*class="box type"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "";
      if (!href || !/\/(?:film|dizi)\//.test(href)) continue;
      href = decodeEntities(href);
      if (seen[href]) continue;
      seen[href] = 1;
      out.push({
        url: resolveUrl(BASE + "/", href),
        title: title,
        year: year,
        dub: /icon_flag_tr/.test(typeHtml),
        sub: /icon_subtitle/.test(typeHtml)
      });
    }
    return out;
  }

  function searchSite(query) {
    var url = BASE + "/arama/?s=" + encodeURIComponent(query);
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

  // -------------------------------------------------------------- film sayfasi

  function parsePage(html, pageUrl) {
    var tmdbId = (html.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i) || [])[1] || "";
    var h1 = stripTags((html.match(/<h1[^>]*class="baslik"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
    var h2 = stripTags((html.match(/<h2[^>]*class="baslik orj"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1]);
    var detay = stripTags((html.match(/<ul[^>]*class="detay"[^>]*>([\s\S]*?)<\/ul>/i) || [])[1]);
    var year = (detay.match(/\b((?:19|20)\d{2})\b/) || [])[1] ||
      (h1.match(/\b((?:19|20)\d{2})\b/) || [])[1] ||
      (pageUrl.match(/\/((?:19|20)\d{2})(?:\/|$)/) || [])[1] || "";
    var quality = (detay.match(/\b(2160p|1080p|720p|480p|4k)\b/i) || [])[1] || "";
    var duration = (detay.match(/(\d+)\s*Dakika/i) || [])[1] || "";
    var hasDub = /Dublaj/i.test(detay) || /icon_flag_tr/.test(html);
    var hasSub = /Altyaz/i.test(detay) || /icon_subtitle/.test(html);

    var buttons = [], re = /<button[^>]*rel="([^"]+)"[^>]*>([\s\S]*?)<\/button>/gi, m;
    while ((m = re.exec(html)) !== null) {
      var label = stripTags(m[2]);
      var u = atobSafe(m[1]);
      if (!/^https?:\/\//i.test(u)) continue;
      if (!/player\.filmizle\.in/i.test(u)) continue;
      if (/fragman|trailer| youtube /i.test(label + " " + u)) continue;
      buttons.push({ playerUrl: u, label: label });
    }

    return {
      url: pageUrl,
      tmdbId: tmdbId,
      title: h1.replace(/\s+[İi]zle\s*$/i, "").trim(),
      originalTitle: h2,
      year: year.replace(/[^\d]/g, ""),
      quality: quality.toLowerCase(),
      duration: duration,
      dub: hasDub,
      sub: hasSub,
      buttons: buttons
    };
  }

  function fetchPage(url) {
    return requestText(url, {
      headers: {
        "User-Agent": UA,
        "Referer": BASE + "/",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"
      }
    }, 1).then(function (html) {
      if (!html || isBlocked(html)) return null;
      return parsePage(html, url);
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

  function findPage(info, tmdbId) {
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
        return fetchPage(uniq[j].url).then(function (page) {
          if (!page) return nextPage(j + 1);
          // TMDB id kesin eslesme: hemen kabul et.
          if (page.tmdbId && String(page.tmdbId) === String(tmdbId)) return page;
          var ps = score({ title: page.title, year: page.year }, info);
          if (page.originalTitle) {
            ps = Math.max(ps, score({ title: page.originalTitle, year: page.year }, info));
          }
          if (ps >= 50 && (!best || ps > best._score)) {
            page._score = ps;
            best = page;
          }
          return nextPage(j + 1);
        });
      }
      return nextPage(0);
    });
  }

  // -------------------------------------------------------------- player / HLS

  function resolvePlayer(playerUrl) {
    var m = playerUrl.match(/\/(?:embed|video)\/([^\/?#]+)/i);
    if (!m) return Promise.resolve(null);
    var id = m[1];
    var api = PLAYER + "/player/index.php?data=" + encodeURIComponent(id) + "&do=getVideo";
    var headers = {
      "User-Agent": UA,
      "Referer": playerUrl,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded"
    };
    var body = "hash=" + encodeURIComponent(id) + "&r=" + encodeURIComponent(BASE + "/");
    return requestText(api, { method: "POST", headers: headers, body: body }, 1).then(function (txt) {
      if (!txt) return null;
      var j = null;
      try { j = JSON.parse(txt); } catch (e) { return null; }
      if (!j) return null;
      var src = j.videoSource || "";
      if (!src && j.securedLink) src = j.securedLink;
      if (!/^https?:\/\//i.test(src)) return null;
      var lm = playerUrl.match(/[?&]lng=([^&#]+)/i);
      return {
        id: id,
        hls: !!j.hls,
        url: src,
        lng: lm ? decodeURIComponent(lm[1]).toLowerCase() : "",
        playerUrl: playerUrl
      };
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
      def: /YES/i.test(a.DEFAULT || "")
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
    "1": "MPEG-2 Video", "2": "MPEG-2 Video", "3": "MP3", "4": "MPEG-2 Audio",
    "11": "AAC", "15": "AAC", "17": "AAC", "27": "H.264", "36": "HEVC",
    "129": "AC-3", "135": "E-AC3", "138": "DTS", "234": "VC-1"
  };

  function levelName(levelIdc) {
    if (!levelIdc) return "";
    return String(levelIdc / 10).replace(/\.0$/, "");
  }

  // PMT + SPS'ten kodek okuma. Hata verirse null doner; stream uretimi etkilenmez.
  function parseTsCodec(buffer) {
    try {
      if (!buffer) return null;
      var a = new Uint8Array(buffer);
      var i;
      var max = Math.min(a.length, 188 * 24);

      for (i = 0; i + 188 <= max; i += 188) {
        if (a[i] !== 0x47) continue;
        var pid = ((a[i + 1] & 0x1f) << 8) | a[i + 2];
        var afc = (a[i + 3] >> 4) & 3;
        var st = i + 4;
        if (afc & 2) st = i + 5 + a[i + 4];
        if (!(afc & 1)) continue;
        if (st >= i + 188 || st + 2 >= i + 188) continue;
        var s = st + 1 + a[st]; // pointer_field
        if (s + 12 >= i + 188) continue;
        if (a[s] === 0x02) { // PMT
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
                if (a[d] === 0x28 && a[d + 1] >= 4) { // AVC video descriptor
                  profile = a[d + 2];
                  level = levelName(a[d + 3]);
                }
                d += 2 + a[d + 1];
              }
            } else if (/Audio|AAC|AC-3|DTS|MP3/i.test(name)) {
              if (!audio) audio = name;
              var q = p + 5, qEnd = Math.min(p + 5 + esLen, end);
              while (q + 2 <= qEnd) {
                if (a[q] === 0x0a && a[q + 1] >= 2) { // ISO 639 language
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
          var vLabel = video;
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
      h.Range = "bytes=0-65535";
      return requestBuffer(seg, { headers: h }, 0).then(parseTsCodec);
    }).catch(function () { return null; });
  }

  function parsePlayerConfig(html) {
    var out = { audio: [], captions: {} };
    var am = String(html || "").match(/var\s+defaultAudio\s*=\s*\[([^\]]*)\]/i);
    if (am) {
      var items = am[1].split(",");
      for (var i = 0; i < items.length; i++) {
        var v = items[i].replace(/["'\s]/g, "");
        if (v) out.audio.push(v);
      }
    }
    var cm = String(html || "").match(/var\s+defaultCaptions\s*=\s*\{([^}]*)\}/i);
    if (cm) {
      var re = /["']?([a-z-]{2,8})["']?\s*:\s*["']([^"']*)["']/gi, m;
      while ((m = re.exec(cm[1])) !== null) out.captions[m[1].toLowerCase()] = m[2].toLowerCase();
    }
    return out;
  }

  function langName(code) {
    var map = { tur: "tr", tr: "tr", eng: "en", en: "en", und: "und" };
    return map[String(code || "").toLowerCase()] || String(code || "").toLowerCase();
  }

  // -------------------------------------------------------------- stream uretimi

  function buildStream(variant, info, master, codec, config, label, lng) {
    lng = lng || "";
    var isDub = lng === "tur" || /dublaj|dub/i.test(label) || /icon_flag_tr/.test(label);
    var isSub = lng === "trsub" || /altyaz/i.test(label);
    var isOrig = lng === "orig" || /orjinal|original/i.test(label);
    var audioLangs = config.audio.length ? config.audio.map(langName) : [];
    var captionLangs = [];
    for (var k in config.captions) {
      if (Object.prototype.hasOwnProperty.call(config.captions, k)) {
        captionLangs.push(langName(k));
      }
    }

    // `lng` oynaticida ses/altyazi secimi yapar; HLS URL'si degismez.
    // Nuvio'da dogru dil etiketini ve aciklamayi uretiriz.
    var language = isDub || isSub ? "tr" : (info.originalLanguage || (audioLangs.length ? audioLangs[0] : "en"));

    var h = variant.height ? parseInt(variant.height, 10) : 0;
    var bw = variant.bandwidth ? parseInt(variant.bandwidth, 10) : 0;
    var quality = qualityFrom(h, bw);
    if (info.quality) quality = info.quality;

    var codecTag = codec && codec.tag ? codec.tag : "";
    if (!codecTag && variant.codecs) {
      var cd = String(variant.codecs).toLowerCase();
      var v = /hvc1|hev1|hevc/.test(cd) ? "HEVC" : (/av01/.test(cd) ? "AV1" : (/avc1|avc3|avc/.test(cd) ? "H.264" : ""));
      var au = /ec-3|eac3/.test(cd) ? "E-AC3" : (/ac-3/.test(cd) ? "AC-3" : (/mp4a|aac/.test(cd) ? "AAC" : ""));
      codecTag = [v, au].filter(function (x) { return !!x; }).join(" | ");
    }

    var tags = [];
    if (isDub) tags.push("TR Dublaj");
    if (isSub) tags.push("TR Altyazı");
    if (isOrig) tags.push("Orjinal Dil");
    if (audioLangs.length) tags.push("Ses: " + unique(audioLangs).join("/"));
    if (master.subtitles.length) tags.push("Alt: " + unique(captionLangs).join("/"));
    else if (isSub) tags.push("Gömülü alt: tr");
    if (codecTag) tags.push(codecTag);
    if (quality && quality !== "Auto") tags.push(quality);

    var baseTitle = (info.titles[0] || info.title || "") + (info.year ? " (" + info.year + ")" : "");
    var title = baseTitle + " [" + tags.join(" | ") + "]";

    var subs = [];
    for (var i = 0; i < master.subtitles.length; i++) {
      var sub = master.subtitles[i];
      if (!sub.url) continue;
      var u = resolveUrl(master.url, sub.url);
      subs.push({
        url: u,
        language: langName(sub.language),
        name: sub.name,
        headers: { "User-Agent": UA, "Referer": variant.url }
      });
    }

    return {
      name: "SinemaCC " + label + (codecTag ? " " + codecTag : ""),
      title: title,
      url: variant.url,
      quality: quality,
      isM3u8: true,
      type: "hls",
      language: language,
      provider: "sinemacc",
      headers: { "User-Agent": UA, "Referer": variant.url },
      subtitles: subs,
      _dub: isDub,
      _sub: isSub,
      _audioLangs: unique(audioLangs),
      _captionLangs: unique(captionLangs),
      _codec: codecTag,
      _quality: quality
    };
  }

  function buildAllStreams(page, info) {
    var out = [];
    function next(i) {
      if (i >= page.buttons.length) return Promise.resolve(out);
      var btn = page.buttons[i];
      return resolvePlayer(btn.playerUrl).then(function (resolved) {
        if (!resolved) return next(i + 1);
        var playerHeaders = { "User-Agent": UA, "Referer": BASE + "/" };
        var config = { audio: [], captions: {} };
        return requestText(resolved.playerUrl, { headers: playerHeaders }, 1).then(function (phtml) {
          if (phtml) config = parsePlayerConfig(phtml);
          return requestText(resolved.url, { headers: { "User-Agent": UA, "Referer": resolved.playerUrl } }, 1);
        }).then(function (masterText) {
          if (!masterText) return next(i + 1);
          var master = parseMaster(masterText, resolved.url);
          if (!master.variants.length) return next(i + 1);

          var v = null, bestBw = -1;
          for (var j = 0; j < master.variants.length; j++) {
            var bw = parseInt(master.variants[j].BANDWIDTH || master.variants[j].BW || "0", 10) || 0;
            if (bw > bestBw) { bestBw = bw; v = master.variants[j]; }
          }
          if (!v) v = master.variants[0];
          v.height = (v.RESOLUTION.match(/\d+x(\d+)/i) || [])[1] || "";
          v.bandwidth = v.BANDWIDTH || v.BW || "";
          v.codecs = v.CODECS || "";

          var headers = { "User-Agent": UA, "Referer": resolved.playerUrl };
          return probeCodec(v.url, headers).then(function (codec) {
            var streamInfo = {
              titles: info.titles,
              year: info.year,
              title: page.title,
              quality: page.quality,
              originalLanguage: info.originalLanguage
            };
            out.push(buildStream(v, streamInfo, master, codec, config, btn.label, resolved.lng));
            return next(i + 1);
          });
        });
      });
    }
    return next(0);
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    if (mediaType === "tv" || mediaType === "series") {
      console.log(TAG + " sinemacc film-only provider");
      return Promise.resolve([]);
    }
    var apiKey = getTmdbKey(settings);
    if (!apiKey) return Promise.resolve([]);

    return fetchTmdbInfo(apiKey, tmdbId).then(function (info) {
      if (!info || !info.titles.length) {
        console.log(TAG + " TMDB bilgisi alinamadi");
        return [];
      }
      console.log(TAG + " Araniyor: " + info.titles[0] + (info.year ? " (" + info.year + ")" : ""));
      return findPage(info, tmdbId).then(function (page) {
        if (!page) {
          console.log(TAG + " Uygun film sayfasi bulunamadi");
          return [];
        }
        console.log(TAG + " Sayfa: " + page.url + " | kaynak: " + page.buttons.length);
        return buildAllStreams(page, info);
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
      // Sadece Node regresyon testleri icin; Nuvio calisma zamaninda kullanilmaz.
      _test: {
        normTitle: normTitle,
        atobSafe: atobSafe,
        parseSearch: parseSearch,
        parsePage: parsePage,
        parseMaster: parseMaster,
        parsePlayerConfig: parsePlayerConfig,
        parseTsCodec: parseTsCodec,
        score: score,
        qualityFrom: qualityFrom
      }
    };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
