const count = Number(process.argv[2] ?? 10);
const mode = process.argv[3] ?? "method";

function start(run: () => Promise<number>) {
  return Promise.resolve().then(() => run()).then((result) => result);
}

async function capture(index: number) {
  const marker = { index, bytes: new Uint8Array(4096) };
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const spec = mode === "method"
    ? { marker, async run() { await gate; return 1; } }
    : { marker, run: async () => { await gate; return 1; } };
  const actual = start(spec.run);
  await Bun.sleep(0);
  finish();
  await actual;
  return new WeakRef(marker);
}

const references = [];
for (let index = 0; index < count; index++) references.push(await capture(index));
for (let index = 0; index < 20; index++) { await Bun.sleep(1); Bun.gc(true); }
process.stdout.write(JSON.stringify({ runtime: Bun.version, jit: process.env.BUN_JSC_useJIT, count, mode, retained: references.flatMap((reference, index) => reference.deref() ? [index] : []) }) + "\n");
