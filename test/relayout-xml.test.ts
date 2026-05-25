import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import BpmnModdle from 'bpmn-moddle';
import { parseBpmnLayout } from '../src/evaluation/layout-evaluator.ts';
import { layoutBpmnXml, relayoutBpmnXml } from '../src/index.ts';
import { warmup } from '../src/layout/elk-singleton.ts';

const FIX = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures', `${name}.json`), 'utf-8'));

const moddle = new BpmnModdle();

function xmlWithTaskIo(): string {
  const inputs = Array.from({ length: 5 }, (_, index) => {
    const n = index + 1;
    return `        <bpmn:dataInput id="di_${n}" name="输入${n}" />`;
  }).join('\n');
  const inputRefs = Array.from({ length: 5 }, (_, index) => {
    const n = index + 1;
    return `          <bpmn:dataInputRefs>di_${n}</bpmn:dataInputRefs>`;
  }).join('\n');
  const inputAssociations = Array.from({ length: 5 }, (_, index) => {
    const n = index + 1;
    return `      <bpmn:dataInputAssociation id="assoc_di_${n}"><bpmn:sourceRef>di_${n}</bpmn:sourceRef></bpmn:dataInputAssociation>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:custom="http://example.com/custom" id="Defs_1" targetNamespace="http://example.com">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="start" name="开始" custom:flag="yes"><bpmn:outgoing>flow_1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:userTask id="task_4" name="打蛋">
      <bpmn:documentation>keep me</bpmn:documentation>
      <bpmn:incoming>flow_1</bpmn:incoming><bpmn:outgoing>flow_2</bpmn:outgoing>
      <bpmn:ioSpecification>
${inputs}
        <bpmn:dataOutput id="do_1" name="蛋液" />
        <bpmn:inputSet id="inputSet_1">
${inputRefs}
        </bpmn:inputSet>
        <bpmn:outputSet id="outputSet_1"><bpmn:dataOutputRefs>do_1</bpmn:dataOutputRefs></bpmn:outputSet>
      </bpmn:ioSpecification>
${inputAssociations}
      <bpmn:dataOutputAssociation id="assoc_do_1"><bpmn:targetRef>do_1</bpmn:targetRef></bpmn:dataOutputAssociation>
    </bpmn:userTask>
    <bpmn:endEvent id="end" name="结束"><bpmn:incoming>flow_2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="flow_1" sourceRef="start" targetRef="task_4" />
    <bpmn:sequenceFlow id="flow_2" sourceRef="task_4" targetRef="end" />
  </bpmn:process>
</bpmn:definitions>`;
}

describe('relayoutBpmnXml', () => {
  beforeAll(async () => { await warmup(); });

  it('replaces BPMNDI while preserving semantic XML and explicit task IO association ids', async () => {
    const { xml } = await relayoutBpmnXml(xmlWithTaskIo());
    await expectImportable(xml);

    expect((xml.match(/<bpmndi:BPMNDiagram/g) ?? []).length).toBe(1);
    expect(xml).toContain('custom:flag="yes"');
    expect(xml).toContain('<bpmn:documentation>keep me</bpmn:documentation>');
    expect(xml).toContain('id="task_4"');
    expect(xml).toContain('id="assoc_di_5"');
    expect(xml).toContain('bpmnElement="di_5"');
    expect(xml).toContain('bpmnElement="do_1"');
    expect(xml).toContain('bpmnElement="assoc_di_5"');
    expect(xml).toContain('bpmnElement="assoc_do_1"');

    const parsed = parseBpmnLayout('relayout-xml', xml);
    expect(parsed.boxes.has('task_4')).toBe(true);
    expect(parsed.boxes.has('di_1')).toBe(true);
    expect(parsed.boxes.has('di_5')).toBe(true);
    expect(parsed.boxes.has('do_1')).toBe(true);
  });

  it('rejects preserve/local modes until incremental XML relayout is implemented', async () => {
    await expect(relayoutBpmnXml(xmlWithTaskIo(), { mode: 'preserve' })).rejects.toThrow(
      'mode "preserve" is not supported yet',
    );
  });

  it('relayouts generated fixture XML after a task IO patch', async () => {
    const generated = await layoutBpmnXml(FIX('24-collaboration-simple'), 'relayout-source-24');
    const patched = addCustomNamespace(addTaskIo(generated.xml, 'task_submit', 5, 1));
    const { xml } = await relayoutBpmnXml(patched);
    await expectImportable(xml);

    expect((xml.match(/<bpmndi:BPMNDiagram/g) ?? []).length).toBe(1);
    expect(xml).toContain('custom:patched="true"');
    expect(xml).toContain('id="task_submit"');
    expect(xml).toContain('id="task_submit_input_5_assoc"');
    expect(xml).toContain('bpmnElement="task_submit_input_5"');
    expect(xml).toContain('bpmnElement="task_submit_output_1"');
    expect(xml).toContain('bpmnElement="task_submit_input_5_assoc"');
    expect(xml).toContain('bpmnElement="task_submit_output_1_assoc"');

    const parsed = parseBpmnLayout('relayout-generated-fixture', xml);
    expect(parsed.boxes.has('pool_customer')).toBe(true);
    expect(parsed.boxes.has('pool_supplier')).toBe(true);
    expect(parsed.boxes.has('task_submit_input_5')).toBe(true);
    expect(parsed.edges.some((edge) => edge.id === 'msgflow_order')).toBe(true);
  });

  it('preserves extension-heavy engine XML and complex event definitions', async () => {
    const generated = await layoutBpmnXml(FIX('14-timer-variants'), 'relayout-source-14');
    const patched = addEngineExtension(addCustomNamespace(generated.xml), 'task_main_with_boundary');
    const { xml } = await relayoutBpmnXml(patched);
    await expectImportable(xml);

    expect(xml).toContain('custom:assignee="${owner}"');
    expect(xml).toContain('<custom:executionListener event="start" class="demo.Listener" />');
    expect(xml).toContain('<bpmn:timeDate');
    expect(xml).toContain('2025-01-15T09:00:00Z');
    expect(xml).toContain('<bpmn:timeDuration');
    expect(xml).toContain('PT2H');
    expect(xml).toContain('<bpmn:timeCycle');
    expect(xml).toContain('R/PT30M');

    const parsed = parseBpmnLayout('relayout-engine-event-definitions', xml);
    expect(parsed.boxes.has('start_timer_date')).toBe(true);
    expect(parsed.boxes.has('boundary_timer_duration')).toBe(true);
    expect(parsed.boxes.has('boundary_timer_cycle_non_int')).toBe(true);
  });

  it('keeps callActivity called processes as definitions without rendering ghost DI', async () => {
    const generated = await layoutBpmnXml(FIX('22-call-activity'), 'relayout-source-22');
    const { xml } = await relayoutBpmnXml(generated.xml);
    await expectImportable(xml);

    expect(xml).toContain('id="process_reusable_approval"');
    expect(xml).toContain('calledElement="process_reusable_approval"');
    expect(xml).toContain('bpmnElement="call_subprocess_latest"');
    expect(xml).not.toContain('bpmnElement="sub_start"');
    expect(xml).not.toContain('bpmnElement="sub_task_review"');
  });

  it('renders one DI edge for dataInputAssociation with multiple sourceRefs and preserves assignments', async () => {
    const { xml } = await relayoutBpmnXml(xmlWithMultiSourceDataAssociation());
    await expectImportable(xml);

    expect(xml).toContain('<bpmn:assignment>');
    expect(xml).toContain('<bpmn:transformation>');
    expect(xml).toContain('bpmnElement="multi_input_assoc"');
    expect((xml.match(/bpmnElement="multi_input_assoc"/g) ?? []).length).toBe(1);
    expect(xml).toContain('bpmnElement="di_a"');
    expect(xml).toContain('bpmnElement="di_b"');
    expect(xml).toContain('bpmnElement="do_multi"');
  });

  it.each([
    ['13-boundary-events-all', ['task_with_timer_int', 'boundary_timer_interrupting']],
    ['21-subprocess-variants', ['subprocess_with_boundary', 'subprocess_nested_level1']],
    ['26-collaboration-lanes', ['pool_company', 'lane_sales', 'lane_finance']],
    ['27-collaboration-nested-lanes', ['pool_org', 'lane_management', 'lane_team_a']],
    ['29-collaboration-message-flows', ['pool_client', 'pool_server', 'msgflow_request']],
  ])('relayouts generated fixture XML for %s', async (fixtureName, expectedElements) => {
    const generated = await layoutBpmnXml(FIX(fixtureName), `relayout-source-${fixtureName}`);
    const { xml } = await relayoutBpmnXml(generated.xml);
    await expectImportable(xml);

    const parsed = parseBpmnLayout(`relayout-${fixtureName}`, xml);
    for (const elementId of expectedElements) {
      if (elementId.startsWith('msgflow_')) {
        expect(parsed.edges.some((edge) => edge.id === elementId)).toBe(true);
      } else {
        expect(parsed.boxes.has(elementId)).toBe(true);
      }
    }
  });
});

function addTaskIo(xml: string, taskId: string, inputCount: number, outputCount: number): string {
  const tagPattern = '(?:task|userTask|serviceTask|sendTask|receiveTask|scriptTask|manualTask|businessRuleTask)';
  const taskRe = new RegExp(`(<bpmn:(${tagPattern})\\b[^>]*\\bid="${escapeRegExp(taskId)}"[^>]*)(>)([\\s\\S]*?)(</bpmn:\\2>)`);
  const match = taskRe.exec(xml);
  if (!match) throw new Error(`Missing task ${taskId} in generated fixture XML`);

  const inputs = Array.from({ length: inputCount }, (_, index) => {
    const n = index + 1;
    return `      <bpmn:dataInput id="${taskId}_input_${n}" name="输入${n}" />`;
  }).join('\n');
  const outputs = Array.from({ length: outputCount }, (_, index) => {
    const n = index + 1;
    return `      <bpmn:dataOutput id="${taskId}_output_${n}" name="输出${n}" />`;
  }).join('\n');
  const inputRefs = Array.from({ length: inputCount }, (_, index) => {
    const n = index + 1;
    return `        <bpmn:dataInputRefs>${taskId}_input_${n}</bpmn:dataInputRefs>`;
  }).join('\n');
  const outputRefs = Array.from({ length: outputCount }, (_, index) => {
    const n = index + 1;
    return `        <bpmn:dataOutputRefs>${taskId}_output_${n}</bpmn:dataOutputRefs>`;
  }).join('\n');
  const inputAssociations = Array.from({ length: inputCount }, (_, index) => {
    const n = index + 1;
    return `    <bpmn:dataInputAssociation id="${taskId}_input_${n}_assoc"><bpmn:sourceRef>${taskId}_input_${n}</bpmn:sourceRef></bpmn:dataInputAssociation>`;
  }).join('\n');
  const outputAssociations = Array.from({ length: outputCount }, (_, index) => {
    const n = index + 1;
    return `    <bpmn:dataOutputAssociation id="${taskId}_output_${n}_assoc"><bpmn:targetRef>${taskId}_output_${n}</bpmn:targetRef></bpmn:dataOutputAssociation>`;
  }).join('\n');
  const io = `
    <bpmn:ioSpecification>
${inputs}
${outputs}
      <bpmn:inputSet id="${taskId}_inputSet_0">
${inputRefs}
      </bpmn:inputSet>
      <bpmn:outputSet id="${taskId}_outputSet_0">
${outputRefs}
      </bpmn:outputSet>
    </bpmn:ioSpecification>
${inputAssociations}
${outputAssociations}`;

  const open = `${match[1]} custom:patched="true"${match[3]}`;
  return xml.slice(0, match.index)
    + open
    + match[4]
    + io
    + match[5]
    + xml.slice(match.index + match[0].length);
}

function addCustomNamespace(xml: string): string {
  return xml.replace('<bpmn:definitions ', '<bpmn:definitions xmlns:custom="http://example.com/custom" ');
}

function addEngineExtension(xml: string, taskId: string): string {
  const taskRe = new RegExp(`(<bpmn:userTask\\b[^>]*\\bid="${escapeRegExp(taskId)}"[^>]*)(>)`);
  const match = taskRe.exec(xml);
  if (!match) throw new Error(`Missing userTask ${taskId}`);
  return xml.slice(0, match.index)
    + `${match[1]} custom:assignee="\${owner}"${match[2]}
      <bpmn:extensionElements>
        <custom:executionListener event="start" class="demo.Listener" />
      </bpmn:extensionElements>`
    + xml.slice(match.index + match[0].length);
}

function xmlWithMultiSourceDataAssociation(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_multi_data_assoc" targetNamespace="http://example.com">
  <bpmn:process id="Process_multi_data_assoc" isExecutable="true">
    <bpmn:startEvent id="start_multi"><bpmn:outgoing>flow_multi_1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:userTask id="task_multi_assoc" name="多输入任务">
      <bpmn:incoming>flow_multi_1</bpmn:incoming><bpmn:outgoing>flow_multi_2</bpmn:outgoing>
      <bpmn:ioSpecification>
        <bpmn:dataInput id="di_a" name="输入A" />
        <bpmn:dataInput id="di_b" name="输入B" />
        <bpmn:dataOutput id="do_multi" name="输出" />
        <bpmn:inputSet id="inputSet_multi">
          <bpmn:dataInputRefs>di_a</bpmn:dataInputRefs>
          <bpmn:dataInputRefs>di_b</bpmn:dataInputRefs>
        </bpmn:inputSet>
        <bpmn:outputSet id="outputSet_multi"><bpmn:dataOutputRefs>do_multi</bpmn:dataOutputRefs></bpmn:outputSet>
      </bpmn:ioSpecification>
      <bpmn:dataInputAssociation id="multi_input_assoc">
        <bpmn:sourceRef>di_a</bpmn:sourceRef>
        <bpmn:sourceRef>di_b</bpmn:sourceRef>
        <bpmn:targetRef>task_multi_assoc</bpmn:targetRef>
        <bpmn:assignment><bpmn:from>di_a + di_b</bpmn:from><bpmn:to>mergedInput</bpmn:to></bpmn:assignment>
        <bpmn:transformation>combine()</bpmn:transformation>
      </bpmn:dataInputAssociation>
      <bpmn:dataOutputAssociation id="multi_output_assoc"><bpmn:targetRef>do_multi</bpmn:targetRef></bpmn:dataOutputAssociation>
    </bpmn:userTask>
    <bpmn:endEvent id="end_multi"><bpmn:incoming>flow_multi_2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="flow_multi_1" sourceRef="start_multi" targetRef="task_multi_assoc" />
    <bpmn:sequenceFlow id="flow_multi_2" sourceRef="task_multi_assoc" targetRef="end_multi" />
  </bpmn:process>
</bpmn:definitions>`;
}

async function expectImportable(xml: string): Promise<void> {
  await expect(moddle.fromXML(xml)).resolves.toBeDefined();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
