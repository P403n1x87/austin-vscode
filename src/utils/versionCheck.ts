import { execFile } from "child_process";


const MIN_MAJOR = 4;

export class AustinVersionError extends Error {
    constructor(public readonly version: string) {
        super(`Unsupported Austin version: ${version}. Please upgrade to ${MIN_MAJOR}.0.0 or newer.`);
    }
}


export function checkAustinVersion(austinPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(austinPath, ["--version"], (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`Failed to run '${austinPath} --version': ${err.message}`));
                return;
            }
            const output = (stdout || stderr).trim();
            const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
            if (!match) {
                reject(new Error(`Could not parse Austin version from: '${output}'`));
                return;
            }
            const major = parseInt(match[1], 10);
            if (major < MIN_MAJOR) {
                reject(new AustinVersionError(match[0]));
                return;
            }
            resolve();
        });
    });
}
