const retainers = new WeakMap<object, (revoke: () => void) => void>();
export { retainers };
