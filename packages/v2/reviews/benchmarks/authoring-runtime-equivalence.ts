import assert from "node:assert/strict";
const roots = process.argv.slice(2);
const texts = [];
for (const root of roots) {
  const output = await Bun.build({ entrypoints: [root + "/core/src/index.ts"], target: "browser", minify: { syntax: true, whitespace: true, identifiers: false } });
  assert(output.success);
  assert.equal(output.outputs.length, 1);
  texts.push(await output.outputs[0]!.text());
}
assert.equal(texts.length, 2);
assert(texts[0] === texts[1], "Runtime bundles differ");
process.stdout.write(JSON.stringify({ runtime: Bun.version, target: "browser", minify: { syntax: true, whitespace: true, identifiers: false }, equal: true, bytes: Buffer.byteLength(texts[0]!), sha256: new Bun.CryptoHasher("sha256").update(texts[0]!).digest("hex") }) + "\n");
