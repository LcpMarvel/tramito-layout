import { describe, expect, it } from 'bun:test';
import { ModelBuilder } from '../src/serializer/transform/model-builder.ts';
import type { LayoutedGraph } from '../src/serializer/types/elk-output.ts';

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
});
