import { createReadStream, PathLike } from 'fs';

export async function readHead(path: PathLike, n: number): Promise<string> {
    const chunks = [];

    for await (let chunk of createReadStream(path, { start: 0, end: n - 1 })) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString();
}
