"""Bouwt de module Prikken in kliniek in een LIS-bestand (LIS-new2.html) en koppelt hem aan de afnamemodule.

Gebruik: python embedded/build.py && python embedded/lis_inbouwen.py <LIS.html> docs/kliniek.html <uit.html>
"""
import sys, re
from pathlib import Path
bron, kliniek, uit = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
s = bron.read_text()

def vervang(oud, nieuw, n=1):
    global s
    assert s.count(oud) == n, (s.count(oud), oud[:90])
    s = s.replace(oud, nieuw)

# ---------- 1. Afnamemodule: kliniekorders bijwerken en rondes als routes ontvangen ----------
vervang('''    let n = 0, unknown = 0;
    for (const [req, srs] of groups) {
      if (state.orders.some(o => o.req === req && o.status !== "done")) continue;''',
'''    let n = 0, unknown = 0, updated = 0;
    const kliniek = ((json.meta && json.meta.tag) || []).some(t => t.code === "prikken-in-kliniek");
    const klInfo = sr => { try { return JSON.parse(((sr.extension || []).find(x => x.url === "urn:lis:kliniek") || {}).valueString || "null"); } catch { return null; } };
    for (const [req, srs] of groups) {
      const bestaand = state.orders.find(o => o.req === req && o.status !== "done");
      if (bestaand) {
        /* Prikken in kliniek: afdeling, kamer, bed, prikronde en bijzonderheden bijwerken op een open order */
        if (kliniek && tabOf(bestaand) === "open") {
          const f = srs[0], k = klInfo(f) || {};
          const eigen = String(bestaand.note || "").split(" · ").filter(x => x && !/^(Prikronde:|CITO: direct|Nuchter afnemen|⚠ |Bijzonderheden:)/.test(x));
          bestaand.loc = (f.locationCode || [])[0]?.text || bestaand.loc;
          const kl = (f.note || []).map(x => x.text), klTekst = kl.join(" · ");
          bestaand.note = [...new Set([...eigen.filter(x => !klTekst.includes(x)), ...kl])].join(" · ");
          /* een eigen afnametijdstip van de order (bijv. dalspiegel) blijft staan */
          if (f.occurrenceDateTime && (!bestaand.due || bestaand.dueLabel === bestaand.ronde)) { bestaand.due = f.occurrenceDateTime; bestaand.dueLabel = k.ronde || "Prikronde"; }
          if (f.priority === "stat") bestaand.priority = "stat";
          Object.assign(bestaand, { kamer: k.kamer || "", bed: k.bed || "", afdeling: k.afdeling || "", ronde: k.ronde || "", condities: k.condities || [], updated: nowIso() });
          updated++;
        }
        continue;
      }''')
vervang('''        due: first.occurrenceDateTime || null, dueLabel: first.occurrenceDateTime ? "Afnametijdstip" : "",
        authoredOn: first.authoredOn || nowIso(), updated: nowIso()
      });''', '''        due: first.occurrenceDateTime || null, dueLabel: first.occurrenceDateTime ? ((kliniek && (klInfo(first) || {}).ronde) || "Afnametijdstip") : "",
        authoredOn: first.authoredOn || nowIso(), updated: nowIso(),
        ...(kliniek ? (({ afdeling, kamer, bed, ronde, condities }) => ({ afdeling, kamer, bed, ronde, condities, planned: today() }))(klInfo(first) || {}) : {})
      });''')
