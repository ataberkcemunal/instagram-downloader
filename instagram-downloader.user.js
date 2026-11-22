// ==UserScript==
// @name         Instagram Downloader
// @version      1.1
// @description  Adds download buttons to photos, videos, stories and profile pictures on Instagram.
// @match        https://www.instagram.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @sandbox      raw
// @inject-into  page
// @run-at       document-idle
// ==/UserScript==
/*
 * Instagram Downloader
 *
 * Adds buttons to every photo, video (posts, Reels, stories) and profile picture on Instagram:
 * next to Save in posts, in the right-hand column in Reels, beside the controls at the top right of
 * stories, and on a small floating bar elsewhere. The buttons are attached to Instagram's
 * elements with CSS anchor positioning, so they scroll and swipe with the media. Floating bars
 * over grid tiles, media in messages and the profile picture appear while the pointer is over
 * them; the others are always shown.
 *
 *   Download     Saves the photo at its largest size, or the video with its audio track,
 *                named after the account.
 *   First frame  Story videos only (stories, highlights, stories shared in messages): saves
 *                the first frame at the video's own resolution.
 *   Cover        Reel previews (profile grid, Reels tab, Explore, Reels shared in messages)
 *                and the posts gallery: saves the cover picture Instagram shows before the
 *                video plays.
 *   Open         Opens the media in its own tab. Click a photo to zoom; in a video tab,
 *                S saves the video and, for a story, F saves the first frame.
 *   Posts        On a profile, a round button beside the Posts tab's icon: opens a tab with
 *                its posts as cards, each holding every photo and video of the post (all photos
 *                of a multi-photo post side by side) at full resolution. More load as the tab is
 *                scrolled; a switch shows only multi-photo posts.
 *   Highlights   A circle ("All") first in the row of highlights: opens a tab with every
 *                highlight, named after it, holding its uncropped cover and all its photos and
 *                videos at full resolution, each with open and download buttons (and first
 *                frame for videos).
 *
 * As a bookmarklet, each click turns the toolbars on or off. As a userscript (AUTO_START),
 * they appear on their own when Instagram loads.
 *
 * Every comment is a block comment and every statement ends with a semicolon, so the code
 * still runs when a browser collapses the bookmarklet onto a single line.
 */
