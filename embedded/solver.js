/* Route-optimalisatie (VRP met tijdvensters en prioriteiten) in pure JavaScript.
 *
 * Doelfunctie (gelijk aan de OR-Tools-versie):
 *   rijtijd + Σ gewicht(status) × aankomsttijd
 *   + zware boete per seconde te laat na CITO-/nuchter-deadline
 *   + boete per vervallen order (CITO >> nuchter >> normaal)
 * Harde eisen (eigen tijdvenster, einde dienst) gelden als zeer zware boete.
 *
 * Methode: prioriteitsgestuurde cheapest insertion als startoplossing, daarna
 * Ruin & Recreate (Slack Induction by String Removals-achtig, Christiaens & Vanden Berghe 2020)
 * met simulated annealing als acceptatiecriterium, en een afsluitende 2-opt/relocate-polish.
 */
(function (root) {
  "use strict";

  const BOETE_TE_LAAT = { cito: 1000, nuchter: 300 };
  const BOETE_VERVALLEN = { cito: 1e10, nuchter: 1e9, normaal: 1e8 };
  const HARD = 1e6; // per seconde schending van een harde eis

  function maakRng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  /**
   * probleem = {
   *   dur: number[][] (sec, knoop 0 = start),
   *   orders: [{status, duur, vanaf?, uiterlijk?}]  (sec t.o.v. vertrek; orders[i] hoort bij knoop i+1)
   *   horizon, citoDeadline, nuchterDeadline, gewicht: {cito, nuchter, normaal},
   *   medewerkers, terug (bool)
   * }
   */
  function routeKosten(p, route) {
    const { dur, orders } = p;
    let t = 0, vorige = 0, kosten = 0, reis = 0;
    for (const k of route) {
      const o = orders[k - 1];
      const d = dur[vorige][k];
      reis += d; t += d;
      if (o.vanaf != null && t < o.vanaf) t = o.vanaf;
      if (o.uiterlijk != null && t > o.uiterlijk) kosten += HARD * (t - o.uiterlijk);
      kosten += (p.gewicht[o.status] || 0) * t;
      const grens = o.status === "cito" ? p.citoDeadline : o.status === "nuchter" ? p.nuchterDeadline : null;
      if (grens != null && t > grens) kosten += BOETE_TE_LAAT[o.status] * (t - grens);
      t += o.duur;
      vorige = k;
    }
    if (route.length && p.terug) { const d = dur[vorige][0]; reis += d; t += d; }
    if (t > p.horizon) kosten += HARD * (t - p.horizon);
    return kosten + reis;
  }

  function planning(p, route) {
    const { dur, orders } = p;
    let t = 0, vorige = 0;
    const stops = [];
    for (const k of route) {
      const o = orders[k - 1];
      const d = dur[vorige][k];
      t += d;
      if (o.vanaf != null && t < o.vanaf) t = o.vanaf;
      stops.push({ knoop: k, aankomst: t, reis: d });
      t += o.duur;
      vorige = k;
    }
    const terugReis = route.length && p.terug ? dur[vorige][0] : 0;
    return { stops, terugReis, eind: t + terugReis };
  }

  class Oplossing {
    constructor(p, routes, vervallen) {
      this.p = p;
      this.routes = routes;
      this.vervallen = vervallen;
      this.rk = routes.map(r => routeKosten(p, r));
    }
    totaal() {
      let s = 0;
      for (const c of this.rk) s += c;
      for (const k of this.vervallen) s += BOETE_VERVALLEN[this.p.orders[k - 1].status];
      return s;
    }
    kloon() {
      const o = Object.create(Oplossing.prototype);
      o.p = this.p; o.routes = this.routes.map(r => r.slice()); o.vervallen = this.vervallen.slice(); o.rk = this.rk.slice();
      return o;
    }
  }

  // Beste invoegplek voor knoop k over alle routes
  function besteInvoeging(sol, k) {
    let beste = { delta: Infinity, v: -1, pos: -1 };
    const p = sol.p;
    for (let v = 0; v < sol.routes.length; v++) {
      const r = sol.routes[v];
      for (let pos = 0; pos <= r.length; pos++) {
        r.splice(pos, 0, k);
        const delta = routeKosten(p, r) - sol.rk[v];
        r.splice(pos, 1);
        if (delta < beste.delta) beste = { delta, v, pos };
      }
    }
    return beste;
  }

  function voegIn(sol, knopen, rng, ruis) {
    const p = sol.p;
    const prio = { cito: 0, nuchter: 1, normaal: 2 };
    // Prioriteit eerst, binnen een klasse willekeurig of op "verste eerst"
    knopen.sort((a, b) => (prio[p.orders[a - 1].status] - prio[p.orders[b - 1].status]) ||
      (rng() < 0.5 ? (p.dur[0][b] - p.dur[0][a]) : (rng() - 0.5)));
    for (const k of knopen) {
      const b = besteInvoeging(sol, k);
      const straf = BOETE_VERVALLEN[p.orders[k - 1].status];
      const delta = b.delta * (ruis ? 1 + (rng() - 0.5) * ruis : 1);
      if (b.v >= 0 && delta < straf) {
        sol.routes[b.v].splice(b.pos, 0, k);
        sol.rk[b.v] = routeKosten(p, sol.routes[b.v]);
      } else {
        sol.vervallen.push(k);
      }
    }
  }

  // Ruin: verwijder een paar strings rond een willekeurige seed-klant (ruimtelijk gerelateerd)
  function ruin(sol, rng) {
    const p = sol.p;
    const n = p.orders.length;
    const verwijderd = [];
    const seed = 1 + Math.floor(rng() * n);
    const buren = [];
    for (let k = 1; k <= n; k++) buren.push(k);
    buren.sort((a, b) => p.dur[seed][a] - p.dur[seed][b]);
    const maxString = Math.max(1, Math.min(10, Math.round(n / 4)));
    const aantalStrings = 1 + Math.floor(rng() * Math.min(3, sol.routes.length + 1));
    const geraakt = new Set();
    for (const c of buren) {
      if (geraakt.size >= aantalStrings) break;
      const v = sol.routes.findIndex(r => r.includes(c));
      if (v < 0 || geraakt.has(v)) continue;
      geraakt.add(v);
      const r = sol.routes[v];
      const len = 1 + Math.floor(rng() * Math.min(maxString, r.length));
      const i = r.indexOf(c);
      const start = Math.max(0, Math.min(i - Math.floor(rng() * len), r.length - len));
      verwijderd.push(...r.splice(start, len));
      sol.rk[v] = routeKosten(p, r);
    }
    // Vervallen orders krijgen altijd een nieuwe kans
    verwijderd.push(...sol.vervallen);
    sol.vervallen = [];
    return verwijderd;
  }

  // Lokale verbetering: 2-opt binnen routes en relocate tussen routes (first improvement)
  function polijst(sol, deadline = Infinity) {
    const p = sol.p;
    let verbeterd = true;
    while (verbeterd && Date.now() < deadline) {
      verbeterd = false;
      for (let v = 0; v < sol.routes.length; v++) {
        const r = sol.routes[v];
        for (let i = 0; i < r.length - 1; i++) {
          for (let j = i + 1; j < r.length; j++) {
            const nieuw = r.slice(0, i).concat(r.slice(i, j + 1).reverse(), r.slice(j + 1));
            const c = routeKosten(p, nieuw);
            if (c < sol.rk[v] - 1e-9) { sol.routes[v] = nieuw; sol.rk[v] = c; verbeterd = true; break; }
          }
          if (verbeterd) break;
        }
      }
      if (verbeterd) continue;
      outer:
      for (let v = 0; v < sol.routes.length; v++) {
        for (let i = 0; i < sol.routes[v].length; i++) {
          const k = sol.routes[v][i];
          const zonder = sol.routes[v].slice(); zonder.splice(i, 1);
          const cz = routeKosten(p, zonder);
          const winst = sol.rk[v] - cz;
          for (let w = 0; w < sol.routes.length; w++) {
            const doel = w === v ? zonder : sol.routes[w];
            const basis = w === v ? cz : sol.rk[w];
            for (let pos = 0; pos <= doel.length; pos++) {
              if (w === v && pos === i) continue;
              const nieuw = doel.slice(); nieuw.splice(pos, 0, k);
              const cn = routeKosten(p, nieuw);
              if (cn - basis < winst - 1e-9) {
                if (w === v) { sol.routes[v] = nieuw; sol.rk[v] = cn; }
                else { sol.routes[v] = zonder; sol.rk[v] = cz; sol.routes[w] = nieuw; sol.rk[w] = cn; }
                verbeterd = true;
                break outer;
              }
            }
          }
        }
      }
    }
  }

  function los(p, opties = {}) {
    const tijdMs = opties.tijdMs ?? 2000;
    const rng = maakRng(opties.seed ?? 12345);
    const n = p.orders.length;
    let sol = new Oplossing(p, Array.from({ length: p.medewerkers }, () => []), []);
    const start = Date.now();
    voegIn(sol, Array.from({ length: n }, (_, i) => i + 1), rng, 0);
    polijst(sol, start + tijdMs * 0.2);
    let huidig = sol, beste = sol.kloon();
    let huidigK = huidig.totaal(), besteK = huidigK;
    // Starttemperatuur op basis van de schaal van de rijtijden
    const gemReis = p.dur.flat().reduce((a, b) => a + b, 0) / Math.max(1, p.dur.length ** 2);
    const T0 = Math.max(1, gemReis * 2), T1 = 1;
    const zoekTijd = tijdMs * 0.85;
    let iter = 0;
    if (n > 1) while (true) {
      const verstreken = (Date.now() - start) / zoekTijd;
      if (verstreken >= 1) break;
      const T = T0 * Math.pow(T1 / T0, verstreken);
      const kand = huidig.kloon();
      const weg = ruin(kand, rng);
      voegIn(kand, weg, rng, 0.2);
      const k = kand.totaal();
      if (k < huidigK - T * Math.log(rng())) { huidig = kand; huidigK = k; }
      if (k < besteK - 1e-9) { beste = kand.kloon(); besteK = k; }
      iter++;
    }
    polijst(beste, start + tijdMs * 1.1);
    return {
      routes: beste.routes,
      vervallen: beste.vervallen.sort((a, b) => a - b),
      kosten: beste.totaal(),
      iteraties: iter,
      plannen: beste.routes.map(r => planning(p, r)),
    };
  }

  const api = { los, routeKosten, planning };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Solver = api;
})(this);
