// node embedded/kliniek.test.js
const assert = require("assert");
const K = require("./kliniek.js");

const { afdelingen, fouten: fa } = K.parseAfdelingen(K.VOORBEELD_AFDELINGEN);
const { rondes, fouten: fr } = K.parseRondes(K.VOORBEELD_RONDES);
assert.deepStrictEqual([fa, fr], [[], []]);
assert.strictEqual(Object.keys(afdelingen).length, 10);
assert.strictEqual(afdelingen.IC.groep, "IC");
assert.strictEqual(afdelingen.C3.groep, "Klinisch");
// Standaard: IC-ronde 06:00 en klinische rondes 07, 08, 10, 12, 14, 16, 18, 20, 22
assert.deepStrictEqual(rondes.map(r => K.hhmm(r.start)), ["06:00", "07:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"]);
assert.deepStrictEqual(rondes[0].groepen, ["IC"]);
assert.ok(rondes[0].nuchter && rondes[1].nuchter && !rondes[2].nuchter);
assert.deepStrictEqual(K.parseRondes(K.STANDAARD_RONDES).rondes, rondes, "tabel en tekst geven hetzelfde");

// Zonder kopregel: standaardvolgorde
const tekst = `C3; 12; 2; L1; 1234567; Mw. Bakker; 01-02-1950; nuchter; Glucose
C3; 3; 1; L2; 2345678; Dhr. Jansen; 03-04-1960; normaal; Na, K
B3; 2; 1; L3; 3456789; Mw. Visser; ; cito; Troponine
C5; 5; 3; L4; 4567890; Dhr. Smit; ; normaal; CRP; 14:30; Alleen linkerarm
B5; 1; 1; L5; 5678901; Mw. Bos; ; normaal; INR; Klinische prikronde 19:00; Patiënt in carantaine
C6; 7; 2; L6; 6789012; Dhr. Vos; ; normaal; Hb; 23:00
XYZ; 1; 1; L7; 1; Mw. X; ; normaal
IC; 4; 1; L8; 7890123; Dhr. de Boer; ; nuchter; Bloedgas; ; Contactisolatie MRSA; niet rechts prikken
IC; 2; 1; L9; 8901234; Mw. Peters; ; normaal; Hb`;
const { aanvragen, fouten } = K.parseAanvragen(tekst, afdelingen, rondes);
assert.strictEqual(fouten.length, 1, "onbekende afdeling wordt gemeld");
assert.strictEqual(aanvragen.length, 8);
assert.deepStrictEqual([aanvragen[1].ordernummer, aanvragen[1].patientnummer, aanvragen[1].patient, aanvragen[1].geboortedatum, aanvragen[1].bepalingen],
  ["L2", "2345678", "Dhr. Jansen", "03-04-1960", "Na, K"]);
assert.strictEqual(aanvragen[3].tijd, 14 * 60 + 30);
assert.deepStrictEqual(aanvragen[3].condities.map(c => c.soort), ["arm"]);
assert.deepStrictEqual([aanvragen[4].ronde, aanvragen[4].tijd], ["Klinische prikronde", 19 * 60]);
assert.deepStrictEqual(aanvragen[4].condities.map(c => c.soort), ["isolatie"], "carantaine herkend");
assert.strictEqual(aanvragen[6].bijzonderheden, "Contactisolatie MRSA; niet rechts prikken", "extra kolommen bij bijzonderheden");
assert.deepStrictEqual(aanvragen[6].condities.map(c => c.soort), ["isolatie", "arm"]);

// Met kopregel in een andere volgorde (plakken uit Excel, tab-gescheiden)
const kop = K.parseAanvragen("Patiëntnaam\tAfdeling\tKamer\tBed\tPrioriteit\tOpmerking\nMw. A\tC3\t4\t2\tnuchter\tlinkerarm", afdelingen, rondes);
assert.deepStrictEqual(kop.fouten, []);
assert.deepStrictEqual([kop.aanvragen[0].patient, kop.aanvragen[0].afdeling, kop.aanvragen[0].kamer, kop.aanvragen[0].status, kop.aanvragen[0].condities[0].soort],
  ["Mw. A", "C3", "4", "nuchter", "arm"]);
assert.strictEqual(K.parseAanvragen("C3; 1; 1; ; ; ; ; spoed", afdelingen, rondes).fouten.length, 1, "onbekende status gemeld");
assert.strictEqual(K.parseAanvragen("C3; 1; 1; ; ; ; ; normaal; ; Avondronde", afdelingen, rondes).fouten.length, 1, "onbekende ronde gemeld");