(() => {
  "use strict";

  const AUTO_START = true;
  const APP_ID = "936619743392459";
  const HOST_TAG = "instagram-downloader";

  /* ---------- What was downloaded ---------- */

  /* Downloads are remembered, so their Download buttons turn Instagram's red (as a liked heart
     does) and still download again when clicked: "m:<media id>" a photo or video (each photo of
     a multi-photo post has its own), "f:<file>" a photo whose media id isn't known, "u:<username>"
     a profile picture, "h:<highlight id>" a highlight's cover. A story is remembered for a day
     (it is gone after that), anything else for good. They are kept in Tampermonkey's storage
     when it is granted (it survives clearing Instagram's site data), one value per download,
     "d:<key>", each the time it is forgotten or null for never; otherwise in IndexedDB. */
  const DAY = 24 * 60 * 60 * 1000;
  const STORE = "downloaded";
  const downloaded = new Map();
  const isDownloaded = key => {
    if (!key || !downloaded.has(key)) return false;
    const until = downloaded.get(key);
    return until === null || until > Date.now();
  };
  const gm = typeof GM_getValue === "function" && typeof GM_setValue === "function" &&
    typeof GM_listValues === "function" && typeof GM_deleteValue === "function";

  /* Buttons that change colour once downloaded, painted again on every scan (a carousel's
     button follows the photo shown) and once the saved downloads have been read. */
  const paintable = new Set();
  const repaintAll = () => {
    for (const button of paintable) {
      if (!button.isConnected && button.painted) paintable.delete(button);
      else button.repaint();
    }
  };

  const request = r => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  /* Reads every saved download, dropping those whose time is up; with Tampermonkey's storage,
     anything left in IndexedDB is moved there and the database deleted. */
  const database = (async () => {
    const now = Date.now();
    const keep = (key, until) => {
      if (until !== null && until <= now) return false;
      if (!downloaded.has(key)) downloaded.set(key, until);
      return true;
    };
    let db = null;
    try {
      if (gm) {
        for (const name of GM_listValues()) {
          if (name.startsWith("d:") && !keep(name.slice(2), GM_getValue(name, null))) GM_deleteValue(name);
        }
      }
      const open = indexedDB.open("instagramDownloader", 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      db = await request(open);
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const keys = await request(store.getAllKeys());
      const values = await request(store.getAll());
      keys.forEach((key, index) => {
        if (!keep(key, values[index])) store.delete(key);
        else if (gm) GM_setValue("d:" + key, values[index]);
      });
      if (gm) {
        db.close();
        indexedDB.deleteDatabase("instagramDownloader");
        db = null;
      }
    } catch (error) {
      console.warn("[Instagram Downloader] couldn't read the list of downloads", error);
    } finally {
      repaintAll();
    }
    return db;
  })();

  function markDownloaded(key, story) {
    if (!key) return;
    const until = story ? Date.now() + DAY : null;
    downloaded.set(key, until);
    if (gm) {
      GM_setValue("d:" + key, until);
      return;
    }
    database.then(db => {
      if (db) db.transaction(STORE, "readwrite").objectStore(STORE).put(until, key);
    }).catch(error => console.warn("[Instagram Downloader] couldn't remember the download", error));
  }
  const LAYER_TAG = "instagram-downloader-layer";
  const RESERVED_PATHS = ["explore", "reels", "direct", "stories", "accounts", "p", "reel", "tv", "about", "legal"];

  /* ---------- General helpers ---------- */

  const pathOf = url => {
    try {
      return new URL(url, location.href).pathname;
    } catch (error) {
      return null;
    }
  };

  const fileOf = url => pathOf(url)?.split("/").pop() || null;

  const widest = list => [...list].sort((a, b) => (b.width || 0) - (a.width || 0))[0];

  /* Local date and time, now or of a given date, such as "2026-11-12 14.05.30". */
  const fileStamp = (now = new Date()) => {
    const pad = number => String(number).padStart(2, "0");
    return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + " " +
      pad(now.getHours()) + "." + pad(now.getMinutes()) + "." + pad(now.getSeconds());
  };

  const extensionOf = type =>
    ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" })[type] || "jpg";

  const isStoryPage = () => /^\/stories\//.test(location.pathname);

  /* Whether a media object is a story (only stories get a first frame button): it is marked
     "story", has a time it expires at, or its picture links to a story. Reels never are. */
  const isStoryItem = (item, element) => item?.product_type !== "clips" && !element?.closest('a[href*="/reel/"]') &&
    (item?.product_type === "story" || !!item?.expiring_at || !!element?.closest('a[href*="/stories/"]'));

  /* Text made safe for a file name: no characters file systems refuse, at most 60 characters. */
  const cleanName = text => (text || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

  /* Waits in whichever window runs its timers sooner: this one or a tab of ours (a gallery).
     Chrome slows down the timers of a tab in the background (after five minutes, to once a
     minute), and the gallery and the Instagram tab it was opened from take turns being in front;
     a gallery that waited on Instagram's timers alone stalled while it was being looked at. */
  const waitIn = (tab, ms) => new Promise(resolve => {
    setTimeout(resolve, ms);
    try {
      if (tab && !tab.closed) tab.setTimeout(resolve, ms);
    } catch (ignored) {}
  });

  function fetchBlob(url) {
    return fetch(url).then(response => {
      if (!response.ok) throw new Error("Download failed (" + response.status + ").");
      return response.blob();
    });
  }

  /* Instagram is built with React, and React attaches its own data (a "fiber") to each element.
     Details such as video addresses are not in the page but can be found there. */
  function getReactFiber(element) {
    if (!element) return null;
    const key = Object.keys(element).find(name => name.includes("Instance") || name.includes("Fiber"));
    return key ? element[key] || null : null;
  }

  /* Looks for a named prop on the React components above an element. */
  function findProp(element, name, levels = 12) {
    let fiber = getReactFiber(element);
    for (let level = 0; fiber && level < levels; level++, fiber = fiber.return) {
      const value = fiber.memoizedProps?.[name];
      if (value) return value;
    }
    return null;
  }

  /* The part of an element inside the viewport, or null when none of it is. */
  function visibleRect(element) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, innerWidth);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, innerHeight);
    return right > left && bottom > top ? { left, right, top, bottom } : null;
  }

  /* The part of an element left after clipping by ancestors that hide overflow, such as profile
     grid tiles and carousel frames. */
  function clippedBox(element) {
    const rect = element.getBoundingClientRect();
    let box = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const clip = node.getBoundingClientRect();
      box = {
        left: Math.max(box.left, clip.left),
        right: Math.min(box.right, clip.right),
        top: Math.max(box.top, clip.top),
        bottom: Math.min(box.bottom, clip.bottom),
      };
      if (box.right <= box.left || box.bottom <= box.top) return null;
    }
    return box;
  }

  /* Instagram keeps the previous and next stories, and other carousel items, in the page while
     hiding them (hidden, transparent or hidden from screen readers). With "strict" off, the
     screen reader flag is ignored. */
  function isShown(element, strict) {
    if (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      return false;
    }
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.5) return false;
      if (strict && node.getAttribute("aria-hidden") === "true") return false;
    }
    return true;
  }

  /* Avatars and small images are not content: tiny images, images directly inside a span or link,
     and images in a header. */
  function isProfileImage(image) {
    return image.getAttribute("data-testid") === "user-avatar" ||
      image.width < 48 ||
      image.parentElement?.localName === "span" ||
      image.parentElement?.localName === "a" ||
      !!image.closest("header");
  }

  /* Whether an element is a visible photo or video worth downloading. isProfileImage is not used
     for videos because video.width is usually 0. */
  function isUsableMedia(element, strict) {
    if (element.getBoundingClientRect().height < 150) return false;
    if (element.tagName === "VIDEO") return isShown(element, strict);
    if (element.tagName !== "IMG") return false;
    const src = element.currentSrc || element.src;
    return !!src && !src.startsWith("data:") && element.complete && element.naturalWidth > 0 &&
      !isProfileImage(element) && isShown(element, strict);
  }

  /* Usable media stacked at a point, topmost first. The browser leaves out clipped elements. */
  function mediaAtPoint(x, y) {
    return document.elementsFromPoint(x, y).filter(element => isUsableMedia(element, false));
  }

  /* ---------- Media data ---------- */

  /* Instagram media objects (those with image_versions2) in the React props above an element,
     nearest first, with the component level they were found at. */
  function collectMediaItems(element, maxLevels = 40) {
    const skippedKeys = new Set(["_owner", "return", "child", "sibling", "stateNode", "alternate"]);
    const found = [];
    const seen = new Set();
    let level = 0;
    const visit = (value, depth) => {
      if (!value || typeof value !== "object" || depth > 5 || seen.has(value) || seen.size > 8000) return;
      if (value instanceof Node) return;
      seen.add(value);
      if (value.image_versions2?.candidates?.length) found.push({ item: value, level });
      for (const key in value) {
        if (skippedKeys.has(key)) continue;
        try {
          visit(value[key], depth + 1);
        } catch (error) {}
      }
    };
    try {
      let fiber = getReactFiber(element);
      for (; fiber && level < maxLevels; level++, fiber = fiber.return) visit(fiber.memoizedProps, 0);
    } catch (error) {}
    return found;
  }

  const codeOfPath = path => path?.match(/\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/)?.[1] || null;

  /* The code (/p/CODE/) of the post a media belongs to. In a post window it is the page address,
     which always names the open post. In the feed it is the first post link in the media's
     article: the post's own link (its timestamp) comes before the caption and comments.
     Elsewhere (a post page, Reels) it is the page address. */
  function postCodeOf(element) {
    if (element.closest('[role="dialog"]')) {
      const fromPage = codeOfPath(location.pathname);
      if (fromPage) return fromPage;
    }
    const link = element.closest("article")?.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    return codeOfPath(link?.getAttribute("href")) || codeOfPath(location.pathname);
  }

  /* The media object of a video: one matching its manifest or address exactly, otherwise the
     object of the video's own post, found by the post's code. Nothing else is guessed: in the
     feed, the nearest media object may belong to a neighbouring post. Null when it can't be told. */
  function findVideoItem(video) {
    const found = collectMediaItems(video);
    const manifest = findProp(video, "manifest");
    const knownPaths = [video.currentSrc, video.src, findProp(video, "fallbackSrc")]
      .filter(url => url && !url.startsWith("blob:"))
      .map(pathOf);
    const exact = found.find(({ item }) =>
      (manifest && item.video_dash_manifest === manifest) ||
      (item.video_versions || []).some(version => knownPaths.includes(pathOf(version.url))));
    if (exact) return exact.item;
    const code = postCodeOf(video);
    const post = code && found.find(({ item }) => item.code === code);
    return post ? pickMatchingVideo([post.item], manifest) : null;
  }

  /* The media object of a photo: one whose size candidates include this photo's file. */
  function findImageItem(image) {
    const file = fileOf(image.currentSrc || image.src);
    const matches = ({ item }) => item.image_versions2.candidates.some(candidate => fileOf(candidate.url) === file);
    return collectMediaItems(image).find(matches)?.item || null;
  }

  /* The address of a photo's largest size. The page loads photos at the size they are drawn;
     every size of the same file (srcset and Instagram's data) is gathered and the widest wins. */
  function largestImageUrl(image, item) {
    const url = image.currentSrc || image.src;
    const file = fileOf(url);
    const options = [{ url, width: image.naturalWidth }];
    for (const part of (image.srcset || "").split(",")) {
      const [source, descriptor] = part.trim().split(/\s+/);
      if (source) options.push({ url: source, width: parseInt(descriptor) || 0 });
    }
    for (const candidate of item?.image_versions2?.candidates || []) {
      if (fileOf(candidate.url) === file) options.push(candidate);
    }
    return widest(options.filter(option => fileOf(option.url) === file)).url;
  }

  function parseManifest(manifest) {
    return new DOMParser().parseFromString(manifest, "text/xml");
  }

  /* The best video file in the DASH manifest. These files carry picture only (audio is a
     separate file), so this is the last resort. */
  function bestDashUrl(manifest) {
    const representations = [...parseManifest(manifest).querySelectorAll('Representation[mimeType="video/mp4"]')]
      .map(representation => ({
        hd: representation.getAttribute("FBQualityClass") === "hd",
        bandwidth: parseInt(representation.getAttribute("bandwidth")) || 0,
        url: representation.querySelector("BaseURL")?.textContent?.trim(),
      }))
      .filter(representation => representation.url)
      .sort((a, b) => (b.hd - a.hd) || (b.bandwidth - a.bandwidth));
    return representations[0]?.url || null;
  }

  /* The separate audio file in the DASH manifest. */
  function dashAudioUrl(manifest) {
    const xml = parseManifest(manifest);
    const audio = xml.querySelector('Representation[mimeType="audio/mp4"]') ||
      xml.querySelector('AdaptationSet[mimeType="audio/mp4"] Representation');
    return audio?.querySelector("BaseURL")?.textContent?.trim() || null;
  }

  /* File paths in a manifest. Signatures in the addresses change on every request but the paths
     stay the same, so paths tell whether two manifests describe the same video. */
  function manifestPaths(manifest) {
    return [...parseManifest(manifest).querySelectorAll("BaseURL")]
      .map(node => pathOf(node.textContent.trim()))
      .filter(Boolean);
  }

  /* The media object (or carousel item) that belongs to a video. Without a manifest match, the
     only video item is used when there is exactly one, but only if allowSingle says the items
     all come from the video's own post. */
  function pickMatchingVideo(items, manifest, allowSingle = true) {
    const parts = items.flatMap(item => [item, ...(item.carousel_media || [])])
      .filter(part => part.video_versions?.length);
    if (manifest) {
      const paths = manifestPaths(manifest);
      const match = parts.find(part => part.video_dash_manifest === manifest ||
        paths.some(path => (part.video_dash_manifest || "").includes(path)));
      if (match) return match;
    }
    return allowSingle && parts.length === 1 ? parts[0] : null;
  }

  /* Media data embedded in the page (script type="application/json") when a page is opened
     directly. The home page embeds other posts too, so only an exact manifest match or the
     video's own post (by its code) counts. */
  function findItemInPageData(manifest, code) {
    const items = [];
    const walk = (value, depth) => {
      if (!value || typeof value !== "object" || depth > 60) return;
      if ((Array.isArray(value.video_versions) && value.video_versions.length) || Array.isArray(value.carousel_media)) items.push(value);
      for (const key in value) walk(value[key], depth + 1);
    };
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (!script.textContent.includes("video_versions")) continue;
      try {
        walk(JSON.parse(script.textContent), 0);
      } catch (error) {}
    }
    const exact = manifest && pickMatchingVideo(items, manifest, false);
    if (exact) return exact;
    const post = code && items.find(item => item.code === code);
    return post ? pickMatchingVideo([post], manifest) : null;
  }

  /* Converts a post code (/p/CODE/) to Instagram's numeric media id. */
  function shortcodeToPk(code) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let pk = 0n;
    for (const char of code.slice(0, 11)) pk = pk * 64n + BigInt(alphabet.indexOf(char));
    return pk.toString();
  }

  /* A video's media id: from the story address (/stories/name/ID/) or its post's code. */
  function findMediaPk(video) {
    const story = location.pathname.match(/^\/stories\/(?!highlights\/)[^/]+\/(\d+)/);
    if (story) return story[1];
    const code = postCodeOf(video);
    return code ? shortcodeToPk(code) : null;
  }

  /* The media info endpoint used by Instagram's own web app. It works with the signed-in session
     and includes the video file with audio. */
  function fetchItemInfo(video, manifest) {
    const pk = findMediaPk(video);
    if (!pk) return Promise.resolve(null);
    return fetch("/api/v1/media/" + pk + "/info/", { credentials: "include", headers: { "X-IG-App-ID": APP_ID } })
      .then(response => response.ok ? response.json() : null)
      .then(data => pickMatchingVideo(data?.items || [], manifest))
      .catch(() => null);
  }

  /* For story videos, the address is in the React data of the outermost <section> around it. */
  function storyVideoUrl(video) {
    try {
      const sections = [];
      for (let node = video.parentElement; node; node = node.parentElement) {
        if (node.nodeName === "SECTION") sections.push(node);
      }
      const fiber = getReactFiber(sections[sections.length - 1]);
      return fiber?.return?.return?.return?.memoizedProps?.post?.videoUrl || null;
    } catch (error) {
      return null;
    }
  }

  /* A downloadable video address with audio. The video in the page usually plays from a "blob:"
     address that can't be downloaded, and the files in its manifest have no audio. In order:
     the video's real address, React data, embedded page data, the media info endpoint, the story
     data and the player's fallback address. If none is found, the best picture-only file is
     returned together with the separate audio file. */
  async function resolveVideo(video, item) {
    if (video.src && !video.src.startsWith("blob:")) return { url: video.src, item };
    const manifest = findProp(video, "manifest");
    if (!item?.video_versions?.length) item = findItemInPageData(manifest, postCodeOf(video)) || item;
    if (!item?.video_versions?.length) item = (await fetchItemInfo(video, manifest)) || item;
    if (item?.video_versions?.length) return { url: widest(item.video_versions).url, item };
    const fallback = storyVideoUrl(video) || findProp(video, "fallbackSrc");
    if (fallback) return { url: fallback, item };
    if (manifest) return { url: bestDashUrl(manifest), audioUrl: dashAudioUrl(manifest), item };
    return { url: null, item };
  }

  /* ---------- Joining picture and sound ---------- */

  /* When Instagram only offers a video as DASH, picture and sound are two separate fragmented
     MP4 files. They are joined here into one MP4 without re-encoding: the sound's track is added
     to the picture's header (moov) with its own track number, and the fragments (moof + mdat) of
     both are laid out together in time order. Only box headers and a few numbers change. */

  const boxType = (bytes, at) => String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);

  /* The boxes between start and end: type, where it starts, its size and header size. */
  function readBoxes(bytes, start = 0, end = bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const boxes = [];
    for (let at = start; at + 8 <= end;) {
      let size = view.getUint32(at);
      let header = 8;
      if (size === 1) {
        size = Number(view.getBigUint64(at + 8));
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header || at + size > end) break;
      boxes.push({ type: boxType(bytes, at), start: at, size, header });
      at += size;
    }
    return boxes;
  }

  const childBoxes = (bytes, box) => readBoxes(bytes, box.start + box.header, box.start + box.size);
  const findBox = (boxes, type) => boxes.find(box => box.type === type);
  const boxBytes = (bytes, box) => bytes.slice(box.start, box.start + box.size);

  /* A box path such as ["mdia", "mdhd"] below a box. */
  function boxAt(bytes, box, path) {
    for (const type of path) {
      box = box && findBox(childBoxes(bytes, box), type);
    }
    return box || null;
  }

  function makeBox(type, parts) {
    const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index);
    let at = 8;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  const view32 = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  /* A file's track: its number (in tkhd), its time scale (in mdhd) and its fragments, each a moof
     box with the mdat after it, and the time it starts at in seconds. */
  function readTrackFile(bytes) {
    const top = readBoxes(bytes);
    const moov = findBox(top, "moov");
    const trak = moov && findBox(childBoxes(bytes, moov), "trak");
    const tkhd = trak && boxAt(bytes, trak, ["tkhd"]);
    const mdhd = trak && boxAt(bytes, trak, ["mdia", "mdhd"]);
    if (!tkhd || !mdhd) throw new Error("Not an MP4 track.");
    const view = view32(bytes);
    const tkhdVersion = bytes[tkhd.start + 8];
    const trackIdAt = tkhd.start + 12 + (tkhdVersion === 1 ? 16 : 8);
    const mdhdVersion = bytes[mdhd.start + 8];
    const timescale = view.getUint32(mdhd.start + 12 + (mdhdVersion === 1 ? 16 : 8)) || 1;
    const fragments = [];
    top.forEach((box, index) => {
      if (box.type !== "moof") return;
      const mdat = top.slice(index + 1).find(next => next.type === "mdat" || next.type === "moof");
      if (!mdat || mdat.type !== "mdat") return;
      const tfdt = boxAt(bytes, box, ["traf", "tfdt"]);
      let time = 0;
      if (tfdt) {
        time = bytes[tfdt.start + 8] === 1 ? Number(view.getBigUint64(tfdt.start + 12)) : view.getUint32(tfdt.start + 12);
      }
      fragments.push({ bytes, moof: box, mdat, time: time / timescale });
    });
    if (!fragments.length) throw new Error("Not a fragmented MP4.");
    return { bytes, top, moov, trak, trackId: view.getUint32(trackIdAt), trackIdAt: trackIdAt - trak.start, fragments };
  }

  /* One MP4 with the picture's track and the sound's track. */
  function joinVideoAndAudio(videoBuffer, audioBuffer) {
    const video = readTrackFile(new Uint8Array(videoBuffer));
    const audio = readTrackFile(new Uint8Array(audioBuffer));
    const videoId = video.trackId;
    const audioId = videoId + 1;

    /* The sound's track, renumbered. */
    const audioTrak = boxBytes(audio.bytes, audio.trak);
    view32(audioTrak).setUint32(audio.trackIdAt, audioId);

    /* mvhd: the next free track number comes after the sound's. */
    const moovChildren = childBoxes(video.bytes, video.moov);
    const mvhdBox = findBox(moovChildren, "mvhd");
    const mvhd = boxBytes(video.bytes, mvhdBox);
    view32(mvhd).setUint32(mvhd.length - 4, audioId + 1);

    /* mvex: the picture's defaults (and duration) plus the sound's, renumbered. */
    const videoMvex = findBox(moovChildren, "mvex");
    const audioMvex = findBox(childBoxes(audio.bytes, audio.moov), "mvex");
    const mvexParts = videoMvex ? childBoxes(video.bytes, videoMvex).map(box => boxBytes(video.bytes, box)) : [];
    for (const box of audioMvex ? childBoxes(audio.bytes, audioMvex) : []) {
      if (box.type !== "trex") continue;
      const trex = boxBytes(audio.bytes, box);
      view32(trex).setUint32(12, audioId);
      mvexParts.push(trex);
    }
    const moov = makeBox("moov", [
      mvhd,
      ...moovChildren.filter(box => box.type === "trak").map(box => boxBytes(video.bytes, box)),
      audioTrak,
      makeBox("mvex", mvexParts),
      ...moovChildren.filter(box => !["mvhd", "trak", "mvex"].includes(box.type)).map(box => boxBytes(video.bytes, box)),
    ]);
    const ftypBox = findBox(video.top, "ftyp");
    const ftyp = ftypBox ? boxBytes(video.bytes, ftypBox) : new Uint8Array(0);

    /* Fragments in time order (picture first when they start together), renumbered; the sound's
       carry the sound's track number. A fragment that names its data's position in the file
       (base_data_offset) is moved by as much as its moof moves. */
    const fragments = [
      ...video.fragments.map(fragment => ({ ...fragment, audio: false })),
      ...audio.fragments.map(fragment => ({ ...fragment, audio: true })),
    ].sort((a, b) => a.time - b.time || a.audio - b.audio);
    const parts = [ftyp, moov];
    let at = ftyp.length + moov.length;
    fragments.forEach((fragment, index) => {
      const { bytes } = fragment;
      const moof = boxBytes(bytes, fragment.moof);
      const view = view32(moof);
      const shift = at - fragment.moof.start;
      for (const box of readBoxes(moof, 8, moof.length)) {
        if (box.type === "mfhd") view.setUint32(box.start + 12, index + 1);
        if (box.type !== "traf") continue;
        const tfhd = findBox(readBoxes(moof, box.start + 8, box.start + box.size), "tfhd");
        if (!tfhd) continue;
        if (fragment.audio) view.setUint32(tfhd.start + 12, audioId);
        if (view.getUint32(tfhd.start + 8) & 0x000001) {
          view.setBigUint64(tfhd.start + 16, view.getBigUint64(tfhd.start + 16) + BigInt(shift));
        }
      }
      const mdat = bytes.subarray(fragment.mdat.start, fragment.mdat.start + fragment.mdat.size);
      /* The data must follow its moof directly, as in the original file. */
      if (fragment.mdat.start !== fragment.moof.start + fragment.moof.size) {
        throw new Error("Unexpected layout between moof and mdat.");
      }
      parts.push(moof, mdat);
      at += moof.length + mdat.length;
    });
    return new Blob(parts, { type: "video/mp4" });
  }

  /* The video as one file: as it is, or picture and sound joined. Null for audio when they were
     joined; if joining fails, the two files are returned separately so that nothing is lost. */
  async function fetchVideoFile(url, audioUrl) {
    if (!audioUrl) return { video: await fetchBlob(url), audio: null };
    const [video, audio] = await Promise.all([fetchBlob(url), fetchBlob(audioUrl)]);
    try {
      return { video: joinVideoAndAudio(await video.arrayBuffer(), await audio.arrayBuffer()), audio: null };
    } catch (error) {
      console.warn("[Instagram Downloader] Couldn't join picture and sound:", error);
      return { video, audio };
    }
  }

  const profileNameOf = href => {
    const name = href?.match(/^\/([A-Za-z0-9._]+)\/?$/)?.[1];
    return name && !RESERVED_PATHS.includes(name) ? name : null;
  };

  /* The account whose profile is open, on any of its tabs: posts (/name/), Reels (/name/reels/),
     reposts, tagged and saved. Null on other pages. */
  const PROFILE_TABS = ["reels", "reposts", "tagged", "saved", "feed", "igtv", "guides", "channel"];
  const profileOfPage = () => {
    const [, name, tab] = location.pathname.match(/^\/([A-Za-z0-9._]+)(?:\/([a-z_]+))?\/?$/) || [];
    return name && !RESERVED_PATHS.includes(name) && (!tab || PROFILE_TABS.includes(tab)) ? name : null;
  };

  /* The outermost element around a media that is about the media's own size: the box that
     holds the media and anything drawn over it, such as the labels of people tagged in it. */
  function mediaBoxOf(element) {
    const rect = element.getBoundingClientRect();
    let box = element;
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const outer = node.getBoundingClientRect();
      if (Math.abs(outer.width - rect.width) > 8 || Math.abs(outer.height - rect.height) > 8) break;
      box = node;
    }
    return box;
  }

  /* The first profile link in a scope, skipping links on the media itself: those are the people
     tagged in the photo, not its owner. */
  function firstProfileName(scope, media) {
    const box = media ? mediaBoxOf(media) : null;
    const area = media ? media.getBoundingClientRect() : null;
    for (const link of scope.querySelectorAll('a[href^="/"]')) {
      const name = profileNameOf(link.getAttribute("href"));
      if (!name) continue;
      if (box?.contains(link)) continue;
      const rect = link.getBoundingClientRect();
      const onMedia = area && rect.width > 0 && rect.left < area.right && rect.right > area.left && rect.top < area.bottom && rect.bottom > area.top;
      if (!onMedia) return name;
    }
    return null;
  }

  /* The owner in React data: the media's own user, or, for one slide of a carousel (whose items
     carry no user), the user of the post that holds it. */
  function ownerFromItem(element, item) {
    const own = item?.user?.username || item?.owner?.username;
    if (own || !item || !element) return own || null;
    for (const { item: post } of collectMediaItems(element)) {
      const slides = post.carousel_media || [];
      const holds = slides.some(slide => slide === item || (slide.pk && slide.pk === item.pk) || (slide.id && slide.id === item.id));
      if (holds) return post.user?.username || post.owner?.username || null;
    }
    return null;
  }

  /* The account name for file names: from Instagram's data for the media, the story address, or
     the profile links around the media. In a post or post window, the first profile link that is
     not on the media is the owner's; links on the media are people tagged in it. A carousel's
     slides are list items too, so a list item counts as a comment only when it holds a profile
     link of its own away from the media. Elsewhere, the nearest ancestor holding a profile link
     is used. */
  function findUsername(element, item) {
    const fromItem = ownerFromItem(element, item);
    if (fromItem) return fromItem;
    const story = location.pathname.match(/^\/stories\/([^/]+)\//);
    if (story && story[1] !== "highlights") return story[1];
    const post = element?.closest('article, [role="dialog"]');
    /* Media posted in a comment belongs to the comment's author. */
    const comment = element?.closest("li");
    const fromComment = post && comment && post.contains(comment) && firstProfileName(comment, element);
    if (fromComment) return fromComment;
    const fromPost = post && firstProfileName(post, element);
    if (fromPost) return fromPost;
    for (let node = element?.parentElement; node && node !== document.body; node = node.parentElement) {
      const name = firstProfileName(node, element);
      if (name) return name;
      if (node.matches("main")) break;
    }
    return profileOfPage() || "instagram";
  }

  /* An account's profile page, fetched once and shared by the name and profile picture lookups. */
  const profilePages = new Map();
  function fetchProfilePage(username) {
    if (!profilePages.has(username)) {
      profilePages.set(username, fetch("/" + username + "/", { credentials: "include" })
        .then(response => response.ok ? response.text() : "")
        .catch(() => ""));
    }
    return profilePages.get(username);
  }

  /* A page title like "Display Name (@username) • Instagram photos and videos". */
  const titleMatch = title => title?.match(/^(.*?) \(@([A-Za-z0-9._]+)\)/);

  /* An account's display name: from the media object, the current profile page's title, or the
     title of the account's profile page. Empty when the account has none. */
  const displayNames = new Map();
  async function displayNameOf(username, item) {
    for (const user of [item?.user, item?.owner]) {
      if (user?.username === username && typeof user.full_name === "string") return user.full_name;
    }
    if (!displayNames.has(username)) {
      let match = titleMatch(document.title);
      if (match?.[2] !== username) {
        const html = await fetchProfilePage(username);
        const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || "";
        match = titleMatch(new DOMParser().parseFromString(title, "text/html").documentElement.textContent.trim());
      }
      displayNames.set(username, match?.[2] === username ? match[1] : "");
    }
    return displayNames.get(username);
  }

  /* The start of a file name: "username (Display Name)", without characters that file systems
     don't allow. */
  async function fileBase(username, item) {
    const fullName = cleanName(await displayNameOf(username, item));
    return fullName && fullName.toLowerCase() !== username.toLowerCase() ? username + " (" + fullName + ")" : username;
  }

  /* ---------- Icons and buttons ---------- */

  /* Line icons on a 24 px grid, drawn like Instagram's own: 2 px rounded strokes in the current
     text colour. */
  const ICONS = {
    download: ["M12 3.5v11", "m7.5 10.5 4.5 4.5 4.5-4.5", "M4 16.5v2A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-2"],
    frame: ["M5 3.5h14A1.5 1.5 0 0 1 20.5 5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z", "M9 7.5a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5z", "m20.5 15.5-4.8-4.8a1.5 1.5 0 0 0-2.1 0L4 20.3"],
    /* A picture with a play sign: a Reel's or video's cover image. */
    cover: ["M5 3.5h14A1.5 1.5 0 0 1 20.5 5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z", "M10 8.6v6.8l5.4-3.4z"],
    /* A box with an arrow leaving its top right corner: open in a new tab. */
    open: ["M11 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V13", "M14.5 3.5h6v6", "m20.5 3.5-9 9"],
    /* A bare arrow pointing up and right: the same, for the round All posts button. */
    arrow: ["M6.5 17.5 17.5 6.5", "M8.5 6.5h9v9"],
    /* Two photos, one behind the other: all posts, with every photo of multi-photo posts. */
    stack: ["M8.5 7.5h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z", "M3.5 15.5v-10a2 2 0 0 1 2-2h10", "m6.5 17.5 3.8-3.8a1.5 1.5 0 0 1 2.1 0l4 4"],
    /* A highlight circle: all highlights. */
    ring: ["M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z", "M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"],
    busy: ["M12 3a9 9 0 1 0 9 9"],
    done: ["m5 12.5 4.5 4.5L19 7"],
  };

  function icon(doc, name) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const data of ICONS[name]) {
      const path = doc.createElementNS(namespace, "path");
      path.setAttribute("d", data);
      svg.append(path);
    }
    return svg;
  }

  const BUTTON_CSS = [
    "button{all:unset;box-sizing:border-box;display:grid;place-items:center;cursor:pointer;color:inherit;",
    "transition:opacity .15s,background .15s,transform .1s}",
    "button:active{transform:scale(.88)}",
    /* Downloaded already: Instagram's red, as a liked heart. */
    "button.downloaded{color:#ff3040}",
    "button:focus-visible{outline:2px solid currentColor;outline-offset:2px}",
    "svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    "button.busy svg{animation:spin .8s linear infinite}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
  ].join("");

  /* Buttons placed among Instagram's own (next to Save): no background, same size and colour. */
  const ACTION_CSS = BUTTON_CSS + [
    ":host{all:initial;display:flex;align-items:center}",
    ".bar{display:flex;align-items:center;gap:var(--gap)}",
    ".bar.column{flex-direction:column}",
    "button{width:var(--size);height:var(--size)}",
    "button:hover{opacity:.5}",
    "svg{width:var(--icon,24px);height:var(--icon,24px)}",
    ".bar.story svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}",
  ].join("");

  /* Floating bar over media that has no action row: profile grid, comments, stories, profile
     pictures, and the opened tab. */
  const PILL_CSS = BUTTON_CSS + [
    ":host{all:initial}",
    ".bar{position:absolute;display:flex;gap:2px;padding:3px;border-radius:999px;pointer-events:auto;color:#fff;",
    "background:rgba(22,22,22,.55);-webkit-backdrop-filter:blur(14px) saturate(1.6);backdrop-filter:blur(14px) saturate(1.6);",
    "box-shadow:0 2px 12px rgba(0,0,0,.22),inset 0 0 0 .5px rgba(255,255,255,.18)}",
    ".bar.column{flex-direction:column}",
    /* --dx, --dy, --dr and --db move a hover-only bar into the visible part of media that is
       partly off screen or cut off (set by startButtons). */
    ".bar.post{left:calc(10px + var(--dx,0px));top:calc(10px + var(--dy,0px))}",
    /* Bars over tiles, messages and the profile picture show only while the pointer is over the
       media (data-hover, set by startButtons) or a button has keyboard focus. */
    ":host([data-hover-only]) .bar{opacity:0;pointer-events:none;transition:opacity .15s}",
    ":host([data-hover-only][data-hover]) .bar,:host([data-hover-only]) .bar:has(:focus-visible){opacity:1;pointer-events:auto}",
    ".bar.story{right:10px;top:50%;transform:translateY(-50%)}",
    ".bar.avatar-left{left:var(--dx,0px);bottom:var(--db,0px)}",
    ".bar.avatar-right{right:var(--dr,0px);bottom:var(--db,0px)}",
    /* A highlight's circle: one small button centred on its bottom edge, half below it, so the
       cover stays in sight. */
    ".bar.highlight{left:50%;bottom:0;transform:translate(-50%,50%);padding:2px}",
    ".bar.highlight button{width:28px;height:28px}",
    ".bar.highlight svg{width:16px;height:16px}",
    ".bar.tab{position:static}",
    ".bar.profile button{width:30px;height:30px}",
    ".bar.profile svg{width:17px;height:17px}",
    "button{width:34px;height:34px;border-radius:999px}",
    "button:hover{background:rgba(255,255,255,.16)}",
    "svg{width:19px;height:19px;stroke-width:1.9}",
  ].join("");

  /* A button that runs an action. While a returned promise is pending a spinner shows, then a
     check mark; an error is reported. Actions that return nothing (opening a tab) run inside
     the click, so popup blockers allow them. A download button gets done: { key, story }, two
     functions naming what it saves (looked up each time: a carousel's button follows the photo
     shown) and whether that is a story; once saved, the button turns red and stays so. */
  function makeButton(win, iconName, label, action, done) {
    const doc = win.document;
    const button = doc.createElement("button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon(doc, iconName));
    const setIcon = name => button.replaceChildren(icon(doc, name));
    button.repaint = () => {
      button.painted = true;
      if (!done || button.classList.contains("busy")) return;
      let key = null;
      try {
        key = done.key();
      } catch (ignored) {}
      const downloadedAlready = isDownloaded(key);
      button.classList.toggle("downloaded", downloadedAlready);
      button.title = downloadedAlready ? label + " · Downloaded, click to download again" : label;
      button.setAttribute("aria-label", button.title);
    };
    if (done) {
      paintable.add(button);
      button.repaint();
    }
    button.addEventListener("click", event => {
      event.preventDefault();
      if (button.classList.contains("busy")) return;
      let result;
      try {
        result = action();
      } catch (error) {
        result = Promise.reject(error);
      }
      if (!(result instanceof Promise)) return;
      /* What is being saved, named now: a carousel may have moved on by the time it is done. */
      let key = null;
      let story = false;
      try {
        key = done?.key();
        story = !!done?.story?.();
      } catch (ignored) {}
      button.classList.add("busy");
      setIcon("busy");
      result.then(
        () => {
          /* Remembered, then painted at once, so the check mark already shows in red. */
          markDownloaded(key, story);
          button.classList.remove("busy");
          button.repaint();
          setIcon("done");
          setTimeout(() => {
            setIcon(iconName);
            button.repaint();
          }, 1200);
        },
        error => {
          button.classList.remove("busy");
          setIcon(iconName);
          console.error("[Instagram Downloader]", error);
          win.alert(error?.message || "Download failed.");
        });
    });
    return button;
  }

  /* A shadow-root host holding bars of buttons, so Instagram's styles can't change them.
     bars: [[bar class, [[icon, label, action, done], …]], …]. */
  function makeHost(win, css, bars) {
    const doc = win.document;
    const host = doc.createElement(HOST_TAG);
    const root = host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = css;
    root.append(style);
    for (const [barClass, buttons] of bars) {
      const bar = doc.createElement("div");
      bar.className = "bar " + barClass;
      for (const [iconName, label, action, done] of buttons) bar.append(makeButton(win, iconName, label, action, done));
      root.append(bar);
    }
    return host;
  }

  /* Pointer and click events stop at our buttons: tapping them doesn't pause or advance a story,
     open a post or follow a grid tile's link. */
  function isolateEvents(host) {
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "click", "dblclick", "contextmenu"]) {
      host.addEventListener(type, event => {
        event.stopPropagation();
        if (type === "click" || type === "dblclick") event.preventDefault();
      });
    }
  }

  /* ---------- Opening in a tab ---------- */

  /* Opened at once, before any waiting, so popup blockers allow it; filled in later. A tab can be
     opened from another tab of ours (from) as well. */
  function openLoadingTab(from = window) {
    const tab = from.open("about:blank", "_blank");
    if (!tab) {
      from.alert("Allow pop-ups for instagram.com to open media in a new tab.");
      return null;
    }
    tab.document.title = "Loading…";
    tab.document.body.style.cssText =
      "margin:0;min-height:100vh;background:#111;color:#888;font:14px -apple-system,sans-serif;" +
      "display:flex;align-items:center;justify-content:center";
    tab.document.body.textContent = "Loading…";
    return tab;
  }

  /* Runs the handler when a plain letter key is pressed (no Command, Ctrl or Alt). */
  function onKey(doc, letter, handler) {
    doc.addEventListener("keydown", event => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === letter) {
        event.preventDefault();
        handler();
      }
    });
  }

  /* Saves a blob from a window. The file is fetched first so the given name applies: a link to
     another site's address ignores the download name. */
  function saveBlob(win, blob, name) {
    const doc = win.document;
    const url = win.URL.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = url;
    link.download = name;
    doc.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => win.URL.revokeObjectURL(url), 60000);
  }

  /* The bottom 80 px are kept free for the tab's buttons. */
  function prepareTab(doc, title) {
    doc.title = title;
    doc.body.textContent = "";
    doc.body.style.cssText =
      "margin:0;min-height:100vh;box-sizing:border-box;padding-bottom:80px;background:#111;color:#ccc;" +
      "font:14px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center";
  }

  /* The tab's buttons, fixed at the bottom centre so they stay in reach while a photo is zoomed.
     Returns the buttons so keys can press them. */
  function addTabButtons(tab, buttons) {
    const host = makeHost(tab, PILL_CSS, [["tab", buttons]]);
    host.style.cssText = "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:1";
    tab.document.body.append(host);
    return [...host.shadowRoot.querySelectorAll("button")];
  }

  const extensionFromUrl = url => (pathOf(url)?.match(/\.(jpe?g|png|webp|gif|heic)$/i)?.[1] || "jpg").toLowerCase().replace("jpeg", "jpg");

  /* Shows a photo or frame in the tab, from a blob or, when the file couldn't be fetched, from
     its address. The button or S saves it. Clicking zooms to full size (twice the size for small
     photos) keeping the clicked point under the pointer; clicking again fits it. */
  function showImage(tab, { blob, url }, namePrefix) {
    if (tab.closed) return;
    const name = namePrefix + " " + fileStamp() + "." + (blob ? extensionOf(blob.type) : extensionFromUrl(url));
    const doc = tab.document;
    prepareTab(doc, name);
    const image = doc.createElement("img");
    image.src = blob ? tab.URL.createObjectURL(blob) : url;
    const fitStyle = "max-width:100vw;max-height:calc(100vh - 80px);object-fit:contain;cursor:zoom-in";
    image.style.cssText = fitStyle;
    doc.body.append(image);

    let zoomed = false;
    image.addEventListener("click", event => {
      const rect = image.getBoundingClientRect();
      const ratioX = (event.clientX - rect.left) / rect.width;
      const ratioY = (event.clientY - rect.top) / rect.height;
      zoomed = !zoomed;
      if (!zoomed) {
        doc.body.style.alignItems = doc.body.style.justifyContent = "center";
        image.style.cssText = fitStyle;
        return;
      }
      const width = Math.max(image.naturalWidth, rect.width * 2);
      /* margin:auto in the flex body keeps a zoomed photo that still fits the window centred (a
         small photo stayed where it was instead of jumping to the top), while one larger than the
         window starts at the edge and can be scrolled to every side; centring it with
         justify-content would cut off its top and left. */
      doc.body.style.alignItems = doc.body.style.justifyContent = "flex-start";
      image.style.cssText = "flex:none;margin:auto;max-width:none;max-height:none;cursor:zoom-out;width:" + width + "px";
      const zoomedRect = image.getBoundingClientRect();
      const scroller = doc.scrollingElement;
      scroller.scrollLeft = ratioX * zoomedRect.width - event.clientX;
      scroller.scrollTop = ratioY * zoomedRect.height - event.clientY;
    });

    const save = async () => {
      const file = blob || await fetchBlob(url).catch(() => {
        throw new Error("Couldn't download this file. Right-click the image and choose \"Save Image As\".");
      });
      saveBlob(tab, file, name);
    };
    const [downloadButton] = addTabButtons(tab, [["download", "Download (S)", save]]);
    onKey(doc, "s", () => downloadButton.click());
    tab.focus();
  }

  /* Fetches a photo and shows it; if it can't be fetched, it is shown from its address. The tab
     never navigates to the file itself, which some files would turn into a download. */
  function showImageUrl(tab, url, namePrefix) {
    fetchBlob(url)
      .then(blob => showImage(tab, { blob }, namePrefix))
      .catch(() => showImage(tab, { url }, namePrefix));
  }

  /* Captures a video's first frame as a PNG at the video's own resolution, waiting for the video
     to load if needed. Afterwards the video continues from where it was. A video loaded from
     another site without permission (CORS) can't be captured, which rejects. */
  function captureFirstFrame(video) {
    return new Promise((resolve, reject) => {
      const wasPlaying = !video.paused;
      const startTime = video.currentTime;
      let timer;
      const finish = (error, blob) => {
        clearTimeout(timer);
        video.removeEventListener("seeked", drawWhenReady);
        video.removeEventListener("loadeddata", start);
        try {
          video.currentTime = startTime;
          if (wasPlaying) video.play().catch(() => {});
        } catch (ignored) {}
        if (error) reject(error);
        else resolve(blob);
      };
      /* A video that has never played can draw as an empty (transparent) image; if the centre
         pixel is empty, the capture counts as failed. */
      const draw = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const context = canvas.getContext("2d");
          context.drawImage(video, 0, 0);
          const alpha = context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3];
          if (!alpha) throw new Error("The frame came out empty.");
          canvas.toBlob(blob => finish(blob ? null : new Error("Couldn't create the image."), blob), "image/png");
        } catch (error) {
          finish(error);
        }
      };
      /* Seeking to 0 even when already there makes the browser prepare the first frame. It is
         drawn once ready, or after 300 ms at the latest. */
      const drawWhenReady = () => {
        let drawn = false;
        const once = () => {
          if (!drawn) {
            drawn = true;
            draw();
          }
        };
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(once);
        setTimeout(once, 300);
      };
      const start = () => {
        video.pause();
        video.addEventListener("seeked", drawWhenReady, { once: true });
        video.currentTime = 0;
      };
      timer = setTimeout(() => finish(new Error("Couldn't reach the video's first frame.")), 10000);
      if (video.readyState >= 2 && video.videoWidth) start();
      else video.addEventListener("loadeddata", start, { once: true });
    });
  }

  /* Plays the video in the tab. Download (or S) saves the video; first frame (or F) saves its
     first frame, taken from the tab's player, then the video on the Instagram page, then
     Instagram's full-size cover image. */
  function showVideo(tab, url, base, source) {
    if (tab.closed) return;
    const stamp = fileStamp();
    const name = base + " " + stamp + ".mp4";
    const doc = tab.document;
    prepareTab(doc, name);

    const player = doc.createElement("video");
    /* Loaded with CORS so frames can be captured. If the server refuses, it reloads without CORS;
       if it still won't play, a message says so (the buttons keep working). */
    player.crossOrigin = "anonymous";
    player.src = url;
    player.controls = true;
    player.autoplay = true;
    player.style.cssText = "max-width:100vw;max-height:calc(100vh - 80px)";
    player.addEventListener("error", () => {
      if (player.crossOrigin) {
        player.removeAttribute("crossorigin");
        player.src = url;
      } else {
        player.replaceWith(doc.createTextNode("This video can't be played here, but it can still be downloaded."));
      }
    });
    doc.body.append(player);

    /* Browsers start a video with sound on their own only after the person has interacted with
       the page, and this tab is new. So playing is first tried with sound; if that is refused,
       the video plays muted and the sound comes on at the first click or key press in the tab. */
    const unmute = () => {
      player.muted = false;
      doc.removeEventListener("pointerdown", unmute, true);
      doc.removeEventListener("keydown", unmute, true);
    };
    const startPlaying = () => {
      player.play().catch(() => {
        player.muted = true;
        player.play().catch(() => {});
        doc.addEventListener("pointerdown", unmute, true);
        doc.addEventListener("keydown", unmute, true);
      });
    };
    player.addEventListener("loadeddata", startPlaying);

    /* Without a file that has audio, picture and audio are separate: the audio plays in sync, and
       saving joins them into one file. */
    if (source.audioUrl) {
      const audio = doc.createElement("audio");
      audio.src = source.audioUrl;
      const sync = () => {
        if (Math.abs(audio.currentTime - player.currentTime) > 0.3) audio.currentTime = player.currentTime;
      };
      player.addEventListener("play", () => {
        sync();
        audio.play().catch(() => {});
      });
      player.addEventListener("pause", () => audio.pause());
      player.addEventListener("seeked", sync);
      player.addEventListener("ratechange", () => { audio.playbackRate = player.playbackRate; });
      player.addEventListener("volumechange", () => {
        audio.volume = player.volume;
        audio.muted = player.muted;
        if (!player.paused && audio.paused) audio.play().catch(() => {});
      });
      if (!player.paused) audio.play().catch(() => {});
      doc.body.append(audio);
    }

    let file = null;
    const saveVideo = async () => {
      file = file || await fetchVideoFile(url, source.audioUrl).catch(() => {
        throw new Error("Couldn't download the video. Right-click it and choose \"Save Video As\".");
      });
      saveBlob(tab, file.video, name);
      if (file.audio) saveBlob(tab, file.audio, base + " " + stamp + " audio.m4a");
    };
    const saveFrame = () => {
      const attempts = [
        () => captureFirstFrame(player),
        () => source.video?.isConnected ? captureFirstFrame(source.video) : Promise.reject(),
        () => source.cover ? fetchBlob(source.cover) : Promise.reject(),
      ];
      return attempts.reduce((previous, attempt) => previous.catch(attempt), Promise.reject())
        .catch(() => { throw new Error("Couldn't capture the first frame."); })
        .then(blob => saveBlob(tab, blob, base + " " + stamp + " first frame." + extensionOf(blob.type)));
    };

    /* The first frame only for stories (source.story). */
    const [downloadButton, frameButton] = addTabButtons(tab, [
      ["download", "Download video (S)", saveVideo],
      ...(source.story ? [["frame", "Download first frame as a photo (F)", saveFrame]] : []),
    ]);
    onKey(doc, "s", () => downloadButton.click());
    if (frameButton) onKey(doc, "f", () => frameButton.click());
    tab.focus();
  }

  /* Opens a photo or video in its own tab. Must run inside the click, with no waiting first, or
     the popup blocker stops the tab. */
  function openMedia(media) {
    const tab = openLoadingTab();
    if (!tab) return;
    if (media.tagName !== "VIDEO") {
      const item = findImageItem(media);
      /* A video's cover (a story shared in messages) opens the video. */
      imageVideoSource(media).then(async source => {
        if (source) {
          return showVideo(tab, source.url, await fileBase(findUsername(media, source.item), source.item),
            { cover: source.cover, story: isStoryItem(source.item, media) });
        }
        showImageUrl(tab, largestImageUrl(media, item), await fileBase(findUsername(media, item), item));
      });
      return;
    }
    resolveVideo(media, findVideoItem(media)).then(async ({ url, audioUrl, item }) => {
      const base = await fileBase(findUsername(media, item), item);
      const candidates = item?.image_versions2?.candidates || [];
      const cover = candidates.length ? widest(candidates).url : null;
      if (url) return showVideo(tab, url, base, { video: media, cover, audioUrl, story: isStoryPage() || isStoryItem(item, media) });
      /* Without a video address, at least the first frame is shown. */
      captureFirstFrame(media)
        .catch(() => cover ? fetchBlob(cover) : Promise.reject())
        .then(blob => showImage(tab, { blob }, base + " first frame"))
        .catch(() => {
          if (!tab.closed) tab.close();
          alert("Couldn't get the video or its first frame. Try again once the video starts playing.");
        });
    });
  }

  /* ---------- Downloading ---------- */

  async function downloadMedia(media) {
    const stamp = fileStamp();
    if (media.tagName === "VIDEO") {
      const { url, audioUrl, item } = await resolveVideo(media, findVideoItem(media));
      if (!url) throw new Error("Couldn't find the video's address. Try again once it starts playing.");
      const base = await fileBase(findUsername(media, item), item);
      /* Picture and sound in separate files are joined into one. */
      const file = await fetchVideoFile(url, audioUrl);
      saveBlob(window, file.video, base + " " + stamp + ".mp4");
      if (file.audio) saveBlob(window, file.audio, base + " " + stamp + " audio.m4a");
      return;
    }
    /* A video's cover saves the video. */
    const source = await imageVideoSource(media);
    if (source) {
      const base = await fileBase(findUsername(media, source.item), source.item);
      saveBlob(window, await fetchBlob(source.url), base + " " + stamp + ".mp4");
      return;
    }
    const item = findImageItem(media);
    const blob = await fetchBlob(largestImageUrl(media, item));
    const base = await fileBase(findUsername(media, item), item);
    saveBlob(window, blob, base + " " + stamp + "." + extensionOf(blob.type));
  }

  /* The cover of a video shown as a preview (a tile linking to its post, such as Explore's
     playing Reel tiles): the picture Instagram shows for it before it plays. */
  async function downloadVideoCover(video) {
    let item = findVideoItem(video);
    if (!item?.image_versions2?.candidates?.length) item = (await resolveVideo(video, item)).item || item;
    const candidates = item?.image_versions2?.candidates || [];
    const url = candidates.length ? widest(candidates).url : video.poster || null;
    if (!url) throw new Error("Couldn't find this video's cover.");
    const blob = await fetchBlob(url);
    const base = await fileBase(findUsername(video, item), item);
    saveBlob(window, blob, base + " " + fileStamp() + " cover." + extensionOf(blob.type));
  }

  /* A preview: media inside a link to its post or Reel (grid and Explore tiles). */
  const isPreview = media => !!media.closest('a[href*="/p/"], a[href*="/reel/"]');

  /* The first frame of a video from its address, through a copy of the video loaded with
     permission to read its pixels (CORS). */
  async function firstFrameOfUrl(url) {
    const probe = document.createElement("video");
    probe.crossOrigin = "anonymous";
    probe.muted = true;
    probe.preload = "auto";
    probe.src = url;
    try {
      return await captureFirstFrame(probe).catch(() => {
        throw new Error("Couldn't capture the first frame.");
      });
    } finally {
      probe.removeAttribute("src");
      probe.load();
    }
  }

  /* The first frame of the video an image stands for. */
  async function downloadImageVideoFrame(image) {
    const source = await imageVideoSource(image);
    if (!source) throw new Error("This isn't a video.");
    const blob = await firstFrameOfUrl(source.url);
    const base = await fileBase(findUsername(image, source.item), source.item);
    saveBlob(window, blob, base + " " + fileStamp() + " first frame." + extensionOf(blob.type));
  }

  /* The cover of the video an image stands for (a Reel shared in messages): the full-size
     picture Instagram shows before the video plays. */
  async function downloadImageVideoCover(image) {
    const source = await imageVideoSource(image);
    if (!source?.cover) throw new Error("Couldn't find this video's cover.");
    const blob = await fetchBlob(source.cover);
    const base = await fileBase(findUsername(image, source.item), source.item);
    saveBlob(window, blob, base + " " + fileStamp() + " cover." + extensionOf(blob.type));
  }

  /* The video an image stands for, when the image is a video's cover: a story video shared in
     messages shows only its cover. Found in Instagram's data for the image, or else, for an
     image linking to a story (/stories/name/ID/), from the media info endpoint. Null for a
     photo. Worked out once per image. */
  /* The code of a Reel or post an image stands for, from a link around it or from Instagram's
     data for it and the elements around it: a shared Reel in messages carries the Reel's
     address (/reel/CODE/) or its code there, not the Reel itself. */
  function linkedPostCode(image) {
    const fromLink = codeOfPath(image.closest('a[href*="/reel/"], a[href*="/p/"]')?.getAttribute("href"));
    if (fromLink) return fromLink;
    const pattern = /(?:instagram\.com)?\/(?:reels?|p)\/([A-Za-z0-9_-]{6,})/;
    const skippedKeys = new Set(["_owner", "return", "child", "sibling", "stateNode", "alternate", "children"]);
    const seen = new Set();
    let found = null;
    const visit = (value, depth) => {
      if (found || value == null || depth > 5) return;
      if (typeof value === "string") {
        found = value.match(pattern)?.[1] || null;
        return;
      }
      if (typeof value !== "object" || value instanceof Node || seen.has(value) || seen.size > 4000) return;
      seen.add(value);
      if (typeof value.code === "string" && /^[A-Za-z0-9_-]{6,}$/.test(value.code) && (value.media_type || value.product_type || value.image_versions2)) {
        found = value.code;
        return;
      }
      for (const key in value) {
        if (skippedKeys.has(key)) continue;
        try {
          visit(value[key], depth + 1);
        } catch (error) {}
        if (found) return;
      }
    };
    try {
      let fiber = getReactFiber(image);
      for (let level = 0; fiber && level < 15 && !found; level++, fiber = fiber.return) visit(fiber.memoizedProps, 0);
    } catch (error) {}
    return found;
  }

  const imageVideoSources = new WeakMap();
  function imageVideoSource(image) {
    if (!imageVideoSources.has(image)) {
      imageVideoSources.set(image, (async () => {
        let item = findImageItem(image);
        if (!item?.video_versions?.length) {
          /* The media id: a story link's, or that of a video or Reel known from the data without
             its video address (a Reel shared in messages). */
          const isVideo = item && (item.media_type === 2 || item.product_type === "clips");
          const storyLink = image.closest('a[href*="/stories/"]');
          let id = storyLink?.getAttribute("href").match(/\/stories\/[^/]+\/(\d+)/)?.[1] ||
            (isVideo ? String(item.pk || String(item.id || "").split("_")[0] || (item.code ? shortcodeToPk(item.code) : "")) : "");
          /* Otherwise the Reel or post the image stands for, by its code. As that code is looked
             for around the image, it is only used if the Reel's cover is the image's own file. */
          let mustMatch = false;
          if (!id && !storyLink) {
            const code = linkedPostCode(image);
            if (code) {
              id = shortcodeToPk(code);
              mustMatch = true;
            }
          }
          if (id && /^\d+$/.test(id)) {
            const data = await fetch("/api/v1/media/" + id + "/info/", { credentials: "include", headers: { "X-IG-App-ID": APP_ID } })
              .then(response => response.ok ? response.json() : null)
              .catch(() => null);
            const fetched = data?.items?.[0];
            const file = fileOf(image.currentSrc || image.src);
            const sameCover = candidate => fileOf(candidate.url) === file;
            if (fetched && (!mustMatch || [fetched, ...(fetched.carousel_media || [])]
              .some(part => (part.image_versions2?.candidates || []).some(sameCover)))) item = fetched;
          }
        }
        if (!item?.video_versions?.length) return null;
        const covers = item.image_versions2?.candidates || [];
        return { item, url: widest(item.video_versions).url, cover: covers.length ? widest(covers).url : null };
      })().catch(() => null));
    }
    return imageVideoSources.get(image);
  }

  /* A story video's first frame; failing that, Instagram's full-size cover image for the story. */
  async function downloadFirstFrame(video) {
    const stamp = fileStamp();
    let item = findVideoItem(video);
    let blob;
    try {
      blob = await captureFirstFrame(video);
    } catch (error) {
      item = (await resolveVideo(video, item)).item || item;
      const candidates = item?.image_versions2?.candidates || [];
      if (!candidates.length) throw new Error("Couldn't capture the first frame.");
      blob = await fetchBlob(widest(candidates).url);
    }
    const base = await fileBase(findUsername(video, item), item);
    saveBlob(window, blob, base + " " + stamp + " first frame." + extensionOf(blob.type));
  }

  /* ---------- Reel tiles ---------- */

  /* A profile's Reels tab shows each Reel as a link whose cover is a background picture: there
     is no photo or video in the page to take. Each Reel's details are fetched by its code, once,
     when one of its buttons is used. */
  const REEL_TILE = 'a[href*="/reel/"]';

  /* The Reel tile a photo or video belongs to: a link to a Reel that it fills (at least half of
     it), such as a tile of a profile's posts grid or of Explore. Null for anything else. */
  function reelTileOf(media) {
    const link = media.closest(REEL_TILE);
    if (!link) return null;
    const box = link.getBoundingClientRect();
    const rect = media.getBoundingClientRect();
    return box.width >= 80 && box.height >= 80 && rect.width * rect.height >= box.width * box.height * 0.5 ? link : null;
  }
  const reelInfos = new Map();
  function reelTileSource(link) {
    const code = link.getAttribute("href").match(/\/reel\/([A-Za-z0-9_-]+)/)?.[1];
    if (!code) return Promise.reject(new Error("Couldn't find this Reel."));
    if (!reelInfos.has(code)) {
      reelInfos.set(code, fetch("/api/v1/media/" + shortcodeToPk(code) + "/info/", { credentials: "include", headers: { "X-IG-App-ID": APP_ID } })
        .then(response => response.ok ? response.json() : null)
        .then(async data => {
          const item = data?.items?.[0];
          if (!item) throw new Error("Instagram didn't return this Reel. Try again in a moment.");
          const videos = item.video_versions || [];
          const covers = item.image_versions2?.candidates || [];
          const username = item.user?.username || profileOfPage() || "instagram";
          return {
            item,
            video: videos.length ? widest(videos).url : null,
            cover: covers.length ? widest(covers).url : null,
            base: await fileBase(username, item),
          };
        })
        .catch(error => {
          reelInfos.delete(code);
          throw error;
        }));
    }
    return reelInfos.get(code);
  }

  function openReelTile(link) {
    const tab = openLoadingTab();
    if (!tab) return;
    reelTileSource(link).then(({ video, cover, base }) => {
      if (video) showVideo(tab, video, base, { cover, story: false });
      else if (cover) showImageUrl(tab, cover, base + " cover");
      else throw new Error("Couldn't find this Reel's video.");
    }).catch(error => {
      if (!tab.closed) tab.close();
      alert(error.message);
    });
  }

  async function downloadReelTile(link) {
    const { video, base } = await reelTileSource(link);
    if (!video) throw new Error("Couldn't find this Reel's video.");
    saveBlob(window, await fetchBlob(video), base + " " + fileStamp() + ".mp4");
  }

  async function downloadReelTileCover(link) {
    const { cover, base } = await reelTileSource(link);
    if (!cover) throw new Error("Couldn't find this Reel's cover.");
    const blob = await fetchBlob(cover);
    saveBlob(window, blob, base + " " + fileStamp() + " cover." + extensionOf(blob.type));
  }

  /* ---------- Profile pictures ---------- */

  /* The large profile picture on a profile page ("…'s profile picture", or its translation; on
     the viewer's own profile "Change profile photo", or its translation). */
  function isAvatar(image) {
    return /profile (picture|photo)|profil (resmi|fotoğraf)|foto (del|de|do) perfil|photo de profil|profilbild|profilfoto|(immagine|foto) del profilo/i.test(image.alt || "") &&
      image.getBoundingClientRect().width >= 80 &&
      !!image.closest("header") && !image.closest(HIGHLIGHT_LINK);
  }

  /* The largest profile picture (up to 1080 px). The account id comes from the profile page and
     the picture from Instagram's user info endpoint, which doesn't always answer; then null. */
  async function fetchHdAvatarUrl(username) {
    try {
      const html = await fetchProfilePage(username);
      const pk = html.match(/"profile_id":"(\d+)"/)?.[1];
      if (!pk) return null;
      const response = await fetch("/api/v1/users/" + pk + "/info/", { credentials: "include", headers: { "X-IG-App-ID": APP_ID } });
      if (!response.ok) return null;
      const user = (await response.json()).user;
      if (user?.username !== username) return null;
      return user.hd_profile_pic_url_info?.url || user.profile_pic_url_hd || null;
    } catch (error) {
      return null;
    }
  }

  /* This account's 320 px profile picture from the data embedded in the page, if present. */
  function pageDataAvatarUrl(username) {
    let found = null;
    const walk = (value, depth) => {
      if (found || !value || typeof value !== "object" || depth > 60) return;
      if (value.username === username && value.profile_pic_url_hd) found = value.profile_pic_url_hd;
      for (const key in value) walk(value[key], depth + 1);
    };
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (!script.textContent.includes("profile_pic_url_hd")) continue;
      try {
        walk(JSON.parse(script.textContent), 0);
      } catch (error) {}
    }
    return found;
  }

  async function avatarSource(image) {
    const username = profileOfPage() || "instagram";
    const url = (await fetchHdAvatarUrl(username)) || pageDataAvatarUrl(username) || largestImageUrl(image, null);
    return { username, url };
  }

  async function downloadAvatar(image) {
    const { username, url } = await avatarSource(image);
    const blob = await fetchBlob(url);
    const base = await fileBase(username, null);
    saveBlob(window, blob, base + " profile picture " + fileStamp() + "." + extensionOf(blob.type));
  }

  function openAvatar(image) {
    const tab = openLoadingTab();
    if (!tab) return;
    avatarSource(image).then(async ({ username, url }) => showImageUrl(tab, url, (await fileBase(username, null)) + " profile picture"));
  }

  /* ---------- Highlight covers ---------- */

  /* The circles of a profile's highlights link to /stories/highlights/ID/. */
  const HIGHLIGHT_LINK = 'a[href*="/stories/highlights/"]';

  /* A highlight's cover at full size. The circle shows a 150 px crop, but the highlight's own page
     names the same file, uncropped and at full size, as its preview image (og:image). That is
     used when it is the same file as the circle's; otherwise the circle's own picture. */
  const highlightCovers = new Map();
  const highlightIdOf = link => link.getAttribute("href")?.match(/highlights\/(\d+)/)?.[1] || null;
  function highlightCoverUrl(id, shown) {
    if (!id) return Promise.resolve(shown);
    if (!highlightCovers.has(id)) {
      highlightCovers.set(id, fetch("/stories/highlights/" + id + "/", { credentials: "include" })
        .then(response => response.ok ? response.text() : "")
        .then(html => {
          const preview = new DOMParser().parseFromString(html, "text/html").querySelector('meta[property="og:image"]')?.content;
          return preview && shown && fileOf(preview) === fileOf(shown) ? preview : shown;
        })
        .catch(() => shown));
    }
    return highlightCovers.get(id);
  }

  /* "username (Display Name) highlight Title". */
  async function highlightFileBase(link) {
    const username = profileOfPage() || "instagram";
    const title = cleanName(link.textContent);
    return (await fileBase(username, null)) + " highlight" + (title ? " " + title : "");
  }

  function openHighlightCover(link) {
    const tab = openLoadingTab();
    if (!tab) return;
    const image = link.querySelector("img");
    Promise.all([highlightCoverUrl(highlightIdOf(link), image ? largestImageUrl(image, null) : null), highlightFileBase(link)])
      .then(([url, base]) => showImageUrl(tab, url, base + " cover"));
  }

  /* ---------- All highlights in one tab ---------- */

  /* The request Instagram's own story viewer sends for highlights: a GraphQL query identified by
     its doc_id. It needs the page's session tokens (fb_dtsg and lsd) and the query's name in both
     the body and a header; without them Instagram answers "Not Found" or with an HTML page. */
  const HIGHLIGHTS_QUERY = {
    docId: "39990577387253622",
    name: "PolarisStoriesV3HighlightsPageQuery",
    root: "xdt_api__v1__feed__reels_media__connection",
  };

  /* Highlights asked for per request, and the pause between requests: few and slow enough that
     Instagram doesn't refuse with "too many requests" (429). */
  const HIGHLIGHTS_PER_REQUEST = 3;
  const HIGHLIGHTS_PAUSE = 1500;

  /* The session tokens, from the page's own scripts or, failing that, from a fresh copy of the
     home page. */
  let sessionTokens = null;
  async function pageTokens(fresh = false) {
    const find = text => ({
      dtsg: text.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1] || null,
      lsd: text.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1] || null,
    });
    if (fresh || !sessionTokens?.dtsg) {
      let tokens = fresh ? { dtsg: null } : find([...document.scripts].map(script => script.textContent).join("\n"));
      if (!tokens.dtsg) tokens = find(await fetch("/", { credentials: "include" }).then(response => response.text()).catch(() => ""));
      sessionTokens = tokens;
    }
    return sessionTokens;
  }

  /* Runs one of Instagram's GraphQL queries and returns its connection (edges and page_info).
     Busy answers (429, server errors) are retried twice after a longer pause (waiting in tab as
     well, see waitIn). Any other failure is retried once with fresh session tokens, as the ones
     read earlier may have expired while the page stayed open. what names the content in error
     messages. */
  async function graphqlConnection(query, variables, what, tab = null) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const { dtsg, lsd } = await pageTokens(refreshed);
      if (!dtsg) throw new Error("Couldn't read Instagram's session. Reload the page and try again.");
      const response = await graphqlRequest(query, variables, dtsg, lsd).catch(() => null);
      let data = null;
      try {
        data = response ? JSON.parse(await response.text()) : null;
      } catch (error) {}
      const connection = data?.data?.[query.root];
      if (connection?.edges) return connection;
      const status = response?.status || 0;
      if (attempt < 2 && (status === 429 || status >= 500)) {
        await waitIn(tab, 10000 * (attempt + 1));
        continue;
      }
      if (!refreshed && status !== 429) {
        refreshed = true;
        continue;
      }
      throw new Error(status === 429
        ? "Instagram is refusing requests for a while (too many). Try again in a few minutes."
        : "Instagram didn't return " + what + (data?.errors?.[0]?.summary ? " (" + data.errors[0].summary + ")" : "") + ".");
    }
  }

  function graphqlRequest(query, variables, dtsg, lsd) {
    const body = new URLSearchParams({
      fb_dtsg: dtsg,
      lsd: lsd || "",
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: query.name,
      server_timestamps: "true",
      doc_id: query.docId,
      variables: JSON.stringify(variables),
    });
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] || "",
      "X-IG-App-ID": APP_ID,
      "X-FB-Friendly-Name": query.name,
      ...(lsd ? { "X-FB-LSD": lsd } : {}),
    };
    return fetch("/graphql/query", { method: "POST", credentials: "include", headers, body });
  }

  /* The highlights with these ids, each with its title and stories, in the order asked. */
  async function fetchHighlightReels(ids, tab) {
    const reelIds = ids.map(id => "highlight:" + id);
    const connection = await graphqlConnection(HIGHLIGHTS_QUERY, {
      initial_reel_id: reelIds[0],
      reel_ids: reelIds,
      first: reelIds.length,
      __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true,
    }, "these highlights", tab);
    return connection.edges.map(edge => edge.node);
  }

  /* A story's or post's photo and, for a video, its video: the largest files Instagram has. */
  function storyMedia(item) {
    const image = widest(item.image_versions2?.candidates || []);
    const video = item.video_versions?.length ? widest(item.video_versions) : null;
    return {
      image: image?.url || null,
      video: video?.url || null,
      width: item.original_width || image?.width || 0,
      height: item.original_height || image?.height || 0,
      taken: item.taken_at ? new Date(item.taken_at * 1000) : null,
      key: keyOfItem(item),
    };
  }

  /* Every highlight of the profile, as Instagram lists them: id, title and cropped cover, in the
     profile's order. The row on the page can't be relied on for this: it holds only the circles
     in sight and a few around them. null if Instagram doesn't answer. */
  async function fetchHighlightList(username) {
    const id = (await profileInfo(username))?.id;
    if (!id) return null;
    const response = await fetch("/api/v1/highlights/" + id + "/highlights_tray/",
      { credentials: "include", headers: { "X-IG-App-ID": APP_ID } });
    const tray = response.ok ? (await response.json())?.tray : null;
    if (!Array.isArray(tray)) return null;
    return tray.map(reel => ({
      id: String(reel.id || "").replace(/^highlight:/, ""),
      title: reel.title || "",
      picture: reel.cover_media?.cropped_image_version?.url || null,
    })).filter(reel => /^\d+$/.test(reel.id));
  }

  /* The profile's highlight circles, one per highlight, in the order shown. */
  function highlightLinksIn(tray) {
    const seen = new Set();
    return [...tray.querySelectorAll(HIGHLIGHT_LINK)].filter(link => {
      const id = link.getAttribute("href").match(/highlights\/(\d+)/)?.[1];
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  const GALLERY_CSS = [
    "body{margin:0;background:#111;color:#ddd;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    "main{max-width:1600px;margin:0 auto;padding:28px 28px 80px}",
    "h1{margin:0 0 4px;font-size:22px;font-weight:600;color:#fff}",
    ".status{color:#888;margin-bottom:24px}",
    "section{margin:0 0 40px}",
    ".head{display:flex;align-items:center;gap:14px;margin:0 0 12px;position:sticky;top:0;z-index:2;padding:10px 0;background:#111}",
    ".head img{width:44px;height:44px;border-radius:50%;object-fit:cover;background:#222}",
    "h2{margin:0;font-size:17px;font-weight:600;color:#fff}",
    ".count{color:#888;font-size:13px}",
    ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;align-items:start}",
    ".tile{position:relative;border-radius:10px;overflow:hidden;background:#1d1d1d}",
    ".tile img,.tile video{display:block;width:100%;height:auto;background:#1d1d1d}",
    ".tile img{cursor:zoom-in}",
    ".tile instagram-downloader{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .15s}",
    ".tile:hover instagram-downloader,.tile:has(:focus-visible) instagram-downloader{opacity:1}",
    ".label{position:absolute;right:8px;top:8px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;pointer-events:none}",
    ".info{padding:6px 10px 8px;color:#888;font-size:12px;display:flex;justify-content:space-between;gap:8px}",
    ".note{color:#888;padding:8px 0}",
    ".filter{display:inline-flex;align-items:center;gap:6px;margin:-12px 0 24px;color:#bbb;cursor:pointer;user-select:none}",
    "main.only-multi .post.single{display:none}",
    /* Posts: a dense grid of cards, each as many cells wide as it has photos (set by layoutPosts);
       every photo in a 4:5 box like Instagram's grid, shown whole. */
    ".posts{--cell:190px;display:grid;grid-template-columns:repeat(var(--columns,4),minmax(0,1fr));grid-auto-flow:row dense;gap:14px}",
    ".post{min-width:0;padding:8px;border-radius:12px;background:#181818}",
    ".post.multi{background:#161a22;box-shadow:inset 0 0 0 1px rgba(138,180,248,.4)}",
    ".post-head{display:flex;align-items:center;gap:8px;min-height:30px;margin:0 2px 8px;font-size:12px;color:#999}",
    ".post-head .date{color:#eee;font-weight:600;white-space:nowrap}",
    ".post-head .items-count{padding:1px 7px;border-radius:999px;background:rgba(138,180,248,.18);color:#a8c7fa;font-weight:600}",
    ".post-head .spacer{flex:1}",
    ".post-head a{color:#8ab4f8;text-decoration:none;white-space:nowrap}",
    ".post-head instagram-downloader{margin-left:0!important}",
    ".post .grid{grid-template-columns:repeat(var(--span,1),minmax(0,1fr));gap:8px}",
    ".post .tile img,.post .tile video{aspect-ratio:4/5!important;object-fit:contain;background:#0b0b0b}",
    ".post .info{display:none}",
    ".titles{min-width:0}",
    ".count{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70vw}",
  ].join("");

  /* One photo or video in a gallery tab (highlights or posts), at its full resolution, with open
     and download buttons on hover. Clicking a photo opens it in its own tab, where it can be zoomed. */
  function mediaTile(tab, media, name, label, { withCover = false, story = false } = {}) {
    const doc = tab.document;
    const tile = doc.createElement("div");
    tile.className = "tile";
    let element;
    if (media.video) {
      element = doc.createElement("video");
      element.controls = true;
      element.preload = "none";
      element.playsInline = true;
      if (media.image) element.poster = media.image;
      element.src = media.video;
    } else {
      element = doc.createElement("img");
      element.loading = "lazy";
      element.decoding = "async";
      element.src = media.image;
      element.addEventListener("click", () => openOne());
    }
    if (media.width && media.height) element.style.aspectRatio = media.width + " / " + media.height;
    tile.append(element);

    const openOne = () => {
      const opened = openLoadingTab(tab);
      if (!opened) return;
      if (media.video) showVideo(opened, media.video, name, { cover: media.image, story });
      else showImageUrl(opened, media.image, name);
    };
    const save = async () => {
      if (media.video) return saveBlob(tab, await fetchBlob(media.video), name + ".mp4");
      const blob = await fetchBlob(media.image);
      saveBlob(tab, blob, name + "." + extensionOf(blob.type));
    };
    /* Saving from the tile's button or a "download all" button remembers it the same way. */
    tile.save = async () => {
      await save();
      markDownloaded(media.key, story);
      tile.querySelector(HOST_TAG)?.shadowRoot?.querySelectorAll("button").forEach(button => button.repaint?.());
    };
    /* A video's first frame at the video's own resolution, from a copy of the video loaded with
       permission to read its pixels (CORS); failing that, Instagram's full-size cover image for
       the story. */
    const saveFrame = async () => {
      const probe = document.createElement("video");
      probe.crossOrigin = "anonymous";
      probe.muted = true;
      probe.preload = "auto";
      probe.src = media.video;
      let blob;
      try {
        blob = await captureFirstFrame(probe);
      } catch (error) {
        if (!media.image) throw new Error("Couldn't capture the first frame.");
        blob = await fetchBlob(media.image);
      } finally {
        probe.removeAttribute("src");
        probe.load();
      }
      saveBlob(tab, blob, name + " first frame." + extensionOf(blob.type));
    };
    /* A post video's cover (Reels): the picture shown before it plays. */
    const saveCover = async () => {
      const blob = await fetchBlob(media.image);
      saveBlob(tab, blob, name + " cover." + extensionOf(blob.type));
    };
    const host = makeHost(tab, PILL_CSS, [["post", [
      ["open", "Open in new tab", openOne],
      ...(media.video && story ? [["frame", "Download first frame as a photo", saveFrame]] : []),
      ...(media.video && media.image && withCover ? [["cover", "Download cover", saveCover]] : []),
      ["download", media.video ? "Download video" : "Download photo", save, media.key ? { key: () => media.key, story: () => story } : null],
    ]]]);
    tile.append(host);

    if (label) {
      const badge = doc.createElement("span");
      badge.className = "label";
      badge.textContent = label;
      tile.append(badge);
    }
    const info = doc.createElement("div");
    info.className = "info";
    const when = doc.createElement("span");
    when.textContent = media.taken ? media.taken.toLocaleString() : "";
    const size = doc.createElement("span");
    size.textContent = media.width && media.height ? media.width + "×" + media.height : "";
    info.append(when, size);
    /* Where the line below is hidden (post cards), the size shows on hover. */
    if (size.textContent) tile.title = size.textContent;
    if (when.textContent || size.textContent) tile.append(info);
    return tile;
  }

  /* ---------- Gallery tabs: shared parts ---------- */

  /* Turns a loading tab into an empty gallery page with a heading and a status line. */
  function galleryPage(tab, title, heading) {
    const doc = tab.document;
    doc.title = title;
    doc.body.removeAttribute("style");
    doc.body.textContent = "";
    const style = doc.createElement("style");
    style.textContent = GALLERY_CSS;
    doc.head.append(style);
    const main = doc.createElement("main");
    const h1 = doc.createElement("h1");
    h1.textContent = heading;
    const status = doc.createElement("div");
    status.className = "status";
    main.append(h1, status);
    doc.body.append(main);
    return { doc, main, status };
  }

  /* A section of a gallery: a heading that stays at the top while scrolling (an optional round
     picture, a title and a line below it) above a grid of tiles. */
  function gallerySection(doc, parent, { picture, title, sub }) {
    const section = doc.createElement("section");
    const head = doc.createElement("div");
    head.className = "head";
    if (picture) {
      const thumb = doc.createElement("img");
      thumb.src = picture;
      head.append(thumb);
    }
    const titles = doc.createElement("div");
    titles.className = "titles";
    const heading = doc.createElement("h2");
    heading.textContent = title;
    const count = doc.createElement("div");
    count.className = "count";
    count.textContent = sub || "";
    titles.append(heading, count);
    head.append(titles);
    const grid = doc.createElement("div");
    grid.className = "grid";
    section.append(head, grid);
    parent.append(section);
    return { section, head, title: heading, count, grid };
  }

  /* A button in a section's heading that downloads every tile of the section, one after another;
     one that fails doesn't stop the rest. */
  function addDownloadAll(tab, entry, label, barClass = "tab") {
    const host = makeHost(tab, PILL_CSS, [[barClass, [["download", label, async () => {
      const all = [...entry.grid.querySelectorAll(".tile")];
      let failed = 0;
      for (const tile of all) {
        try {
          await tile.save();
        } catch (error) {
          failed++;
        }
        await waitIn(tab, 400);
      }
      if (failed) throw new Error(failed + " of " + all.length + " files couldn't be downloaded.");
    }]]]]);
    host.style.marginLeft = "auto";
    entry.head.append(host);
  }

  /* Shows why a gallery couldn't be (fully) loaded, in its status line. */
  function reportInTab(tab, error, fallback) {
    console.error("[Instagram Downloader]", error);
    if (tab.closed) return;
    const status = tab.document.querySelector(".status");
    if (status) status.textContent = error.message || fallback;
    else tab.document.body.textContent = error.message || fallback;
  }

  /* ---------- All highlights in one tab (continued) ---------- */

  /* Opens a tab with every highlight of the profile: a section per highlight, named after it,
     holding its cover (uncropped) and all its photos and videos at full resolution. Highlights
     are loaded a few at a time, in order, so Instagram isn't flooded with requests. */
  function openAllHighlights(tray) {
    const links = highlightLinksIn(tray);
    const tab = openLoadingTab();
    if (!tab) return;
    const username = profileOfPage() || "instagram";
    showAllHighlights(tab, username, links).catch(error => reportInTab(tab, error, "Couldn't load the highlights."));
  }

  async function showAllHighlights(tab, username, links) {
    const base = await fileBase(username, null);
    if (tab.closed) return;
    const { doc, main, status } = galleryPage(tab, username + " · Highlights", base + " · Highlights");
    status.textContent = "Loading the list of highlights…";

    /* The highlights Instagram lists, then any circle on the page it didn't list; only the
       circles on the page if it doesn't answer. */
    const shown = links.map(link => {
      const circle = link.querySelector("img");
      return {
        id: highlightIdOf(link),
        title: (link.textContent || "").trim(),
        picture: circle ? largestImageUrl(circle, null) || circle.currentSrc || circle.src : null,
      };
    }).filter(reel => reel.id);
    const listed = await fetchHighlightList(username).catch(() => null);
    if (tab.closed) return;
    const reels = listed?.length ? [...listed, ...shown.filter(reel => !listed.some(item => item.id === reel.id))] : shown;
    if (!reels.length) {
      status.textContent = "Couldn't find this profile's highlights. Reload the page and try again.";
      return;
    }

    /* Every section is laid out at once, in the profile's order, and filled in as its highlight
       arrives. */
    const sections = reels.map(reel => {
      const entry = gallerySection(doc, main, { picture: reel.picture, title: reel.title || "Highlight", sub: "Waiting…" });
      return { ...entry, id: reel.id, picture: reel.picture };
    });

    let stories = 0;
    for (let start = 0; start < sections.length; start += HIGHLIGHTS_PER_REQUEST) {
      if (tab.closed) return;
      const batch = sections.slice(start, start + HIGHLIGHTS_PER_REQUEST);
      status.textContent = "Loading highlights… " + start + " of " + sections.length;
      for (const entry of batch) entry.count.textContent = "Loading…";
      let nodes;
      try {
        nodes = await fetchHighlightReels(batch.map(entry => entry.id), tab);
      } catch (error) {
        for (const entry of sections.slice(start)) entry.count.textContent = "Not loaded";
        throw error;
      }
      for (const entry of batch) {
        const node = nodes.find(reel => reel.id === "highlight:" + entry.id);
        if (!node) {
          entry.count.textContent = "Couldn't load this highlight.";
          continue;
        }
        stories += fillHighlightSection(tab, entry, node, base);
        /* The uncropped cover comes from the highlight's own page: one more request each. */
        const coverName = base + " highlight" + (cleanName(node.title) ? " " + cleanName(node.title) : "") + " cover";
        const fallback = node.cover_media?.cropped_image_version?.url || null;
        const coverUrl = (await highlightCoverUrl(entry.id, entry.picture || fallback)) || fallback;
        if (coverUrl && !tab.closed) entry.grid.prepend(mediaTile(tab, { image: coverUrl }, coverName, "Cover"));
      }
      if (start + HIGHLIGHTS_PER_REQUEST < sections.length) await waitIn(tab, HIGHLIGHTS_PAUSE);
    }
    status.textContent = sections.length + (sections.length === 1 ? " highlight · " : " highlights · ") +
      stories + (stories === 1 ? " story" : " stories") + ". Click a photo to open it; hover for download buttons.";
  }

  /* Fills a highlight's section with its stories and a button that downloads them all. Returns
     the number of stories. */
  function fillHighlightSection(tab, entry, node, base) {
    const title = cleanName(node.title);
    if (node.title) entry.title.textContent = node.title;
    const items = node.items || [];
    entry.count.textContent = items.length + (items.length === 1 ? " story" : " stories");
    const prefix = base + " highlight" + (title ? " " + title : "");
    const used = new Map();
    const tiles = items.map(item => {
      const media = storyMedia(item);
      /* Named after when the story was posted; stories posted in the same second get a number. */
      let name = prefix + " " + (media.taken ? fileStamp(media.taken) : item.pk);
      const repeat = (used.get(name) || 0) + 1;
      used.set(name, repeat);
      if (repeat > 1) name += " " + repeat;
      return mediaTile(tab, media, name, media.video ? "Video" : "", { story: true });
    });
    entry.grid.append(...tiles);
    if (tiles.length) addDownloadAll(tab, entry, "Download the cover and all stories of this highlight");
    return items.length;
  }

  /* ---------- All posts in one tab ---------- */

  /* The request Instagram's profile grid sends for the next posts, 12 at a time. Each post comes
     with every photo and video of a multi-photo post (carousel_media). */
  const POSTS_QUERY = {
    docId: "29290744380560118",
    name: "PolarisProfilePostsTabContentQuery_connection",
    root: "xdt_api__v1__feed__user_timeline_graphql_connection",
  };
  const POSTS_PAUSE = 1200;

  function fetchPostsPage(username, after, tab) {
    return graphqlConnection(POSTS_QUERY, {
      after,
      before: null,
      data: {
        count: 12,
        include_reel_media_seen_timestamp: true,
        include_relationship_info: true,
        latest_besties_reel_media: true,
        latest_reel_media: true,
      },
      first: 12,
      include_multi_captions: true,
      last: null,
      username,
      __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
      __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false,
      __relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider: false,
      __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
    }, "this profile's posts", tab);
  }

  /* Opens a tab with the profile's posts, newest first (pinned posts first, as on the profile): a
     section per post with every one of its photos and videos at full resolution, so a
     multi-photo post shows all its photos side by side. More posts load as the tab is scrolled
     down; a switch hides posts with a single photo or video. */
  function openAllPosts() {
    const username = profileOfPage();
    if (!username) return;
    const tab = openLoadingTab();
    if (!tab) return;
    showAllPosts(tab, username).catch(error => reportInTab(tab, error, "Couldn't load the posts."));
  }

  async function showAllPosts(tab, username) {
    const base = await fileBase(username, null);
    if (tab.closed) return;
    const { doc, main, status } = galleryPage(tab, username + " · Posts", base + " · Posts");

    const filter = doc.createElement("label");
    filter.className = "filter";
    const onlyMulti = doc.createElement("input");
    onlyMulti.type = "checkbox";
    onlyMulti.addEventListener("change", () => main.classList.toggle("only-multi", onlyMulti.checked));
    filter.append(onlyMulti, doc.createTextNode(" Only posts with several photos or videos"));
    status.after(filter);
    const list = doc.createElement("div");
    list.className = "posts";
    main.append(list);
    tab.addEventListener("resize", () => layoutPosts(list));
    const end = doc.createElement("div");
    end.className = "note";
    main.append(end);

    /* The next page is asked for once the end of the list comes within a few screens. */
    const nearEnd = () => end.getBoundingClientRect().top < tab.innerHeight * 3;
    let posts = 0;
    let multi = 0;
    let after = null;
    for (let page = 0; ; page++) {
      if (tab.closed) return;
      while (page > 0 && !nearEnd()) {
        await waitIn(tab, 300);
        if (tab.closed) return;
      }
      end.textContent = "Loading more posts…";
      let connection;
      try {
        connection = await fetchPostsPage(username, after, tab);
      } catch (error) {
        end.textContent = "";
        if (!posts) throw error;
        reportInTab(tab, new Error(posts + " posts loaded. " + error.message), "");
        return;
      }
      for (const { node } of connection.edges) {
        if (!node) continue;
        posts++;
        if (addPostCard(tab, list, node, base) > 1) multi++;
      }
      layoutPosts(list);
      status.textContent = posts + (posts === 1 ? " post" : " posts") + " loaded, " + multi + " with several photos or videos." +
        " Click a photo to open it; hover for download buttons.";
      after = connection.page_info?.end_cursor || null;
      if (!connection.page_info?.has_next_page || !after) break;
      end.textContent = "";
      await waitIn(tab, POSTS_PAUSE);
    }
    end.textContent = posts ? "That's all the posts." : "This profile has no posts that can be shown.";
  }

  /* A post's card: one line with its date, how many photos and videos it has, a link to it and
     a button that downloads them all (the caption shows on hover), then each photo and video.
     Returns the number of photos and videos. */
  function addPostCard(tab, parent, node, base) {
    const doc = tab.document;
    const items = node.carousel_media?.length ? node.carousel_media : [node];
    const taken = node.taken_at ? new Date(node.taken_at * 1000) : null;
    const caption = (node.caption?.text || "").trim();
    const card = doc.createElement("article");
    card.className = "post " + (items.length > 1 ? "multi" : "single");
    card.dataset.count = items.length;
    const head = doc.createElement("div");
    head.className = "post-head";
    if (caption) head.title = caption;
    const date = doc.createElement("span");
    date.className = "date";
    date.textContent = taken ? taken.toLocaleDateString() : "Post";
    if (taken) date.title = taken.toLocaleString();
    head.append(date);
    if (items.length > 1) {
      const count = doc.createElement("span");
      count.className = "items-count";
      count.textContent = items.length;
      count.title = items.length + " photos and videos";
      head.append(count);
    }
    const spacer = doc.createElement("span");
    spacer.className = "spacer";
    head.append(spacer);
    if (node.code) {
      const link = doc.createElement("a");
      link.href = "https://www.instagram.com/p/" + node.code + "/";
      link.target = "_blank";
      link.rel = "noopener";
      link.title = "Open the post on Instagram";
      link.textContent = "Post ↗";
      head.append(link);
    }
    const grid = doc.createElement("div");
    grid.className = "grid";
    card.append(head, grid);
    parent.append(card);

    /* Named after when the post was published; the photos of a multi-photo post are numbered. */
    const stamp = taken ? fileStamp(taken) : node.code || node.pk;
    items.forEach((item, index) => {
      const media = storyMedia(item);
      const name = base + " " + stamp + (items.length > 1 ? " " + (index + 1) : "");
      const label = (items.length > 1 ? index + 1 + "/" + items.length : "") +
        (media.video ? (items.length > 1 ? " · " : "") + "Video" : "");
      grid.append(mediaTile(tab, { ...media, taken }, name, label, { withCover: true }));
    });
    addDownloadAll(tab, { head, grid }, items.length > 1 ? "Download all photos and videos of this post" : "Download", "tab small");
    return items.length;
  }

  /* Lays the post cards out on the grid: as many columns as fit, and each card as wide as its
     photos, up to the whole row; a card with more photos than fit in a row wraps them inside. */
  function layoutPosts(list) {
    const style = list.ownerDocument.defaultView.getComputedStyle(list);
    const gap = parseFloat(style.columnGap) || 0;
    const cell = parseFloat(style.getPropertyValue("--cell")) || 190;
    const columns = Math.max(1, Math.floor((list.clientWidth + gap) / (cell + gap)));
    list.style.setProperty("--columns", columns);
    for (const card of list.children) {
      const span = Math.min(columns, Number(card.dataset.count) || 1);
      if (card.style.getPropertyValue("--span") !== String(span)) {
        card.style.setProperty("--span", span);
        card.style.gridColumn = "span " + span;
      }
    }
  }

  /* ---------- The row of highlights ---------- */

  /* The row of highlight circles on a profile page: the nearest element holding all of them that
     scrolls or clips sideways, or else the nearest holding them all. */
  function highlightTray() {
    if (isStoryPage() || !profileOfPage()) return null;
    const links = [...document.querySelectorAll(HIGHLIGHT_LINK)];
    if (!links.length) return null;
    let common = links[0].parentElement;
    while (common && !links.every(link => common.contains(link))) common = common.parentElement;
    if (!common || common === document.body) return null;
    for (let node = common, level = 0; node && node !== document.body && level < 5; node = node.parentElement, level++) {
      if (getComputedStyle(node).overflowX !== "visible") return node;
    }
    return common;
  }

  /* ---------- The profile's Posts and Highlights buttons ---------- */

  /* Whether a box of the page holds nothing but background: no text, picture or control. */
  function isEmptyArea(left, top, right, bottom) {
    if (left < 0 || top < 0 || right > innerWidth || bottom > innerHeight) return false;
    for (let x = left; x <= right; x += 8) {
      for (let y = top; y <= bottom; y += 8) {
        const element = document.elementsFromPoint(x, y).find(item => !item.closest(LAYER_TAG));
        if (!element || element.closest('img, video, a, button, [role="button"], svg, input, textarea, span, h1, h2, h3')) return false;
      }
    }
    return true;
  }

  /* The profile's header (picture, name, counts), for a profile without highlights. */
  function profileHeader() {
    if (isStoryPage() || !profileOfPage()) return null;
    return [...document.querySelectorAll("header")].find(header =>
      header.querySelector("img") && header.getBoundingClientRect().width >= 200) || null;
  }

  /* Whether the profile has posts the viewer can see: false for an account without posts and for
     a private account they don't follow (their own account always counts as open), null until
     Instagram has answered. When the answer
     comes, done() is called so the page is looked at again. If Instagram doesn't answer, the
     profile counts as open. */
  const profileAccess = new Map();
  function canSeePosts(username, done) {
    if (!username) return true;
    if (profileAccess.has(username)) return profileAccess.get(username);
    profileAccess.set(username, null);
    profileInfo(username).then(user => {
      const viewer = document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)/)?.[1];
      const open = !user || !user.is_private || !!user.followed_by_viewer || user.id === viewer;
      profileAccess.set(username, open && user?.edge_owner_to_timeline_media?.count !== 0);
      done();
    });
    return null;
  }

  /* What Instagram says about a profile (its id, whether it is private...), asked once per
     profile; null if it doesn't answer. A failed answer isn't kept, so it is asked again later. */
  const profileInfos = new Map();
  function profileInfo(username) {
    if (!profileInfos.has(username)) {
      const answer = fetch("/api/v1/users/web_profile_info/?username=" + encodeURIComponent(username),
        { credentials: "include", headers: { "X-IG-App-ID": APP_ID } })
        .then(response => response.ok ? response.json() : null)
        .then(data => data?.data?.user || null)
        .catch(() => null);
      profileInfos.set(username, answer);
      answer.then(user => {
        if (!user) profileInfos.delete(username);
      });
    }
    return profileInfos.get(username);
  }

  /* Whether the profile's header shows a post count of 0 ("0 posts", "0 gönderi"): the first line
     of the header that is a number followed by a word. Whatever the language, the posts come first. */
  function headerSaysNoPosts() {
    const header = profileHeader();
    if (!header) return false;
    const line = header.innerText.split("\n").map(text => text.trim()).find(text => /^[\d.,]+\s+\p{L}/u.test(text));
    return !!line && /^0\s/.test(line);
  }

  /* The first (leftmost) of the profile's tabs (posts, reels, tagged...), found through the
     nearest element holding the tab links outside the header (the posts tab and at least one
     other; an account may have only Posts and Tagged). The row of tabs itself can be as wide as
     the grid, far wider than the tabs. */
  function firstProfileTab() {
    const username = profileOfPage();
    if (isStoryPage() || !username) return null;
    const prefix = "/" + username.toLowerCase() + "/";
    const links = [...document.querySelectorAll("main a[href]")].filter(link => {
      const path = link.pathname.toLowerCase();
      return path.startsWith(prefix) && !link.closest("header") && link.getBoundingClientRect().width > 0 &&
        ["", ...PROFILE_TABS].includes(path.slice(prefix.length).replace(/\/$/, ""));
    });
    if (links.length < 2) return null;
    let common = links[0].parentElement;
    while (common && !links.every(link => common.contains(link))) common = common.parentElement;
    if (!common || common === document.body || common.getBoundingClientRect().height >= 120) return null;
    const tabs = [...common.querySelectorAll("a[href]")].filter(link => link.pathname.toLowerCase().startsWith(prefix) &&
      link.getBoundingClientRect().width > 0);
    return tabs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] || null;
  }

  /* Where the bar goes beside its anchor (the row of highlight circles, or else the profile's first
     tab, or else the profile's header): left of it if there is room, otherwise at its right end if that is free, otherwise
     above its right end if that is free, otherwise below it. */
  const PROFILE_BAR = { button: 30, height: 36, gap: 12 };
  function profileBarPlacement(anchor, count) {
    const rect = anchor.getBoundingClientRect();
    const { height, gap } = PROFILE_BAR;
    const width = count * PROFILE_BAR.button + (count - 1) * 2 + 6;
    const middle = rect.top + rect.height / 2;
    if (isEmptyArea(rect.left - gap - width, middle - height / 2, rect.left - gap, middle + height / 2)) return "before";
    if (isEmptyArea(rect.right - gap - width, middle - height / 2, rect.right - gap, middle + height / 2)) return "end";
    if (isEmptyArea(rect.right - width, rect.top - gap - height, rect.right, rect.top - gap)) return "above-end";
    return "below-end";
  }

  /* A one-button bar, on the same frosted pill as the other floating bars: all posts ("posts"), or
     all highlights ("highlights") of the profile with that row of highlights (tray). */
  function buildProfileBarHost(which, tray) {
    const button = which === "posts"
      ? ["stack", "All posts in a new tab, with every photo of multi-photo posts", () => openAllPosts()]
      : ["ring", "All highlights in a new tab", () => openAllHighlights(tray)];
    const host = makeHost(window, PILL_CSS, [["tab profile", [button]]]);
    isolateEvents(host);
    return host;
  }

  /* All highlights: a circle like a highlight's, first in the row of highlights. Its size,
     colours and title's font are read from the first highlight (allHighlightsLook), so it looks
     like one. Its title follows the page's language. */
  const ALL_HIGHLIGHTS_CSS = BUTTON_CSS + [
    ":host{all:initial;position:absolute;left:0;top:0;bottom:0;width:var(--w,125px)}",
    "button{display:flex;flex-direction:column;align-items:center;width:100%;padding-top:var(--top,10px);gap:var(--gap,15px);color:var(--fg,#000)}",
    "button:active{transform:scale(.94)}",
    ".circle{display:grid;place-items:center;width:var(--size,77px);height:var(--size,77px);border-radius:50%;",
    "background:var(--bg,rgba(128,128,128,.12));transition:opacity .15s}",
    "button:hover .circle{opacity:.7}",
    ".circle svg{width:calc(var(--size,77px) * .36);height:calc(var(--size,77px) * .36);stroke-width:1.7}",
    ".title{font:var(--font,600 12px/16px -apple-system,system-ui,sans-serif);white-space:nowrap}",
  ].join("");
  function buildAllHighlightsHost() {
    const host = document.createElement(HOST_TAG);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ALL_HIGHLIGHTS_CSS;
    const button = document.createElement("button");
    button.type = "button";
    button.title = "All highlights in a new tab";
    button.setAttribute("aria-label", button.title);
    const circle = document.createElement("span");
    circle.className = "circle";
    circle.append(icon(document, "open"));
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = /^tr\b/i.test(document.documentElement.lang) ? "T\u00fcm\u00fc" : "All";
    button.append(circle, title);
    button.addEventListener("click", event => {
      event.preventDefault();
      const tray = highlightTray();
      if (tray) openAllHighlights(tray);
    });
    root.append(style, button);
    isolateEvents(host);
    return host;
  }

  /* The first highlight's measures and colours, as the circle's custom properties: the width of
     its place in the row, the circle's size (with the ring Instagram draws a little outside the
     cover), its distance from the top of the frame and from the title, its background, and the
     title's colour and font. */
  function allHighlightsLook(link, frame) {
    const cover = link.querySelector("img");
    const item = link.closest("li");
    if (!cover || !item) return null;
    const coverRect = cover.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (!coverRect.width || !itemRect.width) return null;
    const ring = Math.max(0, Math.min(8, Math.round(coverRect.left - link.getBoundingClientRect().left)));
    let background = null;
    for (let node = cover.parentElement; node && node !== link && !background; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(color)) background = color;
    }
    const parts = [
      "--w:" + Math.round(itemRect.width) + "px",
      "--top:" + Math.max(0, Math.round(coverRect.top - ring - frame.getBoundingClientRect().top)) + "px",
      "--size:" + Math.round(coverRect.width + 2 * ring) + "px",
    ];
    if (background) parts.push("--bg:" + background);
    const title = [...link.querySelectorAll("span")].find(span => !span.children.length && span.textContent.trim());
    if (title) {
      const style = getComputedStyle(title);
      parts.push("--gap:" + Math.max(0, Math.round(title.getBoundingClientRect().top - coverRect.bottom - ring)) + "px",
        "--fg:" + style.color, "--font:" + style.fontWeight + " " + style.fontSize + "/" + style.lineHeight + " " + style.fontFamily);
    }
    return { width: Math.round(itemRect.width), style: ";" + parts.join(";") };
  }

  /* Where the circle goes: the frame around the row of highlights and its arrows, the nearest
     element above the scrolling row that holds nothing else and is as wide as it. The frame gets
     room on its left and the circle is put there, so the row and its arrows become narrower by
     one place: the circle stays put while the highlights scroll, and Instagram's arrows, which
     work out how far the row scrolls from its width, still reach its end. */
  function allHighlightsFrame(tray) {
    const width = tray.getBoundingClientRect().width;
    let node = tray.parentElement;
    for (let level = 0; node && node !== document.body && level < 4; node = node.parentElement, level++) {
      const children = [...node.children].filter(child => child.tagName.toLowerCase() !== HOST_TAG);
      const style = getComputedStyle(node);
      /* Its width without the room already made for the circle. */
      const inner = node.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (children.length === 1 && style.display === "block" && Math.abs(inner - width) <= 2) return node;
    }
    return null;
  }

  /* All posts: a round button with an arrow just right of the Posts tab's icon, in its colour on
     a light shade of it (so it suits the dark theme as well). */
  const POSTS_BUTTON_CSS = BUTTON_CSS + [
    ":host{all:initial}",
    ".bar{display:flex;pointer-events:auto}",
    "button{width:30px;height:30px;border-radius:50%;background:color-mix(in srgb,currentColor 10%,transparent)}",
    "button:hover{background:color-mix(in srgb,currentColor 18%,transparent)}",
    "svg{width:16px;height:16px;stroke-width:2.2}",
  ].join("");
  function buildPostsButtonHost() {
    const host = makeHost(window, POSTS_BUTTON_CSS,
      [["", [["arrow", "All posts in a new tab, with every photo of multi-photo posts", () => openAllPosts()]]]]);
    isolateEvents(host);
    return host;
  }

  /* The Posts tab's icon: the first tab, if it is the one leading to the profile's own address. */
  function postsTabIcon() {
    const tab = firstProfileTab();
    const username = profileOfPage();
    if (!tab || !username) return null;
    if (tab.pathname.toLowerCase().replace(/\/$/, "") !== "/" + username.toLowerCase()) return null;
    return tab.querySelector("svg") || tab;
  }

  /* ---------- Buttons next to Save ---------- */

  /* Save's label in common languages, saved or not; its unsaved icon is also recognised by shape,
     whatever the language. */
  const SAVE_LABEL = /^(save|remove|kaydet|kaldır|guardar|quitar|enregistrer|retirer|speichern|entfernen|salva|rimuovi|salvar|remover|opslaan|verwijderen|zapisz|usuń|сохранить|удалить|保存|저장)$/i;

  const childOf = (container, node) => {
    while (node && node.parentElement !== container) node = node.parentElement;
    return node;
  };

  /* The action row a Save icon belongs to. Posts have a short <section> row (like, comment,
     share … save); Reels have a narrow column on the right (like, comment, share, save, more …).
     Save is already recognised for certain, and a post can lack some of the other buttons
     (sharing or comments turned off), so one other button next to it is enough. */
  function actionBarOf(svg) {
    const section = svg.closest("section");
    if (section && section.getBoundingClientRect().height <= 120 && section.querySelectorAll("svg").length >= 2) {
      return { layout: "row", container: section, item: childOf(section, svg) };
    }
    for (let node = svg.parentElement, level = 0; node && node !== document.body && level < 8; node = node.parentElement, level++) {
      const style = getComputedStyle(node);
      if (style.display.includes("flex") && style.flexDirection === "column" && node.children.length >= 3 &&
        node.getBoundingClientRect().width <= 120) {
        return { layout: "column", container: node, item: childOf(node, svg) };
      }
    }
    return null;
  }

  function findActionBars() {
    const icons = new Set();
    for (const svg of document.querySelectorAll("svg[aria-label]")) {
      if (SAVE_LABEL.test(svg.getAttribute("aria-label").trim())) icons.add(svg);
    }
    for (const polygon of document.querySelectorAll('svg polygon[points^="20 21 12 13.44"]')) icons.add(polygon.ownerSVGElement);
    const bars = [];
    for (const svg of icons) {
      const bar = svg && actionBarOf(svg);
      if (bar?.item) bars.push(bar);
    }
    return bars;
  }

  /* The post an action row belongs to: its article or post window, or for Reels the nearest
     ancestor holding media. */
  function mediaScopeOf(container) {
    const post = container.closest('article, [role="dialog"]');
    if (post) return post;
    for (let node = container.parentElement, level = 0; node && node !== document.body && level < 6; node = node.parentElement, level++) {
      if ([...node.querySelectorAll("video, img")].some(element => isUsableMedia(element, false))) return node;
    }
    return null;
  }

  /* The post's main photo or video: the largest one that isn't clipped away (so in a carousel,
     the item shown), preferring a video over its cover image. Comment images are smaller. */
  function mainMediaOf(container) {
    const scope = mediaScopeOf(container);
    if (!scope) return null;
    const area = box => (box.right - box.left) * (box.bottom - box.top);
    const candidates = [...scope.querySelectorAll("video, img")]
      .filter(element => isUsableMedia(element, false))
      .map(element => ({ element, box: clippedBox(element) }))
      .filter(candidate => candidate.box)
      .map(candidate => ({ element: candidate.element, area: area(candidate.box) }))
      .sort((a, b) => b.area - a.area);
    if (!candidates.length) return null;
    const largest = candidates.filter(candidate => candidate.area >= candidates[0].area * 0.95);
    return (largest.find(candidate => candidate.element.tagName === "VIDEO") || largest[0]).element;
  }

  /* Open and download, in Instagram's style, next to Save. The media is looked up on each
     click, so in a carousel it is always the item shown. */
  function buildActionHost(bar) {
    const withMedia = action => () => {
      const media = mainMediaOf(bar.container);
      if (!media) throw new Error("Couldn't find this post's photo or video.");
      return action(media);
    };
    const host = makeHost(window, ACTION_CSS, [[bar.layout === "column" ? "column" : "row", [
      ["open", "Open in new tab", withMedia(openMedia)],
      ["download", "Download", withMedia(downloadMedia), {
        key: () => mediaKey(mainMediaOf(bar.container)),
        story: () => mediaIsStory(mainMediaOf(bar.container)),
      }],
    ]]]);
    isolateEvents(host);
    return host;
  }

  /* ---------- Floating bars ---------- */

  /* Whether an element is visible: it is the topmost media at the centre of its visible part;
     where a video and its cover image overlap, the video counts. */
  function isVisibleMedia(element) {
    if (!visibleRect(element) || !isUsableMedia(element, false)) return false;
    const box = clippedBox(element);
    if (!box) return false;
    const x = (Math.max(box.left, 0) + Math.min(box.right, innerWidth)) / 2;
    const y = (Math.max(box.top, 0) + Math.min(box.bottom, innerHeight)) / 2;
    const stack = mediaAtPoint(x, y);
    return (stack.find(item => item.tagName === "VIDEO") || stack[0]) === element;
  }

  /* Whether nothing else covers a point of a container: the topmost element there (ignoring our
     own buttons) is inside the container or holds it. A post window opened over a profile grid
     covers the grid's tiles, so their bars hide. */
  function isUncovered(container, x, y) {
    const top = document.elementsFromPoint(x, y).find(element => !element.closest(LAYER_TAG));
    return !!top && (container.contains(top) || top.contains(container));
  }

  function centreOf(rect) {
    return [(Math.max(rect.left, 0) + Math.min(rect.right, innerWidth)) / 2, (Math.max(rect.top, 0) + Math.min(rect.bottom, innerHeight)) / 2];
  }

  /* Whether an element lies within a screen above or two screens below the visible area (feeds
     are scrolled down). Buttons are put on such elements in advance, so they are already in place
     when the element scrolls into view; until then the browser hides them (position-visibility). */
  function isNearScreen(element) {
    const rect = element.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > -innerHeight && rect.top < innerHeight * 3 &&
      rect.right > 0 && rect.left < innerWidth;
  }

  /* Media that get a floating bar, and the profile picture, each with the element its bar is
     attached to. On screen, media must be the visible, uncovered one at its spot; just off screen
     (not on story pages), being shown is enough, as there is nothing to look at there yet. */
  function findFloatingTargets(hoveredHighlight) {
    const story = isStoryPage();
    const targets = [];
    /* The highlight circle under the pointer: a row of circles each with buttons would crowd the
       profile, so only the one being pointed at shows them. */
    const cover = hoveredHighlight?.isConnected && hoveredHighlight.querySelector("img");
    if (cover && visibleRect(cover) && isShown(cover, false)) {
      targets.push({ element: cover, kind: "highlight", anchor: cover, link: hoveredHighlight });
    }
    for (const element of document.querySelectorAll("video, img")) {
      if (!isNearScreen(element)) continue;
      const onScreen = !!visibleRect(element);
      let kind = null;
      if (element.closest(HIGHLIGHT_LINK) || reelTileOf(element)) continue;
      if (element.tagName === "IMG" && isAvatar(element)) {
        if (onScreen && isShown(element, false)) kind = "avatar";
      } else if (onScreen ? isVisibleMedia(element) : !story && isUsableMedia(element, false)) {
        kind = story ? (element.tagName === "VIDEO" ? "storyVideo" : "storyImage") : "post";
      }
      if (!kind) continue;
      /* Media cut off by a scrolling area (a message list) has no element matching its visible
         part; its bar is attached to the media itself and shown, on hover, in its visible part. */
      const anchor = coverAnchorOf(element) || (kind === "post" && onScreen && canHover ? element : null);
      if (!anchor) continue;
      /* Stories are already the topmost layer, and their tap areas for moving between stories
         lie over the media, so they aren't checked for covering. */
      if (story || !onScreen || isUncovered(anchor, ...centreOf(visibleRect(anchor) || element.getBoundingClientRect()))) {
        targets.push({ element, kind, anchor });
      }
    }
    /* Reel tiles: the link itself, whether its cover is a background picture (a profile's Reels
       tab) or a photo filling it (the posts grid, Explore). */
    if (!story) {
      for (const link of document.querySelectorAll(REEL_TILE)) {
        if (!isNearScreen(link)) continue;
        const media = [...link.querySelectorAll("img, video")];
        if (media.length && !media.some(item => reelTileOf(item) === link)) continue;
        const rect = link.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 80 || !isShown(link, false)) continue;
        const shown = visibleRect(link);
        if (shown && !isUncovered(link, ...centreOf(shown))) continue;
        targets.push({ element: link, kind: "reelTile", anchor: link });
      }
    }
    return targets;
  }

  /* What a photo or video on the page is, for remembering its download: its media id; for a
     video whose data isn't found (a story's often isn't), the id in the story's address or its
     post's code, as the download itself uses; for such a photo, its file name. Kept per
     element, address and page (a story's video element is reused for the next story), since
     looking it up walks Instagram's data and buttons are painted on every scan. */
  const keyOfItem = item => {
    const pk = item?.pk || String(item?.id || "").split("_")[0];
    return pk ? "m:" + pk : null;
  };
  const mediaKeys = new WeakMap();
  function mediaKey(media) {
    if (!media) return null;
    const source = media.currentSrc || media.src || media.poster || "";
    const address = source + " " + location.pathname;
    const known = mediaKeys.get(media);
    if (known && known.address === address) return known.key;
    const video = media.tagName === "VIDEO";
    const item = video ? findVideoItem(media) : findImageItem(media);
    let key = keyOfItem(item);
    if (!key && video) {
      const pk = findMediaPk(media);
      if (pk) key = "m:" + pk;
    }
    if (!key && !video && source && !source.startsWith("blob:")) key = "f:" + fileOf(source);
    mediaKeys.set(media, { address, key, story: isStoryPage() || isStoryItem(item, media) });
    return key;
  }
  const mediaIsStory = media => {
    mediaKey(media);
    return !!mediaKeys.get(media)?.story;
  };
  const mediaDone = media => ({ key: () => mediaKey(media), story: () => mediaIsStory(media) });

  /* Open, first frame (story videos only) and download, for one photo or video. A cover button
     is only on previews: tiles linking to their post, Reel tiles and the posts gallery. */
  function mediaButtons(media, kind) {
    const video = media.tagName === "VIDEO";
    return [
      ["open", "Open in new tab", () => openMedia(media)],
      /* The first frame only for story videos: on a story page, or a story elsewhere (messages). */
      ...(video && (kind.startsWith("story") || isStoryItem(findVideoItem(media), media))
        ? [["frame", "Download first frame as a photo", () => downloadFirstFrame(media)]] : []),
      ...(video && kind === "post" && isPreview(media) ? [["cover", "Download cover", () => downloadVideoCover(media)]] : []),
      ["download", media.tagName === "VIDEO" ? "Download video" : "Download photo", () => downloadMedia(media), mediaDone(media)],
    ];
  }

  /* The profile picture gets open in the bottom left corner and download in the bottom right; a
     highlight's circle gets only open, on its bottom edge, as its cover is best looked at before
     it is saved (the tab has a download button); other media get one bar. */
  function buildFloatingHost(media, kind, link) {
    const bars = kind === "avatar"
      ? [
        ["avatar-left", [["open", "Open in new tab", () => openAvatar(media)]]],
        ["avatar-right", [["download", "Download profile picture", () => downloadAvatar(media),
          { key: () => "u:" + (profileOfPage() || "") }]]],
      ]
      : kind === "reelTile"
        ? [["post", [
          ["open", "Open in new tab", () => openReelTile(media)],
          ["cover", "Download cover", () => downloadReelTileCover(media)],
          ["download", "Download video", () => downloadReelTile(media), {
            key: () => {
              const code = media.getAttribute("href")?.match(/\/reel\/([A-Za-z0-9_-]+)/)?.[1];
              return code ? "m:" + shortcodeToPk(code) : null;
            },
          }],
        ]]]
        : kind === "highlight"
        ? [["highlight", [["open", "Open cover in new tab (download it there)", () => openHighlightCover(link)]]]]
        : [[kind.startsWith("story") ? "story column" : "post", mediaButtons(media, kind)]];
    const host = makeHost(window, PILL_CSS, bars);
    isolateEvents(host);
    /* An image that turns out to be a video's cover (a preview, such as a story or Reel shared in
       messages) gets video buttons: first frame for a story, cover for a Reel. */
    if (kind === "post" && media.tagName === "IMG") {
      imageVideoSource(media).then(source => {
        const bar = host.shadowRoot.querySelector(".bar");
        if (!source || !bar || bar.dataset.video) return;
        bar.dataset.video = "true";
        /* A shared Reel's data doesn't always say "clips", so anything that isn't plainly a story
           counts as a Reel: a story links to /stories/, is marked "story" or has a time it expires
           at. */
        const item = source.item;
        const isStory = !media.closest(REEL_TILE) && item.product_type !== "clips" &&
          (!!media.closest('a[href*="/stories/"]') || item.product_type === "story" || !!item.expiring_at);
        if (isStory) {
          bar.insertBefore(makeButton(window, "frame", "Download first frame as a photo", () => downloadImageVideoFrame(media)), bar.lastElementChild);
        }
        if (source.cover && !isStory) {
          bar.insertBefore(makeButton(window, "cover", "Download cover", () => downloadImageVideoCover(media)), bar.lastElementChild);
        }
        bar.lastElementChild.title = "Download video";
        bar.lastElementChild.setAttribute("aria-label", "Download video");
      });
    }
    return host;
  }

  /* A story's buttons in its top row, styled like the story's own pause and more buttons. */
  function buildStoryHeaderHost(media, kind) {
    /* Top to bottom: download, open, first frame. */
    const [open, ...rest] = mediaButtons(media, kind);
    const download = rest.pop();
    const host = makeHost(window, ACTION_CSS, [["column story", [download, open, ...rest]]]);
    isolateEvents(host);
    return host;
  }

  /* ---------- Story header ---------- */

  /* The story card a story's photo or video fills: its outermost ancestor of the same width. */
  function storyCardOf(media) {
    const width = media.getBoundingClientRect().width;
    let card = media;
    for (let node = media.parentElement, level = 0; node && node !== document.body && level < 12; node = node.parentElement, level++) {
      if (Math.abs(node.getBoundingClientRect().width - width) > 4) break;
      card = node;
    }
    return card;
  }

  /* Where a story's buttons go. The story's own controls (sound, pause, more) sit in its top right
     corner; they are found by position, so any language works: icons in the card's top band, in
     its right half. The buttons go in a column just outside the card, to the right of those
     controls and starting at their height, where the page is empty: nothing in the story is covered, whatever its top
     row holds (a song title, a Reels link), and it is away from the story's tap areas and the
     like button. When the window is too narrow for that, they go inside the card, in a column
     just below the last control. Null when the story has no such controls; it then
     keeps its floating bar. */
  function storyHeaderSpot(media, count) {
    const box = storyCardOf(media).getBoundingClientRect();
    const bandBottom = box.top + Math.min(110, box.height * 0.15);
    const middle = (box.left + box.right) / 2;
    const controls = [];
    for (const svg of document.querySelectorAll("svg")) {
      const rect = svg.getBoundingClientRect();
      if (rect.width < 10 || rect.width > 40 || rect.top < box.top - 1 || rect.bottom > bandBottom ||
        rect.left < middle || rect.right > box.right + 1) continue;
      /* Not an icon cut off by its container, such as one in a scrolling song title. */
      const visible = clippedBox(svg);
      if (!visible || visible.right - visible.left < rect.width - 1 || visible.bottom - visible.top < rect.height - 1) continue;
      const button = svg.closest('[role="button"], button');
      const buttonRect = button?.getBoundingClientRect();
      const control = button && buttonRect.width <= 64 && buttonRect.height <= 64 ? button : svg;
      if (isShown(control, false)) controls.push({ control, rect: control.getBoundingClientRect(), icon: rect });
    }
    if (!controls.length) return null;
    controls.sort((a, b) => a.rect.left - b.rect.left);
    const last = controls[controls.length - 1];
    /* The card: the nearest element holding both the media and its controls. */
    let card = last.control.parentElement;
    while (card && card !== document.body && !card.contains(media)) card = card.parentElement;
    if (!card || card === document.body || card.getBoundingClientRect().width > box.width * 1.5) card = storyCardOf(media);
    const cardRect = card.getBoundingClientRect();
    /* The same box and icon size as the story's own controls, and the spacing between them. */
    const spacings = controls.slice(1).map((item, index) => item.rect.left - controls[index].rect.right).filter(space => space > 0);
    const spacing = spacings.length ? Math.max(...spacings) : 12;
    const gap = Math.round(Math.min(16, Math.max(6, spacing)));
    const icon = Math.round(Math.min(32, Math.max(12, last.icon.width)));
    const size = Math.round(Math.min(48, Math.max(icon, last.rect.height)));
    /* White like Instagram's own story controls, whose text colour can be dark (a story opened
       from messages) even though they are drawn white. */
    const spot = { control: last.control, card, size, gap, icon, color: "#fff" };
    /* Outside: the column right of the card must lie on screen and hold nothing but background. */
    const x = cardRect.right + 12 + size / 2;
    const end = last.rect.top + count * size + (count - 1) * gap;
    let empty = x + size / 2 <= innerWidth - 8 && end <= innerHeight - 8;
    for (let y = last.rect.top; empty && y <= end; y += 8) {
      const top = document.elementsFromPoint(x, y).find(element => !element.closest(LAYER_TAG));
      if (!top || card.contains(top) || top.closest('img, video, a, button, [role="button"], svg, input, textarea')) empty = false;
    }
    return { ...spot, placement: empty ? "outside" : "below" };
  }


  /* ---------- The overlay layer ---------- */

  /* Every button lives in our own layer, a sibling of <body>, never inside Instagram's elements.
     Instagram is a React app: React expects the elements it renders to hold exactly what it put
     there, and a foreign element inside them can stop it from updating or loading that part of
     the page (posts not loading on profiles). Only a CSS "anchor-name" is set on Instagram's
     elements; the browser then keeps each bar attached to its anchor while scrolling. Browsers
     without CSS anchor positioning get fixed positions recalculated as the page scrolls. */
  const ANCHOR_SUPPORT = typeof CSS !== "undefined" && CSS.supports("anchor-name: --a") &&
    CSS.supports("left: anchor(left)");
  const anchorNames = new WeakMap();
  let anchorCount = 0;

  function anchorNameOf(element) {
    let name = anchorNames.get(element);
    if (!name) {
      name = "--instagram-downloader-" + ++anchorCount;
      anchorNames.set(element, name);
    }
    if (element.style.getPropertyValue("anchor-name") !== name) element.style.setProperty("anchor-name", name);
    return name;
  }

  /* The element a floating bar is attached to: the outermost ancestor (within a few levels) with
     the same box as the media's visible area, such as a profile grid tile or a carousel frame,
     otherwise the media itself. Null for media that is only partly shown by a frame with nothing
     matching its visible part: a carousel photo halfway through sliding in. A bar attached to the
     photo itself would then sit outside the post. */
  function coverAnchorOf(media) {
    const rect = media.getBoundingClientRect();
    const box = clippedBox(media) || rect;
    const same = other => Math.abs(other.left - box.left) <= 2 && Math.abs(other.right - box.right) <= 2 &&
      Math.abs(other.top - box.top) <= 2 && Math.abs(other.bottom - box.bottom) <= 2;
    let anchor = null;
    let node = media.parentElement;
    for (let level = 0; node && node !== document.body && level < 8; level++, node = node.parentElement) {
      if (same(node.getBoundingClientRect())) anchor = node;
    }
    return anchor || (same(rect) ? media : null);
  }

  /* The frame a post's main media is shown in: its nearest ancestor that hides overflow, if that
     is not much bigger than the media (a carousel's frame, not a whole post window). Other photos
     in the same frame are the carousel's other slides. */
  function slideFrameOf(media) {
    const rect = media.getBoundingClientRect();
    for (let node = media.parentElement, level = 0; node && node !== document.body && level < 10; node = node.parentElement, level++) {
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const frame = node.getBoundingClientRect();
      return frame.width * frame.height <= rect.width * rect.height * 1.5 ? node : null;
    }
    return null;
  }

  /* How the open and download buttons fit in the free space left of Save in a row: from the right
     edge of the nearest button or count before Save to Save's left edge. Save's own size and
     spacing are tried first, then smaller ones. Null when even the smallest doesn't fit (a post
     page whose counts fill the row); the post's media then gets a floating bar instead, rather
     than buttons drawn over Instagram's. */
  function rowFit(bar) {
    const itemRect = bar.item.getBoundingClientRect();
    let used = bar.container.getBoundingClientRect().left;
    for (const node of bar.container.querySelectorAll("svg, span")) {
      if (bar.item.contains(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.right <= itemRect.left + 1) used = Math.max(used, rect.right);
    }
    const free = itemRect.left - used;
    const height = Math.round(itemRect.height) || 24;
    const options = height >= 40 ? [[height, 0], [40, 0], [32, 0], [28, 0]] : [[height, 16], [height, 10], [height, 6]];
    for (const [size, gap] of options) {
      if (2 * size + 2 * gap <= free) return { size, gap };
    }
    return null;
  }

  /* Placement of a host relative to its anchor:
       cover   over the whole anchor (floating bars draw their own position inside it);
       before  just left of it, as tall as it (buttons before Save);
       above   just above it, centred (buttons at the top of the Reels column);
       below   just below it, centred (a story's buttons under its last control);
       outside from its top, 12 px right of a second element (a story's buttons beside its card);
       side    just right of it, centred on it (All posts beside the Posts tab's icon);
       end     inside its right end, as tall as it (the profile's Posts and Highlights bar);
       above-end / below-end  just above or below it, lined up with its right edge.
     gap is the space between the host and the anchor. */
  function anchoredStyle(name, placement, gap, secondName) {
    const far = "-100000px";
    /* Fixed, not absolute: an absolutely positioned bar attached to something far down the page
       makes the page longer, so a page Instagram has locked while a post window is open could
       still be scrolled. A fixed bar never changes the page's size. */
    const common = "position:fixed;margin:0;z-index:2147483646;position-anchor:" + name + ";position-visibility:anchors-visible;";
    if (placement === "cover") {
      return common + "left:anchor(left," + far + ");top:anchor(top," + far + ");" +
        "width:anchor-size(width,0px);height:anchor-size(height,0px);pointer-events:none";
    }
    if (placement === "before") {
      return common + "right:anchor(left," + far + ");top:anchor(top," + far + ");height:anchor-size(height,0px);" +
        "margin-right:" + gap + "px";
    }
    if (placement === "below") {
      return common + "top:anchor(bottom," + far + ");left:anchor(center," + far + ");transform:translateX(-50%);" +
        "margin-top:" + gap + "px";
    }
    if (placement === "outside") {
      return common + "left:anchor(" + secondName + " right," + far + ");top:anchor(top," + far + ");margin-left:12px";
    }
    if (placement === "side") {
      return common + "left:anchor(right," + far + ");top:anchor(center," + far + ");transform:translateY(-50%);" +
        "margin-left:" + gap + "px";
    }
    if (placement === "end") {
      return common + "right:anchor(right," + far + ");top:anchor(top," + far + ");height:anchor-size(height,0px);" +
        "margin-right:" + gap + "px";
    }
    if (placement === "above-end") {
      return common + "bottom:anchor(top," + far + ");right:anchor(right," + far + ");margin-bottom:" + gap + "px";
    }
    if (placement === "below-end") {
      return common + "top:anchor(bottom," + far + ");right:anchor(right," + far + ");margin-top:" + gap + "px";
    }
    return common + "bottom:anchor(top," + far + ");left:anchor(center," + far + ");transform:translateX(-50%);" +
      "margin-bottom:" + gap + "px";
  }

  /* The same placements as fixed positions, for browsers without anchor positioning. */
  function fixedStyle(anchor, placement, gap, second) {
    const rect = anchor.getBoundingClientRect();
    const common = "position:fixed;margin:0;z-index:2147483646;";
    if (placement === "cover") {
      return common + "left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" +
        rect.height + "px;pointer-events:none";
    }
    if (placement === "before") {
      return common + "right:" + (innerWidth - rect.left + gap) + "px;top:" + rect.top + "px;height:" + rect.height + "px";
    }
    if (placement === "below") {
      return common + "top:" + (rect.bottom + gap) + "px;left:" + (rect.left + rect.width / 2) + "px;transform:translateX(-50%)";
    }
    if (placement === "outside") {
      return common + "left:" + (second.getBoundingClientRect().right + 12) + "px;top:" + rect.top + "px";
    }
    if (placement === "side") {
      return common + "left:" + (rect.right + gap) + "px;top:" + (rect.top + rect.height / 2) + "px;transform:translateY(-50%)";
    }
    if (placement === "end") {
      return common + "right:" + (innerWidth - rect.right + gap) + "px;top:" + rect.top + "px;height:" + rect.height + "px";
    }
    if (placement === "above-end") {
      return common + "bottom:" + (innerHeight - rect.top + gap) + "px;right:" + (innerWidth - rect.right) + "px";
    }
    if (placement === "below-end") {
      return common + "top:" + (rect.bottom + gap) + "px;right:" + (innerWidth - rect.right) + "px";
    }
    return common + "bottom:" + (innerHeight - rect.top + gap) + "px;left:" + (rect.left + rect.width / 2) +
      "px;transform:translateX(-50%)";
  }

  /* ---------- Keeping the buttons in place ---------- */

  /* Buttons go next to each Save, and every other visible media gets a floating bar; a post's
     main media gets no floating bar. A scan runs every 400 ms and shortly after Instagram adds or
     removes elements (so bars hide at once when a post window opens over them). Each scan first
     only reads the page, then changes only what differs from last time. A bar whose media is no
     longer visible is hidden. */
  /* Floating bars shown only on hover, where many appear at once. Devices without a pointer that
     can hover (touch screens) always show them. */
  const HOVER_KINDS = ["post", "reelTile", "avatar"];
  const canHover = typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;

  function startButtons() {
    const layer = document.createElement(LAYER_TAG);
    layer.style.cssText = "display:contents";
    document.documentElement.append(layer);
    const entries = new Map();

    const actionAnchorOf = bar => bar.layout === "column" ? bar.container.firstElementChild : bar.item;

    const show = (entry, anchor, placement, gap, extra, second = null) => {
      const style = (ANCHOR_SUPPORT
        ? anchoredStyle(anchorNameOf(anchor), placement, gap, second && anchorNameOf(second))
        : fixedStyle(anchor, placement, gap, second)) + extra;
      entry.anchor = anchor;
      entry.second = second;
      entry.placement = placement;
      entry.gap = gap;
      entry.extra = extra;
      if (entry.style !== style) {
        entry.host.style.cssText = style;
        entry.style = style;
        /* The hover offsets were part of the old style; they are set again on the next hover
           check (after every scan). */
        entry.offsets = null;
      }
    };

    /* When the story changes, Instagram slides and zooms the next story's card into place, and
       its controls appear a moment later. Measured during that animation, the buttons would come
       out small and in the wrong place and then jump. So a story's buttons are shown only once
       its card and controls have kept their size and place for a scan; until then they are
       hidden (undefined). Once shown, the placement is kept as long as the card keeps its size:
       the buttons follow the card on their own, and measuring again on every scan made them
       blink whenever something small changed, such as a scrolling song title. A story that has
       no controls at all gets its floating bar (null) after a second. */
    const settled = new WeakMap();
    const storySpot = (media, kind, now) => {
      const state = settled.get(media);
      if (state?.shown && state.spot.control.isConnected && state.spot.card.isConnected) {
        const rect = state.spot.card.getBoundingClientRect();
        if (Math.abs(rect.width - state.width) <= 2 && Math.abs(rect.height - state.height) <= 2) return state.spot;
      }
      const spot = storyHeaderSpot(media, kind === "storyVideo" ? 3 : 2);
      const card = spot?.card.getBoundingClientRect();
      const control = spot?.control.getBoundingClientRect();
      const key = spot
        ? spot.placement + "|" + [spot.size, spot.gap, spot.icon, card.width, card.height, control.left, control.top].map(Math.round).join("|")
        : "none";
      if (!state || state.key !== key) {
        settled.set(media, { key, since: now });
        soon();
        return undefined;
      }
      if (!spot) {
        if (now - state.since >= 1000) return null;
        soon();
        return undefined;
      }
      settled.set(media, { key, since: state.since, shown: true, spot, width: card.width, height: card.height });
      return spot;
    };

    const scan = () => {
      const bars = findActionBars();
      const actions = [];
      const mainAnchors = new Set();
      for (const bar of bars) {
        /* A post's main media is known from its action row even while the row itself is still
           below the screen (a tall photo in the feed); otherwise the photo would get a floating
           bar until the row scrolled into view. */
        if (!isNearScreen(bar.container)) continue;
        const fit = bar.layout === "column" ? { size: 24, gap: 20 } : rowFit(bar);
        if (!fit) continue;
        const main = mainMediaOf(bar.container);
        if (main) {
          const anchor = coverAnchorOf(main);
          if (anchor) mainAnchors.add(anchor);
          const frame = slideFrameOf(main);
          if (frame) mainAnchors.add(frame);
        }
        /* Rows just off screen get their buttons in advance; rows on screen only when nothing
           (a post window) covers them. */
        const anchor = actionAnchorOf(bar);
        if (!anchor || !isNearScreen(anchor) || !isShown(bar.container, false)) continue;
        const anchorRect = visibleRect(anchor);
        if (anchorRect && !isUncovered(bar.container, ...centreOf(anchorRect))) continue;
        const save = bar.item.querySelector("svg");
        actions.push({ bar, anchor, ...fit, color: getComputedStyle(save || bar.item).color });
      }
      /* Nothing in a post's main media box gets a floating bar: not the photo or video, nor a
         video's cover image, which can be told apart from the video differently. */
      const isMainMedia = target => [...mainAnchors].some(anchor => anchor === target.anchor || anchor.contains(target.element));
      const floats = findFloatingTargets(hoveredHighlight).filter(target => !(target.kind === "post" && isMainMedia(target)));

      const current = new Set();
      for (const { bar, anchor, size, gap, color } of actions) {
        const key = bar.container;
        current.add(key);
        let entry = entries.get(key);
        if (!entry) {
          entry = { host: buildActionHost(bar), style: null };
          entries.set(key, entry);
          layer.append(entry.host);
        }
        show(entry, anchor, bar.layout === "column" ? "above" : "before", gap,
          ";color:" + color + ";--size:" + size + "px;--gap:" + gap + "px");
      }
      const now = performance.now();
      for (const { element, kind, anchor, link } of floats) {
        /* A story's buttons go beside its controls; a story without them gets a floating bar. */
        const spot = kind.startsWith("story") ? storySpot(element, kind, now) : null;
        if (spot === undefined) continue;
        current.add(element);
        const hostKind = spot ? kind + " header" : kind;
        let entry = entries.get(element);
        if (!entry || entry.kind !== hostKind) {
          entry?.host.remove();
          entry = { kind: hostKind, host: spot ? buildStoryHeaderHost(element, kind) : buildFloatingHost(element, kind, link), style: null };
          /* Grid tiles, media in messages and elsewhere, and the profile picture: on hover. */
          if (!spot && HOVER_KINDS.includes(kind) && canHover) {
            entry.hoverOnly = true;
            entry.host.toggleAttribute("data-hover-only", true);
          }
          entries.set(element, entry);
          layer.append(entry.host);
        }
        if (spot) {
          show(entry, spot.control, spot.placement, spot.placement === "below" ? 8 : spot.gap,
            ";color:" + spot.color + ";--size:" + spot.size + "px;--gap:" + spot.gap + "px;--icon:" + spot.icon + "px", spot.card);
        } else {
          show(entry, anchor, "cover", 0, "");
        }
      }
      /* The profile's All highlights and All posts buttons, each on what it opens: a circle
         first in the row of highlights, and a round button beside the Posts tab's icon. Where
         that can't be done (Instagram's layout has changed, or there are no tabs), a small bar
         beside the row of highlights, the row of tabs or the header. No All posts button for an
         account without posts or a private account the viewer doesn't follow, nor while that
         isn't known yet, so it doesn't appear and then go away. A bar is shown while nothing (a
         story or post window) covers its anchor, and where it goes is worked out once per anchor
         and width, so it doesn't move about. */
      const placeProfileBar = (which, anchor, tray, extraStyle) => {
        const rect = isNearScreen(anchor) && isShown(anchor, false) ? visibleRect(anchor) : null;
        if (!isNearScreen(anchor) || !isShown(anchor, false) || (rect && !isUncovered(anchor, ...centreOf(rect)))) return null;
        current.add(anchor);
        let entry = entries.get(anchor);
        if (!entry) {
          entry = { kind: "profile", host: buildProfileBarHost(which, tray), style: null };
          entries.set(anchor, entry);
          layer.append(entry.host);
        }
        const width = Math.round(anchor.getBoundingClientRect().width);
        if (entry.anchorWidth !== width && rect) {
          entry.anchorWidth = width;
          entry.profilePlacement = profileBarPlacement(anchor, 1);
        }
        const placement = entry.profilePlacement || "below-end";
        /* Beside the row of highlights, the bar is lined up with the middle of the circles, not of
           the circles and their titles together. */
        const circle = tray && (placement === "before" || placement === "end") ? tray.querySelector(HIGHLIGHT_LINK + " img") : null;
        const circleRect = circle?.getBoundingClientRect();
        const offset = circleRect?.height
          ? Math.max(0, Math.round((circleRect.top + circleRect.bottom) / 2 - tray.getBoundingClientRect().top - PROFILE_BAR.height / 2))
          : null;
        show(entry, anchor, placement, PROFILE_BAR.gap, (offset === null
          ? ";display:flex;align-items:center"
          : ";display:flex;align-items:flex-start;box-sizing:border-box;padding-top:" + offset + "px") + (extraStyle || ""));
        return placement;
      };
      const tray = highlightTray();
      const postsAnchor = firstProfileTab() || (tray ? null : profileHeader());
      const onProfile = !!(tray || postsAnchor || profileHeader());
      const access = onProfile ? canSeePosts(profileOfPage(), soon) : null;
      const withPosts = !!access && !headerSaysNoPosts() && !!(postsAnchor || profileHeader());

      /* The circle goes into Instagram's own page, in the frame around the row of highlights, so
         it is covered by whatever covers them. It is put back only when it isn't in place, as
         moving it is a change of the page that starts another scan. It is measured again only
         while no highlight is pointed at, as Instagram may enlarge that one. The frame's own
         style is put back when the circle goes. */
      const frame = tray ? allHighlightsFrame(tray) : null;
      const firstHighlight = tray?.querySelector(HIGHLIGHT_LINK);
      if (frame && firstHighlight) {
        current.add(frame);
        let entry = entries.get(frame);
        if (!entry) {
          const host = buildAllHighlightsHost();
          const saved = { paddingLeft: frame.style.paddingLeft, position: frame.style.position };
          entry = {
            kind: "allHighlights", host, style: null, restore: () => {
              host.remove();
              frame.style.paddingLeft = saved.paddingLeft;
              frame.style.position = saved.position;
            },
          };
          entries.set(frame, entry);
        }
        if (frame.firstElementChild !== entry.host) frame.prepend(entry.host);
        if (!hoveredHighlight || !entry.look) entry.look = allHighlightsLook(firstHighlight, frame) || entry.look;
        const look = entry.look;
        if (look) {
          if (frame.style.paddingLeft !== look.width + "px") frame.style.paddingLeft = look.width + "px";
          if (getComputedStyle(frame).position === "static") frame.style.position = "relative";
          if (entry.style !== look.style) {
            entry.host.style.cssText = look.style;
            entry.style = look.style;
          }
        }
      } else if (tray) {
        placeProfileBar("highlights", tray, tray, "");
      }

      if (withPosts) {
        const postsIcon = postsTabIcon();
        const rect = postsIcon && isNearScreen(postsIcon) && isShown(postsIcon, false) ? visibleRect(postsIcon) : null;
        if (postsIcon && (!rect || isUncovered(postsIcon, ...centreOf(rect)))) {
          current.add(postsIcon);
          let entry = entries.get(postsIcon);
          if (!entry) {
            entry = { kind: "postsButton", host: buildPostsButtonHost(), style: null };
            entries.set(postsIcon, entry);
            layer.append(entry.host);
          }
          show(entry, postsIcon, "side", 8, ";color:" + getComputedStyle(postsIcon).color);
        } else if (!postsIcon) {
          const postsBarAnchor = postsAnchor || profileHeader();
          if (postsBarAnchor) placeProfileBar("posts", postsBarAnchor, null, "");
        }
      }

      for (const [key, entry] of entries) {
        if (!key.isConnected || (entry.restore && !current.has(key))) {
          if (entry.restore) entry.restore();
          else entry.host.remove();
          entries.delete(key);
        } else if (!current.has(key) && entry.style) {
          entry.host.style.display = "none";
          entry.style = null;
        }
      }
    };

    /* The highlight circle under the pointer. Moving onto its buttons keeps it. While anything
       scrolls (the row of highlights itself, with Shift and the wheel), circles pass under a
       still pointer one after another; a scan for each of them made scrolling stutter, so then
       none is pointed at until the scrolling stops (onScrollForHighlight). */
    let hoveredHighlight = null;
    let scrollEnd = null;
    let rowScrolling = false;
    const onPointerOver = event => {
      if (scrollEnd || event.target.closest?.(HOST_TAG)) return;
      const link = event.target.closest?.(HIGHLIGHT_LINK) || null;
      if (link === hoveredHighlight) return;
      hoveredHighlight = link;
      safeScan();
    };
    addEventListener("pointerover", onPointerOver, true);

    /* Which hover-only bar's media the pointer is over. Instagram's own elements are under the
       pointer, not our bars, so this is worked out from the pointer's position and each bar's
       anchor; again after scrolling and after each scan, as things move under a still pointer. */
    let pointer = null;
    /* The bar goes into the visible part of its media: the part not cut off by the window or a
       scrolling area. */
    const updateHover = () => {
      for (const entry of entries.values()) {
        if (!entry.hoverOnly) continue;
        let inside = false;
        if (pointer && entry.style && entry.anchor?.isConnected) {
          const rect = entry.anchor.getBoundingClientRect();
          if (pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom) {
            const clip = clippedBox(entry.anchor);
            const box = clip && {
              left: Math.max(clip.left, 0),
              top: Math.max(clip.top, 0),
              right: Math.min(clip.right, innerWidth),
              bottom: Math.min(clip.bottom, innerHeight),
            };
            inside = !!box && pointer.x >= box.left && pointer.x <= box.right && pointer.y >= box.top && pointer.y <= box.bottom;
            if (inside) {
              const offsets = "--dx:" + Math.round(box.left - rect.left) + "px;--dy:" + Math.round(box.top - rect.top) +
                "px;--dr:" + Math.round(rect.right - box.right) + "px;--db:" + Math.round(rect.bottom - box.bottom) + "px";
              if (entry.offsets !== offsets) {
                entry.offsets = offsets;
                for (const part of offsets.split(";")) {
                  const [name, value] = part.split(":");
                  entry.host.style.setProperty(name, value);
                }
              }
            }
          }
        }
        if (entry.host.hasAttribute("data-hover") !== inside) entry.host.toggleAttribute("data-hover", inside);
      }
    };
    /* Worked out at once (only the bars on screen are checked), not in an animation frame,
       which a background tab never runs. */
    const hoverSoon = () => {
      if (!rowScrolling) updateHover();
    };
    const onPointerMove = event => {
      pointer = event.pointerType === "touch" ? null : { x: event.clientX, y: event.clientY };
      hoverSoon();
    };
    const onPointerOut = event => {
      if (!event.relatedTarget) {
        pointer = null;
        hoverSoon();
      }
    };
    /* Leaving the page (opening a picture in a new tab, switching windows) hides the bars: the
       pointer is no longer over the page, and it may be elsewhere when the user comes back. */
    const onLeave = () => {
      pointer = null;
      hoverSoon();
    };
    addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    document.addEventListener("pointerout", onPointerOut, true);
    addEventListener("blur", onLeave);
    addEventListener("scroll", hoverSoon, { capture: true, passive: true });
    /* Scrolling hides a highlight's buttons; 200 ms after it stops, the circle under the pointer
       gets them again. While the row of highlights itself scrolls, nothing is scanned: Instagram
       adds and removes circles as the row moves, and a scan after each change (or every 400 ms)
       made the row stutter. One scan follows when it stops. */
    const onScrollForHighlight = event => {
      if (hoveredHighlight) {
        hoveredHighlight = null;
        safeScan();
      }
      const target = event.target;
      if (target?.nodeType === 1 && target.querySelector(HIGHLIGHT_LINK)) rowScrolling = true;
      clearTimeout(scrollEnd);
      scrollEnd = setTimeout(() => {
        scrollEnd = null;
        const wasRow = rowScrolling;
        rowScrolling = false;
        const under = pointer && document.elementFromPoint(pointer.x, pointer.y);
        const link = under && !under.closest(HOST_TAG) ? under.closest(HIGHLIGHT_LINK) : null;
        const changed = !!link && link !== hoveredHighlight;
        if (changed) hoveredHighlight = link;
        if (changed || wasRow) safeScan();
      }, 200);
    };
    addEventListener("scroll", onScrollForHighlight, { capture: true, passive: true });

    const safeScan = () => {
      try {
        scan();
      } catch (error) {
        console.error("[Instagram Downloader]", error);
      }
      hoverSoon();
    };

    /* A scan soon after Instagram changes the page or the page scrolls, at most every 150 ms. */
    let pending = null;
    const soon = () => {
      if (!pending && !rowScrolling) pending = setTimeout(() => {
        pending = null;
        safeScan();
      }, 150);
    };
    const observer = new MutationObserver(soon);
    observer.observe(document.body, { childList: true, subtree: true });
    addEventListener("scroll", soon, { capture: true, passive: true });

    /* Without anchor positioning, fixed positions follow the page as it scrolls. */
    let frame = 0;
    const follow = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const entry of entries.values()) {
          if (entry.style && entry.anchor?.isConnected) show(entry, entry.anchor, entry.placement, entry.gap, entry.extra, entry.second);
        }
      });
    };
    if (!ANCHOR_SUPPORT) {
      addEventListener("scroll", follow, true);
      addEventListener("resize", follow);
    }

    safeScan();
    const timer = setInterval(() => {
      if (rowScrolling) return;
      safeScan();
      repaintAll();
    }, 400);
    return {
      stop() {
        clearInterval(timer);
        clearTimeout(pending);
        observer.disconnect();
        removeEventListener("scroll", soon, true);
        removeEventListener("scroll", follow, true);
        removeEventListener("resize", follow);
        removeEventListener("pointerover", onPointerOver, true);
        removeEventListener("pointermove", onPointerMove, true);
        document.removeEventListener("pointerout", onPointerOut, true);
        removeEventListener("blur", onLeave);
        removeEventListener("scroll", hoverSoon, true);
        removeEventListener("scroll", onScrollForHighlight, true);
        clearTimeout(scrollEnd);
        layer.remove();
        for (const entry of entries.values()) entry.restore ? entry.restore() : entry.host.remove();
        for (const node of document.querySelectorAll("[style*='--instagram-downloader-']")) node.style.removeProperty("anchor-name");
      },
    };
  }

  function toast(message) {
    const note = document.createElement("div");
    note.textContent = message;
    note.style.cssText =
      "position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;" +
      "border-radius:999px;background:rgba(22,22,22,.85);color:#fff;font:14px -apple-system,sans-serif;pointer-events:none";
    document.documentElement.append(note);
    setTimeout(() => note.remove(), 2500);
  }

  /* ---------- Start ---------- */

  /* Each bookmarklet click turns the buttons on or off. */
  function start() {
    if (!/(^|\.)instagram\.com$/.test(location.hostname)) {
      alert("Instagram Downloader only works on instagram.com.");
      return;
    }
    if (window.__instagramDownloader) {
      window.__instagramDownloader.stop();
      window.__instagramDownloader = null;
      toast("Instagram Downloader is off.");
      return;
    }
    window.__instagramDownloader = startButtons();
    if (!AUTO_START) toast("Instagram Downloader is on. Click the bookmarklet again to turn it off.");
  }

  try {
    start();
  } catch (error) {
    console.error("[Instagram Downloader]", error);
    alert("Something went wrong: " + error.message);
  }
})();
