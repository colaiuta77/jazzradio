# -*- coding: utf-8 -*-
"""BookOasis Jazz Radio category plugin."""

import logging
import hashlib
import ipaddress
import math
import re
import threading
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

import requests

from plugins.metadata.base import BaseMetadataProvider

logger = logging.getLogger(__name__)

METADATA_CACHE_TTL = 8
METADATA_STALE_TTL = 120
PLUGIN_VERSION = "1.12.0"
METADATA_TIMEOUT = (3, 3)
METADATA_MAX_BLOCKS = 4
STREAM_TIMEOUT = (3, 20)
STREAM_DATA_URL = "/api/media/dashboard/widgets/jazzradio/data?type=general&stream=1&station="

ITUNES_SEARCH_URL = "https://itunes.apple.com/search"
ITUNES_TIMEOUT = (2.5, 3.0)
ARTWORK_CACHE_TTL = 3600
ARTWORK_NEGATIVE_CACHE_TTL = 600
ARTWORK_CACHE_MAX = 512
BACKGROUND_CACHE_TTL = 3 * 3600
BACKGROUND_FAILURE_TTL = 900
BACKGROUND_REFRESH_COOLDOWN = 60
UNSPLASH_RANDOM_URL = "https://api.unsplash.com/photos/random"
MUSICBRAINZ_API_URL = "https://musicbrainz.org/ws/2/"
MBID_RE = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
OFFICIAL_HOMEPAGE_RELATION = "fe33d22f-c3b0-4d68-bd53-a856badf2b15"

STATIONS = [
    {
        "id": "relaxingjazz",
        "name": "RelaxingJazz",
        "subtitle": "Smooth Jazz · Saint Lucia",
        "description": "광고 없이 24시간 부드러운 스무스 재즈를 들을 수 있는 채널입니다.",
        "stream_url": "https://443-1.autopo.st/171/stream/3/",
        "quality": "MP3 · 320 kbps",
        "homepage": "https://relaxingjazz.com/",
        "icon": "fa-solid fa-mug-hot",
    },
    {
        "id": "radio-swiss-jazz",
        "name": "Radio Swiss Jazz",
        "subtitle": "Jazz · Blues · Soul · Switzerland",
        "description": "SRG SSR이 제공하는 재즈·블루스·소울 중심의 스위스 인터넷 라디오입니다.",
        "stream_url": "https://stream.srg-ssr.ch/srgssr/rsj/mp3/128",
        "quality": "MP3 · 128 kbps",
        "homepage": "https://www.radioswissjazz.ch/",
        "icon": "fa-solid fa-mountain-sun",
    },
    {
        "id": "jazz24",
        "name": "Jazz24",
        "subtitle": "Classic & Modern Jazz · Seattle",
        "description": "KNKX / Pacific Public Media가 운영하는 24시간 재즈 스트림입니다.",
        "stream_url": "https://knkx-live-a.edge.audiocdn.com/6285_128k",
        "quality": "MP3 · 128 kbps",
        "homepage": "https://www.jazz24.org/",
        "icon": "fa-solid fa-music",
    },
]


def _read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _decode_icy_metadata(raw):
    raw = raw.rstrip(b"\0")
    if not raw:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1", errors="replace")


def _parse_stream_title(value):
    value = str(value or "").strip()
    if not value:
        return None
    if " - " in value:
        artist, title = value.split(" - ", 1)
    else:
        artist, title = "", value
    return {
        "artist": artist.strip(),
        "title": title.strip(),
        "raw": value,
    }


def _is_station_placeholder(station, parsed):
    raw = str((parsed or {}).get("raw") or "").strip().lower()
    if not raw:
        return True

    homepage = str(station.get("homepage") or "").strip().lower()
    host = homepage.split("://", 1)[-1].split("/", 1)[0]
    host = host[4:] if host.startswith("www.") else host
    if host and host in raw.replace("www.", ""):
        return True

    normalize = lambda value: re.sub(r"[^a-z0-9]+", "", str(value or "").lower())
    if normalize(parsed.get("artist")) == normalize(station.get("name")):
        title = str(parsed.get("title") or "").strip().lower()
        if title.startswith(("www.", "http://", "https://")) or "stream" in title:
            return True
    return False


def _normalize_music_text(value):
    value = unicodedata.normalize("NFKD", str(value or "").casefold())
    return "".join(ch for ch in value if ch.isalnum())


