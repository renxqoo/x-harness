// e2e：真实使用场景——基于 sqlite 的增删改查 4 个插件，验证运行期动态注册、使用、销毁。
//   注册：4 个插件逐一动态安装（平台不重启）
//   使用：增 → 查 → 改 → 查 → 删 → 查 全程走插件提供的服务
//   销毁：逐个卸载；销毁后服务无法使用，未销毁的照常工作；数据比插件活得久
//   复活：重新动态注册立刻能用，sqlite 数据仍在
import { must } from "./check.ts";
import { createWorld, pluginPath, service, type World } from "./world.ts";

interface Create {
  insert(name: string): void;
}
interface Read {
  all(): { id: number; name: string }[];
}
interface Update {
  rename(id: number, name: string): void;
}
interface Delete {
  remove(id: number): void;
}

async function install(world: World, file: string): Promise<string> {
  const result = await world.svc.install({ path: pluginPath(file) });
  must(result.ok, `动态注册 ${file} 成功（实际：${result.ok === false ? result.reason : "ok"}）`);
  return result.ok ? result.value.name : "";
}

/** 销毁后服务必须无法使用：token 随卸载注销（解析面失联）。
 *  边界：销毁语义 = 平台解析面失联；调用方在卸载前捕获的旧引用不归登记簿管。 */
function mustBeUnusable(world: World, name: string): void {
  must(world.svc.serviceToken(name) === undefined, `销毁后 ${name} 的 token 必须注销`);
}

/** 注册四件并验证登记如实 */
async function registrationRound(world: World): Promise<void> {
  const names = [
    await install(world, "crud-create.ts"),
    await install(world, "crud-read.ts"),
    await install(world, "crud-update.ts"),
    await install(world, "crud-delete.ts"),
  ];
  must(names.join(",") === "crud-create,crud-read,crud-update,crud-delete", "四个插件登记如实");
  console.log(`注册：${names.join("、")}（运行期动态安装，平台不重启）`);
}

/** 增删改查往返 */
function usageRound(world: World): void {
  const create = service<Create>(world, "crud-create");
  const read = service<Read>(world, "crud-read");
  const update = service<Update>(world, "crud-update");
  const del = service<Delete>(world, "crud-delete");

  create.insert("ada");
  create.insert("grace");
  let rows = read.all();
  must(rows.length === 2 && rows[0]?.name === "ada" && rows[1]?.name === "grace", `增+查生效（实际 ${JSON.stringify(rows)}）`);

  update.rename(rows[0]?.id ?? 0, "ada lovelace");
  rows = read.all();
  must(rows[0]?.name === "ada lovelace", `改生效（实际 ${JSON.stringify(rows[0])}）`);

  del.remove(rows[1]?.id ?? 0);
  rows = read.all();
  must(rows.length === 1 && rows[0]?.name === "ada lovelace", `删生效（实际 ${JSON.stringify(rows)}）`);
  console.log(`使用：增删改查往返通过——剩 ${JSON.stringify(rows)}`);
}

/** 逐个卸载：销毁的无法使用，未销毁的照常，登记清空 */
async function teardownRound(world: World): Promise<void> {
  must((await world.svc.uninstall("crud-delete")).ok, "卸载 crud-delete 成功");
  mustBeUnusable(world, "crud-delete");
  must(service<Read>(world, "crud-read").all().length === 1, "销毁 crud-delete 后其余插件照常");

  for (const name of ["crud-update", "crud-read", "crud-create"]) {
    must((await world.svc.uninstall(name)).ok, `卸载 ${name} 成功`);
    mustBeUnusable(world, name);
  }
  must(world.svc.list().length === 0, "全部销毁后登记为空");
  console.log("销毁：4 个插件逐一卸载，服务全部无法使用，登记清空");
}

/** 重装复活：立刻能用；数据比插件活得久 */
async function reviveRound(world: World): Promise<void> {
  await install(world, "crud-create.ts");
  await install(world, "crud-read.ts");
  await install(world, "crud-delete.ts");
  const read = service<Read>(world, "crud-read");
  let rows = read.all();
  must(rows.length === 1 && rows[0]?.name === "ada lovelace", `重装后数据仍在（实际 ${JSON.stringify(rows)}）`);

  service<Create>(world, "crud-create").insert("linus");
  rows = read.all();
  must(rows.length === 2 && rows[1]?.name === "linus", `重装后写入立刻生效（实际 ${JSON.stringify(rows)}）`);

  service<Delete>(world, "crud-delete").remove(rows[1]?.id ?? 0); // 复活的删同样立即可用
  rows = read.all();
  must(rows.length === 1 && rows[0]?.name === "ada lovelace", `复活的删立刻生效（实际 ${JSON.stringify(rows)}）`);
  console.log(`复活：重新注册即可用，数据存活——${JSON.stringify(rows)}`);
}

export async function runCrudScenario(): Promise<void> {
  const world = await createWorld();
  try {
    await registrationRound(world);
    usageRound(world);
    await teardownRound(world);
    await reviveRound(world);
    console.log("\n场景通过：动态注册 / 使用 / 销毁无法使用 / 重装复活");
  } finally {
    try {
      await world.dispose();
    } catch (disposeError) {
      console.error("world.dispose 失败（不掩蔽上面的场景错误）：", disposeError);
      process.exitCode = 1;
    }
  }
}
