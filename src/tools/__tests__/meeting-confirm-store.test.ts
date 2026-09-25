import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createSqlitePendingConfirmStore } from "../meeting-confirm.js";

const stores: Array<{ close?: () => void }> = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close?.();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const openStore = (directory = mkdtempSync(join(tmpdir(), "appointment-confirm-"))) => {
  if (!directories.includes(directory)) {
    directories.push(directory);
  }
  const store = createSqlitePendingConfirmStore(join(directory, "checkpoint.sqlite"));
  stores.push(store);
  return store;
};

describe("SQLite pending confirmation store", () => {
  it("preserves confirmations across store instances without lost updates", () => {
    const directory = mkdtempSync(join(tmpdir(), "appointment-confirm-"));
    directories.push(directory);
    const first = openStore(directory);
    const expiresAt = Date.now() + 10_000;
    first.remember("thread-a", "fingerprint-a", expiresAt);
    first.close?.();
    stores.splice(stores.indexOf(first), 1);

    const afterRestart = openStore(directory);
    afterRestart.remember("thread-b", "fingerprint-b", expiresAt);

    expect(afterRestart.consume("thread-a", "fingerprint-a", Date.now() + 1_000)).toBe(true);
    expect(afterRestart.consume("thread-b", "fingerprint-b", Date.now() + 1_000)).toBe(true);
  });

  it("atomically consumes a confirmation only once", () => {
    const directory = mkdtempSync(join(tmpdir(), "appointment-confirm-"));
    directories.push(directory);
    const first = openStore(directory);
    const second = openStore(directory);
    const expiresAt = Date.now() + 10_000;
    first.remember("thread-a", "fingerprint-a", expiresAt);

    expect(first.consume("thread-a", "fingerprint-a", Date.now() + 1_000)).toBe(true);
    expect(second.consume("thread-a", "fingerprint-a", Date.now() + 1_000)).toBe(false);
  });

  it("rejects expired and mismatched confirmations", () => {
    const store = openStore();
    const expiresAt = Date.now() + 1_000;
    store.remember("thread-a", "fingerprint-a", expiresAt);

    expect(store.consume("thread-a", "wrong", Date.now())).toBe(false);
    expect(store.consume("thread-a", "fingerprint-a", expiresAt)).toBe(false);
  });
});
