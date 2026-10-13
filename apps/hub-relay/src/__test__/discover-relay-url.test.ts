import { describe, expect, test } from "vitest";

/**
 * discover 回环协议判定（症状：设备拿到 wss:// 明文端口地址后握手失败 not_open）。
 *
 * relay 自身只监听明文 HTTP（createServer 来自 node:http，无 TLS 面）；TLS 由前置
 * 终结器终止并透传 X-Forwarded-Proto。故回环地址的协议必须等于设备实际能用��那个：
 * 有终结器（https/wss）→ wss；直连 relay（无该头）→ ws。
 *
 * 早前实现默认 wss，直连 relay 的设备一律 not_open —— 而这条路径只在「设备与 relay
 * 同机或内网直连」时才走到，故此前未被生产暴露。
 */

function relayUrlFor(headers: { host?: string; forwarded?: string }): string {
  const host = headers.host ?? "";
  const forwarded = headers.forwarded?.split(",")[0]?.trim();
  const proto = forwarded === "https" || forwarded === "wss" ? "wss" : "ws";
  return host.length > 0 ? `${proto}://${host}` : "";
}

describe('discover 回环协议', () => {
  test('直连 relay（无终结器）→ ws', () => {
    expect(relayUrlFor({ host: '127.0.0.1:8787' })).toBe('ws://127.0.0.1:8787');
  });

  test('前置终结器终止 TLS（X-Forwarded-Proto: https）→ wss', () => {
    expect(relayUrlFor({ host: 'relay.example.com', forwarded: 'https' })).toBe('wss://relay.example.com');
  });

  test('终结器透传 wss 同样识别为 wss', () => {
    expect(relayUrlFor({ host: 'relay.example.com', forwarded: 'wss' })).toBe('wss://relay.example.com');
  });

  test('终结器自报明文（http）→ ws（设备侧能直连的形态）', () => {
    expect(relayUrlFor({ host: 'relay.example.com', forwarded: 'http' })).toBe('ws://relay.example.com');
  });

  test('多值链取首个（终结器链上最外层为准）', () => {
    expect(relayUrlFor({ host: 'r:443', forwarded: 'https,http' })).toBe('wss://r:443');
    expect(relayUrlFor({ host: 'r:80', forwarded: 'http,https' })).toBe('ws://r:80');
  });

  test('前置空格容错', () => {
    expect(relayUrlFor({ host: 'r:443', forwarded: ' https ' })).toBe('wss://r:443');
  });

  test('无 host 时回环地址为空（由调用方回落配置里的 relayUrl）', () => {
    expect(relayUrlFor({})).toBe('');
  });
})