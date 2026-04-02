import * as assert from 'assert';
import { generateInteractiveSVG } from '../../flamegraph-svg';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const simpleHierarchy = {
    key: 'root',
    name: 'root',
    value: 1000,
    children: [
        { key: 'a', name: 'func_a', value: 600, children: [], data: { name: 'func_a', file: '/app/module_a.py' } },
        { key: 'b', name: 'func_b', value: 400, children: [], data: { name: 'func_b', file: '/app/module_b.py' } },
    ],
    data: {},
};

// tiny_func occupies 1/100 of width = 12 px at INIT_W=1200, below LABEL_MIN_W=30
const hierWithNarrowFrame = {
    key: 'root',
    name: 'root',
    value: 100,
    children: [
        { key: 'big',  name: 'big_func',  value: 99, children: [], data: { name: 'big_func',  file: 'a.py' } },
        { key: 'tiny', name: 'tiny_func', value: 1,  children: [], data: { name: 'tiny_func', file: 'b.py' } },
    ],
    data: {},
};

// Helper: decode the base64 data blob embedded in the SVG
function decodeEmbeddedData(svg: string): { hierarchy: any; mode: string } {
    const match = svg.match(/id="fg-data">([A-Za-z0-9+/=]+)</);
    assert.ok(match, 'fg-data element not found in SVG');
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

// Helper: count occurrences of a substring
function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

// ── Structure ─────────────────────────────────────────────────────────────────

suite('generateInteractiveSVG — structure', () => {
    test('returns a string', () => {
        assert.strictEqual(typeof generateInteractiveSVG(simpleHierarchy, 'cpu'), 'string');
    });

    test('output starts with <svg', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        assert.ok(svg.trimStart().startsWith('<svg'), 'expected SVG root element');
    });

    test('contains header, frames group, and footer elements', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        assert.ok(svg.includes('id="frames-group"'), 'missing frames-group');
        assert.ok(svg.includes('id="footer-bg"'),    'missing footer-bg');
        assert.ok(svg.includes('id="footer-text"'),  'missing footer-text');
        assert.ok(svg.includes('id="reset-btn"'),    'missing reset-btn');
        assert.ok(svg.includes('id="fo-search"'),    'missing search foreignObject');
    });

    test('contains an embedded interactive script', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        assert.ok(svg.includes('<script><![CDATA['), 'missing CDATA script block');
        assert.ok(svg.includes(']]></script>'),      'missing CDATA closing');
    });

    test('embedded script contains key runtime functions', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        for (const fn of ['doLayout', 'colorFor', 'render', 'applySearch', 'findAncestors']) {
            assert.ok(svg.includes(`function ${fn}`), `missing function ${fn}`);
        }
    });
});

// ── Frames ────────────────────────────────────────────────────────────────────

suite('generateInteractiveSVG — frames', () => {
    test('generates a frame element for every node in the hierarchy', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        // root + 2 children = 3 frames
        const frameCount = countOccurrences(svg, 'class="frame"');
        assert.strictEqual(frameCount, 3);
    });

    test('each frame has a rect, text, and title child', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        assert.strictEqual(countOccurrences(svg, 'class="frame"'), countOccurrences(svg, '<title>'));
        assert.ok(countOccurrences(svg, '<rect id="r') >= 3, 'expected rect per frame');
        assert.ok(countOccurrences(svg, '<text id="t') >= 3, 'expected text per frame');
    });

    test('each frame has a matching clip path', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        assert.strictEqual(
            countOccurrences(svg, '<clipPath id="c'),
            countOccurrences(svg, 'class="frame"'),
            'clip path count should match frame count'
        );
    });

    test('frame title contains function name and formatted metric', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        assert.ok(svg.includes('func_a'), 'expected func_a in output');
        assert.ok(svg.includes('func_b'), 'expected func_b in output');
    });

    test('frame title escapes XML special characters', () => {
        const evil = {
            key: 'root', name: '<root>', value: 100, children: [], data: { name: '<root>', file: 'a.py' },
        };
        const svg = generateInteractiveSVG(evil, 'cpu');
        assert.ok(!svg.includes('<<root>>'),       'raw angle brackets must be escaped');
        assert.ok(svg.includes('&lt;root&gt;'), 'expected escaped form');
    });
});

// ── Text visibility ───────────────────────────────────────────────────────────

suite('generateInteractiveSVG — text visibility', () => {
    test('wide frames do not suppress their label', () => {
        // big_func is 99% of width = ~1188 px > LABEL_MIN_W (30)
        const svg = generateInteractiveSVG(hierWithNarrowFrame, 'cpu');
        // Find the text element for big_func — its id is "t" + the _id of big_func.
        // We can verify no text for big_func carries display="none" while having big_func content.
        const textBlocks = svg.match(/<text id="t\d+"[^>]*>big_func[^<]*/g) || [];
        assert.ok(textBlocks.length > 0, 'expected at least one text block for big_func');
        for (const block of textBlocks) {
            assert.ok(!block.includes('display="none"'), `wide frame label should be visible: ${block}`);
        }
    });

    test('narrow frames suppress their label with display="none"', () => {
        // tiny_func is 1% of 1200 px = 12 px < LABEL_MIN_W (30)
        const svg = generateInteractiveSVG(hierWithNarrowFrame, 'cpu');
        const textBlocks = svg.match(/<text id="t\d+"[^>]*>tiny_func[^<]*/g) || [];
        assert.ok(textBlocks.length > 0, 'expected at least one text block for tiny_func');
        for (const block of textBlocks) {
            assert.ok(block.includes('display="none"'), `narrow frame label should be hidden: ${block}`);
        }
    });
});

