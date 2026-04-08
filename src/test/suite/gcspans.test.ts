import * as assert from 'assert';
import { AustinStats } from '../../model';
import { computeGCSpans, GC_MIN_FRACTION } from '../../providers/flamegraph';
import '../../stringExtension';
import '../../mapExtension';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an AustinStats with a sequence of (gc, metric, frames?) events on
 *  a single thread (pid=1, tid='T1') unless overridden. */
function makeStats(
    events: Array<{ gc: boolean; metric: number; frames?: Array<{ module: string; scope: string; line?: number }>; tid?: string }>,
    pid = 1,
): AustinStats {
    const stats = new AustinStats();
    for (const ev of events) {
        const frames = (ev.frames ?? []).map(f => ({ module: f.module, scope: f.scope, line: f.line ?? 1 }));
        stats.update(pid, ev.tid ?? 'T1', frames, ev.metric, ev.gc);
    }
    return stats;
}


// ---------------------------------------------------------------------------
// computeGCSpans — basic span building
// ---------------------------------------------------------------------------
suite('computeGCSpans — basic span building', () => {

    test('returns empty array when there are no events', () => {
        const stats = new AustinStats();
        assert.deepStrictEqual(computeGCSpans(stats), []);
    });

    test('returns empty array when no events have gc=true', () => {
        const stats = makeStats([
            { gc: false, metric: 100 },
            { gc: false, metric: 200 },
        ]);
        assert.deepStrictEqual(computeGCSpans(stats), []);
    });

    test('produces one thread entry for a single gc span', () => {
        const stats = makeStats([
            { gc: false, metric: 100 },
            { gc: true,  metric: 100 },
            { gc: false, metric: 100 },
        ]);
        const result = computeGCSpans(stats);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].threadKey, '1:T1');
        assert.strictEqual(result[0].label, 'P1 TT1');
        assert.strictEqual(result[0].spans.length, 1);
    });

    test('merges contiguous gc=true events into a single span', () => {
        const stats = makeStats([
            { gc: false, metric: 100 },
            { gc: true,  metric: 50 },
            { gc: true,  metric: 50 },
            { gc: false, metric: 100 },
        ]);
        const result = computeGCSpans(stats);
        assert.strictEqual(result[0].spans.length, 1);
        assert.strictEqual(result[0].spans[0].durationFraction, 100 / 300);
    });

    test('produces separate spans for non-contiguous gc runs', () => {
        const stats = makeStats([
            { gc: true,  metric: 100 },
            { gc: false, metric: 100 },
            { gc: true,  metric: 100 },
        ]);
        const result = computeGCSpans(stats);
        assert.strictEqual(result[0].spans.length, 2);
    });

    test('a gc span at the very end of the stream is captured', () => {
        const stats = makeStats([
            { gc: false, metric: 100 },
            { gc: true,  metric: 100 },
        ]);
        const result = computeGCSpans(stats);
        assert.strictEqual(result[0].spans.length, 1);
    });
});


// ---------------------------------------------------------------------------
// computeGCSpans — span fractions
// ---------------------------------------------------------------------------
suite('computeGCSpans — span fractions', () => {

    test('startFraction is correct for a mid-stream span', () => {
        // 200 non-gc, 100 gc → startFraction = 200/300
        const stats = makeStats([
            { gc: false, metric: 200 },
            { gc: true,  metric: 100 },
        ]);
        const span = computeGCSpans(stats)[0].spans[0];
        assert.ok(Math.abs(span.startFraction - 200 / 300) < 1e-9);
    });

    test('durationFraction is correct', () => {
        const stats = makeStats([
            { gc: false, metric: 100 },
            { gc: true,  metric: 50 },
            { gc: false, metric: 50 },
        ]);
        const span = computeGCSpans(stats)[0].spans[0];
        assert.ok(Math.abs(span.durationFraction - 50 / 200) < 1e-9);
    });

    test('durationPct is the pre-formatted percentage string', () => {
        const stats = makeStats([
            { gc: false, metric: 500 },
            { gc: true,  metric: 500 },
        ]);
        const span = computeGCSpans(stats)[0].spans[0];
        assert.strictEqual(span.durationPct, '50.0');
    });

    test('startFraction is 0 when gc starts immediately', () => {
        const stats = makeStats([
            { gc: true, metric: 100 },
            { gc: false, metric: 100 },
        ]);
        const span = computeGCSpans(stats)[0].spans[0];
        assert.strictEqual(span.startFraction, 0);
    });
});


