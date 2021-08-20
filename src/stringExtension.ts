export { };


declare global {
    interface String {
        rsplit(sep: string, maxsplit: number): string[];
    }
}


String.prototype.rsplit = function (sep: string, maxsplit: number): string[] {
    var split = this.split(sep);
    return maxsplit ? [split.slice(0, -maxsplit).join(sep)].concat(split.slice(-maxsplit)) : split;
};
