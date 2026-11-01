"""FastAPI-backend van de routeplanner voor bloedafname."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .geocode import GeocodeFout, geocode
from .matrix import reistijden, route_geometrie
from .models import OrderStatus, PlanResultaat, PlanVerzoek, Route, Stop
from .optimizer import OptConfig, OptOrder, optimaliseer

STATIC = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="Routeplanner bloedafname", version="1.0")


def _min(hhmm: str) -> int:
    h, m = hhmm.strip().split(":")
    return int(h) * 60 + int(m)


def _hhmm(minuten: float) -> str:
    m = int(round(minuten))
    return f"{m // 60:02d}:{m % 60:02d}"


@app.get("/api/geocode")
def api_geocode(postcode: str, huisnummer: int, toevoeging: str | None = None):
    try:
        lat, lon, naam = geocode(postcode.replace(" ", "").upper(), huisnummer, toevoeging)
    except GeocodeFout as e:
        raise HTTPException(404, str(e))
    return {"lat": lat, "lon": lon, "weergavenaam": naam}


@app.post("/api/plan", response_model=PlanResultaat)
def api_plan(req: PlanVerzoek) -> PlanResultaat:
    if not req.orders:
        raise HTTPException(400, "Geen orders opgegeven")
    ids = [o.id for o in req.orders]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "Order-id's moeten uniek zijn")

    ins = req.instellingen
    t0 = _min(ins.starttijd)
    waarschuwingen: list[str] = []

    # 1. Geocoding (parallel, met cache)
    adressen = [req.start, *req.orders]
    with httpx.Client(timeout=10) as client, ThreadPoolExecutor(8) as pool:
        futs = [pool.submit(geocode, a.postcode, a.huisnummer, a.toevoeging, client) for a in adressen]
        coords, namen, fouten = [], [], []
        for a, f in zip(adressen, futs):
            try:
                lat, lon, naam = f.result()
                coords.append((lat, lon)); namen.append(naam)
            except GeocodeFout as e:
                fouten.append(str(e))
    if fouten:
        raise HTTPException(422, {"fouten": fouten})

    # 2. Reistijdmatrix
    duur, afstand, bron = reistijden(coords)
    if bron.startswith("schatting"):
        waarschuwingen.append("Reistijden zijn geschat omdat de routeserver niet bereikbaar was.")

    # 3. Optimalisatie
    def rel(hhmm: str | None) -> int | None:
        return None if not hhmm else (_min(hhmm) - t0) * 60

    opt_orders = [OptOrder(o.status, o.duur_min * 60, rel(o.vanaf), rel(o.uiterlijk)) for o in req.orders]
    cfg = OptConfig(
        horizon_sec=(_min(ins.eindtijd) - t0) * 60,
        nuchter_deadline_sec=(_min(ins.nuchter_uiterlijk) - t0) * 60,
        cito_deadline_sec=ins.cito_binnen_min * 60,
        gewicht={OrderStatus.CITO: ins.gewicht_cito, OrderStatus.NUCHTER: ins.gewicht_nuchter,
                 OrderStatus.NORMAAL: ins.gewicht_normaal},
        medewerkers=req.medewerkers,
        terug_naar_start=ins.terug_naar_start,
        rekentijd_sec=ins.rekentijd_sec,
    )
    if cfg.horizon_sec <= 0:
        raise HTTPException(400, "Eindtijd moet na starttijd liggen")
    try:
        res = optimaliseer(duur, opt_orders, cfg)
    except RuntimeError as e:
        raise HTTPException(422, str(e))

    # 4. Resultaat opbouwen
    routes: list[Route] = []
    for v, r in enumerate(res.routes):
        if len(r) <= 2:
            continue
        if not ins.terug_naar_start:
            r = r[:-1]
        stops, tot_t, tot_d = [], 0.0, 0.0
        for i, (knoop, aankomst) in enumerate(r):
            vorige = r[i - 1][0] if i else None
            rt = duur[vorige][knoop] / 60 if vorige is not None else 0
            ad = afstand[vorige][knoop] / 1000 if vorige is not None else 0
            tot_t += rt; tot_d += ad
            order = req.orders[knoop - 1] if knoop else None
            dienst = order.duur_min if order else 0
            if order and order.status == OrderStatus.NUCHTER and aankomst > cfg.nuchter_deadline_sec:
                waarschuwingen.append(f"Nuchtere order {order.id} valt na {ins.nuchter_uiterlijk}.")
            if order and order.status == OrderStatus.CITO and aankomst > cfg.cito_deadline_sec:
                waarschuwingen.append(f"CITO-order {order.id} valt later dan {ins.cito_binnen_min} min na vertrek.")
            stops.append(Stop(
                volgorde=i, order_id=order.id if order else None,
                label=(order.patient + " – " if order and order.patient else "") + namen[knoop],
                status=order.status if order else None,
                lat=coords[knoop][0], lon=coords[knoop][1],
                aankomst=_hhmm(t0 + aankomst / 60), vertrek=_hhmm(t0 + aankomst / 60 + dienst),
                reistijd_min=round(rt, 1), afstand_km=round(ad, 2),
            ))
        routes.append(Route(
            medewerker=v + 1, stops=stops,
            totaal_reistijd_min=round(tot_t, 1), totaal_afstand_km=round(tot_d, 1),
            eindtijd=stops[-1].vertrek,
            geometrie=route_geometrie([coords[k] for k, _ in r]),
        ))

    niet = [{"order_id": req.orders[k - 1].id, "status": req.orders[k - 1].status.value,
             "reden": "past niet binnen werktijd/tijdvensters"} for k in res.vervallen]
    if niet:
        waarschuwingen.append(f"{len(niet)} order(s) konden niet worden ingepland.")
    return PlanResultaat(routes=routes, niet_ingepland=niet, reistijdbron=bron, waarschuwingen=waarschuwingen)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
