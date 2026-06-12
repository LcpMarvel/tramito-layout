import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { layoutBpmnGraph } from '../src/index.ts';
import { flatToNested } from '../src/loader/flat-builder.ts';
import { warmup } from '../src/layout/elk-singleton.ts';
import { nestedToFlat, NotFlatRepresentable } from './helpers/nested-to-flat.ts';

// 扁平前门 vs 嵌套入口 = 同一编译器的两道前门，后端 codegen 完全共享。本测试钉死这条等价性：
// 任取一个真实嵌套 fixture，反推成扁平 → flatToNested 回嵌套 → 经同一管线布局，几何必须与
// 「fixture 直接走嵌套入口」逐点一致。一份 fixture 覆盖两条入口，无需维护两套 fixture。
//
// 为什么几何能逐点相等（而非近似）：
//   - 流程节点尺寸由 type+label 经 node-sizes 重算，loader 不读输入 width/height；
//   - elkPlacement 自建 ELK options，无视输入 layoutOptions；
//   - flat 保留全部用户 id 与结构/顺序，flatToNested 确定性装配。
//   故两条路径喂给 ELK 的「结构 + 尺寸 + 顺序」按构造完全相同，elkjs 对相同输入确定 ⟹ 坐标逐点相等。
//   唯一允许不同的 id：单 process 模式下顶层 process 容器 id（flatToNested 固定为 process_root），
//   对它只比几何、不比 id。

const FIX_DIR = resolve(import.meta.dir, '../fixtures');
const fixtures = readdirSync(FIX_DIR).filter((f) => f.endsWith('.json'));

interface Box { x: number; y: number; width: number; height: number }

// 把 LayoutedGraph 拍平成「稳定 id → 几何」。容器 process/collaboration 的 id 在两条路径可能不同，
// 单独收集（只比几何）。其余元素（participant/lane/flowNode/boundaryEvent/artifact/edge）id 全部稳定。
//
// 只收「已定位」元素（x、y 都有值）。WHY：管线只把主流可达节点喂 ELK（pipeline.ts mainReachable），
// 完全孤立/无锚点的节点（无边的 eventBasedGateway、无 association 的 dataObject）两条路径都不定位、
// x/y 皆 undefined，其残留尺寸是偶然产物、不构成「布局」。比对它们只会拿噪声当 bug。真正要防的
// 「嵌套能放、扁平丢了」由 boxes 的 **key 集合相等** 兜住：某节点只在一侧已定位 → key 集不等 → 断言失败。
function flatten(graph: any) {
  const boxes = new Map<string, Box>();
  const edges = new Map<string, string>();
  const processBoxes: Box[] = [];

  const placed = (n: any) => typeof n.x === 'number' && typeof n.y === 'number';
  const box = (n: any): Box => ({ x: n.x, y: n.y, width: n.width ?? 0, height: n.height ?? 0 });
  const edgeKey = (e: any): string => {
    const sec = (e.sections ?? [])[0];
    if (!sec) return '<no-section>';
    const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
    return pts.map((p: any) => `${p.x},${p.y}`).join(' ');
  };

  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    const type = n.bpmn?.type;
    if (type === 'process') {
      if (placed(n)) processBoxes.push(box(n));
    } else if (type === 'collaboration' || type === undefined) {
      // definitions 根 / collaboration 容器：不计入几何比对（无稳定可比的定位语义）。
    } else if (typeof n.id === 'string' && placed(n)) {
      if (boxes.has(n.id)) throw new Error(`duplicate id in layouted graph: ${n.id}`);
      boxes.set(n.id, box(n));
    }
    for (const c of n.children ?? []) visit(c);
    for (const be of n.boundaryEvents ?? []) visit(be);
    for (const a of n.artifacts ?? []) visit(a);
    for (const e of n.edges ?? []) {
      if (typeof e.id === 'string') edges.set(e.id, edgeKey(e));
    }
  };
  visit(graph);
  return { boxes: Object.fromEntries([...boxes].sort()), edges: Object.fromEntries([...edges].sort()), processBoxes };
}

describe('扁平前门 ⟺ 嵌套入口：同一 fixture 两条路径几何逐点一致', () => {
  beforeAll(async () => {
    await warmup();
  });

  const skipped: { file: string; reason: string }[] = [];

  for (const file of fixtures) {
    it(`${file}`, async () => {
      const nested = JSON.parse(readFileSync(resolve(FIX_DIR, file), 'utf-8'));
      const label = file.replace('.json', '');

      let flat;
      try {
        flat = nestedToFlat(nested);
      } catch (e) {
        if (e instanceof NotFlatRepresentable) {
          // 显式登记不可扁平表达的 fixture（不静默跳过）——见末尾汇总断言。
          skipped.push({ file, reason: e.reason });
          return;
        }
        throw e;
      }

      const fromNested = (await layoutBpmnGraph(nested, label)).graph;
      const fromFlat = (await layoutBpmnGraph(flatToNested(flat), label)).graph;

      const a = flatten(fromNested);
      const b = flatten(fromFlat);

      expect(b.boxes).toEqual(a.boxes);
      expect(b.edges).toEqual(a.edges);
      expect(b.processBoxes).toEqual(a.processBoxes);
    });
  }

  it('汇总：被跳过的 fixture 都带明确「不可扁平表达」原因', () => {
    // 这条不是为了「越少越好」，而是把跳过原因显式钉在测试输出里，避免静默漏测。
    for (const s of skipped) {
      expect(s.reason.length).toBeGreaterThan(0);
    }
    if (skipped.length > 0) {
      console.log(`[flat-equivalence] ${skipped.length} fixture(s) not flat-representable:`);
      for (const s of skipped) console.log(`  - ${s.file}: ${s.reason}`);
    }
  });
});
