import assert from "node:assert/strict";
import test from "node:test";
import type { OfficeTeam } from "@hermes-studio/protocol";
import type { TeamsApi } from "../src/teams-api.ts";
import {
  refreshTeams,
  registerTeamsRuntime,
  teams,
  updateTeam,
} from "../src/teams-store.ts";

test("an older teams list cannot overwrite a committed mutation", async () => {
  const original = team("Old", 1);
  const updated = team("New", 2);
  const staleList = deferred<{ teams: OfficeTeam[] }>();
  let listCalls = 0;
  const api: TeamsApi = {
    async list() {
      listCalls += 1;
      return listCalls === 1 ? { teams: [original] } : await staleList.promise;
    },
    async update() { return updated; },
    async create() { throw new Error("unused"); },
    async updateSettings() { throw new Error("unused"); },
    async remove() { throw new Error("unused"); },
  };

  registerTeamsRuntime(api);
  await flush();
  assert.equal(teams.value[0]?.name, "Old");

  const refresh = refreshTeams();
  const mutation = updateTeam(original.id, { expectedRevision: 1, name: "New" });
  assert.equal(await mutation, "success");
  staleList.resolve({ teams: [original] });
  assert.equal(await refresh, false);
  assert.equal(teams.value[0]?.name, "New");
  assert.equal(teams.value[0]?.revision, 2);
});

function team(name: string, revision: number): OfficeTeam {
  const updatedAt = `2026-07-27T00:00:0${revision}.000Z`;
  return {
    id: "team-aaaaaaaaaaaaaaaaaaaaaaaa",
    name,
    color: "#112233",
    memberProfileIds: ["default"],
    settings: {
      revision,
      skillsEnabled: false,
      contextEnabled: false,
      skills: [],
      context: "",
      updatedAt,
    },
    revision,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
