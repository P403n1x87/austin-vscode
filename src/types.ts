export const enum AustinMode {
    WallTime = "Wall time",
    CpuTime = "CPU time"
}

export class AustinSettings { 
    path: string = "austin";
    mode: AustinMode = AustinMode.CpuTime;
    interval: number = 100;
}