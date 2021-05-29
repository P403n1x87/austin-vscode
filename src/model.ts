import * as vscode from 'vscode';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import './stringExtension';
import { isAbsolute } from 'path';


export function absolutePath(path: string) {
    if (!isAbsolute(path)) {
        if (vscode.workspace.workspaceFolders) {
            for (let folder of vscode.workspace.workspaceFolders) {
                let absolutePath = vscode.Uri.joinPath(folder.uri, path).fsPath
                if (existsSync(absolutePath)) {
                    return absolutePath;
                }
            }
        }
    }
    return path;
}


interface FrameObject {
    scope: string;
    lineNumber: number;
    module: string;
};


function parseFrame(frame: string): FrameObject {
    let module: string, scope: string, line: string;
    [module, scope, line] = frame.rsplit(":", 2);

    return { "scope": scope, "lineNumber": Number(line), "module": absolutePath(module) };
}


export function aggregateByLine(file: string, cb: (stats: Map<string, Map<number, [number, number]>>, overallTotal: number) => void) {
    const readInterface = createInterface({
        input: createReadStream(file)
    });

    let stats = new Map<string, Map<number, [number, number]>>();
    let overallTotal = 0;

    readInterface.on("line", (line) => {
        if (line.startsWith('#')) {
            return;
        }

        let frames: string, metrics: string;
        [frames, metrics] = line.rsplit(' ', 1);
        const metric = Number(metrics);  // TODO: Assuming metrics is a single number
        overallTotal += metric;

        let fo: FrameObject | undefined = undefined;
        let frameList: FrameObject[] = frames.split(';').slice(2).map(parseFrame);
        let seenFrames = new Set<string>(); // Prevent inflating times (e.g. recursive functions)
        frameList.forEach((fo) => {
            if (seenFrames.has(`${fo.module}:${fo.lineNumber}`)) {
                return;
            }
            seenFrames.add(`${fo.module}:${fo.lineNumber}`);
            if (!(stats.has(fo.module))) {
                stats.set(fo.module, new Map<number, [number, number]>());
            }
            let module = stats.get(fo.module);
            if (!(module?.has(fo.lineNumber))) {
                module?.set(fo.lineNumber, [0, 0]);
            }
            let own: number, total: number;
            [own, total] = module?.get(fo.lineNumber)!;
            total += metric;
            module?.set(fo.lineNumber, [own, total]);
        });

        // Set own time to the top of the stack
        if (frameList.length > 0) {
            fo = frameList[frameList.length - 1];
            let module = stats.get(fo.module);
            let own: number, total: number;
            [own, total] = module?.get(fo.lineNumber)!;
            own += metric;
            module?.set(fo.lineNumber, [own, total]);
        }
    });

    readInterface.on("close", () => { cb(stats, overallTotal); });
}


interface D3Hierarchy {
    name: string;
    value: number;
    children: D3Hierarchy[];
    data?: any;
}


export function makeHierarchy(file: string, lines: boolean, cb: (stats: D3Hierarchy) => void) {
    const readInterface = createInterface({
        input: createReadStream(file)
    });

    let stats: D3Hierarchy = {
        "name": file,
        "value": 0,
        "children": [],
        "data": "root",
    };

    readInterface.on("line", (line) => {
        if (line.startsWith('#')) {
            return;
        }

        let frames: string, metrics: string;
        [frames, metrics] = line.rsplit(' ', 1);
        const metric = Number(metrics);  // TODO: Assuming metrics is a single number

        let fo: FrameObject | undefined = undefined;
        let frameList: FrameObject[] = frames.split(';').map(parseFrame);
        stats.value += metric;

        let updateContainer = (container: D3Hierarchy[], frame: FrameObject, keyFactory: (frame: FrameObject) => string, newDataFactory: (frame: FrameObject) => any) => {
            const name: string = keyFactory(frame);
            for (let e of container) {
                if (e.name === name) {
                    e.value += metric;
                    return e.children;
                }
            }
            const newContainer: D3Hierarchy[] = [];
            container.push({
                "name": name,
                "value": metric,
                children: newContainer,
                "data": newDataFactory(frame),
            });
            return newContainer;
        };

        let container = stats.children;
        frameList.forEach((fo) => {
            if (lines) {
                container = updateContainer(
                    container,
                    fo,
                    (fo) => { return fo.lineNumber ? `${fo.scope} (${fo.module})` : fo.scope; },
                    (fo) => { return { "file": fo.module, "source": file }; }
                );
                if (fo.lineNumber) {
                    container = updateContainer(
                        container,
                        fo,
                        (fo) => { return `${fo.lineNumber}`; },
                        (fo) => { return { "file": fo.module, "line": fo.lineNumber, "source": file }; }
                    );
                };
            }
            else {
                container = updateContainer(
                    container,
                    fo,
                    (fo) => { return fo.module && fo.lineNumber ? `${fo.scope} (${fo.module})` : fo.scope; },
                    (fo) => { return { "file": fo.module, "line": fo.lineNumber, "source": file }; }
                );
            }
        });

    });

    readInterface.on("close", () => { cb(stats); });
}
