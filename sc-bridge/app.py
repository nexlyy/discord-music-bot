"""
Мост SoundCloud → Lavalink.

С конца 2025 года SoundCloud отдаёт новые треки только потоком AAC HLS, который встроенный
источник Lavalink не понимает (lavalink-devs/lavaplayer#189). Мост скачивает трек через yt-dlp
в .m4a и отдаёт обычным HTTP-файлом с поддержкой Range (перемотка). Lavalink играет его как http-трек.

Эндпоинты (только во внутренней сети docker compose):
  GET /resolve?url=<ссылка>      метаданные трека или плейлиста
  GET /search?q=<запрос>          поиск треков
  GET /stream/<id>                аудиофайл (качает при первом обращении)
  GET /prefetch/<id>              скачать заранее, ответ сразу
  GET /health
"""

import glob
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yt_dlp

CACHE = os.environ.get("CACHE_DIR", "/cache")
CACHE_LIMIT = int(os.environ.get("CACHE_MB", "1024")) * 1024 * 1024
PORT = int(os.environ.get("PORT", "8080"))
API = "https://api-v2.soundcloud.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
MIME = {"m4a": "audio/mp4", "mp4": "audio/mp4", "mp3": "audio/mpeg", "opus": "audio/ogg", "ogg": "audio/ogg", "webm": "audio/webm"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sc-bridge")
os.makedirs(CACHE, exist_ok=True)


class BridgeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- client_id

_client_id = {"value": None, "at": 0.0}
_client_lock = threading.Lock()


def _http_get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def client_id(force: bool = False) -> str:
    """client_id веб-плеера SoundCloud: ищем в скриптах главной страницы, как это делают lavaplayer и yt-dlp."""
    with _client_lock:
        if not force and _client_id["value"] and time.time() - _client_id["at"] < 6 * 3600:
            return _client_id["value"]
        html = _http_get("https://soundcloud.com/").decode("utf-8", "replace")
        scripts = re.findall(r'<script[^>]+src="(https://a-v2\.sndcdn\.com/assets/[^"]+\.js)"', html)
        for src in reversed(scripts):
            m = re.search(r'client_id\s*:\s*"([a-zA-Z0-9]{32})"', _http_get(src).decode("utf-8", "replace"))
            if m:
                _client_id.update(value=m.group(1), at=time.time())
                log.info("client_id обновлён")
                return m.group(1)
        raise BridgeError(502, "Не удалось получить client_id SoundCloud")


def api(path: str, params: dict) -> object:
    for attempt in range(2):
        query = urllib.parse.urlencode({**params, "client_id": client_id(force=attempt > 0)})
        try:
            return json.loads(_http_get(f"{API}{path}?{query}"))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403) and attempt == 0:
                continue
            if e.code == 404:
                raise BridgeError(404, "Не найдено на SoundCloud (удалено или приватное)")
            raise BridgeError(502, f"SoundCloud ответил {e.code}")
    raise BridgeError(502, "SoundCloud не отвечает")


# ---------------------------------------------------------------- метаданные

def track_meta(t: dict) -> dict:
    transcodings = (t.get("media") or {}).get("transcodings") or []
    protocols = [tc.get("format", {}).get("protocol", "") for tc in transcodings]
    artwork = t.get("artwork_url") or (t.get("user") or {}).get("avatar_url")
    publisher = t.get("publisher_metadata") or {}
    return {
        "id": t["id"],
        "url": t.get("permalink_url"),
        "title": t.get("title") or "Без названия",
        "artist": publisher.get("artist") or (t.get("user") or {}).get("username") or "SoundCloud",
        "duration": t.get("full_duration") or t.get("duration") or 0,
        "artwork": artwork.replace("-large.", "-t500x500.") if artwork else None,
        # Все варианты зашифрованы — DRM, скачать нельзя
        "drm": bool(protocols) and all("encrypted" in p for p in protocols),
        "playable": bool(protocols) and t.get("policy") != "BLOCK",
    }


def full_tracks(items: list) -> list:
    """В плейлисте SoundCloud полными приходят только первые треки, остальные — заглушки с id."""
    by_id = {t["id"]: t for t in items if "title" in t}
    missing = [t["id"] for t in items if "title" not in t]
    for i in range(0, len(missing), 50):
        for t in api("/tracks", {"ids": ",".join(map(str, missing[i:i + 50]))}):
            by_id[t["id"]] = t
    return [by_id[t["id"]] for t in items if t["id"] in by_id]


