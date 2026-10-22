import { expect, it } from "vitest";
import { createFault } from "../../contracts/create-fault";
import { createExecution } from "../create-execution";
import { value } from "../../__test__/helpers";
import type { CoreFaultCode } from "../../index";

const fault = (code: CoreFaultCode) => createFault(code);

it("self waiting is rejected even when the target has no outgoing edges", () => {
  const graph = createExecution(fault);
  expect(graph.wait("self", "self")).toMatchObject({ ok: false, error: { code: "wait-cycle" } });
  expect(graph.waitingFor("self")).toEqual([]);
});

it("a reversed wait remains blocked until every duplicate edge is released", () => {
  const graph = createExecution(fault);
  const first = value(graph.wait("a", "b"));
  const second = value(graph.wait("a", "b"));
  expect(graph.waitingFor("a")).toEqual(["b"]);
  expect(Object.isFrozen(graph.waitingFor("a"))).toBe(true);
  first();
  first();
  expect(graph.wait("b", "a")).toMatchObject({ ok: false, error: { code: "wait-cycle" } });
  expect(graph.waitingFor("b")).toEqual([]);
  second();
  expect(graph.waitingFor("a")).toEqual([]);
  const reverse = value(graph.wait("b", "a"));
  expect(graph.waitingFor("b")).toEqual(["a"]);
  second();
  expect(graph.waitingFor("b")).toEqual(["a"]);
  reverse();
  expect(graph.waitingFor("b")).toEqual([]);
});

it("a transitively reachable source is rejected across a shared descendant", () => {
  const graph = createExecution(fault);
  const releases = [
    ["a", "b"],
    ["a", "c"],
    ["b", "d"],
    ["c", "d"],
    ["d", "e"],
  ].map(([source, target]) => value(graph.wait(source!, target!)));
  expect(graph.wait("e", "a")).toMatchObject({ ok: false, error: { code: "wait-cycle" } });
  expect(graph.wait("e", "b")).toMatchObject({ ok: false, error: { code: "wait-cycle" } });
  expect(graph.waitingFor("e")).toEqual([]);
  const independent = value(graph.wait("e", "z"));
  expect(graph.waitingFor("e")).toEqual(["z"]);
  independent();

  for (const release of releases.reverse()) release();

  for (const node of ["a", "b", "c", "d", "e", "z"]) expect(graph.waitingFor(node)).toEqual([]);
});

it("removing a path permits a former cycle and old disposers cannot delete fresh edges", () => {
  const graph = createExecution(fault);
  const old = value(graph.wait("a", "b"));
  const downstream = value(graph.wait("b", "c"));
  expect(graph.wait("c", "a")).toMatchObject({ ok: false, error: { code: "wait-cycle" } });
  old();
  const fresh = value(graph.wait("a", "b"));
  old();
  expect(graph.wait("c", "a")).toMatchObject({ ok: false, error: { code: "wait-cycle" } });
  downstream();
  const reverse = value(graph.wait("c", "a"));
  expect(graph.waitingFor("c")).toEqual(["a"]);
  fresh();
  reverse();
  expect(graph.waitingFor("a")).toEqual([]);
  expect(graph.waitingFor("b")).toEqual([]);
  expect(graph.waitingFor("c")).toEqual([]);
});
