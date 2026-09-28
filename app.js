// deck.gl + MapLibre as the map, Lattice Grid as the attribute table: one
// DuckDB relation, five windows, the map's view as the grid's filter.
// The layers and their legends live in layers.js; the data side in data.js.
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
drawLegends($);

const loader = createLoader({ timeoutMs: 90_000 });
(async () => {
    loader.armTimeout();
    const { plants, countries } = await startDuckDB(loader.step);
    loader.step('drawing the layers', 'Drawing layers…');

    // The attribute table: every plant, paged from DuckDB; sort and the filter row run in SQL.
    // Flex shares divide the window's width, so the table fills it on any screen.
    const grid = LatticeGrid.createGrid(panel('table', 'Attribute table · all plants, filter row on'), {
        rowKey: 'id', source: plants, filterRow: true, selection: 'single',
        columns: [
            { field: 'id', title: 'ID', layout: { hidden: true } },
            { field: 'name', title: 'Plant', layout: { flex: 4, min: 200 } },
            { field: 'country', title: 'Country', layout: { flex: 1, min: 80 } },
            { field: 'primary_fuel', title: 'Fuel', layout: { flex: 1.5, min: 100 } },
            { field: 'capacity_mw', title: 'MW', type: 'number', format: { decimals: 1 }, layout: { flex: 1, min: 90 } },
            { field: 'commissioning_year', title: 'Year', type: 'number', layout: { flex: 1, min: 70 } },
            { field: 'geometry', title: 'Location', type: 'geometry', layout: { hidden: true } },
        ],
    });
    $('#version').textContent = grid.getVersion();
    loader.waitForRows(() => grid.rows.count() > 0 && grid.rows.get(0).data && grid.rows.get(0).data.name !== undefined);

    // Engine answers over the matching set (the viewport box included): KPIs and capacity per country.
    const request = (groupBy) => ({ filters: grid.filters.get(), sort: [], range: null, groupBy });
    let kpi = { n: null, mw: null };
    const state = { zoom: 1.2, override: {}, byCountry: new Map(), breaks: [], countries, selected: new Set() };
    const refresh = async () => {
        const [totals, groups] = await Promise.all([
            plants.aggregate(request([]), [{ id: 'n', col: 'id', fn: 'count' }, { id: 'mw', col: 'capacity_mw', fn: 'sum' }]),
            plants.aggregate(request(['country']), [{ id: 'mw', col: 'capacity_mw', fn: 'sum' }]),
        ]);
        kpi = totals.values;
        state.byCountry.clear();
        for (const g of groups.groups || []) if (g.level > 0) state.byCountry.set(g.keys[0], Number(g.values.mw) || 0);
        state.breaks = quantileBreaks([...state.byCountry.values()], 6);
        drawCapacityLegend($('#capacity-legend'), state.breaks);
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

    // The map: MapLibre draws a neutral keyless basemap (OpenFreeMap Positron, Bright
    // if Positron fails to load), deck.gl draws the layers and owns the view.
    const view = { longitude: 10, latitude: 25, zoom: state.zoom };
    const STYLES = ['https://tiles.openfreemap.org/styles/positron', 'https://tiles.openfreemap.org/styles/bright'];
    const basemap = new maplibregl.Map({ container: 'basemap', style: STYLES[0],
        interactive: false, center: [view.longitude, view.latitude], zoom: view.zoom, attributionControl: false });
    let styled = false, fellBack = false;
    basemap.once('style.load', () => { styled = true; });
    basemap.on('error', () => { if (!styled && !fellBack) { fellBack = true; basemap.setStyle(STYLES[1]); } });
    const deckgl = new deck.Deck({
        parent: $('#deck'), initialViewState: view, controller: true,
        getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
        // Crossing the world-zoom line swaps layers even before the rows answer.
        onViewStateChange: ({ viewState }) => {
            const crossed = (viewState.zoom < WORLD_ZOOM) !== (state.zoom < WORLD_ZOOM);
            state.zoom = viewState.zoom;
            if (crossed) queueMicrotask(() => binding.update());
        },
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

    const boxes = [...document.querySelectorAll('[data-layer]')];
    // viewportCap 5,000 (default 20,000): a continent at zoom 4-5 holds 8-9k plants, so it draws as density.
    const binding = LatticeGridDeck.bindDeck(grid, {
        deck: deckgl, viewportFilter: true, position: { geometry: 'geometry' }, viewportCap: 5000,
        layers: (rows, ctx) => {
            const p = ctx.provenance;
            $('#readout').textContent = 'rows drawn ' + p.rows.toLocaleString() + ' of ' + p.matched.toLocaleString()
                + ' matched · ' + (p.computed === 'engine' ? 'engine' : 'browser')
                + (p.binned ? ' · binned into ' + p.cells.toLocaleString() + ' cells' : '') + (ctx.pending ? ' · loading' : '');
            state.selected = new Set(grid.selection.keys());
            try { state.zoom = deckgl.getViewports()[0]?.zoom ?? state.zoom; } catch { /* deck not initialised yet */ }
            const { layers, on } = buildLayers(rows, ctx, state);
            for (const box of boxes) box.checked = on[box.dataset.layer];
            return layers;
        },
    });

    // A toggle the reader touches overrides the zoom rule for that layer; "auto" hands it back.
    for (const box of boxes) {
        box.addEventListener('change', () => { state.override[box.dataset.layer] = box.checked; binding.update(); });
    }
    $('#auto-layers').addEventListener('click', () => { state.override = {}; binding.update(); });
    grid.on('selection:changed', () => binding.update());
    grid.on('filter:changed', refresh);
    refresh();
    window.__demo = { grid, deck: deckgl, binding, plants, basemap, state, kpi: () => kpi };
})().catch(loader.fail);