def _score_itunes_result(artist, title, result):
    wanted_artist = _normalize_music_text(artist)
    wanted_title = _normalize_music_text(title)
    result_artist = _normalize_music_text(result.get("artistName"))
    result_title = _normalize_music_text(result.get("trackName"))

    if not wanted_title or not result_title:
        return 0.0

    if result_title == wanted_title:
        title_score = 70.0
    elif wanted_title in result_title or result_title in wanted_title:
        title_score = 50.0
    else:
        title_score = SequenceMatcher(None, wanted_title, result_title).ratio() * 40.0

    if not wanted_artist:
        artist_score = 20.0
    elif result_artist == wanted_artist:
        artist_score = 30.0
    elif wanted_artist in result_artist or result_artist in wanted_artist:
        artist_score = 24.0
    else:
        artist_score = SequenceMatcher(None, wanted_artist, result_artist).ratio() * 20.0

    return title_score + artist_score


def _select_itunes_result(artist, title, results):
    candidates = []
    for result in results or []:
        score = _score_itunes_result(artist, title, result)
        if score >= 55.0:
            candidates.append((score, result))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _https_url(value, hosts):
    value = str(value or "").strip()
    try:
        parsed = urlsplit(value)
        if (parsed.scheme == "https" and parsed.hostname in hosts
                and parsed.port in (None, 443) and not parsed.username and not parsed.password
                and not re.search(r"[\x00-\x20\\]", value)):
            return value
    except ValueError:
        pass
    return ""


def _unsplash_link(value):
    value = _https_url(value, {"unsplash.com"})
    if not value:
        return ""
    parsed = urlsplit(value)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    params.update(utm_source="bookoasis_jazzradio", utm_medium="referral")
    return parsed._replace(query=urlencode(params)).geturl()


def _upgrade_artwork_url(url, size=600):
    url = str(url or "").strip()
    if not url:
        return ""
    upgraded = re.sub(r"/\d+x\d+bb\.", f"/{size}x{size}bb.", url)
    if upgraded == url:
        upgraded = url.replace("100x100bb", f"{size}x{size}bb")
    return upgraded


