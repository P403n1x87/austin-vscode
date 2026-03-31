// @ts-check

// @ts-ignore
const vscode = acquireVsCodeApi();

const d3 = /** @type {any} */ (window).d3;
const flamegraph = /** @type {any} */ (window).flamegraph;

/**
 * @param {number} h
 * @param {number} s
 * @param {number} l
 */
function hslToHex(h, s, l) {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    /** @param {number} n */
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');   // convert to Hex and prefix "0" if needed
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}


/** @param {string} text */
var hash = function (text) {
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
        hash = text.charCodeAt(i) + ((hash << 5) - hash);
    }
    return hash;
};

/** @param {any} data */
var stringToColour = function (data) {
    let name = data.name;
    let scope = data.data.name;
    let module = data.data.file;

    if (!module) {
        return hslToHex(0, 10, 70);
    }

    if (!scope) {
        scope = name;
    }

    var sat = hash(scope) % 20;
    var hue;
    switch (scope.charAt(0)) {
        case 'P':
            hue = 120;
            break;
        case 'T':
            hue = 240;
            break;
        default:
            let h = hash(module) % 360;
            let s = hash(scope) % 10;
            let isPy = module.endsWith(".py");
            return hslToHex(h >= 0 ? h : -h, (isPy ? 60 : 20) + s, 60);
    }

    return hslToHex(hue, 0 + sat, 70);
};

/** @param {any} obj */
function isEmpty(obj) {
    return obj && Object.keys(obj).length === 0 && obj.constructor === Object;
}

/** @param {string} text */
function esc(text) {
    return text.replace("<", "&lt;").replace(">", "&gt;");
}

/**
 * @param {any} d
 * @param {any} parent
 */
function timeLabel(d, parent) {
    return (
        esc(d.data.name) + " 🕘 " + d.data.value.toString() +
        " μs (" + (d.data.value / parent.data.value * 100).toFixed(2) + "%)" +
        (d.data.data.file ? " in " + d.data.data.file : "")
    );
}


/**
 * @param {any} node
 * @param {string} parentKey
 */
function addPathKeys(node, parentKey) {
    var myKey = parentKey ? parentKey + '/' + node.name : node.name;
    if (node.data) { node.data.pathKey = myKey; }
    if (node.children) {
        for (var i = 0; i < node.children.length; i++) {
            addPathKeys(node.children[i], myKey);
        }
    }
}


/** @param {any} data */
function flameGraph(data) {
    if (!data || isEmpty(data)) {
        return;
    }

    // Add path keys to every node's data before D3 processes it
    if (data.children) {
        for (var i = 0; i < data.children.length; i++) {
            addPathKeys(data.children[i], '');
        }
    }

    var fg = flamegraph()
        .width(/** @type {HTMLElement} */ (document.getElementById('chart')).clientWidth)
        .transitionDuration(250)
        .minFrameSize(0)
        .transitionEase(d3.easeCubic)
        .inverted(true)
        .cellHeight(24)
        .label(function (/** @type {any} */ d) {
            var parent = d;
            try {
                while (parent.parent.parent) {
                    parent = parent.parent;
                }
            }
            catch (err) {
                // parent.parent is undefined
            }
            return timeLabel(d, parent);
        });

    fg.setWidth = function (/** @type {number} */ width) {
        fg.width(width);
        d3.select("#chart svg").style("width", width);
        if (zoomedNode) {
            fg.zoomTo(zoomedNode);
        } else {
            fg.resetZoom();
        }
    };

    fg.setColorMapper(function (/** @type {any} */ d) {
        if (!isNaN(+d.data.name)) {
            return '#808080';
        }
        return d.highlight ? "#F620F6" : stringToColour(d.data);
    });

    fg.setDetailsElement(document.getElementById("footer"));

    fg.onClick(function (/** @type {any} */ d) {
        zoomedNode = d;
        vscode.postMessage(d.data.data);
    });

    fg.setSearchMatch(function (/** @type {any} */ d, /** @type {any} */ term) {
        if (searchMode === 'path') {
            return !!(d.data.data && d.data.data.pathKey === term);
        }
        return d.data.name.indexOf(term) !== -1 || (d.data.data.file && d.data.data.file.indexOf(term) !== -1);
    });

    d3.select("#chart")
        .datum(data)
        .call(fg);

    window.addEventListener('resize', () => { fg.setWidth(/** @type {HTMLElement} */ (document.getElementById('chart')).clientWidth); });

    fg.setWidth(/** @type {HTMLElement} */ (document.getElementById('chart')).clientWidth);

    return fg;
}


