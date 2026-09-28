// deck.gl + MapLibre as the map, Lattice Grid as the attribute table: one
// DuckDB relation, five windows, the map's view as the grid's filter.
const FUEL = { Coal: [90, 90, 90], Gas: [230, 140, 30], Oil: [140, 70, 30], Hydro: [30, 120, 220],
    Nuclear: [170, 60, 200], Solar: [240, 200, 20], Wind: [40, 190, 170], Biomass: [90, 160, 60] };
const OTHER = [150, 150, 170];
const ramp = (t, a, b) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const CAP = [[255, 237, 160], [189, 0, 38]], DEN = [[198, 219, 239], [8, 48, 107]];
const radius = (mw) => 1.5 + Math.sqrt(Math.max(0, mw)) / 6; // pixels, area-true
const shown = { plants: true, countries: true, density: true };
const $ = (sel) => document.querySelector(sel);
const panel = (id, heading, html) => {
    const el = $('#' + id + '-body');
    el.className = 'panel';
    el.innerHTML = '<div class="panel__head">' + heading + '</div><div class="panel__body">' + (html || '') + '</div>';
    return el.lastChild;
};

LatticeGridLayout.createLayout($('#container'), {
    columns: 24, rows: 20, gap: 6, padding: 6, overflowX: 'static', overflowY: 'static',
    windows: [
        { id: 'map', title: 'Map', xPos: 1, yPos: 1, xSize: 15, ySize: 13, chrome: false },
        { id: 'table', title: 'Attribute table', xPos: 1, yPos: 14, xSize: 15, ySize: 6, chrome: false },
        { id: 'layers', title: 'Layers', xPos: 16, yPos: 1, xSize: 9, ySize: 9, chrome: false },
        { id: 'kpis', title: 'In view', xPos: 16, yPos: 10, xSize: 9, ySize: 10, chrome: false },
        { id: 'footer', title: 'Credits', xPos: 1, yPos: 20, xSize: 24, ySize: 1, chrome: false },
    ],
});
panel('map', 'Map · drag or scroll to move; the view filters the table', '<div id="basemap"></div><div id="deck"></div>');
panel('layers', 'Layers', $('#layers-panel').innerHTML);
$('#footer-body').innerHTML = $('#footer-panel').innerHTML;
$('#fuel-legend').innerHTML = Object.entries(FUEL).concat([['Other', OTHER]]).map(([f, c]) =>
    '<span><i class="sw" style="background:rgb(' + c + ')"></i>' + f + '</span>').join('');
$('#size-legend').innerHTML = [10, 1000, 5000].map((mw) => '<i class="sw" style="width:' + 2 * radius(mw)
    + 'px;height:' + 2 * radius(mw) + 'px;background:#888"></i>' + mw.toLocaleString() + ' ').join('');
$('#capacity-ramp').style.background = 'linear-gradient(90deg, rgb(' + CAP[0] + '), rgb(' + CAP[1] + '))';
$('#density-ramp').style.background = 'linear-gradient(90deg, rgb(' + DEN[0] + '), rgb(' + DEN[1] + '))';

