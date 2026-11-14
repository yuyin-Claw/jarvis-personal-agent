#!/usr/bin/env node
/**
 * JARVIS 0.1 CLI 对话入口
 *
 * 用法：
 *   jarvis                  # 新会话交互模式
 *   jarvis --continue       # 继续最近会话
 *   jarvis ask "问题"        # 单次问答
 *
 * 环境变量见 config.ts。Ctrl+C 退出（状态已持久化，重进 --continue 恢复）。
 */
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { LLMGateway, OpenAICompatibleProvider } from "@jarvis/llm-gateway";
import { SqliteMemoryEngine } from "@jarvis/memory";
import { ConversationGateway } from "./gateway.js";
import { JARVIS_SYSTEM_PROMPT } from "./persona.js";
import { loadConfig } from "./config.js";
import { mkdirSync } from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = loadConfig();

  // 初始化存储
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const memory = new SqliteMemoryEngine({ path: config.dbPath });
  memory.migrate();

  // 初始化 LLM
  const gateway = new LLMGateway();
  gateway.register(
    new OpenAICompatibleProvider({
      id: "zhipu",
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      models: [
        { id: config.model, provider: "zhipu", vision: true },
      ],
    }),
  );

  // 对话 Gateway：流式透传到 stdout
  const conversation = new ConversationGateway({
    memory,
    systemPrompt: JARVIS_SYSTEM_PROMPT,
    generateReply: async (messages, handlers) => {
      let full = "";
      for await (const ev of gateway.stream({ model: config.model, messages })) {
        if (ev.type === "delta") {
          full += ev.text;
          handlers.onDelta?.(ev.text);
        } else if (ev.type === "error") {
          throw ev.error;
        }
      }
      output.write("\n");
      return full;
    },
  });

  // 会话选择
  let conversationId: string;
  if (args[0] === "--continue") {
    const last = memory.listConversations()[0];
    if (!last) {
      conversationId = conversation.newConversation("新会话");
    } else {
      conversationId = last.id;
      console.log(`（继续会话：${last.title}）`);
    }
  } else {
    conversationId = conversation.newConversation(args[0] === "ask" ? String(args[1] ?? "提问").slice(0, 30) : "新会话");
  }

  const ask = async (text: string): Promise<string> => {
    const result = await conversation.receive(
      { conversationId, text },
      {
        onDelta: (t) => process.stdout.write(t),
        onMemoryInjected: (hits) => {
          if (hits.length > 0) {
            console.log(`〔记忆 ${hits.length} 条：${hits.map((h) => h.content.slice(0, 12)).join("／")}〕`);
          }
        },
      },
    );
    return result.assistantText;
  };

  // 单次问答模式
  if (args[0] === "ask" && args[1]) {
    await ask(String(args[1]));
    memory.close();
    return;
  }

  // 交互模式
  console.log(`JARVIS 0.1 · 模型 ${config.model} · Ctrl+C 退出`);
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const text = (await rl.question("\n你> ")).trim();
      if (!text) continue;
      if (text === "exit" || text === "quit") break;
      process.stdout.write("JARVIS> ");
      try {
        await ask(text);
      } catch (err) {
        console.error(`\n[出错] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    rl.close();
    memory.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
