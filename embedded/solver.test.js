// node embedded/solver.test.js
const assert = require("assert");
const S = require("./solver.js");
const n = 6, pts = [[0, 0], ...Array.from({ length: n }, (_, i) => [0, i + 1])];
const dur = pts.map(a => pts.map(b => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 300)));
const basis = (orders, extra = {}) => ({ dur, orders, horizon: 6 * 3600, citoDeadline: 3600, nuchterDeadline: 3 * 3600,
  gewicht: { cito: 20, nuchter: 5, normaal: 0 }, medewerkers: 1, terug: true, ...extra });
const norm = () => Array.from({ length: n }, () => ({ status: "normaal", duur: 600 }));

let o = norm(); o[5] = { status: "cito", duur: 600 };
let r = S.los(basis(o), { tijdMs: 300 });
assert.strictEqual(r.routes[0][0], 6, "CITO (verste punt) moet eerst");

o = norm(); o[4] = { status: "nuchter", duur: 900 };
r = S.los(basis(o, { nuchterDeadline: 1800 }), { tijdMs: 300 });
const p5 = r.plannen[0].stops.find(s => s.knoop === 5);
assert.ok(p5.aankomst <= 1800, "nuchter voor deadline");

o = norm().map(x => ({ ...x, duur: 3600 })); o[2] = { status: "cito", duur: 3600 };
r = S.los(basis(o, { horizon: 3 * 3600 }), { tijdMs: 300 });
assert.ok(r.vervallen.length > 0 && !r.vervallen.includes(3), "regulier valt eerst af, CITO niet");

o = norm(); o[0] = { status: "normaal", duur: 600, vanaf: 7200 };
r = S.los(basis(o), { tijdMs: 300 });
assert.ok(r.plannen[0].stops.find(s => s.knoop === 1).aankomst >= 7200, "hard tijdvenster");

r = S.los(basis(norm().map(x => ({ ...x, duur: 3000 })), { medewerkers: 2, horizon: 4 * 3600 }), { tijdMs: 300 });
assert.ok(!r.vervallen.length && r.routes.every(x => x.length), "verdeling over 2 medewerkers");
console.log("solver: alle tests geslaagd");
