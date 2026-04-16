export const enum AustinMode {
    WallTime = "Wall time",
    CpuTime = "CPU time",
    Memory = "Memory"
}

export const enum AustinLineStats {
    PERCENT = "Percent",
    ABSOLUTE = "Absolute",
    BOTH = "Both"
}

export class AustinSettings {
    path: string = "austin";
    mode: AustinMode = AustinMode.CpuTime;
    interval: number = 100;
    lineStats: AustinLineStats = AustinLineStats.PERCENT;
    children: boolean = false;
    gc: boolean = false;
    topRows: number = 50;
}
