export const enum AustinMode {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    WallTime = "Wall time",
    // eslint-disable-next-line @typescript-eslint/naming-convention
    CpuTime = "CPU time"
}

export class AustinSettings {
    path: string = "austin";
    mode: AustinMode = AustinMode.CpuTime;
    interval: number = 100;
    binaryMode: boolean = false;
}