vervang('''    save(); render();
    return { n, unknown };
  }''', '''    save(); render();
    return { n, unknown, updated };
  }
  /* Routes in het formaat van de routeplanner ({routes:[{id, naam, gebied, datum, stops:[{ordernummer, volgorde, eta}], ...}]})
     toevoegen of vervangen; toe-eigeningen van collega's blijven staan. */
  function importRoutes(j, bron = "routeplanner") {
    const idOf = s => (state.orders.find(o => (o.req === s.ordernummer || o.id === s.id) && tabOf(o) === "open") || state.orders.find(o => o.req === s.ordernummer || o.id === s.id) || {}).id;
    const nieuw = (j.routes || []).map(x => { const st = (x.stops || []).slice().sort((a, b) => a.volgorde - b.volgorde);
      return { id: x.id, name: x.naam || x.id, area: x.gebied || "", date: x.datum || today(), order: st.map(idOf).filter(Boolean),
        eta: Object.fromEntries(st.filter(idOf).map(s => [idOf(s), s.eta])), km: x.afstandKm, min: x.duurMin, source: bron,
        claim: x.medewerker ? { by: x.medewerker, at: x.toegeeigendOp || nowIso() } : null, at: nowIso() }; }).filter(r => r.order.length);
    const known = store.json("afname.routes", []) || [];
    for (const r of nieuw) {
      const old = state.routes.find(x => x.id === r.id) || known.find(x => x.id === r.id);
      if (old && old.claim && !r.claim) r.claim = old.claim;
      /* een stop hoort in één route: uit andere routes halen */
      for (const x of state.routes) if (x.id !== r.id) x.order = x.order.filter(id => !r.order.includes(id));
      const i = state.routes.findIndex(x => x.id === r.id);
      if (i >= 0) state.routes[i] = r; else state.routes.push(r);
    }
    state.routes = state.routes.filter(r => r.order.length);
    save(); lockMsg(); render();
    return nieuw.length;
  }
  /* Prikken in kliniek: orders (FHIR) en prikrondes (routes) in één keer */
  function importKliniek(bundle, routes) {
    const r = importBundle(bundle);
    const nr = routes ? importRoutes(routes, "kliniek") : 0;
    feed("info", "Prikrondes ontvangen uit Prikken in kliniek", `${r.n} nieuwe en ${r.updated} bijgewerkte order(s) · ${nr} ronde(s) als route`);
    toast(`Prikken in kliniek: ${nr} ronde(s), ${r.n + r.updated} order(s)`);
    return { nieuw: r.n, bijgewerkt: r.updated, onbekend: r.unknown, routes: nr };
  }''')
vervang('''if (d.type === "orders" && d.bundle) { const r = importBundle(d.bundle); if (r.n) toast(`${r.n} nieuwe aanvraag/aanvragen uit de ordermodule`); } };''',
        '''if (d.type === "kliniek" && d.bundle) { importKliniek(d.bundle, d.routes); return; } if (d.type === "orders" && d.bundle) { if (((d.bundle.meta || {}).tag || []).some(t => t.code === "prikken-in-kliniek")) return; const r = importBundle(d.bundle); if (r.n) toast(`${r.n} nieuwe aanvraag/aanvragen uit de ordermodule`); } };''')
vervang('''  window.AFNAME = { simCollect, importBundle, toFhir: () => toFhir(state.orders), catalog: () => CAT };''',
        '''  window.AFNAME = { simCollect, importBundle, importRoutes, importKliniek, toFhir: () => toFhir(state.orders), catalog: () => CAT, orders: () => JSON.parse(JSON.stringify(state.orders)) };''')

# ---------- 2. De module zelf, ingebed zoals de andere modules ----------
k = kliniek.read_text()
shim = '<head><script>(function(){try{["replaceState","pushState"].forEach(function(k){var o=history[k];history[k]=function(){try{return o.apply(history,arguments);}catch(e){}};});}catch(e){}})();</script>'
assert k.count('<head>') == 1
k = k.replace('<head>', shim, 1)
k = re.sub(r'</(script)', r'<\\/LIS:\1', k, flags=re.I).replace('<!--', '<\\!LIS--')
assert '</script' not in k.lower()
anker = '<script type="text/plain" id="mod-status">'
vervang(anker, f'<script type="text/plain" id="mod-kliniek">{k}</script>\n{anker}')

