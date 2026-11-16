/** 可替换的文本向量 Provider（默认实现：智谱 Embedding-3 / OpenAI 兼容）。 */
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface OpenAIEmbeddingOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  /** Embedding-3 支持 256/512/1024/2048；默认 256 控制存储与计算量 */
  dimensions?: number;
  timeoutMs?: number;
}

interface EmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
  error?: { message?: string };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly dimensions: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OpenAIEmbeddingOptions) {
    this.model = opts.model ?? "embedding-3";
    this.dimensions = opts.dimensions ?? 256;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const output: number[][] = [];
    // 官方限制每批最多 64 条；这里用 32 留余量。
    for (let start = 0; start < texts.length; start += 32) {
      const batch = texts.slice(start, start + 32).map((t) => t.slice(0, 6_000));
      const response = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input: batch, dimensions: this.dimensions }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = await response.json() as EmbeddingResponse;
      if (!response.ok || !body.data) {
        throw new Error(`Embedding 请求失败（HTTP ${response.status}）：${body.error?.message ?? "未知错误"}`);
      }
      const sorted = [...body.data].sort((a, b) => a.index - b.index);
      if (sorted.length !== batch.length || sorted.some((v) => !Array.isArray(v.embedding))) {
        throw new Error("Embedding 响应数量或格式不匹配");
      }
      output.push(...sorted.map((v) => v.embedding));
    }
    return output;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}
