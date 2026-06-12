import { describe, expect, test } from 'bun:test';
import { resolveBackEdges, type BackEdgeInput } from '../src/stages/back-edge-resolver.ts';

const node = (id: string, type: any = 'task') => ({ id, type });

describe('resolveBackEdges', () => {
  test('无环图返回空集', () => {
    const input: BackEdgeInput = {
      nodes: [node('s', 'startEvent'), node('a'), node('b'), node('e', 'endEvent')],
      edges: [
        { id: 'e1', source: 's', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'e' },
      ],
    };
    expect(resolveBackEdges(input).size).toBe(0);
  });

  test('审批双环（fixture 45）：两条「不通过」default 回头边被反转，主干不动', () => {
    // start → 修图 → 经理审核 → gw4 →(通过) 客户审核 → gw6 →(通过) end
    //                  ↑____________|不通过(default)        |
    //         ↑_________________________________|不通过(default)
    const input: BackEdgeInput = {
      nodes: [
        node('start_1', 'startEvent'),
        node('task_2', 'userTask'),
        node('task_3', 'userTask'),
        node('gateway_4', 'exclusiveGateway'),
        node('task_5', 'userTask'),
        node('gateway_6', 'exclusiveGateway'),
        node('end_7', 'endEvent'),
      ],
      edges: [
        { id: 'flow_8', source: 'start_1', target: 'task_2' },
        { id: 'flow_9b', source: 'task_2', target: 'task_3' },
        { id: 'flow_10', source: 'task_3', target: 'gateway_4' },
        { id: 'flow_11', source: 'gateway_4', target: 'task_5', label: '通过' },
        { id: 'flow_12', source: 'gateway_4', target: 'task_2', isDefault: true, label: '不通过' },
        { id: 'flow_13', source: 'task_5', target: 'gateway_6' },
        { id: 'flow_14', source: 'gateway_6', target: 'end_7', label: '通过' },
        { id: 'flow_9', source: 'gateway_6', target: 'task_3', isDefault: true, label: '不通过' },
      ],
    };
    const reversed = resolveBackEdges(input);
    expect(reversed).toEqual(new Set(['flow_12', 'flow_9']));
  });

  test('语义加权：无 default/label 时按声明顺序断环（指向更早节点的边当回头边）', () => {
    const input: BackEdgeInput = {
      nodes: [node('s', 'startEvent'), node('a'), node('b'), node('e', 'endEvent')],
      edges: [
        { id: 'e1', source: 's', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'loop', source: 'b', target: 'a' },
        { id: 'e3', source: 'b', target: 'e' },
      ],
    };
    expect(resolveBackEdges(input)).toEqual(new Set(['loop']));
  });

  test('反转后图必无环（多环压力：嵌套环 + 自环外的交叉环）', () => {
    const input: BackEdgeInput = {
      nodes: [node('s', 'startEvent'), node('a'), node('b'), node('c'), node('d'), node('e', 'endEvent')],
      edges: [
        { id: 'e1', source: 's', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'c' },
        { id: 'e4', source: 'c', target: 'd' },
        { id: 'e5', source: 'd', target: 'e' },
        { id: 'l1', source: 'c', target: 'a' },
        { id: 'l2', source: 'd', target: 'b' },
        { id: 'l3', source: 'd', target: 'a' },
      ],
    };
    const reversed = resolveBackEdges(input);
    // 验证反转后无环：Kahn 拓扑排序应消费完所有节点
    const adj = new Map<string, string[]>();
    const inDeg = new Map<string, number>();
    for (const n of input.nodes) { adj.set(n.id, []); inDeg.set(n.id, 0); }
    for (const e of input.edges) {
      const src = reversed.has(e.id) ? e.target : e.source;
      const tgt = reversed.has(e.id) ? e.source : e.target;
      adj.get(src)!.push(tgt);
      inDeg.set(tgt, (inDeg.get(tgt) ?? 0) + 1);
    }
    const queue = input.nodes.map(n => n.id).filter(id => inDeg.get(id) === 0);
    let consumed = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      consumed++;
      for (const next of adj.get(id)!) {
        const d = inDeg.get(next)! - 1;
        inDeg.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    expect(consumed).toBe(input.nodes.length);
  });

  test('不可达孤岛里的环也能断', () => {
    const input: BackEdgeInput = {
      nodes: [node('s', 'startEvent'), node('e', 'endEvent'), node('x'), node('y')],
      edges: [
        { id: 'e1', source: 's', target: 'e' },
        { id: 'c1', source: 'x', target: 'y' },
        { id: 'c2', source: 'y', target: 'x' },
      ],
    };
    const reversed = resolveBackEdges(input);
    expect(reversed.size).toBe(1);
  });
});
