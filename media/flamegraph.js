//@ts-check

const vscode = acquireVsCodeApi();


function hslToHex(h, s, l) {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');   // convert to Hex and prefix "0" if needed
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}


var hash = function (text) {
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
        hash = text.charCodeAt(i) + ((hash << 5) - hash);
    }
    return hash;
};

var stringToColour = function (text, highlight = false) {
    var i = text.indexOf(' ');
    if (i === -1) {
        var sat = hash(text) % 20;
        var hue;
        switch (text.charAt(0)) {
            case 'P':
                hue = 120;
                break;
            case 'T':
                hue = 240;
                break;
            default:
                hue = 0;
        }
        return hslToHex(hue, 50 + sat, highlight ? 90 : 70);
    }

    var scope = text.slice(0, i);
    var module = text.slice(i + 1);
    let h = hash(module) % 360;
    let s = hash(scope) % 10;

    return hslToHex(h >= 0 ? h : -h, 60 + s, highlight ? 90 : 70);
};

function isEmpty(obj) {
    return obj && Object.keys(obj).length === 0 && obj.constructor === Object;
}


function flameGraph(data) {
    if (!data || isEmpty(data)) {
        return;
    }

    var flameGraph = flamegraph()
        .width(document.getElementById('chart').offsetWidth)
        .transitionDuration(250)
        .minFrameSize(0)
        .transitionEase(d3.easeCubic)
        .inverted(true);

    flameGraph.setWidth = function (width) {
        flameGraph.width(width);
        d3.select("#chart svg").style("width", width);
        flameGraph.resetZoom();
    };

    flameGraph.setColorMapper(function (d, originalColor) {
        if (!isNaN(+d.data.name)) {
            return '#808080';
        }
        // return stringToColour(d.data.name, d.highlight);
        return d.highlight ? "#F620F6" : stringToColour(d.data.name);
    });

    flameGraph.onClick(function (d) {
        vscode.postMessage(d.data.data);
    });

    d3.select("#chart")
        .datum(data)
        .call(flameGraph);

    window.addEventListener('resize', () => { flameGraph.setWidth(document.getElementById('chart').offsetWidth); });

    return flameGraph;
}


const graph = flameGraph(vscode.getState());


window.addEventListener('message', event => {
    if (event.data.search) {
        graph.search(event.data.search);
        return;
    }
    if (event.data === "reset") {
        graph.resetZoom();
        graph.clear();
        return;
    }
    flameGraph(event.data);
    vscode.setState(event.data);
});

document.addEventListener('keydown', (event) => {
    var name = event.key;
    var code = event.code;
    // Alert the key name and key code on keydown
    vscode.postMessage({ "event": "keydown", "name": name });
}, false);