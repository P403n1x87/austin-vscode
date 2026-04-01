import * as path from 'path';

export function testDataPath(filename: string): string {
    return path.resolve(process.cwd(), 'src/test/suite/data', filename);
}
