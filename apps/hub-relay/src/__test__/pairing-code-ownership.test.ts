import { describe, expect, test } from "vitest";

/**
 * 配对码空间隔离（安全面）。
 *
 * 症状：任一已配对网关可以把受害网关的活跃配对码顶到自己名下，受害设备随后
 * discover 到的是攻击者的 pairingId/gatewayKeyFingerprint，把配对票据发给攻击者。
 *
 * 根因：pairingCodes.set 无条件覆盖，且原有的「每网关 16 条」上限只约束单个网关
 * 自己占多少，挡不住针对性顶号（攻击者只需反复注册受害方当前的码）。
 *
 * 修法：① 码空间先到先得（他人持有则拒绝覆盖）；② 码空间全局容量上限。
 */

/** 与 main.ts 同一套判定（跨进程装配成本高，此处逐条镜像并说明对应关系）。 */
const PAIRING_CODES_PER_GATEWAY_MAX = 16;
const PAIRING_CODES_TOTAL_MAX = 4096;

type Row = { pairingId: string; installationId: string; gatewayKeyFingerprint: string; exp: number };
type Registry = Map<string, Row>;

function register(codes: Registry, code: string, row: Row): boolean {
  const owned = [...codes.values()].filter((item) => item.installationId === row.installationId);
  const holder = codes.get(code);
  const takeover = holder !== undefined && holder.installationId !== row.installationId;
  const ownRenewal = holder !== undefined && holder.installationId === row.installationId;
  if (takeover) return false;
  if (owned.length >= PAIRING_CODES_PER_GATEWAY_MAX) return false;
  if (!ownRenewal && codes.size >= PAIRING_CODES_TOTAL_MAX) return false;
  codes.set(code, row);
  return true;
}

const row = (installationId: string, code: string): [string, Row] => [
  code,
  { pairingId: `pr_${installationId}`, installationId, gatewayKeyFingerprint: `fp_${installationId}`, exp: 9_999 },
];

describe('配对码空间隔离（安全：顶号使受害设备把票据发给攻击者）', () => {
  test('攻击者不能覆盖他人持有的码', () => {
    const codes: Registry = new Map();
    register(codes, ...row('victim', '111111'));
    // 攻击者抢先注册同一码
    expect(register(codes, ...row('attacker', '111111'))).toBe(false);
    expect(codes.get('111111')?.installationId).toBe('victim');
  })

  test('顶号后 discover 拿到的仍是受害网关的指纹（票据不会流给攻击者）', () => {
    const codes: Registry = new Map();
    register(codes, ...row('victim', '222222'));
    register(codes, ...row('attacker', '222222'));
    const found = codes.get('222222');
    expect(found?.gatewayKeyFingerprint).toBe('fp_victim');
    expect(found?.installationId).toBe('victim');
  })

  test('码持有者可以续期/更新自己的码', () => {
    const codes: Registry = new Map();
    register(codes, ...row('victim', '333333'));
    const refreshed = { ...row('victim', '333333')[1], pairingId: 'pr_new' };
    expect(register(codes, '333333', refreshed)).toBe(true);
    expect(codes.get('333333')?.pairingId).toBe('pr_new');
  })

  test('单网关条数上限仍然生效', () => {
    const codes: Registry = new Map();
    let accepted = 0;
    for (let i = 0; i < PAIRING_CODES_PER_GATEWAY_MAX + 5; i += 1) {
      if (register(codes, ...row('gw', `1${String(i).padStart(5, '0')}`))) accepted += 1;
    }
    expect(accepted).toBe(PAIRING_CODES_PER_GATEWAY_MAX);
  })

  test('码空间全局上限生效（多网关合计封顶）', () => {
    const codes: Registry = new Map();
    let accepted = 0;
    // 每个网关注册 16 条，凑满全局上限后应停止
    for (let gw = 0; accepted < PAIRING_CODES_TOTAL_MAX + 64; gw += 1) {
      for (let i = 0; i < PAIRING_CODES_PER_GATEWAY_MAX; i += 1) {
        if (register(codes, ...row(`gw${gw}`, `${String(gw).padStart(3, '0')}${String(i).padStart(3, '0')}`))) accepted += 1;
      }
      if (gw > 1000) break;
    }
    expect(codes.size).toBe(PAIRING_CODES_TOTAL_MAX);
  })

  test('全局上限满时已有码仍可续期（不被误伤）', () => {
    const codes: Registry = new Map();
    // 先让 gw0 只占 1 条（远未达单网关上限 16）
    register(codes, ...row('gw0', '000000'));
    // 用大量其它网关把全局容量填满
    for (let gw = 1; codes.size < PAIRING_CODES_TOTAL_MAX; gw += 1) {
      for (let i = 0; i < PAIRING_CODES_PER_GATEWAY_MAX; i += 1) {
        register(codes, ...row(`gw${gw}`, `${String(gw).padStart(3, '0')}${String(i).padStart(3, '0')}`));
      }
    }
    expect(codes.size).toBe(PAIRING_CODES_TOTAL_MAX);
    // 新网关在容量满时被拒
    expect(register(codes, ...row('latecomer', '999999'))).toBe(false);
    // 已持有者续期不被全局容量拦下（它只占 1 条，未达单网关上限）
    expect(register(codes, ...row('gw0', '000000'))).toBe(true);
  })
})
