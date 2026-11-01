"""Geocoding van Nederlandse adressen via de PDOK Locatieserver (BAG-gebaseerd, gratis, geen API-key)."""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

import httpx

PDOK_URL = os.getenv(
    "PDOK_URL", "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free"
)
CACHE_PATH = Path(os.getenv("GEOCODE_CACHE", Path(__file__).resolve().parent.parent / "geocode_cache.json"))

_lock = threading.Lock()
_cache: dict[str, list[float]] | None = None


class GeocodeFout(Exception):
    pass


def _laad_cache() -> dict[str, list[float]]:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(CACHE_PATH.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            _cache = {}
    return _cache


def _bewaar_cache() -> None:
    try:
        CACHE_PATH.write_text(json.dumps(_cache, indent=0))
    except OSError:
        pass


_POINT = re.compile(r"POINT\(([-\d.]+) ([-\d.]+)\)")


def geocode(postcode: str, huisnummer: int, toevoeging: str | None = None,
            client: httpx.Client | None = None) -> tuple[float, float, str]:
    """Geeft (lat, lon, weergavenaam) terug voor postcode + huisnummer."""
    sleutel = f"{postcode}|{huisnummer}|{(toevoeging or '').upper()}"
    with _lock:
        cache = _laad_cache()
        if sleutel in cache:
            lat, lon, naam = cache[sleutel]
            return lat, lon, naam

    q = f"postcode:{postcode} and huisnummer:{huisnummer}"
    params = {"q": q, "fq": "type:adres", "rows": 10,
              "fl": "weergavenaam,centroide_ll,huisletter,huisnummertoevoeging"}
    eigen = client is None
    client = client or httpx.Client(timeout=10)
    try:
        r = client.get(PDOK_URL, params=params)
        r.raise_for_status()
        docs = r.json().get("response", {}).get("docs", [])
    except httpx.HTTPError as e:
        raise GeocodeFout(f"PDOK niet bereikbaar voor {postcode} {huisnummer}: {e}") from e
    finally:
        if eigen:
            client.close()

    if not docs:
        raise GeocodeFout(f"Adres niet gevonden: {postcode} {huisnummer}{toevoeging or ''}")

    gekozen = docs[0]
    if toevoeging:
        t = toevoeging.upper()
        for d in docs:
            if (d.get("huisletter") or "").upper() == t or (d.get("huisnummertoevoeging") or "").upper() == t:
                gekozen = d
                break

    m = _POINT.search(gekozen.get("centroide_ll", ""))
    if not m:
        raise GeocodeFout(f"Geen coördinaten voor {postcode} {huisnummer}")
    lon, lat = float(m.group(1)), float(m.group(2))
    naam = gekozen.get("weergavenaam", f"{postcode} {huisnummer}")

    with _lock:
        _laad_cache()[sleutel] = [lat, lon, naam]
        _bewaar_cache()
    return lat, lon, naam
