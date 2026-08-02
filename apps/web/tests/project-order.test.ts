import assert from "node:assert/strict";
import test from "node:test";
import {
  moveSidebarProject,
  reconcileSidebarProjectOrder,
  setSidebarProjectOrder,
  sidebarProjectOrder,
  sortProjectsBySidebarOrder,
} from "../src/project-order";

test("project sidebar order moves, sorts, and reconciles durable ids", () => {
  setSidebarProjectOrder([]);
  reconcileSidebarProjectOrder(["alpha", "beta", "gamma"]);
  moveSidebarProject("gamma", "alpha");

  assert.deepEqual(sidebarProjectOrder.value, ["gamma", "alpha", "beta"]);
  assert.deepEqual(
    sortProjectsBySidebarOrder([{ key: "alpha" }, { key: "beta" }, { key: "gamma" }]).map((item) => item.key),
    ["gamma", "alpha", "beta"],
  );

  reconcileSidebarProjectOrder(["gamma", "alpha", "delta"]);
  assert.deepEqual(sidebarProjectOrder.value, ["gamma", "alpha", "delta"]);
  setSidebarProjectOrder([]);
});
