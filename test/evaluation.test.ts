import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { layoutBpmnXml } from '../src/index.ts';
import { warmup } from '../src/layout/elk-singleton.ts';
import { evaluateBpmnXmlFixtures } from '../src/evaluation/index.ts';

const FIX = (n: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures', `${n}.json`), 'utf-8'));

describe('layout evaluation library', () => {
  beforeAll(async () => { await warmup(); });

  it('scores generated BPMN XML without going through the CLI', async () => {
    const fixtures = await Promise.all([
      layoutBpmnXml(FIX('13-boundary-events-all'), '13-boundary-events-all'),
      layoutBpmnXml(FIX('29-collaboration-message-flows'), '29-collaboration-message-flows'),
    ]);

    const result = evaluateBpmnXmlFixtures([
      { fixture: '13-boundary-events-all', xml: fixtures[0]!.xml },
      { fixture: '29-collaboration-message-flows', xml: fixtures[1]!.xml },
    ], { hardOnly: true });

    expect(result.hard?.grandTotal).toBe(0);
    expect(result.hard?.dirtyFixtures).toBe(0);
  });
});
