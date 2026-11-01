# Routeplanner bloedafname

Plant de optimale route(s) voor bloedafnamemedewerkers op basis van **postcode + huisnummer**,
waarbij **CITO**-orders het zwaarst wegen en **nuchtere** afnames vroeg in de ochtend worden ingepland.

![stack](https://img.shields.io/badge/OR--Tools-VRPTW-blue) ![stack](https://img.shields.io/badge/OSRM-OpenStreetMap-green) ![stack](https://img.shields.io/badge/PDOK-BAG-orange)

## Gebruikte technologie

| Onderdeel | Tool | Waarom |
|---|---|---|
| Geocoding | **PDOK Locatieserver** (Kadaster/BAG) | Officiële Nederlandse adresregistratie, gratis, geen API-key, exact op postcode + huisnummer + toevoeging |
| Reistijden | **OSRM** (Open Source Routing Machine) op OpenStreetMap | Echte rijtijden over het wegennet als volledige matrix; zelf te hosten voor privacy en snelheid |
| Optimalisatie | **Google OR-Tools** (Vehicle Routing Problem met tijdvensters) | De standaard open-source solver voor routeplanning; Guided Local Search metaheuristiek |
| API | FastAPI | Snelle Python-API met automatische documentatie op `/docs` |
| Kaart | Leaflet + OpenStreetMap | Lichtgewicht interactieve kaart |

## Hoe de prioriteiten werken

De solver minimaliseert: **totale rijtijd + Σ gewicht(status) × aankomsttijd**.

* **CITO** (standaardgewicht 20): één minuut eerder bij een CITO-patiënt is evenveel waard als 20 minuten extra rijden.
  Daarnaast een zware boete als CITO later valt dan *X minuten na vertrek* (standaard 60).
* **Nuchter** (standaardgewicht 5): plus een zware boete na de nuchter-deadline (standaard 10:00).
* **Normaal** (standaardgewicht 0): puur zo efficiënt mogelijk rijden.
* **Eigen tijdvenster** per order (bijv. afspraak `09:00-10:30`) is een harde eis.
* Past niet alles binnen de dienst? Dan vallen eerst reguliere orders af, daarna nuchtere, en CITO als allerlaatste.
* Meerdere medewerkers: de orders worden automatisch over de medewerkers verdeeld.

Alle gewichten en tijden zijn in de UI aan te passen onder *Prioriteiten en instellingen*.

## Twee varianten

1. **Losse HTML (`docs/index.html`)**: één bestand, geen server nodig. Dubbelklik of host het (bijv. GitHub Pages).
   Geocoding (PDOK) en reistijden (OSRM) worden direct vanuit de browser opgevraagd; de optimalisatie draait in een
   Web Worker met *Ruin & Recreate* + simulated annealing (dezelfde doelfunctie als hieronder). Op testinstanties tot
   40 adressen / 3 medewerkers is het resultaat gelijk aan of iets beter dan OR-Tools met dezelfde rekentijd.
   Invoer en gevonden adressen worden lokaal in de browser onthouden.
   Opnieuw bouwen na wijzigingen: `python embedded/build.py`. Tests: `node embedded/solver.test.js`.
2. **Server (FastAPI + Google OR-Tools)**: zie hieronder. Geschikt voor grotere aantallen en integratie via de API.

## Online zetten met GitHub Pages

Settings → Pages → *Deploy from a branch* → branch `main`, map `/docs`. De planner staat dan op
`https://<gebruiker>.github.io/<repo>/`.

## Starten (servervariant)

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://localhost:8000. API-documentatie: http://localhost:8000/docs

Standaard wordt de publieke OSRM-demoserver gebruikt (prima om te testen, niet voor productie: beperkte
capaciteit en adressen gaan naar een externe server). Voor productie: draai OSRM zelf:

```bash
./osrm-voorbereiden.sh      # eenmalig, downloadt en verwerkt het Nederlandse wegennet
docker compose up -d        # app + eigen OSRM op http://localhost:8000
```

Is OSRM onbereikbaar, dan valt de app terug op een schatting (hemelsbrede afstand × 1,35 bij 35 km/u) en meldt dat.

### Omgevingsvariabelen

| Variabele | Standaard | |
|---|---|---|
| `OSRM_URL` | `https://router.project-osrm.org` | eigen OSRM-server |
| `OSRM_PROFIEL` | `driving` | |
| `PDOK_URL` | PDOK Locatieserver v3.1 | |
| `GEOCODE_CACHE` | `geocode_cache.json` | cache van gevonden adressen |

## Invoer

In de UI één order per regel (of plakken uit Excel / CSV, zie `voorbeeld_orders.csv`):

```
postcode; huisnummer[-toevoeging]; status; duur(min); naam; [tijdvenster]
3581AB; 10; cito; 10; Dhr. Jansen
3531TS; 2-A; nuchter; 15; Mw. Bakker
3511LX; 7; normaal; 10; ; 09:00-10:30
```

Of rechtstreeks via de API: `POST /api/plan` (zie `/docs` voor het schema).

### Doorsturen vanuit de ordermodule

De losse HTML-versie leest orders ook uit de link: `index.html#orders=<base64url>&start=<postcode>-<huisnummer>&medewerkers=<n>`.
`orders` is de invoertekst hierboven (UTF-8, base64url). De gegevens staan in de hash, gaan dus niet naar de webserver,
en de hash wordt na het inlezen gewist.

## Tests

```bash
pytest -q
```

## Privacy

Stuur bij voorkeur geen patiëntnamen mee naar externe diensten: de app stuurt alleen postcode/huisnummer naar PDOK
en coördinaten naar OSRM; namen blijven lokaal. Gebruik voor productie een eigen OSRM-server.
