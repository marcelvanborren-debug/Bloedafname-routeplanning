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

  // Voert fn uit over items met maximaal n tegelijk (netjes voor PDOK en OSRM)
  async function pool(items, n, fn) {
    const uit = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try { uit[k] = { ok: true, waarde: await fn(items[k], k) }; }
        catch (e) { uit[k] = { ok: false, fout: e }; }
      }
    }));
    return uit;
  }

  // OSRM-tabel in blokken: de publieke server accepteert max. 100 coördinaten per verzoek
  async function osrmMatrix(coords, osrm, voortgang = () => {}) {
    const n = coords.length, B = 50;
    const dur = Array.from({ length: n }, () => new Array(n).fill(0));
    const dist = Array.from({ length: n }, () => new Array(n).fill(0));
    const blokken = [];
    for (let a = 0; a < n; a += B) for (let b = 0; b < n; b += B) blokken.push([a, b]);
    let klaar = 0;
    const res = await pool(blokken, 2, async ([a, b]) => {
      const src = coords.slice(a, a + B), dst = coords.slice(b, b + B);
      const alle = a === b ? src : src.concat(dst);
      const loc = alle.map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(";");
      const si = src.map((_, i) => i).join(";");
      const di = dst.map((_, j) => (a === b ? j : src.length + j)).join(";");
      let r;
      for (let poging = 0; poging < 3; poging++) {
        r = await fetch(`${osrm}/table/v1/driving/${loc}?sources=${si}&destinations=${di}&annotations=duration,distance`);
        if (r.status !== 429) break;
        await new Promise(ok => setTimeout(ok, 1000 * (poging + 1)));
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (d.code !== "Ok") throw new Error(d.message || d.code);
      d.durations.forEach((row, i) => row.forEach((x, j) => {
        const I = a + i, J = b + j;
        dur[I][J] = I === J ? 0 : Math.round(x || 0) + 60;
        dist[I][J] = Math.round(d.distances[i][j] || 0);
      }));
      voortgang(`Reistijden berekenen… ${++klaar}/${blokken.length}`);
    });
    const fout = res.find(x => !x.ok);
    if (fout) throw fout.fout;
    return { dur, dist };
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

  // Testset: willekeurige BESTAANDE adressen uit de BAG via PDOK
  window.genereerTestset = async function (aantal = 300, plaatsen = ["Ede", "Arnhem", "Nijmegen"], voortgang = () => {}) {
    const zoek = async (plaats, start, rows) => {
      const u = new URL(PDOK);
      u.searchParams.set("q", "*:*");
      u.searchParams.append("fq", "type:adres");
      u.searchParams.append("fq", `woonplaatsnaam:${plaats}`);
      u.searchParams.set("rows", String(rows));
      u.searchParams.set("start", String(start));
      u.searchParams.set("fl", "postcode,huisnummer,huisletter,huisnummertoevoeging");
      const r = await fetch(u);
      if (!r.ok) throw new Error(`PDOK HTTP ${r.status}`);
      return (await r.json()).response;
    };
    const totalen = await Promise.all(plaatsen.map(p => zoek(p, 0, 0).then(r => r.numFound)));
    // Om en om per plaats, met 10% extra zodat er na ontdubbelen genoeg overblijven
    const taken = [];
    const extra = Math.ceil(aantal * 1.1);
    for (let k = 0; k < extra; k++) {
      const i = k % plaatsen.length;
      taken.push([plaatsen[i], Math.floor(Math.random() * Math.max(1, totalen[i] - 1))]);
    }
    let klaar = 0;
    const res = await pool(taken, 6, async ([p, start]) => {
      const d = (await zoek(p, start, 1)).docs[0];
      if (++klaar % 20 === 0) voortgang(`Testadressen ophalen… ${klaar}/${taken.length}`);
      return d;
    });
    const gezien = new Set();
    const regels = [];
    for (const x of res) {
      if (!x.ok || !x.waarde || !x.waarde.postcode) continue;
      const d = x.waarde;
      const toev = (d.huisletter || "") + (d.huisnummertoevoeging ? (d.huisletter ? "" : "") + d.huisnummertoevoeging : "");
      const sleutel = `${d.postcode}|${d.huisnummer}|${toev}`;
      if (gezien.has(sleutel)) continue;
      gezien.add(sleutel);
      const r = Math.random();
      const status = r < 0.05 ? "cito" : r < 0.30 ? "nuchter" : "normaal";
      regels.push(`${d.postcode}; ${d.huisnummer}${toev ? "-" + toev : ""}; ${status}; 10`);
    }
    return regels.slice(0, aantal);
  };

  window.planLokaal = async function (req, osrmUrl, voortgang = () => {}) {
    const ins = req.instellingen;
    const t0 = min(ins.starttijd);
    const waarschuwingen = [];
    const osrm = (osrmUrl || "https://router.project-osrm.org").replace(/\/$/, "");

    voortgang("Adressen opzoeken bij PDOK…");
    const cache = leesCache();
    const adressen = [req.start, ...req.orders];
    let gedaan = 0;
    const uitkomst = await pool(adressen, 6, async a => {
      const r = await geocode(a, cache);
      if (++gedaan % 10 === 0) voortgang(`Adressen opzoeken bij PDOK… ${gedaan}/${adressen.length}`);
      return r;
    });
    schrijfCache(cache);
    if (!uitkomst[0].ok) return { fouten: ["Startadres: " + uitkomst[0].fout.message] };
    // Niet gevonden orders overslaan en melden, de rest gewoon plannen
    const nietGevonden = [];
    const gevonden = [uitkomst[0].waarde];
    const orders = [];
    req.orders.forEach((o, i) => {
      const u = uitkomst[i + 1];
      if (u.ok) { orders.push(o); gevonden.push(u.waarde); }
      else nietGevonden.push({ order_id: o.id, status: o.status, reden: u.fout.message });
    });
    if (!orders.length) return { fouten: nietGevonden.map(n => n.reden) };
    req = { ...req, orders };
    const coords = gevonden.map(v => [v[0], v[1]]);
    const namen = gevonden.map(v => v[2]);

    voortgang("Reistijden berekenen…");
    let dur, dist, bron;
    try { ({ dur, dist } = await osrmMatrix(coords, osrm, voortgang)); bron = `OSRM (${osrm})`; }
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
    const niet_ingepland = nietGevonden.concat(res.vervallen.map(k => ({ order_id: req.orders[k - 1].id, status: req.orders[k - 1].status, reden: "past niet binnen werktijd/tijdvensters" })));
    if (niet_ingepland.length) waarschuwingen.push(`${niet_ingepland.length} order(s) konden niet worden ingepland.`);
    return { routes, niet_ingepland, reistijdbron: bron + ` · ${res.iteraties.toLocaleString("nl-NL")} iteraties`, waarschuwingen };
  };
})();