// ---------------------------------------------------------------------------
// computeGCSpans — minimum fraction filter
// ---------------------------------------------------------------------------
suite('computeGCSpans — minimum fraction filter', () => {

    test(`drops spans below ${GC_MIN_FRACTION * 100}% of thread total`, () => {
        // total = 100000; span = 99 → fraction = 0.00099 < 0.001
        const stats = makeStats([
            { gc: false, metric: 99901 },
            { gc: true,  metric: 99 },
        ]);
        const result = computeGCSpans(stats);
        assert.deepStrictEqual(result, []);
    });

    test('keeps spans at exactly the minimum fraction', () => {
        // total = 100000; span = 100 → fraction = 0.001 == GC_MIN_FRACTION
        const stats = makeStats([
            { gc: false, metric: 99900 },
            { gc: true,  metric: 100 },
        ]);
        const result = computeGCSpans(stats);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].spans.length, 1);
    });

    test('events with metric <= 0 do not contribute to total', () => {
        const stats = makeStats([
            { gc: false, metric: 0 },
            { gc: true,  metric: 100 },
        ]);
        // totalMetric = 100; span = 100 → fraction = 1.0 — should be kept
        const result = computeGCSpans(stats);
        assert.strictEqual(result.length, 1);
    });
});


// ---------------------------------------------------------------------------
// computeGCSpans — top frame contributors
// ---------------------------------------------------------------------------
suite('computeGCSpans — top frame contributors', () => {

    test('span has no top frames when stack is empty during gc', () => {
        const stats = makeStats([{ gc: true, metric: 100 }]);
        const span = computeGCSpans(stats)[0].spans[0];
        assert.strictEqual(span.topFrames.length, 0);
    });

    test('only the leaf (innermost) frame is attributed', () => {
        const stats = makeStats([{
            gc: true,
            metric: 100,
            frames: [
                { module: '/a.py', scope: 'outer' },
                { module: '/a.py', scope: 'inner' },
            ],
        }]);
        const span = computeGCSpans(stats)[0].spans[0];
        assert.strictEqual(span.topFrames.length, 1);
        assert.strictEqual(span.topFrames[0].scope, 'inner');
    });

    test('top frames are sorted by metric descending', () => {
        const stats = makeStats([
            { gc: true, metric: 100, frames: [{ module: '/a.py', scope: 'rarer' }] },
            { gc: true, metric: 200, frames: [{ module: '/a.py', scope: 'rarer' }, { module: '/b.py', scope: 'common' }] },
            { gc: true, metric: 300, frames: [{ module: '/a.py', scope: 'rarer' }, { module: '/c.py', scope: 'dominant' }] },
        ]);
        const span = computeGCSpans(stats)[0].spans[0];
        assert.strictEqual(span.topFrames[0].scope, 'dominant');
        assert.strictEqual(span.topFrames[1].scope, 'common');
        assert.strictEqual(span.topFrames[2].scope, 'rarer');
    });

    test('at most 3 top frames are returned', () => {
        const frames = ['a', 'b', 'c', 'd'].map(s => ({ module: '/m.py', scope: s }));
        const stats = makeStats(
            frames.map(f => ({ gc: true, metric: 100, frames: [f] }))
        );
        const span = computeGCSpans(stats)[0].spans[0];
        assert.ok(span.topFrames.length <= 3);
    });

    test('leaf-frame fractions sum to at most 100% within a span', () => {
        const stats = makeStats([
            { gc: true, metric: 50, frames: [{ module: '/a.py', scope: 'fn1' }] },
            { gc: true, metric: 30, frames: [{ module: '/b.py', scope: 'fn2' }] },
            { gc: true, metric: 20, frames: [{ module: '/c.py', scope: 'fn3' }] },
        ]);
        const span = computeGCSpans(stats)[0].spans[0];
        const total = span.topFrames.reduce((s, f) => s + f.fraction, 0);
        assert.ok(total <= 1.0 + 1e-9, `fractions summed to ${total}, expected ≤ 1`);
    });
});


