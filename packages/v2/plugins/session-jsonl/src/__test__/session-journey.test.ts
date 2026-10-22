import { expect, it } from "vitest";
import { createSessionPlugin, session } from "../../../session/src/index";
import { fixtures, value } from "./helpers";
const fixture = fixtures();
it("session projects messages, events and replacements over a swappable JSONL provider", async () => {
  const f = await fixture();
  value(await f.host.install([value(createSessionPlugin())]));
  const service = value(f.host.use(session));
  value(await service.create({ id: "chat", metadata: { topic: "test" } }));
  value(
    await service.append({
      id: "chat",
      expectedRevision: 0,
      commitId: "messages",
      entries: [
        { kind: "message", message: { role: "user", content: [{ type: "text", text: "你好" }] } },
        { kind: "event", type: "trace", data: { value: 1 } },
        {
          kind: "message",
          message: { role: "assistant", content: [{ type: "text", text: "回答" }] },
        },
      ],
    }),
  );
  value(
    await service.append({
      id: "chat",
      expectedRevision: 3,
      commitId: "summary",
      entries: [
        {
          kind: "message",
          message: { role: "system", content: [{ type: "text", text: "摘要" }] },
          replace: { startSeq: 1, endSeq: 3 },
        },
      ],
    }),
  );
  expect(
    value(await service.conversation({ id: "chat" })).nodes.map((node) => [
      node.position,
      node.seq,
    ]),
  ).toEqual([[1, 4]]);
  expect(value(await service.history({ id: "chat" })).records).toHaveLength(4);
  value(await service.fork({ id: "branch", sourceId: "chat", throughRevision: 3 }));
  expect(value(await service.conversation({ id: "branch" })).nodes.map((node) => node.seq)).toEqual(
    [1, 3],
  );
  expect(await service.getCommit({ id: "branch", commitId: "messages" })).toMatchObject({
    error: { code: "not-found" },
  });
});
