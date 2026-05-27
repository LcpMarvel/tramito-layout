// 编译器错误分层。把 tramito-layout 当编译器看：
//   - 前端诊断（validateGraph / loader）= 用户/生成模型可改的结构错，loader 以 AggregateError 抛出。
//   - 后端（布局各 stage + 序列化）一旦在“已通过前端校验”的输入上 throw，按定义就是编译器自身的 bug，
//     即 InternalCompilerError（ICE）。它不是输入 graph 的错，绝不能回喂给生成模型自纠——
//     否则模型会对着自己没写错的东西瞎改、空烧 LLM step（正是本功能要消除的浪费）。
//
// 不变式：通过 validateGraph 的 graph 一定能编译出 XML。任何逃逸到边界的非 AggregateError = 违反不变式 = ICE。

export class InternalCompilerError extends Error {
  /** 供消费侧路由：true ⇒ 是我们的 bug，不要回喂模型。 */
  readonly internal = true;
  /** 触发该错误的后端 stage（从原始 message 的 [xxx] 前缀提取，可能为空）。 */
  readonly stage?: string;

  constructor(message: string, options?: { stage?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'InternalCompilerError';
    this.stage = options?.stage;
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// 后端 throw 普遍带 "[stage] ..." 前缀（如 [edge-router] / [merger] / [serializer]）。
function extractStageTag(err: unknown): string | undefined {
  const m = /^\[([^\]]+)\]/.exec(messageOf(err));
  return m ? m[1] : undefined;
}

/**
 * 把一个逃逸到编译边界的错误归类：
 *   - AggregateError（loader 的校验错）→ 原样透传（用户可改）。
 *   - 已是 InternalCompilerError → 原样透传（幂等，避免重复包装）。
 *   - 其它一切 → 包成 InternalCompilerError。
 */
export function asCompileError(err: unknown): unknown {
  if (err instanceof AggregateError) return err;
  if (err instanceof InternalCompilerError) return err;
  return new InternalCompilerError(
    '内部编译错误：graph 已通过结构校验，但布局/序列化阶段失败。' +
      '这是 tramito-layout 的 bug，不是输入 graph 的问题——请勿把此错误回喂给生成模型自纠，应作为 bug 上报。' +
      `原始原因：${messageOf(err)}`,
    { stage: extractStageTag(err), cause: err },
  );
}

/** 在编译边界包裹后端执行：校验错透传，其它非预期错误统一归为 ICE。 */
export async function withCompileErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asCompileError(err);
  }
}
