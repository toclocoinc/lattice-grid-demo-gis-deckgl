/**
 * The data side: DuckDB-Wasm with the spatial extension, the power-plant
 * GeoParquet behind a paged pushdown source, and the country outlines read
 * once as GeoJSON features for the choropleth layer.
 *
 * Why a paged pushdown source and not the 35k rows in memory: the deck.gl
 * binding asks the ENGINE for the rows inside the view, and past its cap
 * (20,000) hands over the engine's density cells instead. A memory grid would
 * hand deck every row at every zoom, with no density path at all.
 */

/**
 * Start DuckDB-Wasm, register both parquet files and build the plants source.
 *
 * @param {(name: string, text: string) => void} step announces each slow step
 * @returns {Promise<{plants: object, countries: object[]}>} the pushdown
 *   source over the plants, and one GeoJSON Feature per country
 */
async function startDuckDB(step) {
    step('starting DuckDB-WASM', 'Starting DuckDB-WASM…');
    const duckdb = await import('https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm');
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const worker = await duckdb.createWorker(bundle.mainWorker);
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const connection = await db.connect();
    step('loading the spatial extension', 'Loading the spatial extension…');
    await connection.query('INSTALL spatial; LOAD spatial;');

    // Whole-file fetches handed to DuckDB as buffers (some static hosts serve
    // .parquet gzip-encoded, which breaks HTTP range reads; 2 MB in total).
    const register = async (name) => {
        const res = await fetch(new URL('./data/' + name, location.href));
        if (!res.ok) throw new Error(name + ': HTTP ' + res.status);
        await db.registerFileBuffer(name, new Uint8Array(await res.arrayBuffer()));
    };
    step('reading the power plants', 'Reading 34,936 power plants (1.9 MB) and the country outlines…');
    await Promise.all([register('power-plants.parquet'), register('countries.parquet')]);

    // `aggregates: { default: 'engine' }` lets source.aggregate() (KPIs,
    // capacity per country) and the binding's viewport questions run in SQL.
    const plants = LatticeGrid.createPushdownSource({
        adapter: LatticeGrid.duckdbAdapter({ connection, from: "read_parquet('power-plants.parquet')", spatial: true }),
        compute: LatticeGrid, pageSize: 200, aggregates: { default: 'engine' },
    });

    const res = await connection.query(
        "SELECT iso_a3, name, ST_AsGeoJSON(geometry) AS g FROM read_parquet('countries.parquet')");
    const countries = res.toArray().map((r) => ({
        type: 'Feature', geometry: JSON.parse(r.g), properties: { iso: r.iso_a3, name: r.name },
    }));
    return { plants, countries };
}
