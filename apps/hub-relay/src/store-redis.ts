// Redis 共享存储适配（DESIGN §1.5：多实例硬依赖；键名见 limits.ts）
import { RespClient } from "./resp.ts";
import type { RouteStore } from "./store-memory.ts";
import { REVOKE_CHANNEL, REVOKE_SET_KEY, ROUTE_KEY_DEVICE, ROUTE_KEY_INSTALLATION, ROUTE_PATTERN_CHANNEL } from "./limits.ts";

interface RouteValue {
  gatewayKeyPub: string;
  nodeId: string;
}

interface DeviceValue {
  installationId: string;
  nodeId: string;
}

export function createRedisStore(spec: { host: string; port: number; password?: string; nodeId: string }): RouteStore {
  const client = new RespClient({ host: spec.host, port: spec.port, password: spec.password });
  const ready = (): Promise<void> => client.ensure();
  return {
    async getInstallation(id) {
      await ready();
      const raw = await client.get(ROUTE_KEY_INSTALLATION + id);
      return raw === null ? null : (JSON.parse(raw) as RouteValue);
    },
    async putInstallation(id, value) {
      await ready();
      await client.set(ROUTE_KEY_INSTALLATION + id, JSON.stringify(value));
    },
    async getDevice(id) {
      await ready();
      const raw = await client.get(ROUTE_KEY_DEVICE + id);
      return raw === null ? null : (JSON.parse(raw) as DeviceValue);
    },
    async putDevice(id, value) {
      await ready();
      await client.set(ROUTE_KEY_DEVICE + id, JSON.stringify(value));
    },
    async removeDevice(id) {
      await ready();
      await client.del(ROUTE_KEY_DEVICE + id);
    },
    async isRevoked(id) {
      await ready();
      return client.sismember(REVOKE_SET_KEY, id);
    },
    async revoke(id) {
      await ready();
      await client.sadd(REVOKE_SET_KEY, id);
      await client.publish(REVOKE_CHANNEL, id);
    },
    async publishCrossNode(installationId, message) {
      await ready();
      // pattern 频道统一承载（订阅侧按 ROUTE_PATTERN_CHANNEL 匹配）
      await client.publish(ROUTE_PATTERN_CHANNEL, JSON.stringify({ toInstallation: installationId, line: message }));
    },
    async subscribeCrossNode(handler) {
      await ready();
      await client.subscribe(REVOKE_CHANNEL, (_channel, deviceId) => handler("*", JSON.stringify({ kind: "revoke", deviceId })));
      // D2：路由频道（route:<installationId>）——跨节点转发消费
      await client.subscribe(ROUTE_PATTERN_CHANNEL, (channel, message) => {
        const installationId = channel.startsWith("xh-relay:route:") ? channel.slice("xh-relay:route:".length) : "";
        handler(installationId, message);
      });
    },
  };
}

export { RespClient };
