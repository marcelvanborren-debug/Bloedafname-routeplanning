"""Reistijd- en afstandsmatrices via OSRM (Open Source Routing Machine, OpenStreetMap-wegennet).

Standaard wordt de publieke OSRM-demoserver gebruikt. Voor productie: draai OSRM zelf
(zie docker-compose.yml) en zet OSRM_URL=http://osrm:5000.
Valt terug op hemelsbrede afstand x omrijfactor als OSRM niet bereikbaar is.
"""
from __future__ import annotations

import math
import os

import httpx

OSRM_URL = os.getenv("OSRM_URL", "https://router.project-osrm.org").rstrip("/")
OSRM_PROFIEL = os.getenv("OSRM_PROFIEL", "driving")
FALLBACK_KMH = float(os.getenv("FALLBACK_KMH", "35"))
OMRIJFACTOR = 1.35

Coord = tuple[float, float]  # (lat, lon)


def _haversine_km(a: Coord, b: Coord) -> float:
    r = 6371.0
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def schatting_matrix(coords: list[Coord]) -> tuple[list[list[int]], list[list[int]]]:
    """Fallback: (seconden, meters) op basis van hemelsbrede afstand."""
    n = len(coords)
    dur = [[0] * n for _ in range(n)]
    dist = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i != j:
                km = _haversine_km(coords[i], coords[j]) * OMRIJFACTOR
                dist[i][j] = int(km * 1000)
                dur[i][j] = int(km / FALLBACK_KMH * 3600) + 60  # +1 min parkeren/lopen
    return dur, dist


def osrm_matrix(coords: list[Coord]) -> tuple[list[list[int]], list[list[int]]]:
    loc = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coords)
    url = f"{OSRM_URL}/table/v1/{OSRM_PROFIEL}/{loc}"
    r = httpx.get(url, params={"annotations": "duration,distance"}, timeout=20)
    r.raise_for_status()
    data = r.json()
    if data.get("code") != "Ok":
        raise RuntimeError(data.get("message", "OSRM-fout"))
    dur = [[int(round(x or 0)) + (60 if i != j else 0) for j, x in enumerate(row)]
           for i, row in enumerate(data["durations"])]
    dist = [[int(round(x or 0)) for x in row] for row in data["distances"]]
    return dur, dist


def reistijden(coords: list[Coord]) -> tuple[list[list[int]], list[list[int]], str]:
    try:
        dur, dist = osrm_matrix(coords)
        return dur, dist, f"OSRM ({OSRM_URL})"
    except Exception as e:  # noqa: BLE001 - bewust breed: altijd een plan kunnen maken
        dur, dist = schatting_matrix(coords)
        return dur, dist, f"schatting hemelsbreed x{OMRIJFACTOR} @ {FALLBACK_KMH:.0f} km/u (OSRM niet bereikbaar: {type(e).__name__})"


def route_geometrie(coords: list[Coord]) -> list[list[float]]:
    """Weggeometrie voor een reeks punten; bij falen een rechte lijn."""
    if len(coords) < 2:
        return [list(c) for c in coords]
    try:
        loc = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coords)
        r = httpx.get(f"{OSRM_URL}/route/v1/{OSRM_PROFIEL}/{loc}",
                      params={"overview": "full", "geometries": "geojson"}, timeout=20)
        r.raise_for_status()
        pts = r.json()["routes"][0]["geometry"]["coordinates"]
        return [[lat, lon] for lon, lat in pts]
    except Exception:  # noqa: BLE001
        return [list(c) for c in coords]