def resolve(url: str) -> dict:
    url = url.split("?")[0]
    data = api("/resolve", {"url": url})
    kind = data.get("kind")
    if kind == "track":
        return {"kind": "track", "title": data.get("title"), "url": data.get("permalink_url"), "tracks": [track_meta(data)]}
    if kind == "playlist":
        tracks = [track_meta(t) for t in full_tracks(data.get("tracks") or [])]
        return {"kind": "playlist", "title": data.get("title"), "url": data.get("permalink_url"), "tracks": tracks}
    raise BridgeError(422, "По ссылке не трек и не плейлист (профили пока не поддерживаются)")


def search(q: str, limit: int) -> dict:
    data = api("/search/tracks", {"q": q, "limit": limit})
    tracks = [track_meta(t) for t in data.get("collection", []) if t.get("kind") == "track"]
    return {"kind": "search", "title": None, "url": None, "tracks": tracks}


# ---------------------------------------------------------------- загрузка и кэш

_locks: dict = {}
_locks_guard = threading.Lock()


def cached_file(track_id: str):
    files = [f for f in glob.glob(os.path.join(CACHE, f"{track_id}.*")) if ".part" not in f and ".tmp." not in f]
    return files[0] if files else None


def evict():
    files = sorted((os.path.join(CACHE, f) for f in os.listdir(CACHE)), key=lambda f: os.stat(f).st_atime)
    total = sum(os.path.getsize(f) for f in files)
    while files and total > CACHE_LIMIT:
        f = files.pop(0)
        total -= os.path.getsize(f)
        os.remove(f)


def download(track_id: str) -> str:
    with _locks_guard:
        lock = _locks.setdefault(track_id, threading.Lock())
    with lock:
        existing = cached_file(track_id)
        if existing:
            os.utime(existing)
            return existing
        started = time.time()
        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio[acodec!=none]",
            "outtmpl": os.path.join(CACHE, f"{track_id}.tmp.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.extract_info(f"https://api.soundcloud.com/tracks/{track_id}", download=True)
        except yt_dlp.utils.DownloadError as e:
            text = str(e)
            if "DRM" in text:
                raise BridgeError(451, "Трек защищён DRM")
            raise BridgeError(502, f"Не удалось скачать: {text[-200:]}")
        tmp = glob.glob(os.path.join(CACHE, f"{track_id}.tmp.*"))
        if not tmp:
            raise BridgeError(502, "yt-dlp не создал файл")
        ext = tmp[0].rsplit(".", 1)[-1]
        final = os.path.join(CACHE, f"{track_id}.{ext}")
        os.replace(tmp[0], final)
        log.info("скачан %s за %.1f с (%d КБ)", track_id, time.time() - started, os.path.getsize(final) // 1024)
        evict()
        return final


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, status: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_HEAD(self):
        self.handle_request(head=True)

    def do_GET(self):
        self.handle_request(head=False)

    def handle_request(self, head: bool):
        parsed = urllib.parse.urlparse(self.path)
        params = dict(urllib.parse.parse_qsl(parsed.query))
        try:
            if parsed.path == "/health":
                return self.send_json(200, {"ok": True})
            if parsed.path == "/resolve":
                return self.send_json(200, resolve(params.get("url", "")))
            if parsed.path == "/search":
                return self.send_json(200, search(params.get("q", ""), min(int(params.get("limit", "10")), 25)))
            m = re.fullmatch(r"/prefetch/(\d+)", parsed.path)
            if m:
                threading.Thread(target=self.quiet_download, args=(m.group(1),), daemon=True).start()
                return self.send_json(202, {"ok": True})
            m = re.fullmatch(r"/stream/(\d+)", parsed.path)
            if m:
                return self.serve_file(download(m.group(1)), head)
            return self.send_json(404, {"error": "not found"})
        except BridgeError as e:
            return self.send_json(e.status, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("ошибка запроса %s", parsed.path)
            return self.send_json(500, {"error": str(e)})

    @staticmethod
    def quiet_download(track_id: str):
        try:
            download(track_id)
        except Exception as e:  # noqa: BLE001
            log.info("предзагрузка %s не удалась: %s", track_id, e)

    def serve_file(self, path: str, head: bool):
        size = os.path.getsize(path)
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        status = 200
        if rng:
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                if start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        self.send_response(status)
        self.send_header("Content-Type", MIME.get(path.rsplit(".", 1)[-1], "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head:
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)


if __name__ == "__main__":
    log.info("sc-bridge на порту %d, кэш %s (до %d МБ), yt-dlp %s", PORT, CACHE, CACHE_LIMIT // 1048576, yt_dlp.version.__version__)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
