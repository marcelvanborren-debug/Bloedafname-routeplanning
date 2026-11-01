/* Browserversie van de backend: geocoding (PDOK), reistijden (OSRM) en optimalisatie (Solver),
 * levert hetzelfde resultaat-formaat als POST /api/plan. */
(function () {
  "use strict";
  const PDOK = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";
  const CACHE_SLEUTEL = "routeplanner-geocache-v2"; // v2: oude, mogelijk foute treffers vergeten
  const OMRIJ = 1.35, KMH = 35;

  const leesCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_SLEUTEL)) || {}; } catch { return {}; } };
  const schrijfCache = c => { try { localStorage.setItem(CACHE_SLEUTEL, JSON.stringify(c)); } catch { /* geen opslag */ } };

  const min = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const hhmm = m => { m = Math.round(m); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  const normPc = pc => pc.replace(/\s/g, "").toUpperCase();

  async function geocode(a, cache) {
    const pc = normPc(a.postcode);
    if (!/^\d{4}[A-Z]{2}$/.test(pc)) throw new Error(`Ongeldige postcode: ${a.postcode}`);
    const sleutel = `${pc}|${a.huisnummer}|${(a.toevoeging || "").toUpperCase()}`;
    if (cache[sleutel]) return cache[sleutel];
    const u = new URL(PDOK);
    // Exacte filters (fq) i.p.v. een vrije zoekvraag: anders kan PDOK een ander huisnummer
    // in dezelfde postcode teruggeven en vallen meerdere orders op hetzelfde punt.
    u.searchParams.set("q", `${pc} ${a.huisnummer}`);
    u.searchParams.append("fq", "type:adres");
    u.searchParams.append("fq", `postcode:${pc}`);
    u.searchParams.append("fq", `huisnummer:${a.huisnummer}`);
    u.searchParams.set("rows", "20");
    u.searchParams.set("fl", "weergavenaam,centroide_ll,postcode,huisnummer,huisletter,huisnummertoevoeging");
    let docs;
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error(r.status);
      docs = (await r.json()).response.docs;
    } catch (e) { throw new Error(`PDOK niet bereikbaar voor ${pc} ${a.huisnummer} (${e.message})`); }
    docs = docs.filter(x => (x.postcode || pc).toUpperCase() === pc && +(x.huisnummer ?? a.huisnummer) === +a.huisnummer);
    if (!docs.length) throw new Error(`Adres niet gevonden: ${pc} ${a.huisnummer}${a.toevoeging || ""}`);
    const toev = x => ((x.huisletter || "") + (x.huisnummertoevoeging || "")).toUpperCase();
    let d = docs.find(x => toev(x) === (a.toevoeging || "").toUpperCase().replace(/[-\s]/g, "")) || docs[0];
    const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(d.centroide_ll || "");
    if (!m) throw new Error(`Geen coördinaten voor ${pc} ${a.huisnummer}`);
    const res = [+m[2], +m[1], d.weergavenaam];
    cache[sleutel] = res;
    return res;
  }

  function haversineKm(a, b) {
    const r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }

  function schatting(coords) {
    const n = coords.length, dur = [], dist = [];
    for (let i = 0; i < n; i++) {
      dur.push([]); dist.push([]);
      for (let j = 0; j < n; j++) {
        if (i === j) { dur[i].push(0); dist[i].push(0); continue; }
        const km = haversineKm(coords[i], coords[j]) * OMRIJ;
        dist[i].push(Math.round(km * 1000));
        dur[i].push(Math.round(km / KMH * 3600) + 60);
      }
    }
    return { dur, dist };
  }

  async function osrmMatrix(coords, osrm) {
    const loc = coords.map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(";");
    const r = await fetch(`${osrm}/table/v1/driving/${loc}?annotations=duration,distance`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.code !== "Ok") throw new Error(d.message || d.code);
    return {
      dur: d.durations.map((row, i) => row.map((x, j) => Math.round(x || 0) + (i !== j ? 60 : 0))),
      dist: d.distances.map(row => row.map(x => Math.round(x || 0))),
    };
  }

  async function geometrie(coords, osrm) {
    if (coords.length < 2) return coords;
    try {
      const loc = coords.map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(";");
      const r = await fetch(`${osrm}/route/v1/driving/${loc}?overview=full&geometries=geojson`);
      const d = await r.json();
      return d.routes[0].geometry.coordinates.map(([lo, la]) => [la, lo]);
    } catch { return coords; }
  }

  // Optimalisatie in een Web Worker zodat de pagina blijft reageren
  function losOp(probleem, tijdMs) {
    const bron = document.getElementById("solver-src").textContent;
    try {
      const url = URL.createObjectURL(new Blob([bron + "\nonmessage = e => postMessage(Solver.los(e.data.p, e.data.o));"], { type: "text/javascript" }));
      const w = new Worker(url);
      return new Promise((ok, fout) => {
        w.onmessage = e => { ok(e.data); w.terminate(); URL.revokeObjectURL(url); };
        w.onerror = e => { fout(new Error(e.message)); w.terminate(); };
        w.postMessage({ p: probleem, o: { tijdMs } });
      });
    } catch {
      return Promise.resolve(window.Solver.los(probleem, { tijdMs }));
    }
  }

  window.planLokaal = async function (req, osrmUrl, voortgang = () => {}) {
    const ins = req.instellingen;
    const t0 = min(ins.starttijd);
    const waarschuwingen = [];
    const osrm = (osrmUrl || "https://router.project-osrm.org").replace(/\/$/, "");

    voortgang("Adressen opzoeken bij PDOK…");
    const cache = leesCache();
    const adressen = [req.start, ...req.orders];
    const uitkomst = await Promise.allSettled(adressen.map(a => geocode(a, cache)));
    schrijfCache(cache);
    const fouten = uitkomst.filter(u => u.status === "rejected").map(u => u.reason.message);
    if (fouten.length) return { fouten };
    const coords = uitkomst.map(u => [u.value[0], u.value[1]]);
    const namen = uitkomst.map(u => u.value[2]);

    voortgang("Reistijden berekenen…");
    let dur, dist, bron;
    try { ({ dur, dist } = await osrmMatrix(coords, osrm)); bron = `OSRM (${osrm})`; }
    catch (e) {
      ({ dur, dist } = schatting(coords));
      bron = `schatting hemelsbreed ×${OMRIJ} @ ${KMH} km/u (OSRM niet bereikbaar: ${e.message})`;
      waarschuwingen.push("Reistijden zijn geschat omdat de routeserver niet bereikbaar was.");
    }

    const rel = s => s ? (min(s) - t0) * 60 : null;
    const horizon = (min(ins.eindtijd) - t0) * 60;
    if (horizon <= 0) return { fouten: ["Eindtijd moet na starttijd liggen"] };
    const p = {
      dur,
      orders: req.orders.map(o => ({ status: o.status, duur: o.duur_min * 60, vanaf: rel(o.vanaf), uiterlijk: rel(o.uiterlijk) })),
      horizon,
      citoDeadline: ins.cito_binnen_min * 60,
      nuchterDeadline: (min(ins.nuchter_uiterlijk) - t0) * 60,
      gewicht: { cito: ins.gewicht_cito, nuchter: ins.gewicht_nuchter, normaal: ins.gewicht_normaal },
      medewerkers: req.medewerkers,
      terug: ins.terug_naar_start,
    };

    voortgang(`Optimaliseren (${ins.rekentijd_sec} s)…`);
    const res = await losOp(p, ins.rekentijd_sec * 1000);

    voortgang("Route op de kaart zetten…");
    const routes = [];
    for (let v = 0; v < res.routes.length; v++) {
      const r = res.routes[v];
      if (!r.length) continue;
      const plan = res.plannen[v];
      const stops = [{ volgorde: 0, order_id: null, label: namen[0], status: null, lat: coords[0][0], lon: coords[0][1],
                       aankomst: hhmm(t0), vertrek: hhmm(t0), reistijd_min: 0, afstand_km: 0 }];
      let totT = 0, totD = 0, vorige = 0;
      plan.stops.forEach((s, i) => {
        const o = req.orders[s.knoop - 1];
        const rt = dur[vorige][s.knoop] / 60, ad = dist[vorige][s.knoop] / 1000;
        totT += rt; totD += ad;
        if (o.status === "nuchter" && s.aankomst > p.nuchterDeadline) waarschuwingen.push(`Nuchtere order ${o.id} valt na ${ins.nuchter_uiterlijk}.`);
        if (o.status === "cito" && s.aankomst > p.citoDeadline) waarschuwingen.push(`CITO-order ${o.id} valt later dan ${ins.cito_binnen_min} min na vertrek.`);
        if (o.uiterlijk && s.aankomst > p.orders[s.knoop - 1].uiterlijk) waarschuwingen.push(`Order ${o.id} haalt het tijdvenster niet.`);
        stops.push({ volgorde: i + 1, order_id: o.id, label: (o.patient ? o.patient + " – " : "") + namen[s.knoop], status: o.status,
                     lat: coords[s.knoop][0], lon: coords[s.knoop][1], aankomst: hhmm(t0 + s.aankomst / 60),
                     vertrek: hhmm(t0 + (s.aankomst + o.duur_min * 60) / 60), reistijd_min: Math.round(rt * 10) / 10, afstand_km: Math.round(ad * 100) / 100 });
        vorige = s.knoop;
      });
      if (ins.terug_naar_start) {
        const rt = dur[vorige][0] / 60, ad = dist[vorige][0] / 1000;
        totT += rt; totD += ad;
        stops.push({ volgorde: stops.length, order_id: null, label: namen[0], status: null, lat: coords[0][0], lon: coords[0][1],
                     aankomst: hhmm(t0 + plan.eind / 60), vertrek: hhmm(t0 + plan.eind / 60), reistijd_min: Math.round(rt * 10) / 10, afstand_km: Math.round(ad * 100) / 100 });
      }
      if (plan.eind > horizon) waarschuwingen.push(`Medewerker ${v + 1} is later klaar dan ${ins.eindtijd}.`);
      routes.push({ medewerker: v + 1, stops, totaal_reistijd_min: Math.round(totT * 10) / 10, totaal_afstand_km: Math.round(totD * 10) / 10,
                    eindtijd: stops[stops.length - 1].vertrek, geometrie: await geometrie(stops.map(s => [s.lat, s.lon]), osrm) });
    }
    const niet_ingepland = res.vervallen.map(k => ({ order_id: req.orders[k - 1].id, status: req.orders[k - 1].status, reden: "past niet binnen werktijd/tijdvensters" }));
    if (niet_ingepland.length) waarschuwingen.push(`${niet_ingepland.length} order(s) konden niet worden ingepland.`);
    return { routes, niet_ingepland, reistijdbron: bron + ` · ${res.iteraties.toLocaleString("nl-NL")} iteraties`, waarschuwingen };
  };
})();
