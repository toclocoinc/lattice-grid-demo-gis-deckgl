// The page's loading state: the status line and an overlay over the map and
// table name the current step from the first paint, with the seconds elapsed,
// until the first real rows are in the grid. A step that throws, or a first
// load that has not answered inside the timeout, becomes a plain error line
// naming the step, with a Retry button.
function createLoader({ timeoutMs = 90_000, tickMs = 500 } = {}) {
    const el = (id) => document.getElementById(id);
    const t0 = Date.now();
    let step = { name: 'starting', text: 'Starting…' };
    let timer = null, watcher = null, failed = false;

    const render = (text) => { el('status').textContent = text; el('loading-text').textContent = text; };
    const renderStep = () => {
        if (!failed) render(step.text + ' ' + Math.round((Date.now() - t0) / 1000) + ' s elapsed.');
    };
    const tick = setInterval(renderStep, tickMs);
    const stop = () => { clearTimeout(timer); clearInterval(tick); clearInterval(watcher); };

    const loader = {
        /** Announce a step; `name` is what an error line names. */
        step(name, text) { step = { name, text }; renderStep(); },
        /** Start the clock: `fail()` fires if the rows have not arrived in time. */
        armTimeout() {
            clearTimeout(timer);
            timer = setTimeout(() => loader.fail(new Error('no answer after ' + timeoutMs / 1000 + ' s')), timeoutMs);
        },
        /** Poll `hasRows()`; the first true drops the overlay and stops the clock. */
        waitForRows(hasRows, pollMs = 250) {
            clearInterval(watcher);
            watcher = setInterval(() => { if (!failed && hasRows()) loader.rowsIn(); }, pollMs);
        },
        /** The first rows are visible: overlay, clock and status line all stop. */
        rowsIn() { stop(); el('loading').hidden = true; el('status').textContent = ''; },
        fail(error) {
            if (failed) return;
            failed = true;
            stop();
            console.error('[gis-deckgl] failed at step "' + step.name + '":', error);
            render('Failed while ' + step.name + ': ' + (error && error.message ? error.message : String(error)));
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.textContent = 'Retry';
            retry.addEventListener('click', () => location.reload());
            (el('loading').hidden ? el('status') : el('loading')).append(' ', retry);
        },
    };
    return loader;
}
