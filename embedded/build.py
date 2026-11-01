"""Bouwt routeplanner.html: één zelfstandig bestand (Leaflet, CSS, solver en app inline)."""
from pathlib import Path
E = Path(__file__).resolve().parent
R = E.parent / 'static'

s = (R / 'index.html').read_text()

def vervang(oud, nieuw):
    global s
    assert s.count(oud) == 1, oud[:60]
    s = s.replace(oud, nieuw)

css = (R / 'leaflet/leaflet.css').read_text()
js = (R / 'leaflet/leaflet.js').read_text().replace('</script', '<\\/script')
vervang('<link rel="stylesheet" href="/static/leaflet/leaflet.css">', f'<style>/* Leaflet 1.9.4 (BSD-2) */\n{css}</style>')
vervang('<script src="/static/leaflet/leaflet.js"></script>', f'<script>{js}</script>')

vervang('''    <div class="rij">
      <div><label>Terug naar start</label>''', '''    <label>Routeserver (OSRM)</label>
    <input id="osrmUrl" value="https://router.project-osrm.org">
    <div class="hint">Standaard de publieke OSRM-demoserver. Voor productie: eigen OSRM-server.</div>
    <div class="rij">
      <div><label>Terug naar start</label>''')
vervang('''  <label>Orders — één per regel''', '''  <button id="testset" type="button" style="background:#fff;color:#0b3b60;border:1px solid #0b3b60;margin:14px 0 0">Testset: 300 echte adressen Ede, Arnhem, Nijmegen</button>
  <label>Orders — één per regel''')
vervang('''  <div class="hint">Status: <b>cito</b>''', '''  <label class="hint" style="margin-top:6px">Of laad een CSV-bestand: <input id="csv" type="file" accept=".csv,.txt" style="padding:2px;border:0"></label>
  <div class="hint">Status: <b>cito</b>''')

begin = s.index('  try {\n    const r = await fetch("/api/plan"')
eind = s.index('  } finally {', begin)
s = s[:begin] + '''  try {
    const data = await planLokaal(body, $("osrmUrl").value.trim(), t => knop.textContent = t);
    if (data.fouten) { data.fouten.forEach(f => melding(f)); return; }
    toon(data);
  } catch (e) {
    melding("Er ging iets mis: " + e.message);
''' + s[eind:]

extra = '''
$("testset").addEventListener("click", async () => {
  const knop = $("testset"); knop.disabled = true; $("meldingen").innerHTML = "";
  try {
    const regels = await genereerTestset(300, ["Ede", "Arnhem", "Nijmegen"], t => knop.textContent = t);
    $("orders").value = regels.join("\\n");
    $("startPc").value = "6815AD"; $("startNr").value = "55";  // Rijnstate Arnhem als vertrekpunt
    $("medewerkers").value = 15; $("rekentijd").value = 15;
    document.dispatchEvent(new Event("input"));
    melding(`${regels.length} bestaande adressen opgehaald (5% cito, 25% nuchter). Start: Rijnstate Arnhem, 15 medewerkers, 15 s rekentijd. Klik op "Plan optimale route".`, true);
  } catch (e) { melding("Testset ophalen mislukt: " + e.message); }
  finally { knop.disabled = false; knop.textContent = "Testset: 300 echte adressen Ede, Arnhem, Nijmegen"; }
});
$("csv").addEventListener("change", async e => {
  const f = e.target.files[0]; if (f) $("orders").value = (await f.text()).trim();
});
// Instellingen onthouden in deze browser
const BEWAAR = ["startPc","startNr","starttijd","eindtijd","medewerkers","orders","nuchterUiterlijk","citoBinnen","wCito","wNuchter","wNormaal","terug","rekentijd","osrmUrl"];
try { const b = JSON.parse(localStorage.getItem("routeplanner-invoer") || "{}"); BEWAAR.forEach(id => { if (b[id] != null) $(id).value = b[id]; }); } catch {}
document.addEventListener("input", () => { try { localStorage.setItem("routeplanner-invoer", JSON.stringify(Object.fromEntries(BEWAAR.map(id => [id, $(id).value])))); } catch {} });
// Orders uit de ordermodule: #orders=<base64url, UTF-8>&start=<postcode>-<huisnummer>&medewerkers=<n>
// De gegevens staan in de hash, dus ze gaan niet naar de webserver; na inlezen wordt de hash gewist.
(function () {
  const h = new URLSearchParams(location.hash.slice(1)), b64 = h.get("orders");
  if (!b64) return;
  try {
    const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
    const tekst = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))).trim();
    $("orders").value = tekst;
    const st = (h.get("start") || "").match(/^(\\d{4}\\s?[A-Za-z]{2})-(.+)$/);
    if (st) { $("startPc").value = st[1]; $("startNr").value = st[2]; }
    const mw = parseInt(h.get("medewerkers"), 10); if (mw > 0) $("medewerkers").value = Math.min(mw, 50);
    document.dispatchEvent(new Event("input"));
    const n = tekst.split(/\\r?\\n/).filter(r => r.trim() && !/^postcode/i.test(r.trim())).length;
    melding(`${n} orders ontvangen uit de ordermodule. Controleer startadres en medewerkers en klik op "Plan optimale route".`, true);
  } catch (e) { melding("De orders in de link konden niet worden gelezen: " + e.message); }
  history.replaceState(null, "", location.pathname + location.search);
})();
</script>'''
i = s.rindex('</script>')
s = s[:i] + extra + s[i + len('</script>'):]

solver = (E / 'solver.js').read_text()
lokaal = (E / 'lokaal.js').read_text()
vervang('<script>\nconst KLEUR', f'<script id="solver-src">{solver}</script>\n<script>{lokaal}</script>\n<script>\nconst KLEUR')
vervang('<header><h1>Routeplanner bloedafname</h1></header>', '<header><h1>Routeplanner bloedafname</h1><span style="font-size:12px;opacity:.75">PDOK · OSRM · optimalisatie in de browser</span></header>')
out = E.parent / 'docs' / 'index.html'; out.write_text(s)
print(out, len(s) // 1024, 'KB')