// ---------------------------------------------------------------------------
// computeGCSpans — multi-thread
// ---------------------------------------------------------------------------
suite('computeGCSpans — multi-thread', () => {

    test('produces separate entries for separate threads', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 100, true);
        stats.update(1, 'T2', [], 100, true);
        const result = computeGCSpans(stats);
        assert.strictEqual(result.length, 2);
        const keys = result.map(r => r.threadKey).sort();
        assert.deepStrictEqual(keys, ['1:T1', '1:T2']);
    });

    test('span fractions are per-thread, not cross-thread', () => {
        const stats = new AustinStats();
        // T1: 900 non-gc + 100 gc  → fraction = 0.1
        stats.update(1, 'T1', [], 900, false);
        stats.update(1, 'T1', [], 100, true);
        // T2: 100 non-gc + 900 gc  → fraction = 0.9
        stats.update(1, 'T2', [], 100, false);
        stats.update(1, 'T2', [], 900, true);

        const result = computeGCSpans(stats);
        const t1 = result.find(r => r.threadKey === '1:T1')!;
        const t2 = result.find(r => r.threadKey === '1:T2')!;

        assert.ok(Math.abs(t1.spans[0].durationFraction - 0.1) < 1e-9);
        assert.ok(Math.abs(t2.spans[0].durationFraction - 0.9) < 1e-9);
    });

    test('a thread with no gc events does not appear in results', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 100, false);
        stats.update(1, 'T2', [], 100, true);
        const result = computeGCSpans(stats);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].threadKey, '1:T2');
    });

    test('separate process IDs produce separate thread entries', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 100, true);
        stats.update(2, 'T1', [], 100, true);
        const result = computeGCSpans(stats);
        assert.strictEqual(result.length, 2);
        const keys = result.map(r => r.threadKey).sort();
        assert.deepStrictEqual(keys, ['1:T1', '2:T1']);
    });

    test('tid containing colons is preserved in threadKey and label', () => {
        // Some platforms use thread IDs that look like "T1:sub", producing a
        // threadKey of "1:T1:sub".  The label must reconstruct the full tid.
        const stats = new AustinStats();
        stats.update(1, 'T1:sub', [], 100, true);
        const result = computeGCSpans(stats);
        assert.strictEqual(result[0].threadKey, '1:T1:sub');
        assert.strictEqual(result[0].label, 'P1 TT1:sub');
    });
});


