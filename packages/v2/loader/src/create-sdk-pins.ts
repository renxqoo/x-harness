export function createSdkPins() {
  const fingerprints = new Map<string, string>();
  return Object.freeze({
    pin(this: void, root: string, fingerprint: string) {
      const existing = fingerprints.get(root);

      if (existing !== undefined) return existing === fingerprint;

      if (fingerprints.size >= 64) return false;

      fingerprints.set(root, fingerprint);
      return true;
    },
  });
}
