// 提取器测试（docs/TRUNCATED-TOOL-RESCUE.md 层 2 测试口径——参数化 field 跑 content 与
// new_string 两遍）：转义边界、半截前缀、path 半截、丢序列、裸控制字符保真。

import { describe, expect, it } from "vitest";
import { extractStringField } from "../extract-string-field.ts";

/** 参数化双字段：同一行为在 write（content）与 edit（new_string）两提取面各钉一遍 */
const FIELDS = ["content", "new_string"] as const;

describe("extractStringField（参数化：content + new_string）", () => {
  for (const field of FIELDS) {
    describe(`field="${field}"`, () => {
      it("字段半截（引号未闭）→ 半截前缀（转义解码后）", () => {
        const raw = `{"path":"a.txt","${field}":"abc\\ndef\\u00e9`;
        expect(extractStringField(raw, field)).toEqual({ path: "a.txt", value: "abc\ndefé" });
      });

      it("path 半截（path 在 field 之后、引号未闭）→ 无 path（无法命名目标）", () => {
        expect(extractStringField(`{"${field}":"body","path":"a.tx`, field)).toEqual({ value: "body" });
      });

      it("无字段键（截断在字段之前）→ {}", () => {
        expect(extractStringField(`{"path":"a.txt","${field.slice(0, 3)}`, field)).toEqual({});
      });

      it("字段完整但更后的键截断 → value 完整返回", () => {
        const raw = `{"${field}":"whole value","path":"a.txt","other":"tru`;
        expect(extractStringField(raw, field)).toEqual({ path: "a.txt", value: "whole value" });
      });

      it("\\uXXXX 正常解码 + surrogate pair 组装", () => {
        const raw = `{"path":"p","${field}":"\\u4e2d\\ud83d\\ude00\\u00ff"}`;
        expect(extractStringField(raw, field)).toEqual({ path: "p", value: "中😀ÿ" });
      });

      it("\\u 截在中间（不足 4 位十六进制）→ 丢弃该不完整序列（保守不猜）", () => {
        const raw = `{"path":"p","${field}":"keep\\u4e`;
        expect(extractStringField(raw, field)).toEqual({ path: "p", value: "keep" });
      });

      it("\\u 非十六进制 → 同样丢弃（不猜坏序列）", () => {
        const raw = `{"path":"p","${field}":"x\\uZZZZy"`;
        expect(extractStringField(raw, field)).toEqual({ path: "p", value: "x" });
      });

      it("裸控制字符（真实 \\x00-\\x1f——JSON 非法但截断流会有）按原样收进前缀", () => {
        const raw = `{"path":"p","${field}":"line1\nline2\ttab`;
        expect(extractStringField(raw, field)).toEqual({ path: "p", value: "line1\nline2\ttab" });
      });

      it("空串 value（字段完整、值为空）→ value 空串在场", () => {
        expect(extractStringField(`{"path":"p","${field}":""`, field)).toEqual({ path: "p", value: "" });
      });

      it("值非字符串（截在冒号后/数字值）→ 该处不命中，续找无 → {}", () => {
        expect(extractStringField(`{"${field}":12,"path":"p"`, field)).toEqual({});
      });

      it("字段名作为别的字符串值出现 → 不误命中（继续找到真正的键）", () => {
        const raw = `{"note":"${field} here","path":"p","${field}":"real`;
        expect(extractStringField(raw, field)).toEqual({ path: "p", value: "real" });
      });

      it("全部标准转义对（quote backslash slash b f n r t）", () => {
        const raw = `{"path":"p","${field}":"a\\"b\\\\c\\/d\\be\\ff\\ng\\rh\\ti"`;
        expect(extractStringField(raw, field)).toEqual({ path: "p", value: 'a"b\\c/d\be\ff\ng\rh\ti' });
      });
    });
  }
});