// ── Embedded data ─────────────────────────────────────────────────────────────

suite('generateInteractiveSVG — embedded data', () => {
    test('fg-data element contains valid base64-encoded JSON', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        assert.doesNotThrow(() => decodeEmbeddedData(svg), 'data blob must decode to valid JSON');
    });

    test('embedded data preserves the hierarchy structure', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        const { hierarchy } = decodeEmbeddedData(svg);
        assert.strictEqual(hierarchy.name, 'root');
        assert.strictEqual(hierarchy.value, 1000);
        assert.strictEqual(hierarchy.children.length, 2);
    });

    test('embedded data carries the correct mode', () => {
        for (const mode of ['cpu', 'wall', 'memory']) {
            const svg = generateInteractiveSVG(simpleHierarchy, mode);
            const { mode: embeddedMode } = decodeEmbeddedData(svg);
            assert.strictEqual(embeddedMode, mode);
        }
    });

    test('all nodes in embedded data have a stable _id', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        const { hierarchy } = decodeEmbeddedData(svg);
        function checkIds(node: any): void {
            assert.ok(typeof node._id === 'number', `node "${node.name}" missing _id`);
            if (node.children) { node.children.forEach(checkIds); }
        }
        checkIds(hierarchy);
    });

    test('_id values are unique across all nodes', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        const { hierarchy } = decodeEmbeddedData(svg);
        const ids: number[] = [];
        function collect(node: any): void {
            ids.push(node._id);
            if (node.children) { node.children.forEach(collect); }
        }
        collect(hierarchy);
        assert.strictEqual(new Set(ids).size, ids.length, '_id values must be unique');
    });
});

// ── Mode-specific output ──────────────────────────────────────────────────────

suite('generateInteractiveSVG — modes', () => {
    test('cpu mode contains "CPU Time Profile" label', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        assert.ok(svg.includes('CPU Time Profile'), 'missing CPU label');
    });

    test('wall mode contains "Wall Time Profile" label', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'wall');
        assert.ok(svg.includes('Wall Time Profile'), 'missing wall label');
    });

    test('memory mode contains "Memory Allocations Profile" label', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'memory');
        assert.ok(svg.includes('Memory Allocations Profile'), 'missing memory label');
    });

    test('different modes produce different background colors', () => {
        const cpuSvg    = generateInteractiveSVG(simpleHierarchy, 'cpu');
        const wallSvg   = generateInteractiveSVG(simpleHierarchy, 'wall');
        const memorySvg = generateInteractiveSVG(simpleHierarchy, 'memory');
        // Extract the background style value and confirm they differ
        const bg = (svg: string) => svg.match(/background:([^;]+);/)?.[1];
        assert.notStrictEqual(bg(cpuSvg),    bg(wallSvg),   'cpu and wall should have different backgrounds');
        assert.notStrictEqual(bg(cpuSvg),    bg(memorySvg), 'cpu and memory should have different backgrounds');
        assert.notStrictEqual(bg(wallSvg),   bg(memorySvg), 'wall and memory should have different backgrounds');
    });
});

// ── Logo embedding ────────────────────────────────────────────────────────────

suite('generateInteractiveSVG — logo', () => {
    test('no logo element when logoB64 is omitted', () => {
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu');
        assert.ok(!svg.includes('<image '), 'unexpected <image> element without logo');
    });

    test('includes <image> element when logoB64 is provided', () => {
        const fakeB64 = Buffer.from('<svg/>').toString('base64');
        const svg = generateInteractiveSVG(simpleHierarchy, 'cpu', fakeB64);
        assert.ok(svg.includes('<image '), 'expected <image> element with logo');
        assert.ok(svg.includes('data:image/svg+xml;base64,'), 'expected data URI for logo');
        assert.ok(svg.includes(fakeB64), 'expected encoded logo data in output');
    });

    test('mode label is shifted right when logo is present', () => {
        const fakeB64 = Buffer.from('<svg/>').toString('base64');
        const svgWith    = generateInteractiveSVG(simpleHierarchy, 'cpu', fakeB64);
        const svgWithout = generateInteractiveSVG(simpleHierarchy, 'cpu');
        // Match the opening tag of the text element that contains the mode label
        const labelTag = (svg: string) => svg.match(/<text [^>]*>CPU Time Profile/)?.[0] ?? '';
        assert.ok(labelTag(svgWith).includes('x="32"'),  'label x should be 32 with logo');
        assert.ok(labelTag(svgWithout).includes('x="8"'), 'label x should be 8 without logo');
    });
});
