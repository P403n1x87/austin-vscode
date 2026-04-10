// The canonical hashPath implementation lives in media/flamegraph-utils.js, which is
// the UMD module loaded by the flamegraph webview. Re-exporting it here means the
// extension host and the webview always use the same function — no duplication to
// keep in sync. The path resolves identically from both src/utils/ and out/utils/.
const { hashPath } = require('../../media/flamegraph-utils.js') as {
    hashPath: (text: string, seed?: number) => number;
};
export { hashPath };