// ---------------------------------------------------------------------------
// computeGCSpans — zero-metric event handling
// ---------------------------------------------------------------------------
suite('computeGCSpans — zero-metric event handling', () => {

    test('a thread whose events all have metric <= 0 is omitted', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 0,  true);
        stats.update(1, 'T1', [], -5, true);
        assert.deepStrictEqual(computeGCSpans(stats), []);
    });

    test('gc=true event with metric <= 0 does not start a span', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 0,   true);  // skipped — no span started
        stats.update(1, 'T1', [], 100, false); // non-gc with metric > 0
        // totalMetric = 100, no gc span → no thread entry
        assert.deepStrictEqual(computeGCSpans(stats), []);
    });

    test('gc=true event with metric <= 0 does not extend an active span', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 100, true);  // starts span, duration = 100
        stats.update(1, 'T1', [], 0,   true);  // skipped — duration stays 100
        stats.update(1, 'T1', [], 100, false); // closes span; total = 200
        const span = computeGCSpans(stats)[0].spans[0];
        assert.ok(Math.abs(span.durationFraction - 100 / 200) < 1e-9);
    });

    test('gc=false event with metric <= 0 does not close an active span', () => {
        // The zero-metric event is skipped entirely, so two gc runs separated
        // only by a zero-metric non-gc event are merged into one span.
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 100, true);  // span starts
        stats.update(1, 'T1', [], 0,   false); // skipped — span stays open
        stats.update(1, 'T1', [], 100, true);  // span continues
        stats.update(1, 'T1', [], 100, false); // closes span; total = 300
        const result = computeGCSpans(stats);
        // One span, not two
        assert.strictEqual(result[0].spans.length, 1);
        assert.ok(Math.abs(result[0].spans[0].durationFraction - 200 / 300) < 1e-9);
    });
});


// ---------------------------------------------------------------------------
// computeGCSpans — all spans filtered
// ---------------------------------------------------------------------------
suite('computeGCSpans — all spans filtered out', () => {

    test('thread is omitted when all its spans are below the min fraction', () => {
        // Two tiny gc spans, both < 0.1% of total; thread should not appear.
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 999900, false);
        stats.update(1, 'T1', [], 50,     true);   // 0.005% — below threshold
        stats.update(1, 'T1', [], 999900, false);
        stats.update(1, 'T1', [], 50,     true);   // 0.005% — below threshold
        assert.deepStrictEqual(computeGCSpans(stats), []);
    });

    test('only spans above the threshold are kept; others are dropped', () => {
        const stats = new AustinStats();
        // total ≈ 200100; big span = 100 (0.05% < 0.1%), small span = 100100 (>50%)
        stats.update(1, 'T1', [], 100,   true);   // below threshold
        stats.update(1, 'T1', [], 99900, false);
        stats.update(1, 'T1', [], 100100, true);  // well above threshold
        const result = computeGCSpans(stats);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].spans.length, 1);
        // The surviving span is the large one
        assert.ok(result[0].spans[0].durationFraction > 0.5);
    });
});


// ---------------------------------------------------------------------------
// computeGCSpans — scope/module resolution fallback
// ---------------------------------------------------------------------------
suite('computeGCSpans — scope/module resolution', () => {

    test('resolves scope and module from stats.top when available', () => {
        // makeStats calls stats.update() which populates stats.top
        const stats = makeStats([{
            gc: true,
            metric: 100,
            frames: [{ module: '/app/mod.py', scope: 'my_func' }],
        }]);
        const frame = computeGCSpans(stats)[0].spans[0].topFrames[0];
        assert.strictEqual(frame.scope, 'my_func');
        assert.strictEqual(frame.module, '/app/mod.py');
    });

    test('falls back to splitting frameKey on last colon when not in stats.top', () => {
        // Inject a gcEvent manually with a key that has no corresponding stats.top entry
        const stats = new AustinStats();
        // Push a raw gcEvent that bypasses update() so stats.top stays empty
        (stats.gcEvents as any[]).push({
            pid: 1, tid: 'T1', gc: true, metric: 100,
            frameKeys: ['/some/module.py:some_func'],
        });
        const result = computeGCSpans(stats);
        const frame = result[0].spans[0].topFrames[0];
        assert.strictEqual(frame.scope, 'some_func');
        assert.strictEqual(frame.module, '/some/module.py');
    });

    test('frameKey with no colon falls back to key as scope and empty module', () => {
        const stats = new AustinStats();
        (stats.gcEvents as any[]).push({
            pid: 1, tid: 'T1', gc: true, metric: 100,
            frameKeys: ['no_colon_key'],
        });
        const result = computeGCSpans(stats);
        const frame = result[0].spans[0].topFrames[0];
        assert.strictEqual(frame.scope, 'no_colon_key');
        assert.strictEqual(frame.module, '');
    });
});
