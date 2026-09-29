export interface RouteStore {
  getInstallation(installationId: string): Promise<{ gatewayKeyPub: string; nodeId: string } | null>;
  putInstallation(installationId: string, value: { gatewayKeyPub: string; nodeId: string }): Promise<void>;
  getDevice(deviceId: string): Promise<{ installationId: string; nodeId: string } | null>;
  putDevice(deviceId: string, value: { installationId: string; nodeId: string }): Promise<void>;
  getDeviceKey(deviceId: string): Promise<string | null>;
  putDeviceKey(deviceId: string, longTermPub: string): Promise<void>;
  deleteDeviceKey(deviceId: string): Promise<void>;
  removeDevice(deviceId: string): Promise<void>;
  isRevoked(deviceId: string): Promise<boolean>;
  revoke(deviceId: string): Promise<void>;
  publishCrossNode(installationId: string, message: string): Promise<void>;
  subscribeCrossNode(handler: (installationId: string, message: string) => void): Promise<void>;
}


export function createMemoryStore(nodeId: string): RouteStore & { publishToChannel(installationId: string, message: string): void } {
  const installations = new Map<string, { gatewayKeyPub: string; nodeId: string }>();
  const devices = new Map<string, { installationId: string; nodeId: string }>();
  const deviceKeys = new Map<string, string>();
  const revoked = new Set<string>();
  const subscribers: Array<(installationId: string, message: string) => void> = [];
  return {
    publishToChannel(installationId: string, message: string): void {
      for (const fn of subscribers) fn(installationId, message);
    },
    async getInstallation(id) {
      return installations.get(id) ?? null;
    },
    async putInstallation(id, value) {
      installations.set(id, value);
    },
    async getDevice(id) {
      return devices.get(id) ?? null;
    },
    async putDevice(id, value) {
      devices.set(id, value);
    },
    async getDeviceKey(id) {
      return deviceKeys.get(id) ?? null;
    },
    async putDeviceKey(id, longTermPub) {
      deviceKeys.set(id, longTermPub);
    },
    async deleteDeviceKey(id) {
      deviceKeys.delete(id);
    },
    async removeDevice(id) {
      devices.delete(id);
    },
    async isRevoked(id) {
      return revoked.has(id);
    },
    async revoke(id) {
      revoked.add(id);
      this.publishToChannel("*", JSON.stringify({ kind: "revoke", deviceId: id }));
    },
    async publishCrossNode(installationId, message) {
      this.publishToChannel(installationId, message);
      void nodeId;
    },
    async subscribeCrossNode(handler) {
      subscribers.push(handler);
    },
  };
}
