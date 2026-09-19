import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { layoutBpmnXml } from '../src/index.ts';
import { warmup } from '../src/layout/elk-singleton.ts';
import { buildBaseline, compareWithBaseline, evaluateBpmnXmlFixtures } from '../src/evaluation/index.ts';

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

  // 语义回边剔除（卡 0.1）：3 节点审批-驳回环，物理上 gw→task 的边向左（驳回），但它是
  // default flow 标记的循环回边——F1/F3 应把它从分母剔除而不是记为"主流回头"。
  it('excludes semantic back edges from F1/F3 (3-node approval loop)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="definitions_loop" targetNamespace="http://example.com/test">
  <bpmn:process id="process_loop" name="环" isExecutable="true">
    <bpmn:startEvent id="start_1" name="开始"><bpmn:outgoing>flow_1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="task_1" name="提交"><bpmn:incoming>flow_1</bpmn:incoming><bpmn:incoming>flow_3</bpmn:incoming><bpmn:outgoing>flow_2</bpmn:outgoing></bpmn:task>
    <bpmn:exclusiveGateway id="gw_1" name="审核" default="flow_3"><bpmn:incoming>flow_2</bpmn:incoming><bpmn:outgoing>flow_3</bpmn:outgoing><bpmn:outgoing>flow_4</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:endEvent id="end_1" name="结束"><bpmn:incoming>flow_4</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="flow_1" sourceRef="start_1" targetRef="task_1" />
    <bpmn:sequenceFlow id="flow_2" sourceRef="task_1" targetRef="gw_1" />
    <bpmn:sequenceFlow id="flow_3" name="驳回" sourceRef="gw_1" targetRef="task_1" />
    <bpmn:sequenceFlow id="flow_4" name="通过" sourceRef="gw_1" targetRef="end_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_loop" name="BPMNDiagram">
    <bpmndi:BPMNPlane id="BPMNPlane_loop" bpmnElement="process_loop">
      <bpmndi:BPMNShape id="process_loop_di" bpmnElement="process_loop"><dc:Bounds x="0" y="0" width="700" height="200" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="start_1_di" bpmnElement="start_1"><dc:Bounds x="62" y="82" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="task_1_di" bpmnElement="task_1"><dc:Bounds x="178" y="60" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gw_1_di" bpmnElement="gw_1"><dc:Bounds x="358" y="75" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="end_1_di" bpmnElement="end_1"><dc:Bounds x="538" y="82" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="flow_1_di" bpmnElement="flow_1"><di:waypoint x="98" y="100" /><di:waypoint x="178" y="100" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_2_di" bpmnElement="flow_2"><di:waypoint x="278" y="100" /><di:waypoint x="358" y="100" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_3_di" bpmnElement="flow_3"><di:waypoint x="383" y="75" /><di:waypoint x="383" y="20" /><di:waypoint x="228" y="20" /><di:waypoint x="228" y="60" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_4_di" bpmnElement="flow_4"><di:waypoint x="408" y="100" /><di:waypoint x="538" y="100" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    const result = evaluateBpmnXmlFixtures(
      [{ fixture: 'cycle-3', xml }],
      { softOnly: true, ruleFilter: new Set(['F1', 'F3']) },
    );
    const row = result.soft?.cells.get('cycle-3');
    expect(row?.get('F1')?.value).toBe(1);
    expect(row?.get('F1')?.pass).toBe(true);
    expect(row?.get('F3')?.value).toBe(0);
    expect(row?.get('F3')?.pass).toBe(true);
  });

  // F10/F12 sanity（卡 0.2）：101 的八路并行缠线必须在交叉数/骑行段上明显差于 04 的整齐分支。
  // 若哪天 F10(101) ≤ F10(04) 或 F12(101) ≤ F12(04)，说明尺子钝了而不是 101 变干净了。
  it('F10/F12 clearly distinguish messy routing (101) from clean branching (04)', async () => {
    const [r101, r04] = await Promise.all([
      layoutBpmnXml(FIX('101-cicd-parallel-rollback'), '101-cicd-parallel-rollback'),
      layoutBpmnXml(FIX('04-all-gateways'), '04-all-gateways'),
    ]);
    const result = evaluateBpmnXmlFixtures([
      { fixture: '101', xml: r101.xml },
      { fixture: '04', xml: r04.xml },
    ], { softOnly: true, ruleFilter: new Set(['F10', 'F12']) });
    const m = (fx: string, rule: string) => result.soft?.cells.get(fx)?.get(rule)?.value ?? 0;
    expect(m('101', 'F10')).toBeGreaterThan(m('04', 'F10') + 4);
    expect(m('101', 'F12')).toBeGreaterThan(m('04', 'F12'));
  });

  // baseline 对比（卡 0.3）：同一评估结果自比必须全 0；人为把节点挪出原位置（重叠 + 端点
  // 脱边 + 新增交叉）必须被 compare 抓到。这是"美观优化无法自证不退步"的解药。
  it('compareWithBaseline: self-compare is clean, mutated geometry is caught', async () => {
    const { xml } = await layoutBpmnXml(FIX('04-all-gateways'), '04-all-gateways');
    const evalOpts = { softOnly: false };
    const base = buildBaseline(evaluateBpmnXmlFixtures([{ fixture: '04', xml }], evalOpts));
    const clean = compareWithBaseline(evaluateBpmnXmlFixtures([{ fixture: '04', xml }], evalOpts), base);
    expect(clean.hardRegressions).toHaveLength(0);
    expect(clean.softRegressions).toHaveLength(0);
    expect(clean.improvements).toHaveLength(0);

    // 把 task_path_b 挪到 task_path_a 的同一行（N1 重叠 + 相连边端点脱边 E1 + 新增交叉）
    const mutated = xml.replace(
      /(<bpmndi:BPMNShape[^>]*bpmnElement="task_path_b"[^>]*>\s*<dc:Bounds x="[-\d.]+" y=")([-\d.]+)(")/,
      '$132$3',
    );
    expect(mutated).not.toBe(xml);
    const diff = compareWithBaseline(evaluateBpmnXmlFixtures([{ fixture: '04', xml: mutated }], evalOpts), base);
    expect(diff.hardRegressions.length).toBeGreaterThan(0);
    expect(diff.hardRegressions.some(r => r.rule === 'N1')).toBe(true);
  });
});
