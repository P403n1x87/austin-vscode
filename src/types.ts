export const enum AustinMode {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    WallTime = "Wall time",
    // eslint-disable-next-line @typescript-eslint/naming-convention
    CpuTime = "CPU time",
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Memory = "Memory"
}

export const enum AustinLineStats {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    PERCENT = "Percent",
    // eslint-disable-next-line @typescript-eslint/naming-convention
    ABSOLUTE = "Absolute",
    // eslint-disable-next-line @typescript-eslint/naming-convention
    BOTH = "Both"
}

export class AustinSettings {
    path: string = "austin";
    mode: AustinMode = AustinMode.CpuTime;
    interval: number = 100;
    binaryMode: boolean = false;
    lineStats: AustinLineStats = AustinLineStats.PERCENT;
}
