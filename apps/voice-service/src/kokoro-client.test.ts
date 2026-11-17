import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KokoroClient, kokoroModelReady } from "./kokoro-client.mjs";

let root = "";
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("KokoroClient", () => {
  it("常驻 worker 连续合成并复用进程", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-kokoro-client-"));
    const script = path.join(root, "worker.py");
    fs.writeFileSync(script, `import sys,json,base64\nfor line in sys.stdin:\n r=json.loads(line)\n print(json.dumps({'id':r['id'],'ok':True,'audio':base64.b64encode(('RIFF:'+r['text']).encode()).decode(),'sampleRate':24000,'voice':r['voice']}),flush=True)\n`);
    const client = new KokoroClient(script);
    const first = await client.synthesize("第一句", { voice: "zm_yunjian" });
    const proc = client.proc;
    const second = await client.synthesize("第二句", { voice: "zf_xiaoxiao" });
    expect(first.audio.toString()).toBe("RIFF:第一句");
    expect(second.audio.toString()).toBe("RIFF:第二句");
    expect(second.sampleRate).toBe(24000);
    expect(client.proc).toBe(proc);
    client.dispose();
  });

  it("模型目录必须包含全部运行文件", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-kokoro-ready-"));
    expect(kokoroModelReady(root)).toBe(false);
    fs.writeFileSync(path.join(root, "model.onnx"), "x");
    fs.writeFileSync(path.join(root, "voices.bin"), "x");
    fs.writeFileSync(path.join(root, "tokens.txt"), "x");
    fs.writeFileSync(path.join(root, "lexicon-us-en.txt"), "x");
    fs.writeFileSync(path.join(root, "lexicon-zh.txt"), "x");
    fs.mkdirSync(path.join(root, "espeak-ng-data"));
    expect(kokoroModelReady(root)).toBe(true);
  });
});
