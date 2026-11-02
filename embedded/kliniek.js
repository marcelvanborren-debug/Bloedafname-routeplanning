/* Module "Prikken in kliniek": deelt alle openstaande aanvragen op de verpleegafdelingen in
 * per prikronde en per afdeling.
 *
 * - Afdelingen horen bij een instelbare groep (bijv. IC, Klinisch); een prikronde bedient één of
 *   meer groepen. Zo loopt de IC-ronde om 06:00 alleen langs de IC.
 * - Elke aanvraag valt in één prikronde (of in "Direct prikken" bij CITO).
 * - Binnen een ronde staan de afdelingen per groep in loopvolgorde vanaf de prikpost
 *   (gebouw/verdieping), binnen een afdeling de aanvragen op kamer en bed.
 * - Heeft een ronde meer medewerkers, dan worden de afdelingen (nooit een afdeling gesplitst)
 *   in loopvolgorde over de medewerkers verdeeld met een zo gelijk mogelijke werklast.
 *
 * Werkt in de browser (window.Kliniek) en in Node (require) voor de tests.
 */
(function (root) {
  "use strict";

  const STANDAARD_LOOP = {
    afdeling: 2,      // min: afdeling verlaten en de volgende binnenlopen
    verdieping: 0.5,  // min per verdieping verschil
    lift: 1,          // min wachten op de lift zodra je van verdieping wisselt
    gebouw: 3,        // min extra lopen naar een ander gebouw/vleugel
  };

  const min = s => { const [h, m] = String(s).trim().split(":").map(Number); return h * 60 + m; };
  const hhmm = m => { m = Math.round(m); m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  const TIJD = /^\d{1,2}[:.]\d{2}$/;
  const STATUSSEN = ["cito", "nuchter", "normaal"];
  const sleutel = s => String(s ?? "").trim().toUpperCase();
  const velden = regel => regel.split(/[;\t]/).map(s => s.trim());
  const tijd = s => min(s.replace(".", ":"));
  // Natuurlijke sortering: kamer 2 vóór kamer 10, "B3.12" vóór "B3.2a" waar logisch
  const natuurlijk = (a, b) => String(a).localeCompare(String(b), "nl", { numeric: true, sensitivity: "base" });

  /** Afdelingen: één per regel "code; naam; groep; gebouw; verdieping" */
  function parseAfdelingen(tekst) {
    const afdelingen = {}, volgorde = [], groepen = [], fouten = [];
    String(tekst || "").split(/\r?\n/).forEach((regel, i) => {
      regel = regel.trim();
      if (!regel || regel.startsWith("#")) return;
      const d = velden(regel);
      if (/^code$/i.test(d[0])) return; // kopregel
      const verdieping = !d[4] ? 0 : Number(d[4].replace(",", "."));
      if (!d[0] || !Number.isFinite(verdieping)) { fouten.push(`Afdelingen, regel ${i + 1}: code of verdieping onleesbaar`); return; }
      if (afdelingen[sleutel(d[0])]) { fouten.push(`Afdelingen, regel ${i + 1}: afdeling ${d[0]} staat er dubbel in`); return; }
      const groep = d[2] || "Klinisch";
      if (!groepen.some(g => sleutel(g) === sleutel(groep))) groepen.push(groep);
      afdelingen[sleutel(d[0])] = { code: d[0], naam: d[1] || d[0], groep: groepen.find(g => sleutel(g) === sleutel(groep)),
                                    gebouw: sleutel(d[3]), verdieping, index: volgorde.length };
      volgorde.push(sleutel(d[0]));
    });
    return { afdelingen, groepen, fouten };
  }

  /** Prikrondes uit objecten {naam, start: "HH:MM", groepen: "IC, Klinisch" | "alle", medewerkers, nuchter: bool}
   *  (de tabel in de pagina) of uit tekst: één per regel "naam; starttijd; groepen; medewerkers; nuchter". */
  function parseRondes(invoer) {
    const fouten = [], rondes = [];
    const lijst = Array.isArray(invoer) ? invoer : String(invoer || "").split(/\r?\n/).map((regel, i) => {
      regel = regel.trim();
      if (!regel || regel.startsWith("#")) return null;
      const d = velden(regel);
      if (/^naam$/i.test(d[0])) return null;
      return { naam: d[0], start: d[1], groepen: d[2], medewerkers: d[3], nuchter: /^(nuchter|ja|j|x|1|true)$/i.test(d[4] || ""), regel: i + 1 };
    }).filter(Boolean);
    lijst.forEach((r, i) => {
      const waar = `Prikrondes, ${r.regel ? "regel " + r.regel : "ronde " + (i + 1)}`;
      const naam = String(r.naam || "").trim(), t = String(r.start || "").trim();
      if (!naam || !TIJD.test(t)) { fouten.push(`${waar}: naam of starttijd (HH:MM) ontbreekt`); return; }
      const g = String(r.groepen ?? "").trim();
      const groepen = /^(alle|\*)?$/i.test(g) ? null : g.split(",").map(x => x.trim()).filter(Boolean);
      const mw = parseInt(r.medewerkers, 10);
      rondes.push({ naam, start: tijd(t), groepen, medewerkers: Math.max(1, Math.min(20, mw > 0 ? mw : 1)), nuchter: !!r.nuchter });
    });
    rondes.sort((a, b) => a.start - b.start);
    rondes.forEach(r => { r.id = `${r.naam} ${hhmm(r.start)}`; });
    const dubbel = rondes.find((r, i) => rondes.findIndex(x => x.id === r.id) !== i);
    if (dubbel) fouten.push(`Prikrondes: ${dubbel.id} staat er dubbel in`);
    return { rondes, fouten };
  }

  /* Aanvragen (orders). Kolommen worden herkend aan de kopregel (in elke volgorde, ook plakken uit Excel);
   * zonder kopregel geldt de standaardvolgorde KOLOMMEN. */
  const KOLOMMEN = ["afdeling", "kamer", "bed", "ordernummer", "patientnummer", "naam", "geboortedatum", "status", "bepalingen", "ronde", "bijzonderheden"];
  const KOP = {
    afdeling: /^(afdeling|afd|unit|verpleegafdeling)$/,
    kamer: /^(kamer|kamernummer|kamernr)$/,
    bed: /^(bed|bednummer|bednr)$/,
    ordernummer: /^(order|ordernummer|ordernr|aanvraag|aanvraagnummer|aanvraagnr|labnummer)$/,
    patientnummer: /^(patientnummer|patientnr|patnr|patient-?id|ziekenhuisnummer|zisnummer|zis)$/,
    naam: /^(naam|patient|patientnaam)$/,
    geboortedatum: /^(geboortedatum|geb\.?datum|gebdatum|geboren|dob)$/,
    status: /^(status|prioriteit|urgentie)$/,
    bepalingen: /^(bepalingen|bepaling|test|tests|onderzoek|onderzoeken|buizen)$/,
    ronde: /^(ronde|prikronde|tijd|tijdstip|gewenst|gewenste ?tijd|afnametijd|gewenst tijdstip)$/,
    bijzonderheden: /^(bijzonderheden|condities|speciale condities|opmerking|opmerkingen|instructies|bijz\.?)$/,
  };
  const kopNaam = x => String(x).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  /* Speciale condities die de prikker vooraf moet zien. Herkend in de bijzonderheden (vrije tekst). */
  const CONDITIES = [
    { soort: "isolatie", label: "Isolatie", re: /(quarantaine|karantaine|carantaine|isolatie|geïsoleerd|geisoleerd|contactisolatie|druppelisolatie|aerogeen|strikte isolatie|mrsa|brmo|vre|covid|corona|norovirus|clostridi)/i },
    { soort: "arm", label: "Arm", re: /(linker ?arm|rechter ?arm|links prikken|rechts prikken|niet (links|rechts)|alleen (links|rechts)|(linker|rechter)arm)/i },
    { soort: "let-op", label: "Let op", re: /(shunt|fistel|lymfoedeem|okselklier|mammaca|infuus|picc|moeilijk prikbaar|vaatarm|kinderprikker|latex|flauwvallen|angst|agressie|valgevaar|dementie|delier|tolk)/i },
  ];
  function condities(tekst) {
    return CONDITIES.filter(c => c.re.test(tekst || "")).map(c => ({ soort: c.soort, label: c.label }));
  }

  function parseAanvragen(tekst, afdelingen, rondes) {
    const aanvragen = [], fouten = [];
    const rondeNamen = Object.fromEntries(rondes.map(r => [sleutel(r.naam), r.naam]));
    let kolommen = KOLOMMEN;
    String(tekst || "").split(/\r?\n/).forEach((regel, i) => {
      if (!regel.trim() || regel.trim().startsWith("#")) return;
      const d = velden(regel);
      // Kopregel: bepaalt de kolomvolgorde voor de rest van de invoer
      const kop = d.map(x => Object.keys(KOP).find(k => KOP[k].test(kopNaam(x))) || null);
      if (kop.includes("afdeling") && kop.filter(Boolean).length >= 2) { kolommen = kop; return; }
      const v = {};
      kolommen.forEach((k, j) => { if (k && d[j] != null) v[k] = d[j]; });
      // Extra kolommen achteraan horen bij de bijzonderheden
      if (d.length > kolommen.length) v.bijzonderheden = [v.bijzonderheden, ...d.slice(kolommen.length)].filter(Boolean).join("; ");
      const afd = afdelingen[sleutel(v.afdeling)];
      if (!afd) { fouten.push(`Aanvragen, regel ${i + 1}: afdeling "${v.afdeling || ""}" staat niet in de afdelingenlijst`); return; }
      const status = (v.status || "normaal").trim().toLowerCase();
      if (!STATUSSEN.includes(status)) { fouten.push(`Aanvragen, regel ${i + 1}: onbekende status "${v.status}" (cito, nuchter of normaal)`); return; }
      // Ronde/tijd: "14:00", "Klinische prikronde" of "Klinische prikronde 20:00"
      let ronde = null, tijdstip = null;
      const rt = String(v.ronde || "").trim();
      if (rt) {
        const m = rt.match(/^(.*?)\s*(\d{1,2}[:.]\d{2})$/);
        const naamDeel = m ? m[1] : rt;
        if (m) tijdstip = tijd(m[2]);
        if (naamDeel) {
          if (rondeNamen[sleutel(naamDeel)]) ronde = rondeNamen[sleutel(naamDeel)];
          else { fouten.push(`Aanvragen, regel ${i + 1}: onbekende prikronde "${naamDeel}"`); return; }
        }
      }
      const bijz = String(v.bijzonderheden || "").trim();
      aanvragen.push({
        id: `A${aanvragen.length + 1}`, regel: i + 1, afdeling: afd.code, kamer: (v.kamer || "").trim(), bed: (v.bed || "").trim(),
        ordernummer: (v.ordernummer || "").trim(), patientnummer: (v.patientnummer || "").trim(), patient: (v.naam || "").trim(),
        geboortedatum: (v.geboortedatum || "").trim(), status, bepalingen: (v.bepalingen || "").trim(),
        ronde, tijd: tijdstip, bijzonderheden: bijz, condities: condities(bijz),
      });
    });
    return { aanvragen, fouten };
  }

  const bedient = (r, groep) => !r.groepen || r.groepen.some(g => sleutel(g) === sleutel(groep));

  /** Kiest de prikronde voor één aanvraag. Geeft {ronde: id|null, cito?, reden} terug.
   *  groep = afdelingsgroep van de aanvraag; alleen rondes die die groep bedienen tellen mee. */
  function kiesRonde(a, rondes, { vanaf = 0, marge = 30, groep = null } = {}) {
    if (a.status === "cito" && !a.ronde) return { ronde: null, cito: true, reden: "CITO: direct prikken" };
    let open = rondes.filter(r => r.start >= vanaf && (groep == null || bedient(r, groep)));
    const waar = groep ? ` voor ${groep}` : "";
    if (a.ronde) {
      // Opgegeven rondenaam (eventueel met tijdstip): de eerstvolgende ronde met die naam
      open = open.filter(r => sleutel(r.naam) === sleutel(a.ronde));
      const r = a.tijd != null ? open.find(r => r.start >= a.tijd - marge) : open[0];
      return r ? { ronde: r.id, reden: "ronde opgegeven" } : { ronde: null, reden: `geen ${a.ronde}${a.tijd != null ? " om " + hhmm(a.tijd) : ""} meer${waar}` };
    }
    if (a.tijd != null) {
      // Eerste ronde die niet meer dan `marge` minuten vóór het gewenste tijdstip begint
      const r = open.find(r => r.start >= a.tijd - marge);
      return r ? { ronde: r.id, reden: `gewenst ${hhmm(a.tijd)}` } : { ronde: null, reden: `geen ronde meer na ${hhmm(a.tijd)}${waar}` };
    }
    if (a.status === "nuchter") {
      const r = open.find(r => r.nuchter) || (open.some(r => r.nuchter) || rondes.some(r => r.nuchter && (groep == null || bedient(r, groep))) ? null : open[0]);
      return r ? { ronde: r.id, reden: "nuchter" } : { ronde: null, reden: `geen nuchtere ronde meer vandaag${waar}` };
    }
    return open[0] ? { ronde: open[0].id, reden: "eerstvolgende ronde" } : { ronde: null, reden: `geen ronde meer vandaag${waar}` };
  }

  /** Looptijd (min) tussen twee afdelingen (of de prikpost) */
  function looptijd(a, b, loop = STANDAARD_LOOP) {
    if (a === b) return 0;
    let t = loop.afdeling;
    const dv = Math.abs((a.verdieping || 0) - (b.verdieping || 0));
    if (dv) t += loop.lift + dv * loop.verdieping;
    if (sleutel(a.gebouw) !== sleutel(b.gebouw)) t += loop.gebouw;
    return t;
  }

  const padLengte = (pad, start, loop) => pad.reduce((s, x, i) => s + looptijd(i ? pad[i - 1] : start, x, loop), 0)
    + (pad.length ? looptijd(pad[pad.length - 1], start, loop) : 0);

  /** Loopvolgorde van afdelingen: dichtstbijzijnde eerst vanaf de prikpost, daarna 2-opt. Gelijke afstand: volgorde van de lijst. */
  function loopvolgorde(afds, start, loop = STANDAARD_LOOP) {
    const rest = afds.slice().sort((a, b) => a.index - b.index), pad = [];
    let hier = start;
    while (rest.length) {
      let bi = 0;
      for (let i = 1; i < rest.length; i++) if (looptijd(hier, rest[i], loop) < looptijd(hier, rest[bi], loop)) bi = i;
      hier = rest.splice(bi, 1)[0];
      pad.push(hier);
    }
    let beter = true, best = padLengte(pad, start, loop);
    while (beter) {
      beter = false;
      for (let i = 0; i < pad.length - 1 && !beter; i++) for (let j = i + 1; j < pad.length && !beter; j++) {
        const n = pad.slice(0, i).concat(pad.slice(i, j + 1).reverse(), pad.slice(j + 1));
        const l = padLengte(n, start, loop);
        if (l < best - 1e-9) { pad.splice(0, pad.length, ...n); best = l; beter = true; }
      }
    }
    return pad;
  }

  /** Verdeelt een reeks blokken (afdelingen) in loopvolgorde over n medewerkers, zo gelijk mogelijk.
   *  Exact via dynamisch programmeren: minimaliseer de zwaarste deelronde. */
  function verdeel(gewichten, n) {
    const m = gewichten.length;
    n = Math.max(1, Math.min(n, m));
    const pre = [0]; gewichten.forEach(g => pre.push(pre[pre.length - 1] + g));
    const best = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
    const knip = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    best[0][0] = 0;
    for (let k = 1; k <= n; k++) for (let j = k; j <= m; j++) for (let i = k - 1; i < j; i++) {
      const v = Math.max(best[k - 1][i], pre[j] - pre[i]);
      if (v < best[k][j]) { best[k][j] = v; knip[k][j] = i; }
    }
    const grenzen = []; let j = m;
    for (let k = n; k >= 1; k--) { const i = knip[k][j]; grenzen.unshift([i, j]); j = i; }
    return grenzen;
  }

  /**
   * Hoofdfunctie. req = {
   *   afdelingen (uit parseAfdelingen), rondes (uit parseRondes), aanvragen (uit parseAanvragen),
   *   prikpost: {gebouw, verdieping}, vanaf: "HH:MM" (rondes vóór dit tijdstip zijn al geweest),
   *   marge (min), duur (min per afname), loop? (looptijden)
   * }
   */
  function deelIn(req) {
    const loop = { ...STANDAARD_LOOP, ...(req.loop || {}) };
    const duur = req.duur > 0 ? req.duur : 5;
    const start = { gebouw: sleutel(req.prikpost?.gebouw), verdieping: +req.prikpost?.verdieping || 0, prikpost: true };
    const vanaf = req.vanaf ? min(req.vanaf) : 0;
    const per = new Map(req.rondes.map(r => [r.id, []]));
    const cito = [], niet = [];
    for (const a of req.aanvragen) {
      const k = kiesRonde(a, req.rondes, { vanaf, marge: req.marge ?? 30, groep: req.afdelingen[sleutel(a.afdeling)].groep });
      const x = { ...a, reden: k.reden };
      if (k.cito) cito.push(x); else if (k.ronde) per.get(k.ronde).push(x); else niet.push(x);
    }
    const sorteer = (p, q) => natuurlijk(p.kamer, q.kamer) || natuurlijk(p.bed, q.bed) || p.regel - q.regel;
    const groepeer = lijst => {
      const g = new Map();
      for (const a of lijst) { const s = sleutel(a.afdeling); if (!g.has(s)) g.set(s, []); g.get(s).push(a); }
      return g;
    };
    const blok = (afd, lijst) => ({ afdeling: afd.code, naam: afd.naam, groep: afd.groep, gebouw: afd.gebouw, verdieping: afd.verdieping,
      aanvragen: lijst.slice().sort(sorteer), aantal: lijst.length,
      nuchter: lijst.filter(a => a.status === "nuchter").length, cito: lijst.filter(a => a.status === "cito").length });

    // Per afdelingsgroep (volgorde van de afdelingenlijst) de afdelingen in loopvolgorde
    const groepsvolgorde = afds => {
      const gs = [...new Set(afds.slice().sort((a, b) => a.index - b.index).map(a => a.groep))];
      return gs.flatMap(gr => loopvolgorde(afds.filter(a => a.groep === gr), start, loop));
    };
    const rondes = req.rondes.map(r => {
      const lijst = per.get(r.id);
      const g = groepeer(lijst);
      const pad = groepsvolgorde([...g.keys()].map(s => req.afdelingen[s]));
      const blokken = pad.map(afd => blok(afd, g.get(sleutel(afd.code))));
      // Werklast per afdeling: afnames + looptijd naar de afdeling
      const gewicht = blokken.map((b, i) => b.aantal * duur + looptijd(i ? pad[i - 1] : start, pad[i], loop));
      const delen = blokken.length ? verdeel(gewicht, r.medewerkers) : [];
      const medewerkers = delen.map(([i, j], k) => {
        const deel = blokken.slice(i, j);
        let t = r.start, vorige = start;
        for (const b of deel) {
          const afd = req.afdelingen[sleutel(b.afdeling)];
          t += looptijd(vorige, afd, loop);
          b.aankomst = hhmm(t);
          b.medewerker = k + 1;
          b.aanvragen.forEach((a, ai) => { a.aankomst = hhmm(t + ai * duur); });
          t += b.aantal * duur;
          vorige = afd;
        }
        t += deel.length ? looptijd(vorige, start, loop) : 0;
        return { medewerker: k + 1, afdelingen: deel, aantal: deel.reduce((s, b) => s + b.aantal, 0), klaar: hhmm(t), duur_min: Math.round(t - r.start) };
      });
      return { id: r.id, naam: r.naam, start: hhmm(r.start), groepen: r.groepen, nuchter: r.nuchter, medewerkers_gepland: r.medewerkers,
               aantal: lijst.length, afdelingen: blokken, medewerkers };
    });

    const g = groepeer(cito);
    const citoBlokken = groepsvolgorde([...g.keys()].map(s => req.afdelingen[s])).map(afd => blok(afd, g.get(sleutel(afd.code))));
    const waarschuwingen = [];
    if (niet.length) waarschuwingen.push(`${niet.length} aanvra${niet.length === 1 ? "ag past" : "gen passen"} in geen enkele ronde van vandaag.`);
    for (const r of rondes) {
      if (!r.aantal) continue;
      const eigen = req.rondes.find(x => x.id === r.id);
      const volgende = req.rondes.find(x => x.start > eigen.start && (!eigen.groepen || !x.groepen || x.groepen.some(gr => bedient(eigen, gr))));
      const laat = r.medewerkers.filter(m => volgende && min(m.klaar) > volgende.start);
      if (laat.length) {
        const eind = laat.reduce((x, m) => (min(m.klaar) > min(x) ? m.klaar : x), laat[0].klaar);
        waarschuwingen.push(`${r.id} loopt uit tot ca. ${eind}, na de start van ${volgende.id}` +
          (laat.length < r.medewerkers.length ? ` (${laat.length} van ${r.medewerkers.length} medewerkers).` : `. Overweeg een extra medewerker.`));
      }
    }
    return { rondes, cito: { aantal: cito.length, afdelingen: citoBlokken }, niet_ingedeeld: niet.sort(sorteer), waarschuwingen };
  }

  /* ---------- Doorsturen naar de afnamemodule ----------
   * Formaat (JSON, versie 1):
   * { bron: "prikken-in-kliniek", versie: 1, aangemaakt: ISO-tijd,
   *   ronde: {naam, start} | null (CITO/losse afdeling), medewerker: n | null,
   *   orders: [{ordernummer, patientnummer, naam, geboortedatum, afdeling, afdeling_naam, afdelingsgroep,
   *             kamer, bed, status, bepalingen, bijzonderheden, condities: [..], ronde, ronde_start, medewerker}] }
   * De link is <adres>#orders=<base64url van deze JSON>: de gegevens staan in de hash en gaan dus niet
   * naar de webserver van de afnamemodule; die leest location.hash in de browser uit. */
  function exportOrders(blokken, { ronde = null, medewerker = null } = {}) {
    return blokken.flatMap(b => b.aanvragen.map(a => ({
      ordernummer: a.ordernummer, patientnummer: a.patientnummer, naam: a.patient, geboortedatum: a.geboortedatum,
      afdeling: b.afdeling, afdeling_naam: b.naam, afdelingsgroep: b.groep, kamer: a.kamer, bed: a.bed,
      status: a.status, bepalingen: a.bepalingen, bijzonderheden: a.bijzonderheden, condities: a.condities.map(c => c.soort),
      ronde: ronde ? ronde.naam : null, ronde_start: ronde ? ronde.start : null, medewerker: medewerker ?? b.medewerker ?? null,
    })));
  }

  function bericht(blokken, opties = {}) {
    const { ronde = null, medewerker = null } = opties;
    return { bron: "prikken-in-kliniek", versie: 1, aangemaakt: new Date().toISOString(),
             ronde: ronde ? { naam: ronde.naam, start: ronde.start } : null, medewerker, orders: exportOrders(blokken, opties) };
  }

  const CSV_KOLOMMEN = ["ronde", "ronde_start", "medewerker", "afdeling", "afdeling_naam", "afdelingsgroep", "kamer", "bed", "ordernummer",
                        "patientnummer", "naam", "geboortedatum", "status", "bepalingen", "bijzonderheden", "condities"];
  function naarCsv(orders) {
    const cel = v => { v = Array.isArray(v) ? v.join(",") : String(v ?? ""); return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
    return [CSV_KOLOMMEN.join(";"), ...orders.map(o => CSV_KOLOMMEN.map(k => cel(o[k])).join(";"))].join("\r\n");
  }

  function base64url(tekst) {
    const bytes = new TextEncoder().encode(tekst);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function leesBase64url(b64) {
    const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }
  function afnameLink(adres, ber) {
    return `${String(adres).replace(/#.*$/, "")}#orders=${base64url(JSON.stringify(ber))}`;
  }

  /* ---------- Koppeling met de afnamemodule van het LIS ---------- */
  // Bepalingen splitsen op "|" of op komma's buiten haakjes: "Nierfunctie (kreat, eGFR), CRP" -> 2 bepalingen
  function splitsBepalingen(tekst) {
    tekst = String(tekst || "").trim();
    if (!tekst) return [];
    if (tekst.includes("|")) return tekst.split("|").map(x => x.trim()).filter(Boolean);
    const uit = []; let diep = 0, huidig = "";
    for (const c of tekst) {
      if (c === "(") diep++; else if (c === ")") diep = Math.max(0, diep - 1);
      if (c === "," && !diep) { uit.push(huidig); huidig = ""; } else huidig += c;
    }
    uit.push(huidig);
    return uit.map(x => x.trim()).filter(Boolean);
  }
  const isoDatum = d => { const m = String(d || "").trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : (/^\d{4}-\d{2}-\d{2}$/.test(String(d || "").trim()) ? String(d).trim() : ""); };
  const dagTijd = (datum, t) => { const [h, m] = t.split(":").map(Number); const d = new Date(`${datum}T00:00:00`); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const vandaag = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const ordernr = (a, datum) => a.ordernummer || `KL-${datum.replace(/-/g, "")}-${a.id}`;
  const locatie = (b, a) => [`Afdeling ${b.naam}`, a.kamer && `kamer ${a.kamer}`, a.bed && `bed ${a.bed}`].filter(Boolean).join(" · ");

  /** Groepen {blokken, ronde, medewerker} -> FHIR transaction-bundle (Patient + ServiceRequest per bepaling) */
  function fhirBundle(groepen, datum = vandaag()) {
    const entry = [], patIds = new Map();
    for (const g of groepen) for (const b of g.blokken) for (const a of b.aanvragen) {
      const pid = "kl-" + (a.patientnummer || a.patient || a.id).replace(/[^\w-]+/g, "").toLowerCase();
      if (!patIds.has(pid)) {
        patIds.set(pid, true);
        const bd = isoDatum(a.geboortedatum);
        entry.push({ fullUrl: `urn:uuid:${pid}`, request: { method: "PUT", url: `Patient/${pid}` }, resource: { resourceType: "Patient", id: pid,
          identifier: a.patientnummer ? [{ system: "urn:lis:patientnummer", value: a.patientnummer }] : [], name: [{ text: a.patient || "Onbekend" }], ...(bd ? { birthDate: bd } : {}) } });
      }
      const notities = [g.ronde ? `Prikronde: ${g.ronde.id}${g.medewerker ? " (medewerker " + g.medewerker + ")" : ""}` : "CITO: direct prikken",
        a.status === "nuchter" ? "Nuchter afnemen" : null,
        ...a.condities.map(c => `⚠ ${c.label}`),
        a.bijzonderheden ? `Bijzonderheden: ${a.bijzonderheden}` : null].filter(Boolean).map(text => ({ text }));
      const tests = [...new Set(a.tests && a.tests.length ? a.tests : splitsBepalingen(a.bepalingen))];
      (tests.length ? tests : ["Bloedafname"]).forEach((t, i) => entry.push({ fullUrl: `urn:uuid:${a.id}-${i}`, request: { method: "POST", url: "ServiceRequest" }, resource: {
        resourceType: "ServiceRequest", id: `${ordernr(a, datum)}-${i + 1}`, status: "active", intent: "order",
        priority: a.status === "cito" ? "stat" : "routine",
        requisition: { system: "urn:lis:aanvraag", value: ordernr(a, datum) },
        code: { text: t }, subject: { reference: `Patient/${pid}`, display: a.patient },
        locationCode: [{ text: locatie(b, a) }],
        // Een gewenst tijdstip (bijv. dalspiegel) blijft leidend; anders de verwachte tijd in de ronde
        ...(a.tijd != null ? { occurrenceDateTime: dagTijd(datum, hhmm(a.tijd)) } : g.ronde && a.aankomst ? { occurrenceDateTime: dagTijd(datum, a.aankomst) } : {}),
        note: notities,
        extension: [{ url: "urn:lis:kliniek", valueString: JSON.stringify({ afdeling: b.afdeling, kamer: a.kamer, bed: a.bed, ronde: g.ronde ? g.ronde.id : "CITO", condities: a.condities.map(c => c.soort) }) }],
      } }));
    }
    return { resourceType: "Bundle", type: "transaction", timestamp: new Date().toISOString(), meta: { tag: [{ system: "urn:lis:bron", code: "prikken-in-kliniek" }] }, entry };
  }

  /** Groepen -> routes in het formaat dat de afnamemodule van een routeplanner verwacht */
  function afnameRoutes(groepen, datum = vandaag()) {
    return { routes: groepen.filter(g => g.blokken.some(b => b.aanvragen.length)).map(g => {
      const stops = g.blokken.flatMap(b => b.aanvragen.map(a => ({ a, b })));
      const naam = g.ronde ? `${g.ronde.id}${g.medewerker && g.aantalMw > 1 ? " · medewerker " + g.medewerker : ""}` : "Direct prikken (CITO)";
      const id = `KL-${datum}-${(g.ronde ? g.ronde.id : "CITO").replace(/[^\w]+/g, "-")}${g.medewerker ? "-m" + g.medewerker : ""}`;
      return { id, naam, gebied: [...new Set(stops.map(s => s.b.afdeling))].join(" → "), datum,
        stops: stops.map((s, i) => ({ ordernummer: ordernr(s.a, datum), volgorde: i + 1, ...(s.a.aankomst ? { eta: dagTijd(datum, s.a.aankomst) } : {}) })),
        afstandKm: 0, duurMin: g.duurMin ?? null };
    }) };
  }

  /** Groepen voor een indeling: CITO apart, daarna per ronde per medewerker */
  function groepenVan(res, { alleen = null } = {}) {
    const g = [];
    if (res.cito.aantal && (!alleen || alleen === "cito")) g.push({ blokken: res.cito.afdelingen, ronde: null });
    res.rondes.forEach(r => { if (r.aantal && (!alleen || alleen === r.id)) r.medewerkers.forEach(m => g.push({ blokken: m.afdelingen, ronde: r, medewerker: m.medewerker, aantalMw: r.medewerkers.length, duurMin: m.duur_min })); });
    return g;
  }

  /** Open orders uit de afnamemodule -> invoerregels voor deze module. Thuisprik en poli vallen af. */
  function vanAfname(orders, catalogus, afdelingen) {
    const lijst = Object.values(afdelingen);
    const zoekAfd = loc => {
      const kaal = String(loc || "").split(" · ")[0].replace(/^afdeling\s+/i, "").trim().toLowerCase();
      return lijst.find(a => a.naam.toLowerCase() === kaal || a.code.toLowerCase() === kaal)
          || lijst.find(a => kaal && (kaal.includes(a.naam.toLowerCase()) || a.naam.toLowerCase().includes(kaal)))
          || lijst.find(a => new RegExp(`\\b${a.code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(kaal));
    };
    const tests = (catalogus && catalogus.tests) || {};
    const datumNl = d => { const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : d || ""; };
    const regels = [KOLOMMEN.join("; ")], overgeslagen = [];
    const schoon = x => String(x ?? "").replace(/[;\t\r\n]+/g, " ").trim();
    for (const o of orders || []) {
      if (["done", "failed", "cancelled"].includes(o.status) || o.status === "later") continue;
      if (/thuis|poli/i.test(o.loc || "")) continue;
      const afd = zoekAfd(o.loc);
      if (!afd) { overgeslagen.push(`${o.req}: locatie "${o.loc}" niet in de afdelingenlijst`); continue; }
      const kamer = (String(o.loc || "").match(/kamer\s+([^·]+)/i) || [])[1] || o.kamer || "";
      const bed = (String(o.loc || "").match(/bed\s+([^·]+)/i) || [])[1] || o.bed || "";
      const nuchter = (o.tests || []).some(t => ((tests[t.key] || {}).cond || []).includes("nuchter"));
      const status = o.priority === "stat" ? "cito" : nuchter ? "nuchter" : "normaal";
      let tijd = "";
      if (o.due) { const d = new Date(o.due); if (!isNaN(d)) tijd = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
      const note = String(o.note || "").split(" · ").filter(x => !/^(Prikronde:|CITO: direct|Nuchter afnemen|⚠ )/.test(x)).map(x => x.replace(/^Bijzonderheden:\s*/, "")).join(" · ");
      regels.push([afd.code, kamer.trim(), bed.trim(), o.req, (o.patient || {}).mrn, (o.patient || {}).name, datumNl((o.patient || {}).dob), status,
        (o.tests || []).map(t => schoon(t.name)).join(" | "), tijd, note].map(schoon).join("; "));
    }
    return { regels, overgeslagen };
  }

  // Voorbeeld: een fictief ziekenhuis met 3 gebouwen en een dag aan aanvragen
  const VOORBEELD_AFDELINGEN = `code; naam; groep; gebouw; verdieping
IC; Intensive Care; IC; A; 2
SEH; Spoedeisende hulp; Klinisch; A; 0
B2; Cardiologie B2; Klinisch; B; 2
B3; Chirurgie B3; Klinisch; B; 3
B4; Orthopedie B4; Klinisch; B; 4
B5; Neurologie B5; Klinisch; B; 5
C2; Kinderafdeling C2; Klinisch; C; 2
C3; Interne C3; Klinisch; C; 3
C5; Longziekten C5; Klinisch; C; 5
C6; Oncologie C6; Klinisch; C; 6`;

  // Standaard: IC-prikronde om 06:00, klinische prikrondes om 07, 08, 10, 12, 14, 16, 18, 20 en 22 uur
  const STANDAARD_RONDES = [
    { naam: "IC-prikronde", start: "06:00", groepen: "IC", medewerkers: 1, nuchter: true },
    ...["07:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"].map(t =>
      ({ naam: "Klinische prikronde", start: t, groepen: "Klinisch", medewerkers: t === "07:00" ? 3 : 1, nuchter: t === "07:00" })),
  ];
  const rondesNaarTekst = lijst => ["naam; starttijd; groepen; medewerkers; nuchter",
    ...lijst.map(r => `${r.naam}; ${r.start}; ${r.groepen || "alle"}; ${r.medewerkers}${r.nuchter ? "; nuchter" : ""}`)].join("\n");
  const VOORBEELD_RONDES = rondesNaarTekst(STANDAARD_RONDES);

  function voorbeeldAanvragen(aantal = 60, seed = 7) {
    let s = seed;
    const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const kies = l => l[Math.floor(rng() * l.length)];
    const codes = VOORBEELD_AFDELINGEN.split("\n").slice(1).map(r => r.split(";")[0].trim());
    const namen = ["Jansen", "de Vries", "Bakker", "Visser", "Smit", "Meijer", "de Boer", "Mulder", "de Groot", "Bos", "Vos", "Peters", "Hendriks", "van Dijk"];
    // Namen zoals in de catalogus van de afnamemodule, zodat het materiaal (buis) direct bekend is
    const bep = ["Bloedbeeld", "Nierfunctie | CRP", "CRP | BSE", "Glucose nuchter | HbA1c", "PT/INR en APTT", "Bloedkweek", "Bloedbeeld | hs-Troponine T", "Lipidenspectrum", "TSH en vrij T4", "Vancomycine dalspiegel | Nierfunctie"];
    const bijz = ["", "", "", "", "", "", "Alleen linkerarm (shunt rechts)", "Niet rechts prikken: lymfoedeem", "Contactisolatie (MRSA)", "Patiënt in quarantaine", "Moeilijk prikbaar", "Druppelisolatie", "Latexallergie"];
    const regels = [KOLOMMEN.join("; ")];
    for (let i = 0; i < aantal; i++) {
      const afd = kies(codes);
      const r = rng();
      const status = r < 0.05 ? "cito" : r < 0.45 ? "nuchter" : "normaal";
      const kamer = String(Math.floor(rng() * 12) + 1), bed = String(Math.floor(rng() * 4) + 1);
      const naam = `${rng() < 0.5 ? "Dhr." : "Mw."} ${kies(namen)}`;
      const gd = `${String(1 + Math.floor(rng() * 28)).padStart(2, "0")}-${String(1 + Math.floor(rng() * 12)).padStart(2, "0")}-${1930 + Math.floor(rng() * 70)}`;
      const t = status === "normaal" && rng() < 0.4 ? kies(["09:00", "10:30", "14:00", "15:30", "19:00", "21:30"]) : "";
      regels.push([afd, kamer, bed, `L${String(2611020000 + i)}`, String(1000000 + Math.floor(rng() * 8999999)), naam, gd, status, kies(bep), t, kies(bijz)].join("; "));
    }
    return regels;
  }

  const api = { STANDAARD_LOOP, KOLOMMEN, condities, parseAfdelingen, parseRondes, parseAanvragen, kiesRonde, looptijd, loopvolgorde, verdeel, deelIn,
                exportOrders, bericht, naarCsv, splitsBepalingen, fhirBundle, afnameRoutes, groepenVan, vanAfname, afnameLink, base64url, leesBase64url,
                VOORBEELD_AFDELINGEN, STANDAARD_RONDES, VOORBEELD_RONDES, rondesNaarTekst, voorbeeldAanvragen, hhmm };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Kliniek = api;
})(this);