/** @param {any} meta */
function setMetadata(meta) {
    if (!meta || isEmpty(meta)) {
        return;
    }

    const modeSpan = /** @type {HTMLElement} */ (document.getElementById("mode"));
    const header = /** @type {HTMLElement} */ (document.getElementById("header"));
    let mode;
    switch (meta.mode) {
        case "cpu":
            mode = "CPU Time Profile";
            document.body.style.backgroundColor = "rgba(127, 0, 0, .15)";
            header.style.backgroundColor = "rgba(192, 64, 64, .8)";
            break;
        case "wall":
            mode = "Wall Time Profile";
            document.body.style.backgroundColor = "rgba(127, 127, 0, .15)";
            header.style.backgroundColor = "rgba(192, 192, 64, .8)";
            break;
        case "memory":
            mode = "Memory Allocations Profile";
            document.body.style.backgroundColor = "rgba(0, 127, 0, .15)";
            header.style.backgroundColor = "rgba(64, 192, 64, .8)";
            break;

        default:
            mode = "[unsupported profile mode]";
    }
    modeSpan.innerHTML = mode;
}


var searchMode = 'text'; // 'text' | 'path'
/** @type {any} */ var zoomedNode = null;

const state = vscode.getState();
if (state) {
    setMetadata(state.meta);
    var graph = flameGraph(state.hierarchy);
}


window.addEventListener('message', event => {
    if (event.data.focus) {
        var focusKey = event.data.focus;
        searchMode = 'path';
        // Reset first so hidden/removed nodes are restored to the DOM before searching
        graph.resetZoom();
        graph.search(focusKey);
        d3.select('#chart').selectAll('g').each(/** @this {Element} */ function (/** @type {any} */ d) {
            if (d.data.data && d.data.data.pathKey === focusKey) {
                zoomedNode = d;
                graph.zoomTo(d);
                // Scroll the frame to the centre of the visible area after the transition
                var gEl = this;
                setTimeout(function () {
                    var rectEl = gEl.querySelector('rect');
                    if (!rectEl) { return; }
                    var headerEl = document.getElementById('header');
                    var headerHeight = headerEl ? headerEl.offsetHeight : 0;
                    var bounding = rectEl.getBoundingClientRect();
                    var frameCenter = bounding.top + bounding.height / 2;
                    var visibleCenter = headerHeight + (window.innerHeight - headerHeight) / 2;
                    window.scrollBy({ top: frameCenter - visibleCenter, behavior: 'instant' });
                }, 260);
                return; // d3 each doesn't have break; first match is enough
            }
        });
    } else if (event.data.search) {
        searchMode = 'text';
        graph.search(event.data.search);
    }
    else if (event.data.meta) {
        setMetadata(event.data.meta);
        graph = flameGraph(event.data.hierarchy);

        vscode.setState(event.data);
    }
    else if (event.data === "reset") {
        zoomedNode = null;
        graph.resetZoom();
        graph.clear();
    }
    else {
        graph = flameGraph(event.data);
        vscode.setState(event.data);
    }
});

document.addEventListener('keydown', (event) => {
    vscode.postMessage({ "event": "keydown", "name": event.key });
}, false);

function onOpen() {
    vscode.postMessage("open");
}

(function () {
    var searchBox = /** @type {HTMLInputElement} */ (document.getElementById('search-box'));
    if (!searchBox) { return; }
    searchBox.addEventListener('input', function () {
        if (!graph) { return; }
        searchMode = 'text';
        if (searchBox.value) {
            graph.search(searchBox.value);
        } else {
            graph.clear();
        }
    });
    searchBox.addEventListener('keydown', function (e) {
        e.stopPropagation(); // prevent the global keydown handler from firing
    });
})();

vscode.postMessage("initialized");
