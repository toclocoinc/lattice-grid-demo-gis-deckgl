# A GIS map with an attribute table: deck.gl, MapLibre and Lattice Grid

Every power plant in the World Resources Institute's Global Power Plant
Database, 34,936 of them, queried in the browser by DuckDB-WASM and drawn by
deck.gl over a MapLibre basemap, with Lattice Grid as the attribute table.
The map's view is the table's filter: pan or zoom and the table, the KPI tiles
and the country fills narrow to what is on screen.

## What it shows

- **Map** — deck.gl layers over a neutral MapLibre basemap, bound to the grid
  with `bindDeck` from `modules/deckgl`. Which layer draws follows the zoom:
  - **Capacity by country** (world view, zoom below 4): a `GeoJsonLayer`
    choropleth of the Natural Earth outlines, filled by the total MW of the
    matching plants in each country in six quantile classes, summed by DuckDB
    through `source.aggregate()` grouped by country. The legend shows each
    class's MW range and follows the view.
  - **Density** (zoom 4 and closer, while the view holds more plants than the
    binding's `viewportCap`, set to 5,000 here): the engine hands over density
    cells instead of rows, and the page draws them as a deck.gl `HexagonLayer`
    weighted by each cell's count, coloured by quantile.
  - **Plants** (fewer plants in view than the cap): a `ScatterplotLayer`, one
    dot per plant, sized by MW (area-true) and coloured by fuel. Click a plant
    to select its row in the table; the table scrolls to it.
  - A ring marks the row selected in the table.
  - Ticking or unticking a layer overrides the zoom rule for that layer;
    **Layers by zoom** hands control back.
- **Attribute table** — the whole dataset, paged from DuckDB, with the filter
  row on. Sorting and filtering run as SQL. The columns take `flex` shares,
  so the table fills its window at any screen width.
- **Layers** — a toggle and a legend per layer, and the binding's own
  readout: rows drawn, rows matched, and whether the engine or the browser
  counted them.
- **In view** — plants and total MW in view, both computed by the engine over
  the matching set, so they follow the viewport filter.
- **Credits** — data and map credits, and the grid version.

Add `?theme=dark` to the address to see the page under `data-theme="dark"`.

## Data

- `data/power-plants.parquet` (1.89 MB) — the
  [Global Power Plant Database v1.3](https://github.com/wri/global-power-plant-database)
  by World Resources Institute. Licence:
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- `data/countries.parquet` (157 KB) — country outlines from
  [Natural Earth](https://www.naturalearthdata.com/) (1:110m), public domain.

**Basemap tiles come from a third-party service**: the keyless
[OpenFreeMap](https://openfreemap.org) Positron style,
`https://tiles.openfreemap.org/styles/positron` (OpenFreeMap's Bright style if
Positron fails to load). Map data © OpenStreetMap contributors, tiles
© OpenMapTiles. The page also loads MapLibre GL JS 4.7.1, deck.gl 9.1.0 and
DuckDB-WASM 1.32.0 from jsDelivr.

## Run it locally

The page loads Lattice Grid 1.79.0 from the jsDelivr CDN. To try a local build
instead, copy the grid's `dist/` to `vendor/` (not part of this repository)
and set `LOCAL = true` at the top of `index.html`. Serve the folder with any
static server, for example:

```
python3 -m http.server 8607
```

and open http://localhost:8607/. No licence key is needed on localhost.

## Grid features used

`duckdbAdapter` (with `spatial: true`) + `createPushdownSource` (sort, filter
and paging pushed down as SQL; `source.aggregate()` for the KPI tiles and the
per-country sums), `createGrid` with a `geometry` column, `filterRow`, single
row `selection`, `scroll.toRow`, `bindDeck` with `viewportFilter` (a
`withinBbox` condition on the grid) and its engine density cells past
`viewportCap`, and the layout and KPI modules. Modules loaded: `layout`,
`kpi`, `geometry`, `deckgl`.

Why the pushdown source rather than the 35k rows in memory: over a paged
pushdown grid the binding asks the engine for just the rows inside the view,
and for density cells when the view holds too many. A memory grid would hand
deck.gl every row at every zoom and has no density path.

## Licence

The code in this repository is available under the MIT licence. See
[LICENSE](LICENSE). The data licences are named above. Lattice Grid itself is
a separate commercial product, free to use on localhost; keys for your own
sites come from [latticegrid.dev](https://www.latticegrid.dev).
