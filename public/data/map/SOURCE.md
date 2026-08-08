# Administrative boundary data

- Source: Statistics Korea SGIS administrative boundaries, corrected and maintained by `vuski/admdongkor`
- Source repository: https://github.com/vuski/admdongkor
- Snapshot: `ver20260701`
- Data license: CC BY 4.0; the SGIS attribution requirement is retained
- Processing: dissolved into province and municipality boundaries, simplified for web display, reduced to display-only properties, and paired with one interior label point per feature
- Border seam: the high-resolution South Korean northern boundary is connected to the lower-resolution neighboring-country geometry to prevent background gaps at high zoom

These files are used only by the broadcast radar map and are loaded when broadcast mode opens.

# Watersheds and national rivers

- Basin source: VWorld national water-resource unit map, middle-basin layer, distributed through Esri Korea Living Atlas
- Basin reference date: `2025-04`
- River source: VWorld national river polygon layer, distributed through Esri Korea Living Atlas
- Processing: reprojected to WGS84, geometry rounded to five decimal places, and simplified at approximately 20 m for web display
- Files: `kr-basin-middle-202504.geojson`, `kr-national-rivers-2025.geojson`
- Use: selectable basin boundaries and national-river overlays in the 3D terrain rainfall view

# Terrain elevation

- Source: Mapzen Terrain Tiles in Terrarium encoding, hosted by the Registry of Open Data on AWS
- Dataset: https://registry.opendata.aws/terrain-tiles/
- Tile endpoint: `s3://elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
- Use: client-side terrain mesh and hillshade in the 3D terrain rainfall view

# World land polygons (`land-50m-world.geojson`)

- Source: Natural Earth 1:50m `ne_50m_land` (public domain), via https://github.com/nvkelso/natural-earth-vector
- Processing: whole world (no clipping — the satellite full-disk view shows everything from India to the Pacific), coordinates rounded to 3 decimals, merged into a single MultiPolygon
- Used by the satellite view (`?satellite=1`) for land fill and coastline outline
