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
    });
  }
});
