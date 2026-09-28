// The map's layers and legends. Which layers draw is chosen by deck's zoom:
// world view (zoom < 4) → the capacity-by-country choropleth alone; closer in,
// the engine's density cells as hexagons while the view holds more plants than
// the binding's cap, and the plants themselves once it holds fewer. A layer
// toggle the reader has touched overrides the zoom rule for that layer.
const FUEL = { Coal: [90, 90, 90], Gas: [230, 140, 30], Oil: [140, 70, 30], Hydro: [30, 120, 220],
    Nuclear: [170, 60, 200], Solar: [240, 200, 20], Wind: [40, 190, 170], Biomass: [90, 160, 60] };
const OTHER = [150, 150, 170];
// ColorBrewer YlOrRd (capacity) and PuBu (density), six classes each.
const CAP = [[255, 255, 178], [254, 217, 118], [254, 178, 76], [253, 141, 60], [240, 59, 32], [189, 0, 38]];
const DEN = [[241, 238, 246], [208, 209, 230], [166, 189, 219], [116, 169, 207], [43, 140, 190], [4, 90, 141]];
const WORLD_ZOOM = 4;
const capColour = (i, n) => CAP[n > 1 ? Math.round((i * (CAP.length - 1)) / (n - 1)) : CAP.length - 1];
const radius = (mw) => 1.5 + Math.sqrt(Math.max(0, mw)) / 6; // pixels, area-true
const fmt = (n) => Math.round(n).toLocaleString();
const rgb = (c) => 'rgb(' + c + ')';

/**
 * Quantile class breaks: the upper bound of each of `k` equal-count classes.
 * @param {number[]} values positive values to classify
 * @param {number} k how many classes
 * @returns {number[]} ascending breaks, `k` long (or fewer when values repeat)
 */
function quantileBreaks(values, k) {
    const v = values.filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) return [];
    const out = [];
    for (let i = 1; i <= k; i++) out.push(v[Math.min(v.length - 1, Math.ceil((i * v.length) / k) - 1)]);
    return [...new Set(out)];
}

/**
 * Which layers the zoom rule shows, before the reader's overrides.
 * @param {number} zoom deck's zoom
 * @param {boolean} binned whether the binding handed over density cells
 * @returns {{countries: boolean, density: boolean, plants: boolean}}
 */
function autoLayers(zoom, binned) {
    const world = zoom < WORLD_ZOOM;
    return { countries: world, density: !world && binned, plants: !world && !binned };
}

/**
 * Build deck's layers for one render of the binding.
 * @param {object[]} rows the binding's rows, or its density cells when `ctx.binned`
 * @param {object} ctx the binding's layer context
 * @param {{zoom: number, override: object, byCountry: Map, breaks: number[], countries: object[], selected: Set}} s page state
 * @returns {{layers: object[], on: object}} the layers, and which of the three are on
 */
function buildLayers(rows, ctx, s) {
    const auto = autoLayers(s.zoom, ctx.binned);
    const on = {};
    for (const k of Object.keys(auto)) on[k] = k in s.override ? s.override[k] : auto[k];
    const capClass = (mw) => { const i = s.breaks.findIndex((b) => mw <= b); return i < 0 ? s.breaks.length - 1 : i; };
    // Hexagons a little wider than the engine's cells, so every cell lands in one and none sit alone.
    const cell = rows[0] || {};
    const cellKm = ctx.binned ? Math.abs(cell.east - cell.west) * 111 * Math.cos(((cell.north + cell.south) / 2) * Math.PI / 180) : 50;
    return { on, layers: [
        on.countries && new deck.GeoJsonLayer({
            id: 'countries', data: s.countries, stroked: true, lineWidthMinPixels: 0.6, getLineColor: [255, 255, 255, 220],
            getFillColor: (f) => { const mw = s.byCountry.get(f.properties.iso) || 0;
                return mw > 0 && s.breaks.length ? [...capColour(capClass(mw), s.breaks.length), 215] : [0, 0, 0, 0]; },
            updateTriggers: { getFillColor: s.breaks.join() + '|' + [...s.byCountry.values()].join() },
        }),
        on.density && ctx.binned && new deck.HexagonLayer({
            id: 'density', data: rows, gpuAggregation: false, extruded: false, opacity: 0.6, coverage: 0.9,
            radius: Math.max(1000, cellKm * 1000 * 0.75), colorRange: DEN, colorScaleType: 'quantile',
            getPosition: (c) => [(c.west + c.east) / 2, (c.south + c.north) / 2],
            getColorWeight: (c) => c.count, colorAggregation: 'SUM',
        }),
        on.plants && !ctx.binned && new deck.ScatterplotLayer({
            id: 'plants', data: ctx.features, pickable: true, radiusUnits: 'pixels', opacity: 0.85,
            stroked: true, lineWidthUnits: 'pixels', getLineWidth: 0.5, getLineColor: [255, 255, 255],
            getPosition: (f) => f.geometry.coordinates, getRadius: (f) => radius(f.properties.capacity_mw),
            getFillColor: (f) => FUEL[f.properties.primary_fuel] || OTHER,
        }),
        // Table → map: the selected row drawn as a ring on top.
        new deck.ScatterplotLayer({
            id: 'highlight', data: ctx.features.filter((f) => s.selected.has(f.properties.id)),
            radiusUnits: 'pixels', stroked: true, filled: false, lineWidthMinPixels: 3, getLineColor: [255, 0, 90],
            getPosition: (f) => f.geometry.coordinates, getRadius: (f) => radius(f.properties.capacity_mw) + 6,
        }),
    ].filter(Boolean) };
}

/**
 * The static legends: fuel colours, dot sizes and the density ramp.
 * @param {(sel: string) => Element} $ the page's query helper
 */
function drawLegends($) {
    $('#fuel-legend').innerHTML = Object.entries(FUEL).concat([['Other', OTHER]]).map(([f, c]) =>
        '<span><i class="sw" style="background:' + rgb(c) + '"></i>' + f + '</span>').join('');
    $('#size-legend').innerHTML = [10, 1000, 5000].map((mw) => '<i class="sw" style="width:' + 2 * radius(mw)
        + 'px;height:' + 2 * radius(mw) + 'px;background:#888"></i>' + fmt(mw) + ' ').join('');
    $('#density-ramp').innerHTML = DEN.map((c) => '<i style="background:' + rgb(c) + ';opacity:.6"></i>').join('');
}

/**
 * The choropleth legend: one swatch per quantile class, labelled with its MW range.
 * @param {Element} el where it goes
 * @param {number[]} breaks the class upper bounds
 */
function drawCapacityLegend(el, breaks) {
    el.innerHTML = breaks.length ? breaks.map((b, i) => '<span><i class="sw sq" style="background:' + rgb(capColour(i, breaks.length))
        + '"></i>' + (i ? fmt(breaks[i - 1]) + '–' : '≤ ') + fmt(b) + ' MW</span>').join('') : 'no plants in view';
}