const ronde = (a, vanaf = 0) => K.kiesRonde(a, rondes, { vanaf, marge: 30, groep: afdelingen[a.afdeling].groep }).ronde;
assert.strictEqual(ronde(aanvragen[0]), "Klinische prikronde 07:00", "klinisch nuchter naar de nuchtere klinische ronde");
assert.strictEqual(ronde(aanvragen[1]), "Klinische prikronde 07:00", "zonder tijd naar de eerstvolgende ronde van de groep");
assert.ok(K.kiesRonde(aanvragen[2], rondes).cito, "CITO apart");
assert.strictEqual(ronde(aanvragen[3]), "Klinische prikronde 14:00", "14:30 -> 14:00 valt binnen 30 min marge");
assert.strictEqual(ronde(aanvragen[4]), "Klinische prikronde 20:00", "opgegeven ronde met tijd");
assert.strictEqual(ronde(aanvragen[5]), null, "na de laatste ronde: niet ingedeeld");
assert.strictEqual(ronde(aanvragen[6]), "IC-prikronde 06:00", "IC nuchter naar de IC-ronde");
assert.strictEqual(ronde(aanvragen[7]), "IC-prikronde 06:00", "IC alleen in rondes die IC bedienen");
assert.strictEqual(ronde(aanvragen[7], 6 * 60 + 30), null, "IC-ronde geweest: geen andere ronde bedient IC");
assert.strictEqual(ronde(aanvragen[1], 7 * 60 + 30), "Klinische prikronde 08:00", "ronde die al geweest is overslaan");
assert.strictEqual(ronde(aanvragen[0], 7 * 60 + 30), null, "geen nuchtere ronde meer");

const r = K.deelIn({ afdelingen, rondes, aanvragen, prikpost: { gebouw: "A", verdieping: 0 } });
assert.strictEqual(r.cito.aantal, 1);
assert.strictEqual(r.niet_ingedeeld.length, 1);
assert.deepStrictEqual(r.rondes[0].afdelingen.map(b => b.afdeling), ["IC"]);
const ochtend = r.rondes[1];
assert.deepStrictEqual(ochtend.afdelingen.map(b => b.afdeling), ["C3"]);
assert.deepStrictEqual(ochtend.afdelingen[0].aanvragen.map(a => a.kamer), ["3", "12"], "kamers natuurlijk gesorteerd");

// Groter voorbeeld: alles ingedeeld, elke aanvraag precies één keer, afdelingen niet gesplitst
const g = K.parseAanvragen(K.voorbeeldAanvragen(200).join("\n"), afdelingen, rondes);
assert.strictEqual(g.aanvragen.length, 200);
assert.strictEqual(g.fouten.length, 0);
const res = K.deelIn({ afdelingen, rondes, aanvragen: g.aanvragen, prikpost: { gebouw: "A", verdieping: 0 } });
const ids = [...res.cito.afdelingen, ...res.rondes.flatMap(x => x.afdelingen)].flatMap(b => b.aanvragen.map(a => a.id))
  .concat(res.niet_ingedeeld.map(a => a.id));
assert.strictEqual(new Set(ids).size, 200);
assert.strictEqual(ids.length, 200);
for (const x of res.rondes) {
  const viaMw = x.medewerkers.flatMap(m => m.afdelingen.map(b => b.afdeling));
  assert.deepStrictEqual(viaMw, x.afdelingen.map(b => b.afdeling), "medewerkers lopen de afdelingen in loopvolgorde af");
  assert.strictEqual(new Set(viaMw).size, viaMw.length, "afdeling niet gesplitst");
}
assert.strictEqual(res.rondes[1].medewerkers.length, 3);
assert.ok(res.rondes[0].afdelingen.every(b => b.groep === "IC"));
assert.ok(res.rondes.slice(1).every(x => x.afdelingen.every(b => b.groep === "Klinisch")));
// Loopvolgorde: per gebouw bij elkaar (rondgang, dus het begin mag aan het eind aansluiten)
const gebouwen = res.rondes[1].afdelingen.map(b => b.gebouw).join("");
const wissels = [...gebouwen].filter((g, i) => i && g !== gebouwen[i - 1]).length;
assert.ok(wissels <= 3, "gebouwen niet door elkaar: " + gebouwen);

// Verdeling minimaliseert de zwaarste deelronde
assert.deepStrictEqual(K.verdeel([5, 5, 5, 5], 2), [[0, 2], [2, 4]]);
assert.deepStrictEqual(K.verdeel([9, 1, 1, 1], 2), [[0, 1], [1, 4]]);
// Doorsturen: alle gegevens gaan mee, link is terug te lezen
const ronde1 = res.rondes[1];
const ber = K.bericht(ronde1.afdelingen, { ronde: ronde1 });
assert.strictEqual(ber.orders.length, ronde1.aantal);
const o1 = ber.orders.find(o => o.condities.length) || ber.orders[0];
for (const k of ["ordernummer", "patientnummer", "naam", "geboortedatum", "afdeling", "kamer", "bed", "status", "bepalingen", "bijzonderheden", "ronde", "medewerker"])
  assert.ok(k in o1, "veld " + k);
