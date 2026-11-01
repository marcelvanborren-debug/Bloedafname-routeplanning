from app.matrix import schatting_matrix
from app.models import OrderStatus as S
from app.optimizer import OptConfig, OptOrder, optimaliseer


def cfg(**kw):
    base = dict(horizon_sec=6 * 3600, nuchter_deadline_sec=3 * 3600, cito_deadline_sec=3600,
                gewicht={S.CITO: 20, S.NUCHTER: 5, S.NORMAAL: 0}, rekentijd_sec=1)
    base.update(kw)
    return OptConfig(**base)


# Utrecht centrum als start, adressen op een lijn naar het oosten
START = (52.0907, 5.1214)
PUNTEN = [(52.0907, 5.1214 + 0.01 * i) for i in range(1, 7)]


def volgorde(res, v=0):
    return [k for k, _ in res.routes[v][1:-1]]


def test_zonder_prioriteit_logische_volgorde():
    dur, _ = schatting_matrix([START, *PUNTEN])
    res = optimaliseer(dur, [OptOrder(S.NORMAAL, 600) for _ in PUNTEN], cfg())
    assert sorted(volgorde(res)) == [1, 2, 3, 4, 5, 6]
    assert not res.vervallen


def test_cito_ver_weg_gaat_voor():
    dur, _ = schatting_matrix([START, *PUNTEN])
    orders = [OptOrder(S.NORMAAL, 600) for _ in PUNTEN]
    orders[5] = OptOrder(S.CITO, 600)  # verste punt
    res = optimaliseer(dur, orders, cfg())
    assert volgorde(res)[0] == 6


def test_nuchter_voor_regulier():
    dur, _ = schatting_matrix([START, *PUNTEN])
    orders = [OptOrder(S.NORMAAL, 900) for _ in PUNTEN]
    orders[4] = OptOrder(S.NUCHTER, 900)
    res = optimaliseer(dur, orders, cfg(nuchter_deadline_sec=1800))
    aankomst = dict(res.routes[0])
    assert aankomst[5] <= 1800


def test_vervallen_eerst_regulier_niet_cito():
    dur, _ = schatting_matrix([START, *PUNTEN])
    orders = [OptOrder(S.NORMAAL, 3600) for _ in PUNTEN]
    orders[2] = OptOrder(S.CITO, 3600)
    res = optimaliseer(dur, orders, cfg(horizon_sec=3 * 3600))
    assert res.vervallen
    assert 3 not in res.vervallen


def test_meerdere_medewerkers_verdelen():
    dur, _ = schatting_matrix([START, *PUNTEN])
    orders = [OptOrder(S.NORMAAL, 3000) for _ in PUNTEN]
    res = optimaliseer(dur, orders, cfg(medewerkers=2, horizon_sec=4 * 3600))
    assert not res.vervallen
    assert all(len(r) > 2 for r in res.routes)


def test_hard_tijdvenster():
    dur, _ = schatting_matrix([START, *PUNTEN])
    orders = [OptOrder(S.NORMAAL, 600) for _ in PUNTEN]
    orders[0] = OptOrder(S.NORMAAL, 600, vanaf_sec=2 * 3600)
    res = optimaliseer(dur, orders, cfg())
    assert dict(res.routes[0])[1] >= 2 * 3600


def test_gewicht_en_deadline_samen_werken():
    """CITO met ruime deadline moet toch eerder komen naarmate het gewicht stijgt."""
    dur, _ = schatting_matrix([START, *PUNTEN])
    orders = [OptOrder(S.NORMAAL, 600) for _ in PUNTEN]
    orders[5] = OptOrder(S.CITO, 600)
    laag = optimaliseer(dur, orders, cfg(gewicht={S.CITO: 0}, cito_deadline_sec=6 * 3600))
    hoog = optimaliseer(dur, orders, cfg(gewicht={S.CITO: 50}, cito_deadline_sec=6 * 3600))
    assert dict(hoog.routes[0])[6] < dict(laag.routes[0])[6]


def test_cito_deadline_gehaald_ondanks_gewicht_nul():
    dur, _ = schatting_matrix([START, *PUNTEN])
    orders = [OptOrder(S.NORMAAL, 1200) for _ in PUNTEN]
    orders[5] = OptOrder(S.CITO, 600)
    res = optimaliseer(dur, orders, cfg(gewicht={S.CITO: 0}, cito_deadline_sec=1800))
    assert dict(res.routes[0])[6] <= 1800
