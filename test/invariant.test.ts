import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { layoutBpmnXml } from '../src/index.ts';
import { validateGraph } from '../src/loader/validate-graph.ts';
import { warmup } from '../src/layout/elk-singleton.ts';

// 编译器核心不变式：通过 validateGraph 的源 ⟹ 后端一定能编译出 XML。
// 这把它从"文档里的断言"钉成"被测的性质"。任一 fixture 违反（校验有 error，或编译抛错）都是回归。
const FIX_DIR = resolve(import.meta.dir, '../fixtures');
const fixtures = readdirSync(FIX_DIR).filter((f) => f.endsWith('.json'));

describe('编译器不变式：过校验 ⟹ 能编译出 XML', () => {
  beforeAll(async () => {
    await warmup();
  });

  it('fixtures 目录非空（守门测试本身有效）', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const file of fixtures) {
    it(`${file}：validateGraph 无 error，且 layoutBpmnXml 产出 XML`, async () => {
      const json = JSON.parse(readFileSync(resolve(FIX_DIR, file), 'utf-8'));
      const label = file.replace('.json', '');

      const errors = validateGraph(json).filter((i) => i.severity === 'error');
      expect({ file, errors }).toEqual({ file, errors: [] });

      // 既然前端判定可编译，后端就必须成功；任何抛错（含被包装的 ICE）都是不变式被破坏。
      const { xml } = await layoutBpmnXml(json, label);
      expect(xml).toContain('<bpmndi:BPMNDiagram');

      // DI↔语义一致性：DI 平面里每个 bpmnElement 引用都必须命中一个语义元素 id。
      // WHY：2.8.0 曾因 buildProcessFromParticipant 漏收 association，产出「DI 引用存在、
      // 语义元素缺失」的非良构 XML（bpmn.io 导入即 unresolved reference）。DI 只描形状，
      // 几何检查（check:layout）发现不了这类脱节，必须在这里按 XML 结构断言。
      const diIndex = xml.indexOf('<bpmndi:BPMNDiagram');
      const semanticIds = new Set(
        diIndex === -1 ? [] : [...xml.slice(0, diIndex).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]),
      );
      const dangling = diIndex === -1
        ? []
        : [...xml.slice(diIndex).matchAll(/\sbpmnElement="([^"]+)"/g)]
            .map((m) => m[1]!)
            .filter((ref) => !semanticIds.has(ref));
      expect({ file, danglingRefs: dangling }).toEqual({ file, danglingRefs: [] });
    });
  }
});