assert.ok(ber.orders.every(o => o.medewerker >= 1 && o.medewerker <= 3), "medewerker per order");
const link = K.afnameLink("https://lab.example/afname/#oud", ber);
assert.ok(link.startsWith("https://lab.example/afname/#orders="));
assert.deepStrictEqual(JSON.parse(K.leesBase64url(link.split("#orders=")[1])), ber, "link terug te lezen (UTF-8)");
assert.strictEqual(JSON.parse(K.leesBase64url(K.base64url('{"n":"Mw. Ünal; ‘x’"}'))).n, "Mw. Ünal; ‘x’");
const csv = K.naarCsv([{ naam: 'Mw. "A"; B', condities: ["arm", "isolatie"] }]).split("\r\n");
assert.strictEqual(csv.length, 2);
assert.ok(csv[1].includes('"Mw. ""A""; B"') && csv[1].includes("arm,isolatie"));
console.log("kliniek: alle tests geslaagd");

// Koppeling met de afnamemodule van het LIS
assert.deepStrictEqual(K.splitsBepalingen("Nierfunctie (kreat, eGFR, Na, K), CRP"), ["Nierfunctie (kreat, eGFR, Na, K)", "CRP"]);
assert.deepStrictEqual(K.splitsBepalingen("Na, K | CRP"), ["Na, K", "CRP"]);
const groepen = K.groepenVan(res);
assert.strictEqual(groepen.flatMap(g => g.blokken.flatMap(b => b.aanvragen)).length, 200 - res.niet_ingedeeld.length);
const bundel = K.fhirBundle(groepen, "2026-11-03");
const srs = bundel.entry.filter(e => e.resource.resourceType === "ServiceRequest").map(e => e.resource);
assert.ok(srs.every(r => r.requisition.value && r.subject.reference.startsWith("Patient/") && r.locationCode[0].text.startsWith("Afdeling ")));
assert.ok(srs.some(r => r.priority === "stat") && srs.some(r => r.note.some(n => /^⚠ /.test(n.text))));
assert.ok(bundel.entry.some(e => e.resource.resourceType === "Patient" && /^\d{4}-\d{2}-\d{2}$/.test(e.resource.birthDate)), "geboortedatum ISO");
const rt = K.afnameRoutes(groepen, "2026-11-03").routes;
assert.strictEqual(rt.reduce((n, r) => n + r.stops.length, 0), groepen.flatMap(g => g.blokken.flatMap(b => b.aanvragen)).length);
const reqs = new Set(srs.map(r => r.requisition.value));
assert.ok(rt.every(r => r.stops.every(s => reqs.has(s.ordernummer))), "elke stop verwijst naar een order in de bundel");
assert.ok(rt.some(r => /medewerker 2/.test(r.naam)), "ronde met meer medewerkers -> route per medewerker");

// Orders uit de afnamemodule ophalen (thuisprik en poli vallen af, locatie -> afdeling)
const cat = { tests: { glucose: { cond: ["nuchter"] }, bb: {} } };
const af = K.vanAfname([
  { req: "A26-1", status: "open", loc: "Afdeling Interne C3", priority: "routine", tests: [{ key: "glucose", name: "Glucose nuchter" }], patient: { name: "Mw. A", mrn: "41", dob: "1950-02-01" }, note: "Shunt rechterarm" },
  { req: "A26-2", status: "open", loc: "Intensive Care · kamer 4 · bed 2", priority: "stat", tests: [{ key: "bb", name: "Bloedbeeld" }], patient: { name: "Dhr. B", mrn: "42" } },
  { req: "A26-3", status: "open", loc: "Thuisprikdienst", tests: [], patient: {} },
  { req: "A26-4", status: "done", loc: "Intensive Care", tests: [], patient: {} },
  { req: "A26-5", status: "open", loc: "Afdeling Onbekend", tests: [], patient: {} },
], cat, afdelingen);
assert.strictEqual(af.regels.length, 3);
assert.strictEqual(af.overgeslagen.length, 1);
const terug = K.parseAanvragen(af.regels.join("\n"), afdelingen, rondes);
assert.deepStrictEqual(terug.fouten, []);
assert.deepStrictEqual(terug.aanvragen.map(a => [a.afdeling, a.kamer, a.bed, a.status, a.ordernummer, a.geboortedatum]),
  [["C3", "", "", "nuchter", "A26-1", "01-02-1950"], ["IC", "4", "2", "cito", "A26-2", ""]]);
assert.deepStrictEqual(terug.aanvragen[0].condities.map(c => c.soort), ["arm", "let-op"], "rechterarm en shunt herkend");
console.log("kliniek: koppeling geslaagd");
