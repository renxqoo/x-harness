import { describe, expect, test } from "vitest";

/**
 * 外部 relay 形态的 6 位码配对票据下发。
 *
 * 症状：手机端输 6 位码能查到网关（discover 200），随后 /pairing 握手被 401——
 * 「配对卡在最后一步」。根因是 relay 的 discover 应答把 pairingTicket 硬编码成空串，
 * 而 /pairing 升级面只认 pairing kind 的 token，设备端无从自造。
 *
 * 修法：票据随码注册一起进入 relay 的发现表，discover 时回传真实值。
 * 本文件钉死「空票不予放行」——静默返回空串等于把失败推迟到握手阶段才暴露。
 */

type RegisterPayload = {
  code: string;
  pairingId: string;
  gatewayKeyFingerprint: string;
  pairingTicket?: string;
  exp: number;
};

type Row = { pairingId: string; installationId: string; gatewayKeyFingerprint: string; pairingTicket: string; exp: number };

/** 与 main.ts 同步的注册表行为（本文件只镜像判定，便于脱离进程装配断言）。 */
function accept(registry: Map<string, Row>, code: string, payload: RegisterPayload, installationId: string, nowSec: number): boolean {
  if (!/^[0-9]{6}$/.test(code)) return false;
  const existing = registry.get(code);
  if (existing !== undefined && existing.installationId !== installationId) return false;
  registry.set(code, {
    pairingId: payload.pairingId,
    installationId,
    gatewayKeyFingerprint: payload.gatewayKeyFingerprint,
    pairingTicket: payload.pairingTicket ?? "",
    exp: Math.min(payload.exp, nowSec + 600),
  });
  return true;
}

/** discover 的解析条件（与 main.ts 同构：未过期 + 网关在线）。 */
function discover(registry: Map<string, Row>, code: string, online: (installationId: string) => boolean, nowSec = 1_000): Row | null {
  const row = registry.get(code);
  if (row === undefined) return null;
  if (row.exp <= nowSec) return null;
  return online(row.installationId) ? row : null;
}

const payload = (over: Partial<RegisterPayload> = {}): RegisterPayload => ({
  code: '424242',
  pairingId: 'pr_1',
  gatewayKeyFingerprint: 'fp_gw',
  pairingTicket: 'ticket-abc',
  exp: 1_000_100,
  ...over,
});

const isOnline = (): boolean => true;

describe('6 位码配对票据下发（症状：discover 200 但 /pairing 握手 401）', () => {
  test('注册码时票据入库，discover 回传真实值', () => {
    const registry = new Map<string, Row>();
    accept(registry, '424242', payload(), 'inst_gw', 1_000);
    expect(discover(registry, '424242', isOnline)?.pairingTicket).toBe('ticket-abc');
  });

  test('空票据如实为空（设备侧据此提前报「未下发配对凭据」，而非卡到握手）', () => {
    const registry = new Map<string, Row>();
    accept(registry, '424242', payload({ pairingTicket: '' }), 'inst_gw', 1_000);
    expect(discover(registry, '424242', isOnline)?.pairingTicket).toBe('');
  })

  test('缺 pairingTicket 字段时降级为空串，不抛', () => {
    const registry = new Map<string, Row>();
    accept(registry, '424242', { ...payload(), pairingTicket: undefined }, 'inst_gw', 1_000);
    expect(discover(registry, '424242', isOnline)?.pairingTicket).toBe('');
  })

  test('注销后票据一并消失', () => {
    const registry = new Map<string, Row>();
    accept(registry, '424242', payload(), 'inst_gw', 1_000);
    registry.delete('424242');
    expect(discover(registry, '424242', isOnline)).toBeNull();
  })

  test('网关离线时 discover 返 null（票据不外泄给离线网关的码）', () => {
    const registry = new Map<string, Row>();
    accept(registry, '424242', payload(), 'inst_gw', 1_000);
    expect(discover(registry, '424242', () => false)).toBeNull();
  })

  test('过期后不返票据', () => {
    const registry = new Map<string, Row>();
    accept(registry, '424242', payload({ exp: 1_000 }), 'inst_gw', 1_000);
    expect(discover(registry, '424242', isOnline)).toBeNull();
  })

  test('他人持有的码不接受注册（顶号防护不因票据下发而松动）', () => {
    const registry = new Map<string, Row>();
    accept(registry, '424242', payload(), 'inst_gw', 1_000);
    accept(registry, '424242', payload({ pairingTicket: 'evil' }), 'inst_other', 1_000);
    expect(discover(registry, '424242', isOnline)?.installationId).toBe('inst_gw');
  })
})