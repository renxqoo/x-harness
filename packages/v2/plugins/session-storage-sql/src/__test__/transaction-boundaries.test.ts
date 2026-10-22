import { describe, expect, it, vi } from "vitest";
import { fixtures } from "./fixtures";
import { value } from "./value";

const setup = fixtures();

for (const kind of ["sqlite", "postgres"] as const)
  describe(`${kind} storage transaction boundaries`, () => {
    it("cancelled and over-budget transactions roll back database mutations before commit", async () => {
      const fixture = await setup(kind);
      const store = fixture.store;

      try {
        const controller = new AbortController();
        expect(
          await store.run({ write: true, signal: controller.signal }, async (query) => {
            await query.all(
              "UPDATE xh_session_heads SET metadata='1' WHERE namespace=$1 AND id='one'",
              [fixture.namespace],
            );
            controller.abort();
            return { ok: true, value: undefined };
          }),
        ).toMatchObject({ ok: false, error: { code: "cancelled" } });
        let time = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => time);

        try {
          expect(
            await store.run({ write: true }, async (query) => {
              await query.all(
                "UPDATE xh_session_heads SET metadata='2' WHERE namespace=$1 AND id='one'",
                [fixture.namespace],
              );
              time += 20000;
              return { ok: true, value: undefined };
            }),
          ).toMatchObject({ ok: false, error: { code: "cancelled" } });
        } finally {
          clock.mockRestore();
        }

        expect(
          value(await fixture.service.read({ namespace: fixture.namespace, id: "one" })).head
            .metadata,
        ).toBe("null");
      } finally {
        value(await store.close());
        value(await store.close());
      }

      expect(
        await store.run({ write: false }, async () => ({ ok: true, value: undefined })),
      ).toMatchObject({ ok: false, error: { code: "closed" } });
    });
    it("business failure after mutations cannot commit partial state", async () => {
      const fixture = await setup(kind);
      expect(
        await fixture.store.run({ write: true }, async (query) => {
          await query.all(
            "UPDATE xh_session_heads SET metadata='1' WHERE namespace=$1 AND id='one'",
            [fixture.namespace],
          );
          return {
            ok: false as const,
            error: { source: "session" as const, code: "capacity-exceeded" as const },
          };
        }),
      ).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
      expect(
        value(await fixture.service.read({ namespace: fixture.namespace, id: "one" })).head
          .metadata,
      ).toBe("null");
    });
  });
