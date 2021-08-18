export { };


declare global {
    interface Map<K, V> {
        getDefault(key: K, defaultValue: () => V): V;
    }
}


Map.prototype.getDefault = function <K, V>(key: K, defaultValue: () => V) {
    if (this.has(key)) {
        return this.get(key);
    }
    let value = defaultValue();
    this.set(key, value);
    return value;
};
