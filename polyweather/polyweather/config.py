"""Station config for Polymarket daily-temperature markets.

Each city maps to the resolution station's coordinates and the unit the
market buckets are quoted in. Coordinates are the airport weather station
Polymarket resolves against (verify per-contract before trading live).
"""
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True)
class City:
    key: str            # polymarket slug fragment, e.g. "london"
    label: str
    lat: float
    lon: float
    unit: str           # "fahrenheit" or "celsius" (matches bucket quoting)
    tz: str


CITIES: dict[str, City] = {
    # Polymarket quotes London/NYC buckets in °F; HK/most intl in °C.
    "london": City("london", "London (Heathrow)", 51.4775, -0.4614, "fahrenheit", "Europe/London"),
    "nyc": City("nyc", "NYC (LaGuardia)", 40.7769, -73.8740, "fahrenheit", "America/New_York"),
    "nyc-central-park": City("nyc-central-park", "NYC (Central Park)", 40.7794, -73.9692, "fahrenheit", "America/New_York"),
    "la": City("la", "Los Angeles (LAX)", 33.9416, -118.4085, "fahrenheit", "America/Los_Angeles"),
    "chicago": City("chicago", "Chicago (Midway)", 41.7868, -87.7522, "fahrenheit", "America/Chicago"),
    "hong-kong": City("hong-kong", "Hong Kong (HKO)", 22.3020, 114.1740, "celsius", "Asia/Hong_Kong"),
    "singapore": City("singapore", "Singapore (Changi)", 1.3586, 103.9899, "celsius", "Asia/Singapore"),
}


def get_city(key: str) -> City:
    if key not in CITIES:
        raise KeyError(f"Unknown city '{key}'. Known: {', '.join(CITIES)}")
    return CITIES[key]
