import { describe, expect, it } from "vitest";
import { PermissionBroker, type AuditEntry } from "./permission-broker.js";

function lastAudit(entries: AuditEntry[]): AuditEntry {
  const e = entries[entries.length - 1];
  if (!e) throw new Error("no audit");
  return e;
}

describe("PermissionBroker", () => {
  it("read 级放行且免审", () => {
    const b = new PermissionBroker();
    const d = b.check({ kind: "file_read", target: "/tmp/notes.txt", actor: "agent" });
    expect(d.allow).toBe(true);
    expect(d.risk).toBe("read");
  });

  it("write 级放行（白名单已过滤前提下）", () => {
    const b = new PermissionBroker();
    const d = b.check({ kind: "file_write", target: "/tmp/out.js", actor: "harness:glm-coding" });
    expect(d.allow).toBe(true);
    expect(d.risk).toBe("write");
  });

  it("凭证目录提级 system：拒绝 + 需确认", () => {
    const b = new PermissionBroker();
    const d = b.check({ kind: "file_read", target: "/Users/x/.ssh/id_rsa", actor: "agent" });
    expect(d.allow).toBe(false);
    expect(d.needApproval).toBe(true);
    expect(d.risk).toBe("system");
    expect(d.reason).toContain("SSH");
  });

  it(".env / .pem / .key 敏感扩展名拦截", () => {
    const b = new PermissionBroker();
    for (const t of ["app/.env", "server.pem", " signing.key"]) {
      const d = b.check({ kind: "file_write", target: t, actor: "agent" });
      expect(d.risk).toBe("system");
      expect(d.allow).toBe(false);
    }
  });

  it("破坏性命令提级 legal：拒绝", () => {
    const b = new PermissionBroker();
    const d = b.check({ kind: "shell_exec", target: "rm -rf /data", actor: "harness:x" });
    expect(d.risk).toBe("legal");
    expect(d.allow).toBe(false);
  });

  it("支付关键词 legal：拒绝", () => {
    const b = new PermissionBroker();
    const d = b.check({ kind: "shell_exec", target: "curl pay.example.com/transfer", actor: "agent" });
    expect(d.risk).toBe("legal");
    expect(d.allow).toBe(false);
  });

  it("全部请求落审计（含放行）", () => {
    const entries: AuditEntry[] = [];
    const b = new PermissionBroker({ audit: { append: (e) => entries.push(e) } });
    b.check({ kind: "file_read", target: "/tmp/a", actor: "agent" });
    b.check({ kind: "shell_exec", target: "sudo reboot", actor: "agent" });
    expect(entries).toHaveLength(2);
    expect(lastAudit(entries).allowed).toBe(false);
    expect(lastAudit(entries).risk).toBe("legal");
  });

  it("风险只升不降", () => {
    const b = new PermissionBroker();
    // shell_exec 基线 write；目标是普通文件，无提级——write 放行
    const d = b.check({ kind: "shell_exec", target: "node build.js", actor: "harness" });
    expect(d.risk).toBe("write");
    expect(d.allow).toBe(true);
  });
});
