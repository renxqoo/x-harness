// 分类器（§4.4——P1 交付物）：三分类词面矩阵 + fail-closed 对抗锚（未知动词/破坏形态
// 不得入只读类——U12 防线的前置件）。传输动词段在多段管线中跳过（载荷承载语义）。

import { describe, expect, it } from "vitest";
import { classifyPipeline } from "../classifier.ts";
import { parseBash } from "../bash/ast.ts";
import type { ParsedCommand } from "../bash/ast.ts";

function commandsOf(source: string): ParsedCommand[] {
  const parsed = parseBash(source);
  if (!parsed.ok) throw new Error(`unparseable: ${source}`);
  return [...parsed.commands];
}

const classify = (source: string): string => {
  const commands = commandsOf(source);
  const hasOutputRedirect = commands.some((cmd) => cmd.redirects.some((r) => r.face === "output" && r.target !== undefined && r.target !== "/dev/null"));
  return classifyPipeline(commands, hasOutputRedirect);
};

describe("classifyPipeline（三分类）", () => {
  it("只读类：观察动词与 git 只读子命令", () => {
    expect(classify("ls -la")).toBe("readonly");
    expect(classify("git status")).toBe("readonly");
    expect(classify("git diff --stat")).toBe("readonly");
    expect(classify("cat README.md | wc -l")).toBe("readonly");
    expect(classify("curl https://example.com")).toBe("unclassified"); // curl 逐出只读表（对抗审查 #2——缺省落盘/上传面）
  });

  it("只读类补面（纯 stdout 观察类）：printf/文本重排/二进制查看/系统查看；执行钩子类不入（对抗锚）", () => {
    for (const cmd of [
      "printf '%s' hi", "nl -ba f.txt", "tac f.txt", "rev f.txt", "fmt f.txt", "fold -w 80 f.txt",
      "paste a b", "join a b", "comm a b", "seq 3", "expr 1 + 2", "bc", "cal", "factor 12",
      "numfmt --to=si 1000", "od -c f.bin", "hexdump -C f.bin", "strings f.bin",
      "uptime", "who", "w", "groups", "locale", "nproc", "lsof -i", "netstat -an",
      "date +'%F'", "hostname", "git branch -a", "git tag -l v*", "git reflog show", "git remote -v",
    ]) {
      expect(classify(cmd), cmd).toBe("readonly");
    }
    expect(classify("man printf")).toBe("unclassified"); // pager：man -P/MANPAGER env 钩子可执行外部程序
    expect(classify("less f.txt")).toBe("unclassified"); // LESSOPEN env 钩子同理
    expect(classify("xxd -r hex.txt out.bin")).toBe("unclassified"); // -r 反转写盘
    expect(classify("ss -K")).toBe("unclassified"); // -K 杀 socket（变更面）
    expect(classify("ip link set eth0 up")).toBe("unclassified"); // 子命令变更网络配置
  });

  it("症状回归：base64 -o（BSD 落盘）/ arch（带操作数即执行 prog）曾入只读表直通——执行与写盘形态逐出", () => {
    expect(classify("base64 -o out.bin in.bin")).toBe("unclassified");
    expect(classify("arch -arch arm64 rm -rf /")).toBe("unclassified");
    expect(classify("arch")).toBe("unclassified"); // 整词不入表（argv 形态面无法安全区分）
    expect(classify("base64 f.bin")).toBe("unclassified");
  });

  it("症状回归：sort -o / uniq IN OUT 曾混入只读类直通写盘（argv 写面）——写形态逐出只读类落问", () => {
    expect(classify("sort -o out.txt in.txt")).toBe("unclassified");
    expect(classify("sort --output=out.txt in.txt")).toBe("unclassified");
    expect(classify("uniq in.txt out.txt")).toBe("unclassified");
    expect(classify("sort in.txt")).toBe("readonly"); // 无写形态仍只读
    expect(classify("uniq -c in.txt")).toBe("readonly");
  });

  it("症状回归：sort 短旗簇 -nro / uniq stdin 占位 `uniq - out` 曾绕过写形态例外直通写盘——簇内 o 与 `-` 操作数均按写面捕", () => {
    expect(classify("sort -nro out.txt in.txt")).toBe("unclassified"); // -nro = -n -r -o
    expect(classify("sort -nro out.txt")).toBe("unclassified");
    expect(classify("uniq - out.txt")).toBe("unclassified"); // "-" 是 stdin 占位操作数非旗标
    expect(classify("uniq -c - out.txt")).toBe("unclassified");
    expect(classify("sort -t o in.txt")).toBe("readonly"); // "-t o" 的 o 是分隔符值非输出旗
  });

  it("症状回归：sort 长旗缩写 --ou / --compress-program 执行钩子 / uniq dash 名 OUTPUT 曾绕过例外直通——步进解析收口", () => {
    expect(classify("sort --ou=out.txt in.txt")).toBe("unclassified"); // getopt_long 无歧义缩写 = --output
    expect(classify("sort --out out.txt in.txt")).toBe("unclassified");
    expect(classify("sort --compress-program=/tmp/evil in.txt")).toBe("unclassified"); // 临时文件压缩钩子=执行外部程序
    expect(classify("uniq in.txt -o")).toBe("unclassified"); // getopt：首个操作数后全是操作数——-o 是 dash 名 OUTPUT 文件
    expect(classify("uniq -- in.txt -x")).toBe("unclassified"); // -- 后全是操作数
    expect(classify("sort -k1,1o in.txt")).toBe("readonly"); // -k 值内 o 是八进制修饰符非输出旗（误报边界）
    expect(classify("uniq -f 1 in.txt")).toBe("readonly"); // 值旗分离形的值不计操作数（误报边界）
  });

  it("症状回归：git/tree/find/date/hostname 变更形态曾按只读直通——变更面逐出只读类落问", () => {
    expect(classify("tree -o out.txt .")).toBe("unclassified");
    expect(classify("git diff --output=patch.txt HEAD")).toBe("unclassified");
    expect(classify("git show --output=patch.txt HEAD")).toBe("unclassified");
    expect(classify("git branch -D topic")).toBe("unclassified");
    expect(classify("git branch topic")).toBe("unclassified"); // 带名称操作数 = 创建分支
    expect(classify("git tag -am msg v1")).toBe("unclassified"); // 短旗簇 -a -m 签注建标
    expect(classify("git tag v1")).toBe("unclassified");
    expect(classify("git remote remove origin")).toBe("unclassified");
    expect(classify("git reflog expire --all")).toBe("unclassified");
    expect(classify("find . -fprint out.txt")).toBe("unclassified");
    expect(classify("find . -fls out.txt")).toBe("unclassified");
    expect(classify("date -s '2020-01-01 00:00'")).toBe("unclassified");
    expect(classify("hostname newname")).toBe("unclassified");
  });

  it("写类：界内合成写动词与家族子命令", () => {
    expect(classify("mkdir build")).toBe("write");
    expect(classify("git add -A && git commit -m x")).toBe("write");
    expect(classify("npm install")).toBe("write");
    expect(classify("cargo build")).toBe("write");
    expect(classify("echo hi > out.txt")).toBe("write"); // hasOutputRedirect 路径
  });

  it("未分类：未知动词与破坏形态（fail-closed——只读混未知即未知）", () => {
    expect(classify("mytool run")).toBe("unclassified");
    expect(classify("dd if=/dev/zero of=/dev/disk0")).toBe("unclassified");
    expect(classify("rm -rf build")).toBe("unclassified");
    expect(classify("tar -xzf pkg.tgz")).toBe("unclassified");
    expect(classify("find . -delete")).toBe("unclassified"); // -delete 逐出只读
    expect(classify("curl -o payload https://x.test")).toBe("unclassified"); // 落盘旗逐出只读且非写安全 → 问
    expect(classify("git push")).toBe("unclassified"); // git push 非只读子命令非写安全
    expect(classify("ls && mytool run")).toBe("unclassified"); // 只读混未知 = 未知
  });

  it("传输动词：多段管线中载体段跳过（载荷承载语义）；裸载体只读径", () => {
    expect(classify("bash -c 'git status'")).toBe("readonly"); // 载荷段 git status
    expect(classify("timeout 5 npm test")).toBe("write"); // 载荷 npm test
    expect(classify("env VAR=1 ls")).toBe("readonly"); // wrappers 剥离后 argv[0]=ls
    expect(classify("xargs -- grep foo")).toBe("readonly");
    expect(classify("bash")).toBe("readonly"); // 裸载体（无操作数，stdin 即闭）
    expect(classify("env")).toBe("readonly"); // 裸剥离器
    expect(classify("git --version")).toBe("readonly"); // git 旗标形态（无子命令）
    expect(classify("timeout --foreground 5 cargo build")).toBe("write"); // 长旗 + 时长后载荷
    expect(classify("nohup npm run build")).toBe("write");
    expect(classify("env -i git status")).toBe("readonly"); // 旗后载荷
    expect(classify("sh -c 'npm install'")).toBe("write"); // 载荷段写类
  });

  it("症状回归：find 破坏形态曾随载体段豁免直通（find -delete | wc）——留段写形态不随载体跳；opaque 载体段不随载体跳", () => {
    expect(classify("find . -delete | wc -l")).toBe("unclassified"); // -delete 留在 find 段——不随载体豁免
    expect(classify("find . -fprint out.txt | wc -l")).toBe("unclassified");
    expect(classify("find . -name '*.ts' | wc -l")).toBe("readonly"); // 纯检索管线仍只读
    expect(classify("find . -exec git status {} \\;")).toBe("readonly"); // -exec 载荷已提取——载荷段分类
    expect(classify("uptime | watch rm -rf /")).toBe("unclassified"); // opaque 载体段（watch——载荷未提取）
    expect(classify("ls | xargs base64 -o out.bin")).toBe("unclassified"); // 载荷段独立成段按词面裁决
  });
});
