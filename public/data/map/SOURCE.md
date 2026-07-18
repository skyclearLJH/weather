# Administrative boundary data

- Source: Statistics Korea SGIS administrative boundaries, corrected and maintained by `vuski/admdongkor`
- Source repository: https://github.com/vuski/admdongkor
- Snapshot: `ver20260701`
- Data license: CC BY 4.0; the SGIS attribution requirement is retained
- Processing: dissolved into province and municipality boundaries, simplified for web display, reduced to display-only properties, and paired with one interior label point per feature
- Border seam: the high-resolution South Korean northern boundary is connected to the lower-resolution neighboring-country geometry to prevent background gaps at high zoom

These files are used only by the broadcast radar map and are loaded when broadcast mode opens.

# East Asia land polygons (`ea-land-50m.geojson`)

- Source: Natural Earth 1:50m `ne_50m_land` (public domain), via https://github.com/nvkelso/natural-earth-vector
- Processing: clipped to lon 88–168 / lat 2–64 (GK2A EA domain coverage), coordinates rounded to 3 decimals, merged into a single MultiPolygon
- Used by the satellite view (`?satellite=1`) for land/sea fill contrast
