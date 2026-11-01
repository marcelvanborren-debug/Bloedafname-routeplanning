"""Route-optimalisatie met Google OR-Tools (Vehicle Routing Problem met tijdvensters).

Modellering
-----------
* Knoop 0 is de startlocatie (lab/post), knopen 1..n zijn de afnames.
* Kosten = reistijd in seconden + gewogen aankomsttijd per order:
    kosten += gewicht[status] * aankomsttijd   (SoftUpperBound op 0)
  Eén minuut later bij een CITO-patiënt "kost" dus evenveel als `gewicht_cito` minuten extra rijden.
* CITO: zachte deadline `cito_binnen_min` na vertrek met een zeer hoge boete per seconde te laat.
* Nuchter: zachte deadline `nuchter_uiterlijk` (standaard 10:00) met een hoge boete per seconde te laat.
* Eigen tijdvensters (vanaf/uiterlijk) zijn hard.
* Een order mag alleen vervallen als hij echt niet past (eind van de dienst); de boete daarvoor is
  per status gestaffeld, zodat eerst reguliere orders afvallen, dan nuchtere en pas als laatste CITO.
* Zoekstrategie: PATH_CHEAPEST_ARC als startoplossing, daarna Guided Local Search (metaheuristiek).
"""
from __future__ import annotations

from dataclasses import dataclass

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from .models import OrderStatus


@dataclass
class OptOrder:
    status: OrderStatus
    duur_sec: int
    vanaf_sec: int | None = None
    uiterlijk_sec: int | None = None


@dataclass
class OptConfig:
    horizon_sec: int
    nuchter_deadline_sec: int
    cito_deadline_sec: int
    gewicht: dict[OrderStatus, int]
    medewerkers: int = 1
    terug_naar_start: bool = True
    rekentijd_sec: int = 5


BOETE_TE_LAAT = {OrderStatus.CITO: 1000, OrderStatus.NUCHTER: 300}
BOETE_VERVALLEN = {OrderStatus.CITO: 10**10, OrderStatus.NUCHTER: 10**9, OrderStatus.NORMAAL: 10**8}


@dataclass
class OptResultaat:
    routes: list[list[tuple[int, int]]]  # per medewerker: [(knoop, aankomst_sec), ...] incl. start en eind
    vervallen: list[int]                 # knoopnummers (1..n)
    kosten: int


def optimaliseer(duur: list[list[int]], orders: list[OptOrder], cfg: OptConfig) -> OptResultaat:
    n = len(duur)
    assert n == len(orders) + 1, "matrix moet startlocatie + alle orders bevatten"

    duur = [row[:] for row in duur]
    if not cfg.terug_naar_start:
        for i in range(n):
            duur[i][0] = 0

    manager = pywrapcp.RoutingIndexManager(n, cfg.medewerkers, 0)
    routing = pywrapcp.RoutingModel(manager)

    service = [0] + [o.duur_sec for o in orders]

    def reis_cb(fi, ti):
        return duur[manager.IndexToNode(fi)][manager.IndexToNode(ti)]

    def tijd_cb(fi, ti):
        a, b = manager.IndexToNode(fi), manager.IndexToNode(ti)
        return service[a] + duur[a][b]

    reis_idx = routing.RegisterTransitCallback(reis_cb)
    tijd_idx = routing.RegisterTransitCallback(tijd_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(reis_idx)

    routing.AddDimension(tijd_idx, cfg.horizon_sec, cfg.horizon_sec, True, "Tijd")
    tijd = routing.GetDimensionOrDie("Tijd")
    # OR-Tools staat maar één soft upper bound per variabele toe. Daarom een tweede, identieke
    # tijddimensie voor de status-deadlines, gekoppeld aan de eerste.
    routing.AddDimension(tijd_idx, cfg.horizon_sec, cfg.horizon_sec, True, "Deadline")
    deadline = routing.GetDimensionOrDie("Deadline")
    solver = routing.solver()

    for k, o in enumerate(orders, start=1):
        idx = manager.NodeToIndex(k)
        cv = tijd.CumulVar(idx)
        lo = o.vanaf_sec or 0
        hi = min(o.uiterlijk_sec if o.uiterlijk_sec is not None else cfg.horizon_sec, cfg.horizon_sec)
        cv.SetRange(max(0, lo), max(lo, hi))

        # Prioriteit: elke seconde later kost gewicht x seconde rijden
        w = cfg.gewicht.get(o.status, 0)
        if w > 0:
            tijd.SetCumulVarSoftUpperBound(idx, 0, w)

        # Statusgebonden deadlines (zacht, met zware boete)
        grens = {OrderStatus.CITO: cfg.cito_deadline_sec, OrderStatus.NUCHTER: cfg.nuchter_deadline_sec}.get(o.status)
        if grens is not None:
            solver.Add(deadline.CumulVar(idx) == cv)
            deadline.SetCumulVarSoftUpperBound(idx, grens, BOETE_TE_LAAT[o.status])

        routing.AddDisjunction([idx], BOETE_VERVALLEN[o.status])

    # Wachttijd is toegestaan (slack), maar laat de solver geen onnodig late vertrektijd kiezen
    for v in range(cfg.medewerkers):
        tijd.CumulVar(routing.Start(v)).SetRange(0, 0)
        deadline.CumulVar(routing.Start(v)).SetRange(0, 0)
        routing.AddVariableMinimizedByFinalizer(tijd.CumulVar(routing.End(v)))

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromSeconds(cfg.rekentijd_sec)

    sol = routing.SolveWithParameters(params)
    if sol is None:
        raise RuntimeError("Geen oplossing gevonden (controleer tijdvensters en werktijden)")

    routes = []
    for v in range(cfg.medewerkers):
        idx = routing.Start(v)
        r = []
        while True:
            r.append((manager.IndexToNode(idx), sol.Min(tijd.CumulVar(idx))))
            if routing.IsEnd(idx):
                break
            idx = sol.Value(routing.NextVar(idx))
        routes.append(r)

    vervallen = [k for k in range(1, n) if sol.Value(routing.NextVar(manager.NodeToIndex(k))) == manager.NodeToIndex(k)]
    return OptResultaat(routes=routes, vervallen=vervallen, kosten=sol.ObjectiveValue())
