import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { CapabilityRegistry } from "./registry.js";
import { SkillFactory } from "./factory.js";

/**
 * Factory Skill 生成器测试（ADR-011 Step 4.3）
 * 覆盖：draft 骨架五件套 / smoke 契约真实可执行 / 同名拦截 /
 * approve 注册零权限 + staging 清空 / reject 删除 / 名称清洗。
 */

let tmp: string;
let registry: CapabilityRegistry;
let factory: SkillFactory;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-factory-"));
  registry = new CapabilityRegistry({ dbPath: ":memory:", skillsRoot: path.join(tmp, "skills") });
  factory = new SkillFactory({
    registry,
    skillsRoot: path.join(tmp, "skills"),
    stagingRoot: path.join(tmp, "staging"),
  });
});

afterEach(() => {
  registry.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("SkillFactory.draft", () => {
  it("gap → 骨架五件套 + smoke 契约真实可执行", () => {
    const r = factory.draft({
      need: "清理 Chrome 浏览器缓存",
      suggestedKind: "skill",
      suggestedName: "Chrome-Cache Clean!",
    });
    expect(r.name).toBe("chrome-cache-clean"); // 名称清洗
    expect(r.files).toHaveLength(5);
    // smoke 真实执行（shell）
    const out = execSync(`sh ${path.join(r.dir, "tests", "smoke.test.sh")}`).toString().trim();
    expect(out).toBe("PASS");
  });

  it("同名未决骨架拒绝重复生成", () => {
    factory.draft({ need: "n", suggestedKind: "skill", suggestedName: "dup" });
    expect(() => factory.draft({ need: "n2", suggestedKind: "skill", suggestedName: "dup" }))
      .toThrow(/已在 staging 等待审批/);
  });

  it("骨架不注册（registry 不可见直到 approve）", () => {
    factory.draft({ need: "n", suggestedKind: "skill", suggestedName: "ghost-cap" });
    expect(registry.list()).toHaveLength(0);
    expect(factory.listDrafts().map((d) => d.name)).toEqual(["ghost-cap"]);
  });
});

describe("SkillFactory.approve / reject", () => {
  it("approve：staging → skillsRoot + 注册零权限 + staging 清空", () => {
    factory.draft({ need: "查天气", suggestedKind: "skill", suggestedName: "weather-lookup" });
    const rec = factory.approve("weather-lookup");
    expect(rec.permissions).toEqual([]); // 红线：批准也不授予权限
    expect(rec.enabled).toBe(1);
    expect(registry.findByName("weather-lookup")).toBeDefined();
    expect(fs.existsSync(path.join(tmp, "skills", "weather-lookup", "skill.json"))).toBe(true);
    expect(factory.listDrafts()).toHaveLength(0);
    // 注册后的 skill 仍可执行（骨架行为）
    const out = execSync(`cd ${path.join(tmp, "skills", "weather-lookup")} && echo '{"args":{}}' | ./main.sh`).toString();
    expect(out).toContain('"implemented": false');
  });

  it("reject：删除骨架且无注册", () => {
    factory.draft({ need: "n", suggestedKind: "skill", suggestedName: "bad-idea" });
    expect(factory.reject("bad-idea")).toBe(true);
    expect(factory.listDrafts()).toHaveLength(0);
    expect(registry.list()).toHaveLength(0);
    expect(factory.reject("bad-idea")).toBe(false); // 幂等
  });

  it("approve 不存在的骨架报错", () => {
    expect(() => factory.approve("nope")).toThrow(/staging 中无此骨架/);
  });
});
