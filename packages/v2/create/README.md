# 插件工程脚手架

在本目录的工作区执行：

```sh
bun create/src/cli.ts /absolute/new-greeting greeting
```

第三个参数可以指定本地 SDK 目录，该目录包含 core/src 和 application/src。默认使用脚手架所在 SDK。不会联网、安装依赖或发布包。生成的本地工程与 SDK 位置绑定，默认复用 SDK 已安装的 TypeScript 和 Bun 类型；移动位置后重新生成工程配置。

```ts
import { createProject } from "@x-harness/create";
const generated = await createProject({ directory: "/srv/new-greeting", name: "greeting" });
if (generated.ok) {
  const directory = generated.value.directory;
  const files = generated.value.files;
  void directory;
  void files;
}
```

工程包含 contracts.ts、plugin.ts、main.ts、plugin.test.ts、check.ts、package.json、tsconfig.json 和 README。服务示例是普通 greeting，包含输入校验、Result 返回和应用关闭。依次执行 bun run typecheck、bun run test、bun run build、bun run start；构建后执行 bun dist/main.js。

目标父目录必须存在。名字为小写字母开头、至多64字符的字母/数字/连字符。目标目录排他创建，文件排他创建，不覆盖现有目录、文件或目标符号链接。生成期间目录可见，main.ts 和完成标志 .ready 最后写入；只有 ok 的结果表示生成成功。

I/O失败返回 write-failed，directory 指向未完成目录。失败时保留已经写出的文件，绝不自动删除目标目录或文件：身份检查与删除不能原子完成，自动回滚可能误删并发替换的用户文件。缺少 .ready 的目录需调用者检查后处理，再选择另一个不存在的目标重新生成。脚手架不承诺对同一目录的外部持续修改提供文件系统隔离。
