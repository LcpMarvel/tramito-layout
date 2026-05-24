import { describe, expect, it } from 'bun:test';
import { ModelBuilder } from '../src/serializer/transform/model-builder.ts';
import type { BoundsModel } from '../src/serializer/transform/model-types.ts';
import type { LayoutedGraph } from '../src/serializer/types/elk-output.ts';

function boundsOverlap(a: BoundsModel, b: BoundsModel): boolean {
  return a.x < b.x + b.width
    && b.x < a.x + a.width
    && a.y < b.y + b.height
    && b.y < a.y + a.height;
}

describe('model builder', () => {
  it('rejects data associations without endpoints', () => {
    const graph: LayoutedGraph = {
      id: 'defs',
      children: [{
        id: 'proc',
        bpmn: { type: 'process' },
        children: [{
          id: 'task_a',
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          bpmn: { type: 'task' },
        }],
        edges: [{
          id: 'data_assoc_without_source',
          sources: [],
          targets: ['task_a'],
          bpmn: { type: 'dataInputAssociation' },
          sections: [],
        }],
      }],
    } as LayoutedGraph;

    expect(() => new ModelBuilder().build(graph)).toThrow(
      '[model-builder] dataInputAssociation data_assoc_without_source missing source endpoint',
    );
  });

  it('keeps paired ioSpecification data labels from overlapping', () => {
    const graph: LayoutedGraph = {
      id: 'defs',
      children: [{
        id: 'proc',
        bpmn: { type: 'process' },
        children: [{
          id: 'task_38',
          x: 100,
          y: 100,
          width: 100,
          height: 80,
          bpmn: {
            type: 'userTask',
            name: '调味',
            ioSpecification: {
              dataInputs: [{ id: 'di_39', name: '盐、生抽、白胡椒粉' }],
              dataOutputs: [{ id: 'do_40', name: '调味后的炒饭' }],
            },
          },
        }],
        edges: [],
      }],
    } as LayoutedGraph;

    const model = new ModelBuilder().build(graph);
    const inputShape = model.diagram.plane.shapes.find((s) => s.bpmnElement === 'di_39');
    const outputShape = model.diagram.plane.shapes.find((s) => s.bpmnElement === 'do_40');
    const inputLabel = inputShape?.label?.bounds;
    const outputLabel = outputShape?.label?.bounds;

    expect(inputShape).toBeDefined();
    expect(outputShape).toBeDefined();
    expect(inputLabel).toBeDefined();
    expect(outputLabel).toBeDefined();
    expect(boundsOverlap(inputLabel!, outputLabel!)).toBe(false);
    expect(inputLabel!.width).toBe(100);
    expect(inputLabel!.height).toBe(28);
    expect(outputLabel!.width).toBe(84);
    expect(outputLabel!.height).toBe(14);
    expect(outputShape!.bounds.y).toBe(inputLabel!.y + inputLabel!.height + 6);
    expect(outputLabel!.y).toBe(outputShape!.bounds.y + outputShape!.bounds.height + 4);
    expect(inputLabel!.x).toBe(inputShape!.bounds.x + (inputShape!.bounds.width - inputLabel!.width) / 2);
    expect(outputLabel!.x).toBe(outputShape!.bounds.x + (outputShape!.bounds.width - outputLabel!.width) / 2);
  });
});
