import { expect, it, vi } from "vitest";
import { openDirectoryWatch } from "../open-directory-watch";
import { value } from "./helpers";
const mocked = vi.hoisted(() => ({
  change: undefined as (() => void) | undefined,
  error: undefined as (() => void) | undefined,
  close: vi.fn(),
  broken: false,
}));
vi.mock("node:fs", () => ({
  watch: (_path: string, _options: unknown, callback: () => void) => {
    if (mocked.broken) throw new Error("unavailable");

    mocked.change = callback;
    return {
      close: mocked.close,
      on(_event: string, handler: () => void) {
        mocked.error = handler;
        return this;
      },
    };
  },
}));

it("native errors close once, notify failure once, and suppress late events", () => {
  const changed = vi.fn(),
    failed = vi.fn();
  const close = value(
    openDirectoryWatch({ path: "root", identity: "1:2", recursive: true }, { changed, failed }),
  );
  mocked.change?.();
  expect(changed).toHaveBeenCalledOnce();
  mocked.error?.();
  mocked.error?.();
  mocked.change?.();
  close();
  close();
  expect(mocked.close).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
});

it("native registration errors return a neutral fault", () => {
  mocked.broken = true;
  const changed = vi.fn(),
    failed = vi.fn();

  try {
    expect(
      openDirectoryWatch(
        { path: "missing", identity: "1:2", recursive: false },
        { changed, failed },
      ),
    ).toMatchObject({ ok: false, error: { code: "watch-failed" } });
    expect(changed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  } finally {
    mocked.broken = false;
  }
});
