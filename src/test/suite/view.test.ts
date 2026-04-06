import * as assert from 'assert';
import { computeGutterMetrics, formatInterval, formatMemory, formatTime, modeColors, setLinesHeat, statColor } from '../../view';
import { AustinStats, FrameObject } from '../../model';
import '../../stringExtension';
import '../../mapExtension';

suite('formatTime', () => {

    test('formats sub-millisecond values in microseconds', () => {
        assert.strictEqual(formatTime(0), '0μs');
        assert.strictEqual(formatTime(1), '1μs');
        assert.strictEqual(formatTime(999), '999μs');
    });

    test('formats millisecond-range values in ms', () => {
        assert.strictEqual(formatTime(1000), '1.00ms');
        assert.strictEqual(formatTime(1500), '1.50ms');
        assert.strictEqual(formatTime(999999), '1000.00ms');
    });

    test('formats second-range values in s', () => {
        assert.strictEqual(formatTime(1000000), '1.00s');
        assert.strictEqual(formatTime(1500000), '1.50s');
        assert.strictEqual(formatTime(999999999), '1000.00s');
    });

    test('formats very large values in minutes notation', () => {
        // ≥ 1_000_000_000 μs
        assert.strictEqual(formatTime(1000000000), '1.00m');
        assert.strictEqual(formatTime(60000000000), '60.00m');
    });
});

suite('formatMemory', () => {

    test('formats sub-kilobyte values in bytes', () => {
        assert.strictEqual(formatMemory(0), '0B');
        assert.strictEqual(formatMemory(1), '1B');
        assert.strictEqual(formatMemory(1023), '1023B');
    });

    test('formats kilobyte-range values in KB', () => {
        assert.strictEqual(formatMemory(1024), '1.00KB');
        assert.strictEqual(formatMemory(1536), '1.50KB');
        assert.strictEqual(formatMemory(1024 * 1024 - 1), '1024.00KB');
    });

    test('formats megabyte-range values in MB', () => {
        assert.strictEqual(formatMemory(1024 * 1024), '1.00MB');
        assert.strictEqual(formatMemory(1024 * 1024 * 1.5), '1.50MB');
    });

    test('formats gigabyte-range values in GB', () => {
        assert.strictEqual(formatMemory(1024 * 1024 * 1024), '1.00GB');
        assert.strictEqual(formatMemory(1024 * 1024 * 1024 * 2), '2.00GB');
    });
});

suite('formatInterval', () => {

    test('formats sub-millisecond intervals in μs', () => {
        assert.strictEqual(formatInterval(1), '1 μs');
        assert.strictEqual(formatInterval(999), '999 μs');
    });

    test('formats 1000–9999 μs with one decimal in ms', () => {
        assert.strictEqual(formatInterval(1000), '1.0 ms');
        assert.strictEqual(formatInterval(1500), '1.5 ms');
        assert.strictEqual(formatInterval(9999), '10.0 ms');
    });

    test('formats 10000–999999 μs as whole ms', () => {
        assert.strictEqual(formatInterval(10000), '10 ms');
        assert.strictEqual(formatInterval(50000), '50 ms');
        assert.strictEqual(formatInterval(999999), '999 ms');
    });

    test('formats 1_000_000–9_999_999 μs with one decimal in s', () => {
        assert.strictEqual(formatInterval(1000000), '1.0 s');
        assert.strictEqual(formatInterval(2500000), '2.5 s');
    });

    test('formats ≥ 10_000_000 μs as whole seconds', () => {
        assert.strictEqual(formatInterval(10000000), '10 s');
        assert.strictEqual(formatInterval(60000000), '60 s');
    });
});

suite('statColor', () => {

    test('returns red for fraction >= 0.75', () => {
        assert.strictEqual(statColor(0.75), '#e74c3c');
        assert.strictEqual(statColor(1.0), '#e74c3c');
    });

    test('returns orange for fraction >= 0.50', () => {
        assert.strictEqual(statColor(0.50), '#e67e22');
        assert.strictEqual(statColor(0.74), '#e67e22');
    });

    test('returns yellow for fraction >= 0.25', () => {
        assert.strictEqual(statColor(0.25), '#f1c40f');
        assert.strictEqual(statColor(0.49), '#f1c40f');
    });

    test('returns null for fraction < 0.25', () => {
        assert.strictEqual(statColor(0.0), null);
        assert.strictEqual(statColor(0.24), null);
    });
});

suite('modeColors', () => {

    test('returns red palette for cpu mode', () => {
        const c = modeColors('cpu');
        assert.ok(c.bg.includes('127,0,0'));
        assert.ok(c.glow.includes('255,64,64'));
        assert.ok(c.core.includes('255,120,120'));
    });

    test('returns yellow palette for wall mode', () => {
        const c = modeColors('wall');
        assert.ok(c.bg.includes('100,100,0'));
        assert.ok(c.glow.includes('192,192,64'));
        assert.ok(c.core.includes('220,220,120'));
    });

    test('returns green palette for memory mode', () => {
        const c = modeColors('memory');
        assert.ok(c.bg.includes('0,100,0'));
        assert.ok(c.glow.includes('64,192,64'));
        assert.ok(c.core.includes('120,220,120'));
    });

    test('returns fallback palette for unknown mode', () => {
        const c = modeColors('unknown');
        assert.ok(c.bg.includes('70,40,160'));
    });
});

