#!/usr/bin/env bash
# Downloadt het OpenStreetMap-wegennet van Nederland en bereidt het voor op OSRM (auto-profiel).
set -euo pipefail
mkdir -p osrm data && cd osrm
curl -L -o netherlands-latest.osm.pbf https://download.geofabrik.de/europe/netherlands-latest.osm.pbf
IMG=ghcr.io/project-osrm/osrm-backend:v5.27.1
docker run --rm -t -v "$PWD:/osrm" $IMG osrm-extract -p /opt/car.lua /osrm/netherlands-latest.osm.pbf
docker run --rm -t -v "$PWD:/osrm" $IMG osrm-partition /osrm/netherlands-latest.osrm
docker run --rm -t -v "$PWD:/osrm" $IMG osrm-customize /osrm/netherlands-latest.osrm
echo "Klaar. Start met: docker compose up -d"
