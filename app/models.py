"""Datamodellen voor de routeplanner."""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class OrderStatus(str, Enum):
    CITO = "cito"          # spoed: zo snel mogelijk, weegt het zwaarst
    NUCHTER = "nuchter"    # nuchter afnemen: vroeg in de ochtend, weegt zwaarder
    NORMAAL = "normaal"    # reguliere afname


class Adres(BaseModel):
    postcode: str = Field(..., examples=["3511AB"])
    huisnummer: int = Field(..., ge=1, examples=[12])
    toevoeging: Optional[str] = Field(None, examples=["A"])

    @field_validator("postcode")
    @classmethod
    def normaliseer_postcode(cls, v: str) -> str:
        v = v.replace(" ", "").upper()
        if len(v) != 6 or not v[:4].isdigit() or not v[4:].isalpha():
            raise ValueError(f"Ongeldige postcode: {v!r} (verwacht formaat 1234AB)")
        return v

    def label(self) -> str:
        t = f"-{self.toevoeging}" if self.toevoeging else ""
        return f"{self.postcode} {self.huisnummer}{t}"


class Order(Adres):
    id: str
    status: OrderStatus = OrderStatus.NORMAAL
    duur_min: int = Field(10, ge=1, le=240, description="Verwachte duur van de afname in minuten")
    patient: Optional[str] = None
    # Optioneel eigen tijdvenster (HH:MM), bijvoorbeeld een afspraak met de patiënt
    vanaf: Optional[str] = None
    uiterlijk: Optional[str] = None


class Instellingen(BaseModel):
    starttijd: str = Field("07:00", description="Vertrektijd vanaf startlocatie (HH:MM)")
    eindtijd: str = Field("13:00", description="Uiterste terugkomsttijd (HH:MM)")
    nuchter_uiterlijk: str = Field("10:00", description="Nuchtere afnames moeten vóór dit tijdstip gebeuren")
    cito_binnen_min: int = Field(60, description="CITO bij voorkeur binnen zoveel minuten na vertrek (zware boete daarna)")
    gewicht_cito: int = Field(20, ge=0, description="1 minuut later bij CITO weegt als zoveel minuten extra rijden")
    gewicht_nuchter: int = Field(5, ge=0, description="1 minuut later bij nuchter weegt als zoveel minuten extra rijden")
    gewicht_normaal: int = Field(0, ge=0, description="1 minuut later bij regulier weegt als zoveel minuten extra rijden")
    terug_naar_start: bool = True
    rekentijd_sec: int = Field(5, ge=1, le=60)


class PlanVerzoek(BaseModel):
    start: Adres
    orders: list[Order]
    medewerkers: int = Field(1, ge=1, le=50, description="Aantal bloedafnamemedewerkers (voertuigen)")
    instellingen: Instellingen = Instellingen()


class Stop(BaseModel):
    volgorde: int
    order_id: Optional[str]
    label: str
    status: Optional[OrderStatus]
    lat: float
    lon: float
    aankomst: str
    vertrek: str
    reistijd_min: float
    afstand_km: float


class Route(BaseModel):
    medewerker: int
    stops: list[Stop]
    totaal_reistijd_min: float
    totaal_afstand_km: float
    eindtijd: str
    geometrie: list[list[float]]  # [[lat, lon], ...]


class PlanResultaat(BaseModel):
    routes: list[Route]
    niet_ingepland: list[dict]
    reistijdbron: str
    waarschuwingen: list[str]