suite('computeGutterMetrics', () => {

    // The mock returns defaultValue for all config.get calls, so
    // fontSize=14 and lineHeight=0 (auto → 1.5× → height=21).

    test('totalWidth equals leftMargin + width + rightMargin', () => {
        const m = computeGutterMetrics(5);
        assert.strictEqual(m.totalWidth, m.leftMargin + m.width + m.rightMargin);
    });

    test('width equals two columns plus divider', () => {
        const m = computeGutterMetrics(5);
        assert.strictEqual(m.width, m.colW * 2 + (m.col2X - m.colW));
    });

    test('col2X is past colW', () => {
        const m = computeGutterMetrics(5);
        assert.ok(m.col2X > m.colW, 'col2X should be past the first column');
    });

    test('col1X clears the neon glow (bars never overlap left border)', () => {
        const m = computeGutterMetrics(5);
        assert.ok(m.col1X > m.glowW, `col1X (${m.col1X}) should exceed glowW (${m.glowW})`);
    });

    test('barY and barCenterY are within the line height', () => {
        const m = computeGutterMetrics(5);
        assert.ok(m.barY >= 0);
        assert.ok(m.barY + m.barH <= m.height);
        assert.ok(m.barCenterY >= m.barY);
        assert.ok(m.barCenterY <= m.barY + m.barH);
    });

    test('wider labels produce a wider gutter', () => {
        const narrow = computeGutterMetrics(4);
        const wide = computeGutterMetrics(12);
        assert.ok(wide.width > narrow.width, 'more label chars should increase width');
    });

    test('labelX1 and labelX2 are past their respective bar tracks', () => {
        const m = computeGutterMetrics(5);
        assert.ok(m.labelX1 > m.col1X + m.barTrackW);
        assert.ok(m.labelX2 > m.col2X + m.barTrackW);
    });
});


// ---------------------------------------------------------------------------
// setLinesHeat — dispose ordering (no-flicker guarantee)
//
// Old behaviour: clearDecorations() (dispose all) → create new decorators
//                Results in a brief flash with no decorations visible.
//
// New behaviour: save old decorators → create new → dispose old
//                New decorations are applied before old ones disappear.
// ---------------------------------------------------------------------------
suite('setLinesHeat — dispose ordering', () => {
    const vscodeWindow = (require('vscode') as { window: Record<string, unknown> }).window;

    let events: string[] = [];
    let typeIdCounter = 0;
    let savedCreateDeco: unknown;
    let savedEditorDescriptor: PropertyDescriptor | undefined;

    const mockRange = { start: {}, end: {} };
    const mockEditor = {
        document: {
            lineCount: 20,
            lineAt: (_i: number) => ({ range: mockRange, text: 'pass' }),
        },
        setDecorations: (_type: { id: string }, _ranges: unknown[]) => {
            events.push(`set:${_type.id}`);
        },
    };

    setup(() => {
        events = [];
        typeIdCounter = 0;
        savedCreateDeco = vscodeWindow.createTextEditorDecorationType;
        savedEditorDescriptor = Object.getOwnPropertyDescriptor(vscodeWindow, 'activeTextEditor');

        vscodeWindow.createTextEditorDecorationType = (_opts: unknown) => {
            const id = String(typeIdCounter++);
            return { id, dispose: () => events.push(`dispose:${id}`) };
        };
        Object.defineProperty(vscodeWindow, 'activeTextEditor', {
            get: () => mockEditor,
            configurable: true,
        });
    });

    teardown(() => {
        vscodeWindow.createTextEditorDecorationType = savedCreateDeco;
        if (savedEditorDescriptor) {
            Object.defineProperty(vscodeWindow, 'activeTextEditor', savedEditorDescriptor);
        }
    });

    function makeStats(): [AustinStats, Map<string, [FrameObject, number, number]>] {
        const frame: FrameObject = { module: '/tmp/test.py', scope: 'foo', line: 5 };
        const stats = new AustinStats();
        stats.begin('/tmp/test.py');
        stats.update(0, '0', [frame], 1000);
        stats.refresh();
        const locations = stats.locationMap.get('/tmp/test.py')!;
        return [stats, locations];
    }

    test('first call creates decorators and nothing is disposed', () => {
        const [stats, locations] = makeStats();
        setLinesHeat(locations, stats);

        assert.ok(events.some(e => e.startsWith('set:')), 'decorators should be applied');
        assert.ok(!events.some(e => e.startsWith('dispose:')), 'nothing to dispose on first call');
    });

    test('second call disposes old decorators after applying new ones', () => {
        const [stats, locations] = makeStats();

        setLinesHeat(locations, stats);
        const firstCallTypeCount = typeIdCounter; // types 0 .. firstCallTypeCount-1

        events = []; // reset — we only care about the second call's ordering
        setLinesHeat(locations, stats);

        const setEvents     = events.filter(e => e.startsWith('set:'));
        const disposeEvents = events.filter(e => e.startsWith('dispose:'));

        assert.ok(setEvents.length > 0, 'second call should create new decorators');
        assert.ok(disposeEvents.length > 0, 'second call should dispose first-call decorators');

        // All disposed IDs should belong to the first call
        for (const ev of disposeEvents) {
            const id = parseInt(ev.slice('dispose:'.length), 10);
            assert.ok(id < firstCallTypeCount, `disposed id ${id} should be from first call`);
        }

        // Every dispose event must come after the last set event in the sequence
        const lastSetIdx     = events.map((e, i) => e.startsWith('set:')     ? i : -1).reduce((a, b) => Math.max(a, b), -1);
        const firstDisposeIdx = events.findIndex(e => e.startsWith('dispose:'));

        assert.ok(firstDisposeIdx > lastSetIdx,
            'all new setDecorations calls must precede disposal of old decorators');
    });
});
