// 档位词表（UI 选择器来源——permission/get_mode 的 modes 暴露面）：内置五档单源
// （@x-harness/permission PROFILE_IDS——宿主不持本地词表副本）。自定义档
// （permission.profiles）暂不入词表：命令面值域裂缝未收口（thread/start 拒自定义档、
// 全局 set_mode 与文件面不对称——挂账），暴露即给 UI 开坏选项；收口后扩为
// PROFILE_IDS ∪ 自定义档 id（与 set_mode 值域同源）。
import { PROFILE_IDS } from "@x-harness/permission";

export function modeVocabulary(): string[] {
  return [...PROFILE_IDS];
}
