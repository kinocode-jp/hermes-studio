import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUILTIN_MEMORY_MAX_BYTES,
  BuiltinMemoryFilesError,
  BuiltinMemoryFilesStore,
} from "./builtin-memory-files.js";

test("builtin memory files support safe read/write with revision conflicts", async (t) => {
  const hermesRoot = await mkdtempSafe("hermes-studio-mem-rw-");
  t.after(() => rm(hermesRoot, { recursive: true, force: true }));
  await mkdir(join(hermesRoot, "profiles", "coder"), { recursive: true, mode: 0o700 });
  const store = new BuiltinMemoryFilesStore({ hermesRoot });

  const empty = await store.readAll("coder");
  assert.equal(empty.profile, "coder");
  assert.equal(empty.memory.exists, false);
  assert.equal(empty.user.exists, false);
  assert.equal(empty.memory.content, "");
  assert.equal(empty.memory.revision, revisionOf(""));

  const written = await store.write("coder", "memory", "hello memory", empty.memory.revision);
  assert.equal(written.exists, true);
  assert.equal(written.content, "hello memory");
  assert.equal(written.bytes, Buffer.byteLength("hello memory"));
  assert.equal(written.revision, revisionOf("hello memory"));

  const user = await store.write("coder", "user", "hello user", empty.user.revision);
  assert.equal(user.content, "hello user");

  const loaded = await store.readAll("coder");
  assert.equal(loaded.memory.content, "hello memory");
  assert.equal(loaded.user.content, "hello user");

  await assert.rejects(
    () => store.write("coder", "memory", "stale", empty.memory.revision),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "conflict",
  );

  const updated = await store.write("coder", "memory", "next", loaded.memory.revision);
  assert.equal(updated.content, "next");
  assert.equal((await store.readAll("coder")).memory.content, "next");
});

test("builtin memory files reject memories directory symlinks and leaf symlinks", async (t) => {
  const hermesRoot = await mkdtempSafe("hermes-studio-mem-symlink-");
  t.after(() => rm(hermesRoot, { recursive: true, force: true }));
  const escape = await mkdtempSafe("hermes-studio-mem-escape-");
  t.after(() => rm(escape, { recursive: true, force: true }));
  await writeFile(join(escape, "MEMORY.md"), "escaped-secret", { mode: 0o600 });
  await writeFile(join(escape, "USER.md"), "escaped-user", { mode: 0o600 });

  const profileHome = join(hermesRoot, "profiles", "coder");
  await mkdir(profileHome, { recursive: true, mode: 0o700 });
  await symlink(escape, join(profileHome, "memories"));

  const store = new BuiltinMemoryFilesStore({ hermesRoot });
  await assert.rejects(
    () => store.readAll("coder"),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "invalid_request",
  );
  await assert.rejects(
    () => store.write("coder", "memory", "x", revisionOf("")),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "invalid_request",
  );

  // Replace symlink dir with a real memories dir that contains a leaf symlink.
  await rm(join(profileHome, "memories"), { force: true });
  await mkdir(join(profileHome, "memories"), { mode: 0o700 });
  await symlink(join(escape, "MEMORY.md"), join(profileHome, "memories", "MEMORY.md"));
  await writeFile(join(profileHome, "memories", "USER.md"), "safe-user", { mode: 0o600 });

  await assert.rejects(
    () => store.readAll("coder"),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "invalid_request",
  );
  await assert.rejects(
    () => store.write("coder", "memory", "overwrite", revisionOf("")),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "invalid_request",
  );

  // USER.md remains a regular file; leaf rejection is specific to the symlink target.
  // Full readAll fails because MEMORY.md is a symlink — intentional fail-closed.
});

test("builtin memory files reject oversized, non-UTF-8, and NUL content", async (t) => {
  const hermesRoot = await mkdtempSafe("hermes-studio-mem-bounds-");
  t.after(() => rm(hermesRoot, { recursive: true, force: true }));
  await mkdir(join(hermesRoot, "profiles", "coder", "memories"), { recursive: true, mode: 0o700 });
  const store = new BuiltinMemoryFilesStore({ hermesRoot, maxBytes: 32 });

  await assert.rejects(
    () => store.write("coder", "memory", "x".repeat(64), revisionOf("")),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "invalid_request",
  );
  await assert.rejects(
    () => store.write("coder", "memory", "has\0nul", revisionOf("")),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "invalid_request",
  );

  // On-disk invalid UTF-8 is rejected on read.
  await writeFile(join(hermesRoot, "profiles", "coder", "memories", "MEMORY.md"), Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });
  await assert.rejects(
    () => store.readAll("coder"),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "invalid_request",
  );

  // On-disk NUL is rejected on read.
  await writeFile(join(hermesRoot, "profiles", "coder", "memories", "MEMORY.md"), "a\0b", { mode: 0o600 });
  await assert.rejects(
    () => store.readAll("coder"),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "invalid_request",
  );

  // On-disk oversize is rejected on read (even if content is otherwise fine).
  await writeFile(join(hermesRoot, "profiles", "coder", "memories", "MEMORY.md"), "y".repeat(64), { mode: 0o600 });
  await assert.rejects(
    () => store.readAll("coder"),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "invalid_request",
  );

  // Default budget constant is large enough for normal notes.
  assert.ok(BUILTIN_MEMORY_MAX_BYTES >= 256 * 1024);
});

test("builtin memory files create a real memories directory and refuse profile symlink homes", async (t) => {
  const hermesRoot = await mkdtempSafe("hermes-studio-mem-create-");
  t.after(() => rm(hermesRoot, { recursive: true, force: true }));
  const realHome = join(hermesRoot, "profiles", "coder");
  await mkdir(realHome, { recursive: true, mode: 0o700 });
  const store = new BuiltinMemoryFilesStore({ hermesRoot });

  const written = await store.write("coder", "user", "created", revisionOf(""));
  assert.equal(written.content, "created");
  const loaded = await store.readAll("coder");
  assert.equal(loaded.user.content, "created");
  assert.equal(loaded.memory.exists, false);

  // Profile home as a symlink must be rejected.
  const escape = await mkdtempSafe("hermes-studio-mem-profile-escape-");
  t.after(() => rm(escape, { recursive: true, force: true }));
  await mkdir(join(escape, "memories"), { recursive: true, mode: 0o700 });
  await writeFile(join(escape, "memories", "USER.md"), "nope", { mode: 0o600 });
  await rm(realHome, { recursive: true, force: true });
  await symlink(escape, realHome);
  await assert.rejects(
    () => store.readAll("coder"),
    (error: unknown) => error instanceof BuiltinMemoryFilesError && error.code === "invalid_request",
  );
});

function revisionOf(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function mkdtempSafe(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
