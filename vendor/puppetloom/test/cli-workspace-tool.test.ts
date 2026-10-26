import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock
}));

import { runWorkspaceTool } from "../apps/cli/src/cli-support.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
}

function useFakeChild(): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValue(child);
  return child;
}

describe("runWorkspaceTool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("waits for close after exit and decodes UTF-8 split across stdout chunks", async () => {
    const child = useFakeChild();
    const result = runWorkspaceTool("measure-project-performance.mjs", []);
    const output = Buffer.from(`${JSON.stringify({ label: "角色狀態" })}\n`, "utf8");
    const split = output.indexOf(Buffer.from("角", "utf8")) + 1;

    child.stdout.write(output.subarray(0, split));
    child.emit("exit", 0);
    child.stdout.end(output.subarray(split));
    await once(child.stdout, "end");
    child.emit("close", 0);

    await expect(result).resolves.toEqual({ label: "角色狀態" });
  });

  it("reports stderr when the workspace tool exits unsuccessfully", async () => {
    const child = useFakeChild();
    const result = runWorkspaceTool("measure-project-performance.mjs", []);

    child.stderr.end("helper failed");
    child.stdout.end();
    await Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]);
    child.emit("close", 7);

    await expect(result).rejects.toThrow("helper failed");
  });

  it("limits parse diagnostics and redacts credential-like stdout values", async () => {
    const child = useFakeChild();
    const result = runWorkspaceTool("measure-project-performance.mjs", []);
    child.stdout.end(`noise {"API_KEY":"do-not-leak"} ${"x".repeat(1000)}`);
    await once(child.stdout, "end");
    child.emit("close", 0);

    let message = "";
    try { await result; }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain("stdout 摘要");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain("do-not-leak");
    expect(message.length).toBeLessThan(600);
  });
});