const loader = createLoader({ timeoutMs: 90_000 });
(async () => {
    loader.armTimeout();
    const { plants, countries } = await startDuckDB(loader.step);
    loader.step('drawing the layers', 'Drawing layers…');

    // The attribute table: every plant, paged from DuckDB; sort and the filter row run in SQL.
    const grid = LatticeGrid.createGrid(panel('table', 'Attribute table · all plants, filter row on'), {
        rowKey: 'id', source: plants, filterRow: true, selection: 'single',
        columns: [
            { field: 'id', title: 'ID', layout: { hidden: true } },
            { field: 'name', title: 'Plant', layout: { width: 260 } },
            { field: 'country', title: 'Country', layout: { width: 90 } },
            { field: 'primary_fuel', title: 'Fuel', layout: { width: 110 } },
            { field: 'capacity_mw', title: 'MW', type: 'number', format: { decimals: 1 }, layout: { width: 100 } },
            { field: 'commissioning_year', title: 'Year', type: 'number', layout: { width: 80 } },
            { field: 'geometry', title: 'Location', type: 'geometry', layout: { hidden: true } },
        ],
    });
    $('#version').textContent = grid.getVersion();
    loader.waitForRows(() => grid.rows.count() > 0 && grid.rows.get(0).data && grid.rows.get(0).data.name !== undefined);

    // Engine answers over the matching set (the viewport box included): KPIs and capacity per country.
    const request = (groupBy) => ({ filters: grid.filters.get(), sort: [], range: null, groupBy });
    let kpi = { n: null, mw: null };
    const byCountry = new Map();
    const refresh = async () => {
        const [totals, groups] = await Promise.all([
            plants.aggregate(request([]), [{ id: 'n', col: 'id', fn: 'count' }, { id: 'mw', col: 'capacity_mw', fn: 'sum' }]),
            plants.aggregate(request(['country']), [{ id: 'mw', col: 'capacity_mw', fn: 'sum' }]),
        ]);
        kpi = totals.values;
        byCountry.clear();
        for (const g of groups.groups || []) byCountry.set(g.keys[0], Number(g.values.mw) || 0);
        tiles.refresh();
        binding.update();
    };
    const tiles = LatticeGridKPI.createKPI(panel('kpis', 'In view · computed by the engine'), {
        grid, rowKey: 'id', columns: 1,
        tiles: [
            { id: 'plants', label: 'Plants in view', aggregation: 'custom', compute: () => kpi.n, format: { decimals: 0 } },
            { id: 'mw', label: 'Total MW in view', aggregation: 'custom', compute: () => kpi.mw, format: { decimals: 0 } },
        ],
    });

    // The map: MapLibre draws the tiles, deck.gl draws the layers and owns the view.
    const view = { longitude: 10, latitude: 25, zoom: 1.2 };
    const basemap = new maplibregl.Map({ container: 'basemap', style: 'https://demotiles.maplibre.org/style.json',
        interactive: false, center: [view.longitude, view.latitude], zoom: view.zoom, attributionControl: false });
    const deckgl = new deck.Deck({
        parent: $('#deck'), initialViewState: view, controller: true,
        getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
        onAfterRender: () => {
            const vp = deckgl.getViewports()[0];
            if (vp) basemap.jumpTo({ center: [vp.longitude, vp.latitude], zoom: vp.zoom });
        },
        // Map → table: a click on a plant selects its row and scrolls to it.
        onClick: ({ object, layer }) => {
            if (!object || !layer || layer.id !== 'plants') return;
            grid.selection.set([object.properties.id]);
            grid.scroll.toRow(object.properties.id, 'center');
        },
    });

    const binding = LatticeGridDeck.bindDeck(grid, {
        deck: deckgl, viewportFilter: true, position: { geometry: 'geometry' },
        layers: (rows, ctx) => {
            const p = ctx.provenance;
            $('#readout').textContent = 'rows drawn ' + p.rows.toLocaleString() + ' of ' + p.matched.toLocaleString()
                + ' matched · ' + (p.computed === 'engine' ? 'engine' : 'browser')
                + (p.binned ? ' · binned into ' + p.cells.toLocaleString() + ' cells' : '') + (ctx.pending ? ' · loading' : '');
            const selected = new Set(grid.selection.keys());
            const maxCount = ctx.binned ? Math.max(1, ...rows.map((c) => c.count)) : 1;
            return [
                shown.countries && new deck.GeoJsonLayer({
                    id: 'countries', data: countries, stroked: true, lineWidthMinPixels: 0.5, getLineColor: [120, 120, 120, 120],
                    getFillColor: (f) => [...ramp((Math.log10(byCountry.get(f.properties.iso) || 1) - 2) / 4, ...CAP), 110],
                    updateTriggers: { getFillColor: [...byCountry.values()].join() },
                }),
                shown.density && ctx.binned && new deck.PolygonLayer({
                    id: 'density', data: rows, stroked: false,
                    getPolygon: (c) => [[c.west, c.south], [c.east, c.south], [c.east, c.north], [c.west, c.north]],
                    getFillColor: (c) => [...ramp(Math.sqrt(c.count / maxCount), ...DEN), 190],
                }),
                shown.plants && !ctx.binned && new deck.ScatterplotLayer({
                    id: 'plants', data: ctx.features, pickable: true, radiusUnits: 'pixels', opacity: 0.8,
                    getPosition: (f) => f.geometry.coordinates, getRadius: (f) => radius(f.properties.capacity_mw),
                    getFillColor: (f) => FUEL[f.properties.primary_fuel] || OTHER,
                }),
                // Table → map: the selected row drawn as a ring on top.
                new deck.ScatterplotLayer({
                    id: 'highlight', data: ctx.features.filter((f) => selected.has(f.properties.id)),
                    radiusUnits: 'pixels', stroked: true, filled: false, lineWidthMinPixels: 3, getLineColor: [255, 0, 90],
                    getPosition: (f) => f.geometry.coordinates, getRadius: (f) => radius(f.properties.capacity_mw) + 6,
                }),
            ].filter(Boolean);
        },
    });

    for (const box of document.querySelectorAll('[data-layer]')) {
        box.addEventListener('change', () => { shown[box.dataset.layer] = box.checked; binding.update(); });
    }
    grid.on('selection:changed', () => binding.update());
    grid.on('filter:changed', refresh);
    refresh();
    window.__demo = { grid, deck: deckgl, binding, plants, basemap };
})().catch(loader.fail);
