import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LLMGateway, type LLMProvider, type LLMRequest, type LLMResponse, type LLMStreamEvent, type ModelInfo } from "@jarvis/llm-gateway";
import { CodingHarness } from "./coding-harness.js";

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("unexpected null");
  return v;
}

/** 脚本化 provider：按脚本返回 rawChat 结果（模拟工具调用序列） */
class ScriptedRawProvider implements LLMProvider {
  readonly id = "scripted";
  private idx = 0;
  constructor(private script: Array<Record<string, unknown>>) {}
  supportsModel(): boolean {
    return true;
  }
  getModels(): Promise<ModelInfo[]> {
    return Promise.resolve([{ id: "fake", provider: "scripted" }]);
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
  async generate(request: LLMRequest): Promise<LLMResponse> {
    void request;
    return { model: "fake", content: "ok" };
  }
  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    void request;
    yield { type: "done", response: { model: "fake", content: "ok" } };
  }
  async rawChat(): Promise<Record<string, unknown>> {
    const item = this.script[Math.min(this.idx, this.script.length - 1)] ?? {};
    this.idx++;
    return item;
  }
}

function makeHarness(script: Array<Record<string, unknown>>): CodingHarness {
  const gw = new LLMGateway();
  gw.register(new ScriptedRawProvider(script));
  return new CodingHarness({ gateway: gw, model: "fake", maxSteps: 8 });
}

describe("CodingHarness 工具循环", () => {
  it("完整链路：写文件 → 完成", async () => {
    const harness = makeHarness([
      // 第 1 轮：模型要求写文件
      {
        tool_calls: [
          {
            id: "c1",
            function: { name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "hello from harness" }) },
          },
        ],
      },
      // 第 2 轮：完成声明
      { content: "已创建 out.txt，内容为问候语。" },
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-harness-"));
    const job = await harness.execute({ workDir: dir, goal: "创建 out.txt 写入问候" });
    await (harness as unknown as { jobs: Map<string, { done: Promise<void> }> }).jobs.get(job.jobId)?.done;
    const status = await harness.getStatus(job.jobId);
    expect(status.state).toBe("COMPLETED");
    expect(status.steps).toBe(2);
    expect(must(status.output)).toContain("out.txt");
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("hello from harness");
    fs.rmSync(dir, { recursive: true });
  });

  it("工具错误回传模型不崩：越界写被拦截后仍能完成", async () => {
    const harness = makeHarness([
      {
        tool_calls: [
          { id: "c1", function: { name: "write_file", arguments: JSON.stringify({ path: "../evil.txt", content: "x" }) } },
        ],
      },
      { content: "路径不允许，我在目录内创建。" },
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-harness-"));
    const job = await harness.execute({ workDir: dir, goal: "测试越界" });
    await (harness as unknown as { jobs: Map<string, { done: Promise<void> }> }).jobs.get(job.jobId)?.done;
    const status = await harness.getStatus(job.jobId);
    expect(status.state).toBe("COMPLETED");
    expect(status.log.some((l) => l.kind === "error")).toBe(true);
    expect(fs.existsSync(path.resolve(dir, "../evil.txt"))).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it("达到最大步数报 FAILED", async () => {
    // 脚本永远要求 list_files：耗尽 maxSteps
    const harness = makeHarness([
      { tool_calls: [{ id: "c", function: { name: "list_files", arguments: "{}" } }] },
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-harness-"));
    const job = await harness.execute({ workDir: dir, goal: "无限循环" });
    await (harness as unknown as { jobs: Map<string, { done: Promise<void> }> }).jobs.get(job.jobId)?.done;
    const status = await harness.getStatus(job.jobId);
    expect(status.state).toBe("FAILED");
    expect(status.error).toContain("最大步数");
    fs.rmSync(dir, { recursive: true });
  }, 20_000);

  it("run_command 白名单执行真实命令", async () => {
    const harness = makeHarness([
      {
        tool_calls: [
          { id: "c1", function: { name: "run_command", arguments: JSON.stringify({ command: "node -e process.stdout.write('42')" }) } },
        ],
      },
      { content: "命令输出 42。" },
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-harness-"));
    const job = await harness.execute({ workDir: dir, goal: "跑 node" });
    await (harness as unknown as { jobs: Map<string, { done: Promise<void> }> }).jobs.get(job.jobId)?.done;
    const status = await harness.getStatus(job.jobId);
    expect(status.state).toBe("COMPLETED");
    const runLog = status.log.find((l) => l.kind === "tool_result" || l.detail?.includes("run_command"));
    expect(runLog).toBeDefined();
    fs.rmSync(dir, { recursive: true });
  });

  it("cancel：运行中取消", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new (class implements LLMProvider {
      readonly id = "gated";
      supportsModel(): boolean {
        return true;
      }
      getModels(): Promise<ModelInfo[]> {
        return Promise.resolve([{ id: "fake", provider: "gated" }]);
      }
      healthCheck(): Promise<boolean> {
        return Promise.resolve(true);
      }
      generate(): Promise<LLMResponse> {
        return Promise.resolve({ model: "fake", content: "" });
      }
      async *stream(): AsyncIterable<LLMStreamEvent> {
        yield { type: "done", response: { model: "fake", content: "" } };
      }
      async rawChat(): Promise<Record<string, unknown>> {
        await gate;
        return { tool_calls: [{ id: "c", function: { name: "list_files", arguments: "{}" } }] };
      }
    })();
    const gw = new LLMGateway();
    gw.register(provider);
    const harness = new CodingHarness({ gateway: gw, model: "fake" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-harness-"));
    const job = await harness.execute({ workDir: dir, goal: "会被取消" });
    await harness.cancel(job.jobId);
    release();
    await (harness as unknown as { jobs: Map<string, { done: Promise<void> }> }).jobs.get(job.jobId)?.done;
    const status = await harness.getStatus(job.jobId);
    expect(["CANCELLED", "FAILED"]).toContain(status.state);
    fs.rmSync(dir, { recursive: true });
  });

  it("capabilities 与 healthCheck", async () => {
    const harness = makeHarness([{ content: "x" }]);
    const caps = await harness.getCapabilities();
    expect(caps.map((c) => c.id)).toContain("coding");
    const health = await harness.healthCheck();
    expect(health.ok).toBe(true);
  });
});