class JazzradioMetadataProvider(BaseMetadataProvider):
    id = "jazzradio"
    name = "Jazz Radio"
    is_searchable = False
    config_schema = []

    category_tab = {
        "title": "Jazz Radio",
        "icon": "fa-solid fa-radio",
        "order": 96,
        "sessions": "all",
    }

    update_manifest = None
    dashboard_widget = None

    _now_playing_cache = {}
    _now_playing_locks = {station["id"]: threading.Lock() for station in STATIONS}
    _artwork_cache = {}
    _artwork_lock = threading.Lock()
    _background_cache = {}
    _background_lock = threading.Lock()
    _artist_site_cache = {}
    _artist_site_lock = threading.Lock()
    _musicbrainz_last_request = 0
    _musicbrainz_lock = threading.Lock()
    _album_lookup_gate = threading.Lock()

    def search(self, db_type, query):
        return []

    def apply(self, db_type, book_id, item_data):
        return False, "Jazz Radio 플러그인은 메타데이터 적용 기능을 사용하지 않습니다."

    @staticmethod
    def _requested_station_id():
        try:
            from flask import request
            return (request.args.get("station") or "").strip() or None
        except Exception:
            return None

    @staticmethod
    def _station_by_id(station_id):
        return next((station for station in STATIONS if station["id"] == station_id), None)

    def _lookup_itunes_artwork(self, artist, title):
        if not artist or not title:
            return None

        response = requests.get(
            ITUNES_SEARCH_URL,
            params={
                "term": f"{artist} {title}",
                "media": "music",
                "entity": "song",
                "limit": 8,
                "country": "US",
            },
            headers={"User-Agent": f"BookOasis-JazzRadio/{PLUGIN_VERSION}"},
            timeout=ITUNES_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        best = _select_itunes_result(artist, title, payload.get("results") or [])
        if not best:
            return None

        artwork = _upgrade_artwork_url(best.get("artworkUrl100"), 600)
        if not artwork and (_normalize_music_text(best.get("artistName")) != _normalize_music_text(artist)
                            or _normalize_music_text(best.get("trackName")) != _normalize_music_text(title)):
            return None
        return {
            "album_art": artwork,
            "album_name": str(best.get("collectionName") or "").strip(),
            "art_source": "iTunes",
            "artist_url": _https_url(best.get("artistViewUrl"), {"music.apple.com", "itunes.apple.com"}),
            "album_url": _https_url(best.get("collectionViewUrl"), {"music.apple.com", "itunes.apple.com"}),
            "track_url": _https_url(best.get("trackViewUrl"), {"music.apple.com", "itunes.apple.com"}),
            "duration_ms": best["trackTimeMillis"] if type(best.get("trackTimeMillis")) is int and best["trackTimeMillis"] > 0 else 0,
            "genre": str(best.get("primaryGenreName") or "").strip(),
            "release_date": str(best.get("releaseDate") or "").strip(),
        }

    def _musicbrainz_json(self, entity, mbid="", **params):
        with self._musicbrainz_lock:
            delay = 1.1 - (time.monotonic() - type(self)._musicbrainz_last_request)
            if delay > 0:
                time.sleep(delay)
            type(self)._musicbrainz_last_request = time.monotonic()
            response = requests.get(
                MUSICBRAINZ_API_URL + entity + "/" + mbid,
                params={"fmt": "json", **params},
                headers={"User-Agent": f"BookOasis-JazzRadio/{PLUGIN_VERSION} (https://github.com/colaiuta77/jazzradio)"},
                timeout=ITUNES_TIMEOUT,
            )
            response.raise_for_status()
            return response.json()

    def _get_artist_site(self, artist):
        artist = str(artist or "").strip()
        key = _normalize_music_text(artist)
        if not key or len(artist) > 160:
            return ""
        # 이름 검색과 관계 조회도 같은 잠금 안에서 간격을 지킨다.
        with self._artist_site_lock:
            cached = self._artist_site_cache.get(key)
            if cached and cached["expires"] > time.monotonic():
                return cached["url"]
            site, status = "", "not_found"
            try:
                literal = artist.replace("\\", "\\\\").replace('"', '\\"')
                result = self._musicbrainz_json("artist", query=f'artist:"{literal}"', limit=25)
                artists = result.get("artists") or []
                candidates = {item["id"] for item in artists
                              if _normalize_music_text(item.get("name")) == key
                              and MBID_RE.fullmatch(str(item.get("id") or ""))}
                if len(candidates) > 1 or int(result.get("count", len(artists))) > len(artists):
                    status = "ambiguous"
                elif len(candidates) == 1:
                    detail = self._musicbrainz_json("artist", candidates.pop(), inc="url-rels")
                    for relation in detail.get("relations") or []:
                        if relation.get("type-id") != OFFICIAL_HOMEPAGE_RELATION or relation.get("ended"):
                            continue
                        value = str((relation.get("url") or {}).get("resource") or "").strip()
                        parsed = urlsplit(value)
                        host = parsed.hostname or ""
                        if (parsed.scheme not in {"http", "https"} or not host or "." not in host
                                or host.endswith((".local", ".localhost")) or parsed.username or parsed.password
                                or re.search(r"[\x00-\x20]", value)):
                            continue
                        try:
                            ipaddress.ip_address(host)
                        except ValueError:
                            site = value
                            break
            except Exception as exc:
                status = "unavailable"
                logger.warning("[jazzradio] Artist homepage lookup failed: %s", exc)
            self._artist_site_cache[key] = {"url": site, "status": "found" if site else status, "expires": time.monotonic() + (7 * 86400 if site else 30 if status == "unavailable" else 600)}
            while len(self._artist_site_cache) > ARTWORK_CACHE_MAX:
                self._artist_site_cache.pop(min(self._artist_site_cache, key=lambda item: self._artist_site_cache[item]["expires"]))
            return site

    def _lookup_musicbrainz_artwork(self, artist, title, seed):
        if not artist or not title or len(artist) > 160 or len(title) > 250:
            return None
        artist_literal = artist.replace("\\", "\\\\").replace('"', '\\"')
        title_literal = title.replace("\\", "\\\\").replace('"', '\\"')
        result = self._musicbrainz_json("recording", query=f'recording:"{title_literal}" AND artist:"{artist_literal}"', limit=25)
        recordings = result.get("recordings") or []
        if int(result.get("count", len(recordings))) > len(recordings):
            return None
        wanted_artist, wanted_title = _normalize_music_text(artist), _normalize_music_text(title)
        candidates = {}
        for item in recordings:
            credit = "".join(str(part.get("name") or (part.get("artist") or {}).get("name") or "") + str(part.get("joinphrase") or "") for part in item.get("artist-credit") or [])
            if (_normalize_music_text(item.get("title")) != wanted_title or _normalize_music_text(credit) != wanted_artist
                    or not MBID_RE.fullmatch(str(item.get("id") or ""))):
                continue
            if seed.get("duration_ms") and (type(item.get("length")) is not int or abs(item["length"] - seed["duration_ms"]) > 3000):
                continue
            if seed.get("album_name") and not any(_normalize_music_text(release.get("title")) == _normalize_music_text(seed["album_name"]) for release in item.get("releases") or []):
                continue
            if re.search(r"\b(live|remix|demo|rehearsal|alternate|karaoke)\b", str(item.get("disambiguation") or ""), re.I):
                continue
            candidates[item["id"]] = item
        if len(candidates) != 1:
            return None
        recording_id = next(iter(candidates))
        detail = self._musicbrainz_json("recording", recording_id, inc="artists+releases+release-groups")
        releases = detail.get("releases") or []
        if len(releases) >= 25:
            return None
        groups = {}
        for release in releases:
            group = release.get("release-group") or {}
            if (release.get("status") != "Official" or group.get("primary-type") not in {"Album", "EP", "Single"}
                    or group.get("secondary-types") or not MBID_RE.fullmatch(str(group.get("id") or ""))):
                continue
            if seed.get("album_name") and _normalize_music_text(group.get("title")) != _normalize_music_text(seed["album_name"]):
                continue
            groups[group["id"]] = (group, release)
        if len(groups) != 1:
            return None
        group_id, (group, release) = next(iter(groups.items()))
        data = {"album_name": str(group.get("title") or release.get("title") or ""),
                "duration_ms": detail["length"] if type(detail.get("length")) is int and detail["length"] > 0 else 0,
                "release_date": str(group.get("first-release-date") or release.get("date") or ""),
                "metadata_source_url": f"https://musicbrainz.org/recording/{recording_id}"}
        try:
            response = requests.get(f"https://coverartarchive.org/release-group/{group_id}",
                                    headers={"User-Agent": f"BookOasis-JazzRadio/{PLUGIN_VERSION} (https://github.com/colaiuta77/jazzradio)"}, timeout=ITUNES_TIMEOUT)
            if response.status_code == 200 and any(image.get("front") is True and image.get("approved") is True for image in response.json().get("images") or []):
                data.update(album_art=f"https://coverartarchive.org/release-group/{group_id}/front-500",
                            art_source="Cover Art Archive", cover_source_url=f"https://musicbrainz.org/release-group/{group_id}")
        except Exception as exc:
            logger.warning("[jazzradio] Cover Art Archive lookup failed: %s", exc)
        return data

    def _schedule_musicbrainz_artwork(self, key, artist, title):
        if not self._album_lookup_gate.acquire(blocking=False):
            return
        with self._artwork_lock:
            entry = self._artwork_cache.get(key)
            if not entry or not entry.get("needs_mb"):
                self._album_lookup_gate.release()
                return
            entry["needs_mb"] = False
            seed = dict(entry["data"] or {})

        def supplement():
            try:
                extra = self._lookup_musicbrainz_artwork(artist, title, seed)
                with self._artwork_lock:
                    if self._artwork_cache.get(key) is not entry:
                        return
                    merged = dict(entry["data"] or {})
                    for field in ("album_name", "duration_ms", "release_date", "album_art"):
                        if not merged.get(field) and extra and extra.get(field):
                            merged[field] = extra[field]
                            if field == "album_art":
                                merged["art_source"] = extra.get("art_source", "")
                                merged["cover_source_url"] = extra.get("cover_source_url", "")
                            else:
                                merged["metadata_source_url"] = extra.get("metadata_source_url", "")
                    complete = all(merged.get(field) for field in ("album_art", "album_name", "duration_ms", "release_date"))
                    entry.update(data=merged or None, expires=time.monotonic() + (ARTWORK_CACHE_TTL if complete else ARTWORK_NEGATIVE_CACHE_TTL))
            except Exception as exc:
                logger.warning("[jazzradio] MusicBrainz artwork lookup failed: %s", exc)
                with self._artwork_lock:
                    if self._artwork_cache.get(key) is entry:
                        entry["expires"] = time.monotonic() + ARTWORK_NEGATIVE_CACHE_TTL
            finally:
                self._album_lookup_gate.release()
        try:
            threading.Thread(target=supplement, name="jazzradio-album", daemon=True).start()
        except RuntimeError:
            entry["needs_mb"] = True
            self._album_lookup_gate.release()

    def _get_album_art(self, artist, title):
        key = f"{_normalize_music_text(artist)}|{_normalize_music_text(title)}"
        if key == "|":
            return None

        now = time.monotonic()
        cached = self._artwork_cache.get(key)
        if cached and cached["expires"] > now:
            if cached.get("needs_mb"):
                self._schedule_musicbrainz_artwork(key, artist, title)
            return dict(cached["data"]) if cached["data"] else None

        try:
            data = self._lookup_itunes_artwork(artist, title)
        except Exception as exc:
            logger.warning("[jazzradio] iTunes artwork lookup failed (%s - %s): %s", artist, title, exc)
            data = None

        with self._artwork_lock:
            ttl = ARTWORK_CACHE_TTL if data else ARTWORK_NEGATIVE_CACHE_TTL
            self._artwork_cache[key] = {
                "expires": time.monotonic() + ttl,
                "data": dict(data) if data else None,
                "needs_mb": not data or any(not data.get(field) for field in ("album_art", "album_name", "duration_ms", "release_date")),
            }
            while len(self._artwork_cache) > ARTWORK_CACHE_MAX:
                oldest_key = min(self._artwork_cache, key=lambda item: self._artwork_cache[item]["expires"])
                self._artwork_cache.pop(oldest_key, None)

        if self._artwork_cache.get(key, {}).get("needs_mb"):
            self._schedule_musicbrainz_artwork(key, artist, title)
        return dict(data) if data else None

    def _enrich_with_album_art(self, data):
        enriched = dict(data or {})
        enriched.setdefault("album_art", "")
        enriched.setdefault("album_name", "")
        enriched.setdefault("art_source", "")
        for field in ("artist_url", "album_url", "track_url", "genre", "release_date"):
            enriched.setdefault(field, "")
        enriched.setdefault("duration_ms", 0)
        if enriched.get("available") is not True:
            return enriched

        artist = str(enriched.get("artist") or "").strip()
        title = str(enriched.get("title") or "").strip()
        if not artist or not title:
            return enriched

        artwork = self._get_album_art(artist, title)
        if artwork:
            enriched.update(artwork)
        return enriched

    @staticmethod
    def _unsplash_json(url, key, params=None):
        with requests.get(
            url, params=params,
            headers={"Authorization": "Client-ID " + key, "Accept-Version": "v1",
                     "User-Agent": f"BookOasis-JazzRadio/{PLUGIN_VERSION}"},
            timeout=ITUNES_TIMEOUT, allow_redirects=False,
        ) as response:
            response.raise_for_status()
            if response.status_code != 200:
                raise ValueError("Unsplash request was redirected or rejected")
            return response.json()

    def _lookup_unsplash_background(self, key):
        photo = self._unsplash_json(UNSPLASH_RANDOM_URL, key, {
            "query": "jazz", "orientation": "landscape", "content_filter": "high",
        })
        if not isinstance(photo, dict) or photo.get("premium") or photo.get("plus"):
            raise ValueError("Invalid Unsplash photo")
        images, links, author = photo.get("urls") or {}, photo.get("links") or {}, photo.get("user") or {}
        image = _https_url(images.get("raw") or images.get("full") or images.get("regular"), {"images.unsplash.com"})
        source = _unsplash_link(links.get("html"))
        creator = _unsplash_link((author.get("links") or {}).get("html"))
        tracking = _https_url(links.get("download_location"), {"api.unsplash.com"})
        if not image or not source or not creator or not re.fullmatch(r"/photos/[^/]+/download", urlsplit(tracking).path):
            raise ValueError("Invalid Unsplash attribution or download URL")
        parsed = urlsplit(image)
        params = dict(parse_qsl(parsed.query, keep_blank_values=True))
        for field in ("h", "dpr"):
            params.pop(field, None)
        params.update(w="2200", q="80", auto="format", fit="max")
        # 실제 배경을 선택할 때만 다운로드를 추적하고 이미지는 공식 CDN에 직접 연결한다.
        self._unsplash_json(tracking, key)
        return {"url": parsed._replace(query=urlencode(params)).geturl(),
                "creator": str(author.get("name") or "Unsplash 작가")[:200],
                "creator_url": creator, "source_url": source, "reason": ""}

    def _background_config(self, db_type):
        db_type = db_type if db_type in ("general", "adult", "audiobook", "video") else "general"
        configs = {}
        try:
            gateway = self.get_db_gateway(db_type)
        except Exception:
            gateway = None
        for source in ("detail_studio", "jazzradio"):
            try:
                config = gateway.get_plugin_config(source, default={}) or {}
                configs[source] = config if isinstance(config, dict) else {}
            except Exception:
                pass
        reason = "key-required" if configs else "config-unavailable"
        for source in ("detail_studio", "jazzradio"):
            config = configs.get(source, {})
            key = str(config.get("unsplash_key") or "").strip()
            if key and config.get("unsplash_terms") in (True, 1, "1", "true", "on"):
                return key, source, "", configs.get("jazzradio", {})
            if key:
                reason = "terms-pending"
        return "", "default", reason, configs.get("jazzradio", {})

    def _background_settings(self, db_type):
        from flask import session
        _, source, _, own = self._background_config(db_type)
        return {"can_edit": bool(session.get("user_id") and session.get("role") == "admin"
                                 and session.get("is_default_password") != 1),
                "key_saved": bool(str(own.get("unsplash_key") or "").strip()),
                "terms": own.get("unsplash_terms") in (True, 1, "1", "true", "on"), "source": source}

    def run_context_menu_action(self, db_type, action_id, context):
        from flask import has_request_context, request, session
        if (not has_request_context() or request.method != "POST" or not session.get("user_id")
                or session.get("role") != "admin" or session.get("is_default_password") == 1):
            return {"success": False, "error": "관리자로 로그인한 뒤 다시 실행해 주세요."}
        if (action_id != "background_settings" or db_type not in ("general", "adult", "audiobook", "video")
                or not isinstance(context, dict) or set(context) - {"operation", "unsplash_key", "unsplash_terms"}
                or context.get("operation") not in ("save", "delete")):
            return {"success": False, "error": "올바르지 않은 배경 설정 요청입니다."}
        # 공용 액션 경로에서도 커스텀 헤더와 동일 출처를 확인해 설정 변경을 보호한다.
        origin = request.headers.get("Origin")
        try:
            parsed = urlsplit(origin) if origin else None
            same_origin = not parsed or (parsed.scheme in ("http", "https") and parsed.netloc == request.host
                                         and parsed.path in ("", "/") and not parsed.query and not parsed.fragment)
        except ValueError:
            same_origin = False
        if (request.headers.get("X-Jazzradio-Settings") != "1" or not same_origin
                or request.headers.get("Sec-Fetch-Site", "") not in ("", "same-origin", "none")):
            return {"success": False, "error": "같은 BookOasis 화면에서 다시 실행해 주세요."}
        try:
            with self._background_lock:
                gateway = self.get_db_gateway(db_type)
                config = dict(gateway.get_plugin_config("jazzradio", default={}) or {})
                previous = (config.get("unsplash_key"), config.get("unsplash_terms"))
                if context["operation"] == "delete":
                    config.pop("unsplash_key", None)
                    config.pop("unsplash_terms", None)
                else:
                    key = context.get("unsplash_key", "")
                    if not isinstance(key, str):
                        return {"success": False, "error": "Unsplash Access Key 형식을 확인해 주세요."}
                    key = key.strip()
                    if key and not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", key):
                        return {"success": False, "error": "Unsplash Access Key 형식을 확인해 주세요."}
                    if not key and not str(config.get("unsplash_key") or "").strip():
                        return {"success": False, "error": "Unsplash Access Key를 입력해 주세요."}
                    if "unsplash_terms" in context and type(context["unsplash_terms"]) is not bool:
                        return {"success": False, "error": "Unsplash 약관 동의 여부를 확인해 주세요."}
                    if key:
                        config["unsplash_key"] = key
                    if "unsplash_terms" in context:
                        config["unsplash_terms"] = context["unsplash_terms"]
                gateway.set_plugin_config("jazzradio", config)
                cached = self._background_cache.get(db_type)
                if (previous != (config.get("unsplash_key"), config.get("unsplash_terms"))
                        and cached and cached["data"].get("source") == "jazzradio"):
                    self._background_cache.pop(db_type, None)
            return {"success": True, "background_settings": self._background_settings(db_type)}
        except Exception:
            return {"success": False, "error": "배경 설정을 저장하지 못했습니다. 다시 시도해 주세요."}

    def _get_background(self, db_type, force=False):
        db_type = db_type if db_type in ("general", "adult", "audiobook", "video") else "general"
        with self._background_lock:
            key, source, reason, _ = self._background_config(db_type)
            empty = {"url": "", "creator": "", "creator_url": "", "source_url": "", "source": source}
            if not key:
                self._background_cache.pop(db_type, None)
                return {**empty, "reason": reason}
            fingerprint = hashlib.sha256((source + "\0" + key).encode()).hexdigest()
            now = time.monotonic()
            cached = self._background_cache.get(db_type)
            if cached and cached.get("fingerprint") != fingerprint:
                cached = None
                self._background_cache.pop(db_type, None)
            if cached and cached["expires"] > now:
                if not force:
                    return dict(cached["data"])
                if cached["data"].get("reason") == "request-failed":
                    return {**cached["data"], "retry_after": math.ceil(cached["expires"] - now)}
                last_forced = cached.get("last_forced")
                if last_forced is not None and last_forced + BACKGROUND_REFRESH_COOLDOWN > now:
                    return {**cached["data"], "reason": "cooldown",
                            "retry_after": math.ceil(last_forced + BACKGROUND_REFRESH_COOLDOWN - now)}
            try:
                data = {**self._lookup_unsplash_background(key), "source": source}
                ttl = BACKGROUND_CACHE_TTL
            except Exception:
                # 원격 예외는 인증 헤더나 응답 내용을 포함할 수 있어 기록하지 않는다.
                data = {**(cached["data"] if cached else empty), "reason": "request-failed"}
                ttl = BACKGROUND_FAILURE_TTL
            finished = time.monotonic()
            self._background_cache[db_type] = {
                "data": data, "expires": finished + ttl, "fingerprint": fingerprint,
                "last_forced": finished if force else (cached.get("last_forced") if cached else None),
            }
            if force:
                return {**data, "retry_after": BACKGROUND_FAILURE_TTL if data["reason"] == "request-failed" else BACKGROUND_REFRESH_COOLDOWN}
            return dict(data)

    def _fetch_icy_now_playing(self, station):
        headers = {
            "Icy-MetaData": "1",
            "User-Agent": f"BookOasis-JazzRadio/{PLUGIN_VERSION}",
            "Accept": "*/*",
        }
        with requests.get(
            station["stream_url"],
            headers=headers,
            stream=True,
            timeout=METADATA_TIMEOUT,
            allow_redirects=True,
        ) as response:
            response.raise_for_status()
            response.raw.decode_content = False
            metaint = response.headers.get("icy-metaint")
            if not metaint:
                return None
            metaint = int(metaint)
            if metaint <= 0:
                return None

            for _ in range(METADATA_MAX_BLOCKS):
                audio_bytes = _read_exact(response.raw, metaint)
                if len(audio_bytes) != metaint:
                    return None
                length_byte = _read_exact(response.raw, 1)
                if not length_byte:
                    return None
                metadata_size = length_byte[0] * 16
                if not metadata_size:
                    continue
                metadata = _decode_icy_metadata(_read_exact(response.raw, metadata_size))
                match = re.search(r"StreamTitle='(.*?)';", metadata)
                if not match:
                    continue
                parsed = _parse_stream_title(match.group(1))
                if parsed and _is_station_placeholder(station, parsed):
                    continue
                if parsed:
                    parsed.update({
                        "available": True,
                        "station_id": station["id"],
                        "station_name": station["name"],
                        "stale": False,
                    })
                    return parsed
        return None

    def _get_now_playing(self, station):
        station_id = station["id"]
        now = time.monotonic()
        cached = self._now_playing_cache.get(station_id)
        if cached and now - cached["time"] < METADATA_CACHE_TTL:
            return dict(cached["data"])

        with self._now_playing_locks[station_id]:
            now = time.monotonic()
            cached = self._now_playing_cache.get(station_id)
            if cached and now - cached["time"] < METADATA_CACHE_TTL:
                return dict(cached["data"])

            try:
                data = self._fetch_icy_now_playing(station)
            except Exception as exc:
                logger.warning("[jazzradio] ICY metadata fetch failed (%s): %s", station_id, exc)
                data = None

            if data:
                data = self._enrich_with_album_art(data)
                now = time.monotonic()
                self._now_playing_cache[station_id] = {"time": now, "last_success": now, "data": dict(data)}
                return data

            now = time.monotonic()
            last_success = cached.get("last_success", 0) if cached else 0
            if cached and cached["data"].get("available") and now - last_success < METADATA_STALE_TTL:
                stale = dict(cached["data"])
                stale["stale"] = True
                self._now_playing_cache[station_id] = {"time": now, "last_success": last_success, "data": stale}
                return stale

            data = {
                "available": False,
                "station_id": station_id,
                "station_name": station["name"],
                "artist": "",
                "title": "",
                "raw": "",
                "stale": False,
                "album_art": "",
                "album_name": "",
                "art_source": "",
                "artist_url": "",
                "album_url": "",
                "track_url": "",
                "duration_ms": 0,
                "genre": "",
                "release_date": "",
            }
            self._now_playing_cache[station_id] = {"time": now, "last_success": last_success, "data": dict(data)}
            return data

    def _local_asset(self, asset):
        from flask import Response, after_this_request, request, session

        if not session.get("user_id") or set(request.args) - {"type", "limit", asset}:
            return {"success": False, "error": "로그인 후 고정된 리소스 경로를 사용해 주세요."}
        filename, content_type = {
            "pcm_test": ("pcm_probe.html", "text/html; charset=utf-8"),
            "decoder": ("vendor/mpg123-decoder.min.js", "application/javascript; charset=utf-8"),
            "turntable_base": ("assets/turntable-base.png", "image/png"),
            "turntable_disc": ("assets/turntable-disc.png", "image/png"),
        }[asset]
        try:
            content = (Path(__file__).parent / filename).read_bytes()
        except OSError:
            return {"success": False, "error": "플러그인 리소스 파일이 누락되었습니다. 플러그인 폴더 전체를 확인해 주세요."}

        @after_this_request
        def deliver_asset(response):
            if response.status_code != 200:
                return response
            return Response(content, content_type=content_type, headers={
                "Cache-Control": "private, max-age=86400" if content_type == "image/png" else "no-store",
                "X-Content-Type-Options": "nosniff",
            })

        return {"success": True}

    def _relay_stream(self):
        from flask import Response, after_this_request, request, session

        if not session.get("user_id"):
            return {"success": False, "error": "로그인이 필요합니다."}
        station = self._station_by_id(self._requested_station_id())
        if not station or set(request.args) - {"type", "stream", "station", "limit"}:
            return {"success": False, "error": "등록된 방송국만 중계할 수 있습니다."}

        upstream = None
        try:
            upstream = requests.get(
                station["stream_url"],
                headers={
                    "Icy-MetaData": "0",
                    "Accept-Encoding": "identity",
                    "User-Agent": f"BookOasis-JazzRadio/{PLUGIN_VERSION}",
                },
                stream=True,
                timeout=STREAM_TIMEOUT,
                allow_redirects=True,
            )
            upstream.raise_for_status()
            content_type = upstream.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if not content_type.startswith("audio/"):
                raise ValueError("upstream did not return audio")
        except Exception as exc:
            if upstream is not None:
                upstream.close()
            logger.warning("[jazzradio] Stream relay connection failed (%s): %s", station["id"], exc)
            return {"success": False, "error": "방송국 중계 연결에 실패했습니다."}

        def audio_chunks():
            try:
                for chunk in upstream.iter_content(chunk_size=1024):
                    if chunk:
                        yield chunk
            except Exception as exc:
                logger.warning("[jazzradio] Stream relay interrupted (%s): %s", station["id"], exc)
            finally:
                upstream.close()

        relay = Response(audio_chunks(), content_type=content_type, headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        })
        relay.call_on_close(upstream.close)

        # 코어가 결과를 JSON으로 감싼 뒤 정상 응답만 오디오로 교체한다.
        @after_this_request
        def deliver_audio(response):
            if response.status_code != 200:
                relay.close()
                return response
            return relay

        return {"success": True}

    def get_dashboard_data(self, db_type, limit=10):
        try:
            from flask import has_request_context, request
        except ImportError:
            pass
        else:
            if has_request_context():
                if "background_settings" in request.args:
                    from flask import session
                    if (not session.get("user_id") or request.method != "GET" or request.args.get("background_settings") != "1"
                            or set(request.args) - {"type", "limit", "background_settings"}):
                        return {"success": False, "error": "로그인 후 고정된 배경 설정 경로를 사용해 주세요."}
                    return {"success": True, "background_settings": self._background_settings(db_type)}
                for asset in ("pcm_test", "decoder", "turntable_base", "turntable_disc"):
                    if request.args.get(asset) == "1":
                        return self._local_asset(asset)
                if request.args.get("stream") == "1":
                    return self._relay_stream()
                if request.args.get("artist_site") == "1":
                    from flask import session
                    station = self._station_by_id(self._requested_station_id())
                    if (not session.get("user_id") or not station
                            or set(request.args) - {"type", "limit", "artist_site", "station"}):
                        return {"success": False, "error": "로그인 후 고정된 방송국 경로를 사용해 주세요."}
                    np = self._get_now_playing(station)
                    artist = str(np.get("artist") or "") if np.get("available") and not np.get("stale") else ""
                    site = self._get_artist_site(artist)
                    status = "found" if site else self._artist_site_cache.get(_normalize_music_text(artist), {}).get("status", "no_artist")
                    return {"success": True, "artist": artist, "official_site": site, "official_site_status": status}
                if request.args.get("background") == "1":
                    from flask import session
                    if (not session.get("user_id") or set(request.args) - {"type", "limit", "background", "refresh"}
                            or ("refresh" in request.args and request.args.get("refresh") != "1")):
                        return {"success": False, "error": "로그인 후 고정된 배경 경로를 사용해 주세요."}
                    return {"success": True, "background": self._get_background(db_type, force=request.args.get("refresh") == "1")}
        station_id = self._requested_station_id()
        station = self._station_by_id(station_id) if station_id else None
        return {
            "success": True,
            "version": PLUGIN_VERSION,
            "stations": [dict(item, relay_url=STREAM_DATA_URL + item["id"]) for item in STATIONS],
            "count": len(STATIONS),
            "now_playing": self._get_now_playing(station) if station else None,
        }
