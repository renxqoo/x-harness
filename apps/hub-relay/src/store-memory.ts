// 共享存储接口（DESIGN §1.5）：多实例 = 共享存储硬依赖；--single-instance 用内存实现（本文件）。
export interface RouteStore {
  /** installationId → {gatewayKeyPub（enroll 钉存），nodeId（当前连接节点） */
  getInstallation(installationId: string): Promise<{ gatewayKeyPub: string; nodeId: string } | null>;
  putInstallation(installationId: string, value: { gatewayKeyPub: string; nodeId: string }): Promise<void>;
  /** deviceId → installationId 归属 + 当前连接节点 + 设备长期钥（M12 refresh 验签锚；TOFU 钉存） */
  getDevice(deviceId: string): Promise<{ installationId: string; nodeId: string } | null>;
  putDevice(deviceId: string, value: { installationId: string; nodeId: string }): Promise<void>;
  getDeviceKey(deviceId: string): Promise<string | null>;
  putDeviceKey(deviceId: string, longTermPub: string): Promise<void>;
  deleteDeviceKey(deviceId: string): Promise<void>;
  removeDevice(deviceId: string): Promise<void>;
  /** 撤销名单（deviceId 集合） */
  isRevoked(deviceId: string): Promise<boolean>;
  revoke(deviceId: string): Promise<void>;
  /** 跨节点转发与撤销广播（同节点直投不经此） */
  publishCrossNode(installationId: string, message: string): Promise<void>;
  subscribeCrossNode(handler: (installationId: string, message: string) => void): Promise<void>;
}

// 进程内共享存储（仅 --single-instance 合法；多实例配置下用它启动 = fail-fast 拒绝）

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
      // 撤销即时广播（与 store-redis 同语义——单实例直投本地订阅者）
      this.publishToChannel("*", JSON.stringify({ kind: "revoke", deviceId: id }));
    },
    async publishCrossNode(installationId, message) {
      // 单实例：跨节点广播退化为本地订阅者（同进程直投也走这里，保持单一路径）
      this.publishToChannel(installationId, message);
      void nodeId;
    },
    async subscribeCrossNode(handler) {
      subscribers.push(handler);
    },
  };
}