# ---------- 3. Shell: tegel, navigatie, laden en koppelpunten ----------
vervang('''  routeplanner: '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',''',
        '''  routeplanner: '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  kliniek: '<path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-6h6v6M12 8v4M10 10h4"/>',''')
vervang('''  routeplanner: { t: "Routeplanner thuisprik", d: "Optimale routes voor de thuisprikdienst; orders komen uit de ordermodule.", step: "Hulpmiddel", extra: true }''',
        '''  routeplanner: { t: "Routeplanner thuisprik", d: "Optimale routes voor de thuisprikdienst; orders komen uit de ordermodule.", step: "Hulpmiddel", extra: true },
  kliniek: { t: "Prikken in kliniek", d: "Alle klinische aanvragen per prikronde en afdeling, met kamer, bed en bijzonderheden; elke ronde gaat als route naar de afnamemodule.", step: "Hulpmiddel", extra: true }''')
vervang('''status: w => w.__OS, routeplanner: w => w.RP_SET''', '''status: w => w.__OS, routeplanner: w => w.RP_SET, kliniek: w => w.KLINIEK && w.KLINIEK.ready''')
vervang('''  $("#modnav").innerHTML = [...NAV, "status", "keten"].map(id => {''', '''  $("#modnav").innerHTML = [NAV[0], NAV[1], "kliniek", ...NAV.slice(2), "status", "keten"].map(id => {''')
vervang('''    <button class="mtile" data-open="routeplanner"><span class="ico g-routeplanner">${ic("routeplanner")}</span><div style="flex:1"><h3>${MODS.routeplanner.t}</h3><p>${MODS.routeplanner.d}</p></div><span class="go">${ic("arrow")}</span></button>`;''',
        '''    <button class="mtile" data-open="routeplanner"><span class="ico g-routeplanner">${ic("routeplanner")}</span><div style="flex:1"><h3>${MODS.routeplanner.t}</h3><p>${MODS.routeplanner.d}</p></div><span class="go">${ic("arrow")}</span></button>
    <button class="mtile" data-open="kliniek"><span class="ico g-kliniek">${ic("kliniek")}</span><div style="flex:1"><h3>${MODS.kliniek.t}</h3><p>${MODS.kliniek.d}</p></div><span class="go">${ic("arrow")}</span></button>`;''')
vervang('''.g-routeplanner { background: linear-gradient(135deg, #0b3b60, #2d8cf0); }''',
        '''.g-routeplanner { background: linear-gradient(135deg, #0b3b60, #2d8cf0); }
.g-kliniek { background: linear-gradient(135deg, #e5484d, #6d5efc); }
@media (min-width: 761px) { #tiles2 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }''')
vervang('''window.LISBUS = { fromOrder, logiReceived, authEvent, qcReleased, toRoute, statusAuthorized, openKeten };''',
        '''/* ---------------- Prikken in kliniek ↔ afnamemodule ---------------- */
function kliniekBron() { return frame("afname").then(w => ({ orders: w.AFNAME.orders ? w.AFNAME.orders() : readLS("lis.afname.orders", []), catalog: JSON.parse(JSON.stringify(w.AFNAME.catalog())) })); }
function toAfname(bundle, routes) {
  return frame("afname").then(w => {
    const r = w.AFNAME.importKliniek(JSON.parse(JSON.stringify(bundle)), JSON.parse(JSON.stringify(routes)));
    const reqs = uniq((bundle.entry || []).map(e => e.resource).filter(x => x && x.resourceType === "ServiceRequest").map(x => x.requisition && x.requisition.value).filter(Boolean));
    for (const req of reqs) if (K.orders[req]) logEv(req, "afname", "Ingedeeld in een prikronde (Prikken in kliniek)", "afname");
    setTimeout(syncAfname, 60);
    return r;
  });
}
window.LISBUS = { fromOrder, logiReceived, authEvent, qcReleased, toRoute, statusAuthorized, openKeten, kliniekBron, toAfname };''')
uit.write_text(s)
print(uit, round(len(s) / 1048576, 2), "MB")
