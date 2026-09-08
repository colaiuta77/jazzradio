# -*- coding: utf-8 -*-
"""BookOasis Jazz Radio category plugin."""

import logging
import re
import threading
import time
import unicodedata
from difflib import SequenceMatcher

import requests

from plugins.metadata.base import BaseMetadataProvider

logger = logging.getLogger(__name__)

METADATA_CACHE_TTL = 8
METADATA_STALE_TTL = 120
PLUGIN_VERSION = "1.6.1"
METADATA_TIMEOUT = (3, 3)
METADATA_MAX_BLOCKS = 4

ITUNES_SEARCH_URL = "https://itunes.apple.com/search"
ITUNES_TIMEOUT = (2.5, 3.0)
ARTWORK_CACHE_TTL = 3600
ARTWORK_NEGATIVE_CACHE_TTL = 600
ARTWORK_CACHE_MAX = 512

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

    if not wanted_title or not result_title or not result.get("artworkUrl100"):
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


def _upgrade_artwork_url(url, size=300):
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

        artwork = _upgrade_artwork_url(best.get("artworkUrl100"), 300)
        if not artwork:
            return None

        return {
            "album_art": artwork,
            "album_name": str(best.get("collectionName") or "").strip(),
            "art_source": "iTunes",
        }

    def _get_album_art(self, artist, title):
        key = f"{_normalize_music_text(artist)}|{_normalize_music_text(title)}"
        if key == "|":
            return None

        now = time.monotonic()
        cached = self._artwork_cache.get(key)
        if cached and cached["expires"] > now:
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
            }
            while len(self._artwork_cache) > ARTWORK_CACHE_MAX:
                oldest_key = min(self._artwork_cache, key=lambda item: self._artwork_cache[item]["expires"])
                self._artwork_cache.pop(oldest_key, None)

            return dict(data) if data else None

    def _enrich_with_album_art(self, data):
        enriched = dict(data or {})
        enriched.setdefault("album_art", "")
        enriched.setdefault("album_name", "")
        enriched.setdefault("art_source", "")
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
            }
            self._now_playing_cache[station_id] = {"time": now, "last_success": last_success, "data": dict(data)}
            return data

    def get_dashboard_data(self, db_type, limit=10):
        station_id = self._requested_station_id()
        station = self._station_by_id(station_id) if station_id else None
        return {
            "success": True,
            "stations": [dict(item) for item in STATIONS],
            "count": len(STATIONS),
            "now_playing": self._get_now_playing(station) if station else None,
        }
