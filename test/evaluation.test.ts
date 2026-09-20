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

  // F3 同排语义（P6 折行配套）：跨排的 carriage-return / 分支落行不算回头（同 F9 的换排豁免），
  // 同排明显向左才算 N 形回头。两条手工 DI 分别钉住两侧。
  it('F3 scopes to same-row edges: cross-row carriage-return exempt, same-row reversal caught', () => {
    const head = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="definitions_x" targetNamespace="http://example.com/test">`;
    const tail = `</bpmn:definitions>`;
    // 两行折行：row1 start→a→b，row2 c→end；b→c 跨排向左 180px —— 不应计入 F3
    const xrow = `${head}
  <bpmn:process id="p_xrow" isExecutable="true">
    <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="a"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:task>
    <bpmn:task id="b"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing></bpmn:task>
    <bpmn:task id="c"><bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:task>
    <bpmn:endEvent id="e"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="a" />
    <bpmn:sequenceFlow id="f2" sourceRef="a" targetRef="b" />
    <bpmn:sequenceFlow id="f3" sourceRef="b" targetRef="c" />
    <bpmn:sequenceFlow id="f4" sourceRef="c" targetRef="e" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d_xrow"><bpmndi:BPMNPlane id="pl_xrow" bpmnElement="p_xrow">
    <bpmndi:BPMNShape id="p_xrow_di" bpmnElement="p_xrow"><dc:Bounds x="0" y="0" width="700" height="560" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="62" y="182" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="a_di" bpmnElement="a"><dc:Bounds x="178" y="160" width="100" height="80" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="b_di" bpmnElement="b"><dc:Bounds x="358" y="160" width="100" height="80" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="c_di" bpmnElement="c"><dc:Bounds x="178" y="440" width="100" height="80" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="e_di" bpmnElement="e"><dc:Bounds x="358" y="462" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="f1_di" bpmnElement="f1"><di:waypoint x="98" y="200" /><di:waypoint x="178" y="200" /></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="f2_di" bpmnElement="f2"><di:waypoint x="278" y="200" /><di:waypoint x="358" y="200" /></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="f3_di" bpmnElement="f3"><di:waypoint x="408" y="240" /><di:waypoint x="408" y="340" /><di:waypoint x="228" y="340" /><di:waypoint x="228" y="440" /></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="f4_di" bpmnElement="f4"><di:waypoint x="278" y="480" /><di:waypoint x="358" y="480" /></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
${tail}`;
    // 一行：s→a→b→c→e 但 c 排在最左（b→c 同排向左 450px，非成环边）—— 必须计入 F3
    const samrow = `${head}
  <bpmn:process id="p_samrow" isExecutable="true">
    <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="a"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:task>
    <bpmn:task id="b"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing></bpmn:task>
    <bpmn:task id="c"><bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:task>
    <bpmn:endEvent id="e"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="a" />
    <bpmn:sequenceFlow id="f2" sourceRef="a" targetRef="b" />
    <bpmn:sequenceFlow id="f3" sourceRef="b" targetRef="c" />
    <bpmn:sequenceFlow id="f4" sourceRef="c" targetRef="e" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d_samrow"><bpmndi:BPMNPlane id="pl_samrow" bpmnElement="p_samrow">
    <bpmndi:BPMNShape id="p_samrow_di" bpmnElement="p_samrow"><dc:Bounds x="0" y="0" width="950" height="200" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="62" y="82" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="a_di" bpmnElement="a"><dc:Bounds x="358" y="60" width="100" height="80" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="b_di" bpmnElement="b"><dc:Bounds x="608" y="60" width="100" height="80" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="c_di" bpmnElement="c"><dc:Bounds x="158" y="60" width="100" height="80" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="e_di" bpmnElement="e"><dc:Bounds x="808" y="82" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="f1_di" bpmnElement="f1"><di:waypoint x="98" y="100" /><di:waypoint x="358" y="100" /></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="f2_di" bpmnElement="f2"><di:waypoint x="458" y="100" /><di:waypoint x="608" y="100" /></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="f3_di" bpmnElement="f3"><di:waypoint x="608" y="100" /><di:waypoint x="258" y="100" /></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="f4_di" bpmnElement="f4"><di:waypoint x="258" y="100" /><di:waypoint x="808" y="100" /></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
${tail}`;
    const result = evaluateBpmnXmlFixtures(
      [{ fixture: 'xrow', xml: xrow }, { fixture: 'samrow', xml: samrow }],
      { softOnly: true, ruleFilter: new Set(['F3']) },
    );
    const xrowRow = result.soft?.cells.get('xrow');
    expect(xrowRow?.get('F3')?.value).toBe(0);
    expect(xrowRow?.get('F3')?.pass).toBe(true);
    const samRow = result.soft?.cells.get('samrow');
    expect(samRow?.get('F3')?.value).toBe(0.25);
    expect(samRow?.get('F3')?.pass).toBe(false);
  });

  // F10/F12 sanity（卡 0.2）：101 的八路并行缠线必须在交叉数/骑行段上明显差于 04 的整齐分支。
  // 注：P3+浅窗修复后 101 的 F12 已归 0（尺子逼着布局变好的实例）——F12 的锐利度改为用
  // 「干净 fixture 恒 0」锁定；F10 仍保持 101 ≫ 04 的区分度。
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
    expect(m('04', 'F12')).toBe(0);
    expect(m('101', 'F12')).toBeGreaterThanOrEqual(0);
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
