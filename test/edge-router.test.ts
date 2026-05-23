import { describe, expect, it } from 'bun:test';
import { classify } from '../src/stages/edge-router/classifier.ts';
import { selectAnchors, anchorPoint } from '../src/stages/edge-router/anchor.ts';
import { allocateChannels } from '../src/stages/edge-router/channel.ts';
import { shapePath } from '../src/stages/edge-router/path-shaper.ts';
import { routeEdges, type RouteInput } from '../src/stages/edge-router/index.ts';
import { finalizeRoutePorts } from '../src/stages/edge-router/port.ts';
import { detourAroundLocalObstacles } from '../src/stages/edge-router/local-obstacle-detour.ts';
import type { NodeBox } from '../src/stages/types.ts';
import { CROSS_LANE_UP_MIN_START_STUB } from '../src/stages/bpmn-rules.ts';

const box = (x: number, y: number, w = 100, h = 80): NodeBox => ({ x, y, w, h });

function nodeMap(spec: Record<string, { box: NodeBox; type?: any; pool?: string; lane?: string | null; laneIdx?: number | null }>) {
  const m = new Map<string, any>();
  for (const [id, s] of Object.entries(spec)) {
    m.set(id, {
      box: s.box,
      type: s.type ?? 'task',
      poolId: s.pool ?? 'p1',
      laneId: s.lane ?? null,
      laneIdx: s.laneIdx ?? null,
    });
  }
  return m;
}

describe('Stage 4a — Classifier', () => {
  it('forward-straight when same cy and target on the right', () => {
    const nodes = nodeMap({
      a: { box: box(0, 100) }, b: { box: box(200, 100) },
    });
    expect(classify({ id: 'e', source: 'a', target: 'b' }, nodes)).toBe('forward-straight');
  });

  it('forward-step when target on the right but different cy', () => {
    const nodes = nodeMap({
      a: { box: box(0, 100) }, b: { box: box(200, 300) },
    });
    expect(classify({ id: 'e', source: 'a', target: 'b' }, nodes)).toBe('forward-step');
  });

  it('branch-down on gateway convergence with large dy (task → gateway below)', () => {
    // 收敛规则：tgt=gateway && src≠gateway && |dy| ≥ branchThreshold → branch-down/up。
    // 发散（src=gateway）已改回 forward-step（避免针眼小竖段），见 classifier.ts 注释。
    const nodes = nodeMap({
      a: { box: box(0, 100) },
      g: { box: box(200, 400, 50, 50), type: 'exclusiveGateway' },
    });
    expect(classify({ id: 'e', source: 'a', target: 'g' }, nodes)).toBe('branch-down');
  });

  it('forward-step on gateway divergence (src=gateway, target below)', () => {
    // 发散方向（src=gateway）走 Z 形 forward-step。
    const nodes = nodeMap({
      g: { box: box(0, 100, 50, 50), type: 'exclusiveGateway' },
      b: { box: box(200, 400) },
    });
    expect(classify({ id: 'e', source: 'g', target: 'b' }, nodes)).toBe('forward-step');
  });

  it('back-edge-up-left when target on left and slightly above (same-row loop)', () => {
    // dy 必须小于 rowThreshold (= src.h/2 + tgt.h/2 + 40 = 120)，否则归 back-row-up
    const nodes = nodeMap({
      a: { box: box(500, 200) }, b: { box: box(100, 150) },
    });
    expect(classify({ id: 'e', source: 'a', target: 'b' }, nodes)).toBe('back-edge-up-left');
  });

  it('back-row-up when target on left and well above (cross-row)', () => {
    const nodes = nodeMap({
      a: { box: box(500, 400) }, b: { box: box(100, 80) },
    });
    expect(classify({ id: 'e', source: 'a', target: 'b' }, nodes)).toBe('back-row-up');
  });

  it('cross-lane-down when target.laneIdx > source.laneIdx', () => {
    const nodes = nodeMap({
      a: { box: box(0, 100), lane: 'L0', laneIdx: 0 },
      b: { box: box(200, 300), lane: 'L1', laneIdx: 1 },
    });
    expect(classify({ id: 'e', source: 'a', target: 'b' }, nodes)).toBe('cross-lane-down');
  });

  it('cross-pool-down when target.poolId differs', () => {
    const nodes = nodeMap({
      a: { box: box(0, 100), pool: 'p1' },
      b: { box: box(200, 500), pool: 'p2' },
    });
    expect(classify({ id: 'e', source: 'a', target: 'b' }, nodes)).toBe('cross-pool-down');
  });

  it('boundary-to-handler when source is boundaryEvent', () => {
    const nodes = nodeMap({
      be: { box: box(100, 180, 36, 36), type: 'boundaryEvent' },
      h: { box: box(200, 300) },
    });
    expect(classify({ id: 'e', source: 'be', target: 'h' }, nodes)).toBe('boundary-to-handler');
  });
});

describe('Stage 4b — AnchorSelector', () => {
  it('returns right/left for forward-*', () => {
    expect(selectAnchors('forward-straight')).toEqual({ source: 'right', target: 'left' });
    expect(selectAnchors('forward-step')).toEqual({ source: 'right', target: 'left' });
  });

  it('returns bottom/top for cross-lane-down', () => {
    expect(selectAnchors('cross-lane-down')).toEqual({ source: 'bottom', target: 'top' });
  });

  it('returns bottom/bottom for back-edge-up-left (arch below)', () => {
    expect(selectAnchors('back-edge-up-left')).toEqual({ source: 'bottom', target: 'bottom' });
  });

  it('anchorPoint lands on the correct edge midpoint', () => {
    const b = box(100, 200, 100, 80);
    expect(anchorPoint(b, 'right')).toEqual({ x: 200, y: 240 });
    expect(anchorPoint(b, 'left')).toEqual({ x: 100, y: 240 });
    expect(anchorPoint(b, 'top')).toEqual({ x: 150, y: 200 });
    expect(anchorPoint(b, 'bottom')).toEqual({ x: 150, y: 280 });
  });
});

describe('Stage 4c — PathShaper', () => {
  it('forward-straight returns 2-point straight line', () => {
    const wps = shapePath({
      edgeType: 'forward-straight',
      sourceAnchor: 'right', targetAnchor: 'left',
      source: box(0, 100), target: box(200, 100),
      channel: 0,
    });
    expect(wps).toEqual([{ x: 100, y: 140 }, { x: 200, y: 140 }]);
  });

  it('forward-step returns Z-shape with 4 waypoints', () => {
    const wps = shapePath({
      edgeType: 'forward-step',
      sourceAnchor: 'right', targetAnchor: 'left',
      source: box(0, 100), target: box(300, 300),
      channel: 0,
    });
    expect(wps.length).toBe(4);
    expect(wps[0]).toEqual({ x: 100, y: 140 });
    expect(wps[3]).toEqual({ x: 300, y: 340 });
    // 中段两个点 X 相同（垂直段）
    expect(wps[1]!.x).toBe(wps[2]!.x);
  });

  it('branch-down vertical when same cx', () => {
    const wps = shapePath({
      edgeType: 'branch-down',
      sourceAnchor: 'bottom', targetAnchor: 'top',
      source: box(100, 100, 50, 50), target: box(100, 300, 50, 50),
      channel: 0,
    });
    expect(wps.length).toBe(2);
  });

  it('back-edge-up-left arches below source (bottom-bottom)', () => {
    const wps = shapePath({
      edgeType: 'back-edge-up-left',
      sourceAnchor: 'bottom', targetAnchor: 'bottom',
      source: box(400, 100), target: box(100, 100),
      channel: 0,
    });
    expect(wps.length).toBe(4);
    expect(wps[0]).toEqual({ x: 450, y: 180 });
    expect(wps[3]).toEqual({ x: 150, y: 180 });
    // 中段 Y > source.bottom (拱在下方)
    expect(wps[1]!.y).toBeGreaterThan(180);
    expect(wps[2]!.y).toBe(wps[1]!.y); // 平移段同 Y
  });

  it('back-edge channel separates parallel arches', () => {
    const w0 = shapePath({
      edgeType: 'back-edge-up-left',
      sourceAnchor: 'bottom', targetAnchor: 'bottom',
      source: box(400, 100), target: box(100, 100),
      channel: 0,
    });
    const w1 = shapePath({
      edgeType: 'back-edge-up-left',
      sourceAnchor: 'bottom', targetAnchor: 'bottom',
      source: box(400, 100), target: box(100, 100),
      channel: 1,
    });
    expect(w1[1]!.y).toBeGreaterThan(w0[1]!.y);
  });
});

describe('Stage 4d — ChannelAllocator', () => {
  it('assigns 0..N-1 by source.x ascending for parallel back-edges', () => {
    const out = allocateChannels([
      { id: 'e1', edgeType: 'back-edge-up-left', sourceX: 500 },
      { id: 'e2', edgeType: 'back-edge-up-left', sourceX: 200 },
      { id: 'e3', edgeType: 'back-edge-up-left', sourceX: 800 },
    ]);
    expect(out.get('e2')?.channel).toBe(0);
    expect(out.get('e1')?.channel).toBe(1);
    expect(out.get('e3')?.channel).toBe(2);
    expect(out.get('e1')?.total).toBe(3);
  });

  it('separates buckets between back-up and back-down', () => {
    const out = allocateChannels([
      { id: 'a', edgeType: 'back-edge-up-left', sourceX: 100 },
      { id: 'b', edgeType: 'back-edge-down-left', sourceX: 200 },
    ]);
    expect(out.get('a')?.channel).toBe(0);
    expect(out.get('b')?.channel).toBe(0);
  });

  it('defaults to 0 for non-channelized edges', () => {
    const out = allocateChannels([
      { id: 'a', edgeType: 'forward-straight', sourceX: 0 },
    ]);
    expect(out.get('a')?.channel).toBe(0);
  });
});

describe('Stage 4 — routeEdges integration', () => {
  it('routes a mixed bag without throwing', () => {
    const input: RouteInput = {
      nodes: nodeMap({
        a: { box: box(0, 100) }, b: { box: box(200, 100) },
        c: { box: box(400, 100) }, back: { box: box(600, 100) },
      }),
      edges: [
        { id: 'f1', source: 'a', target: 'b', bpmnType: 'sequenceFlow' },
        { id: 'f2', source: 'b', target: 'c', bpmnType: 'sequenceFlow' },
        { id: 'loop', source: 'back', target: 'a', bpmnType: 'sequenceFlow' },
      ],
      laneBoxes: new Map(),
      poolBoxes: new Map(),
    };
    const out = routeEdges(input);
    expect(out.routes.size).toBe(3);
    expect(out.routes.get('f1')!.edgeType).toBe('forward-straight');
    // 同 cy 时 dy >= 0 → down-left（在 source 下方拱）
    expect(out.routes.get('loop')!.edgeType).toBe('back-edge-down-left');
    // 每条 edge 至少 2 waypoints
    for (const r of out.routes.values()) {
      expect(r.waypoints.length).toBeGreaterThanOrEqual(2);
      expect(r.sourcePort.point).toEqual(r.waypoints[0]!);
      expect(r.targetPort.point).toEqual(r.waypoints[r.waypoints.length - 1]!);
    }
  });

  it('exposes source/target ports on routes', () => {
    const input: RouteInput = {
      nodes: nodeMap({
        a: { box: box(0, 100) },
        b: { box: box(200, 100) },
      }),
      edges: [{ id: 'f1', source: 'a', target: 'b', bpmnType: 'sequenceFlow' }],
      laneBoxes: new Map(),
      poolBoxes: new Map(),
    };
    const route = routeEdges(input).routes.get('f1')!;
    expect(route.sourcePort).toEqual({
      nodeId: 'a',
      side: 'right',
      point: route.waypoints[0]!,
      boundary: 'box',
    });
    expect(route.targetPort).toEqual({
      nodeId: 'b',
      side: 'left',
      point: route.waypoints[route.waypoints.length - 1]!,
      boundary: 'box',
    });
  });

  it('keeps same-lane forward skip arches outside source/target boxes', () => {
    const input: RouteInput = {
      nodes: nodeMap({
        match: { box: box(1388, 366), type: 'serviceTask', lane: 'sales', laneIdx: 0 },
        fastEnd: { box: box(1518, 388, 36, 36), type: 'endEvent', lane: 'sales', laneIdx: 0 },
        normalEnd: { box: box(1588, 388, 36, 36), type: 'endEvent', lane: 'sales', laneIdx: 0 },
      }),
      edges: [{ id: 'flow_8', source: 'match', target: 'normalEnd', bpmnType: 'sequenceFlow' }],
      laneBoxes: new Map(),
      poolBoxes: new Map(),
    };

    const route = routeEdges(input).routes.get('flow_8')!;
    expect(route.edgeType).toBe('forward-straight');
    expect(route.sourcePort.side).toBe('top');
    expect(route.targetPort.side).toBe('top');
    expect(route.waypoints[1]!.y).toBeLessThan(route.waypoints[0]!.y);
    expect(route.waypoints.every((point) => point.x >= route.waypoints[0]!.x)).toBe(true);
  });

  it('routes gateway forward skips below intermediate gateway labels', () => {
    const input: RouteInput = {
      nodes: nodeMap({
        g: { box: box(0, 100, 50, 50), type: 'exclusiveGateway', lane: 'sales', laneIdx: 0 },
        skipped: { box: box(100, 100, 50, 50), type: 'exclusiveGateway', lane: 'sales', laneIdx: 0 },
        task: { box: box(250, 85, 100, 80), type: 'userTask', lane: 'sales', laneIdx: 0 },
      }),
      edges: [{ id: 'internal', source: 'g', target: 'task', bpmnType: 'sequenceFlow' }],
      laneBoxes: new Map(),
      poolBoxes: new Map(),
    };

    const route = routeEdges(input).routes.get('internal')!;
    expect(route.edgeType).toBe('forward-straight');
    expect(route.sourcePort.side).toBe('bottom');
    expect(route.targetPort.side).toBe('bottom');
    expect(route.waypoints[1]!.y).toBeGreaterThan(route.waypoints[0]!.y);
  });

  it('enters cross-lane targets from the left when the target is to the right', () => {
    const input: RouteInput = {
      nodes: nodeMap({
        fork: { box: box(100, 100, 50, 50), type: 'parallelGateway', lane: 'upper', laneIdx: 0 },
        copy: { box: box(260, 240, 100, 80), type: 'userTask', lane: 'lower', laneIdx: 1 },
      }),
      edges: [{ id: 'copy', source: 'fork', target: 'copy', bpmnType: 'sequenceFlow' }],
      laneBoxes: new Map([
        ['upper', { top: 80, bottom: 200, centerY: 140, height: 120, poolId: 'p1' }],
        ['lower', { top: 200, bottom: 340, centerY: 270, height: 140, poolId: 'p1' }],
      ]),
      poolBoxes: new Map(),
    };

    const route = routeEdges(input).routes.get('copy')!;
    expect(route.edgeType).toBe('cross-lane-down');
    expect(route.sourcePort.side).toBe('bottom');
    expect(route.targetPort.side).toBe('left');
    expect(route.targetPort.point).toEqual({ x: 260, y: 280 });
    expect(route.waypoints.at(-2)!.y).toBe(280);
  });

  it('treats serializer-only ioSpecification shapes as route obstacles', () => {
    const input: RouteInput = {
      nodes: nodeMap({
        a: { box: box(0, 100) },
        b: { box: box(300, 100) },
      }),
      edges: [{ id: 'f1', source: 'a', target: 'b', bpmnType: 'sequenceFlow' }],
      laneBoxes: new Map(),
      poolBoxes: new Map(),
      routeObstacles: [{ poolId: 'p1', box: box(150, 120, 36, 50) }],
    };

    const route = routeEdges(input).routes.get('f1')!;
    expect(route.waypoints.length).toBe(4);
    expect(route.waypoints[1]!.y).toBeLessThan(120);
    expect(route.waypoints[2]!.y).toBeLessThan(120);
  });

  it('starts cross-lane-up back links with a visible vertical stub', () => {
    const input: RouteInput = {
      nodes: nodeMap({
        notify: { box: box(2250, 621, 100, 80), lane: 'manager', laneIdx: 2 },
        receive: { box: box(1328, 440, 36, 36), type: 'intermediateCatchEvent', lane: 'director', laneIdx: 1 },
      }),
      edges: [{ id: 'notify-to-receive', source: 'notify', target: 'receive', bpmnType: 'sequenceFlow' }],
      laneBoxes: new Map([
        ['director', { top: 395, bottom: 602, centerY: 498.5, height: 207, poolId: 'p1' }],
        ['manager', { top: 602, bottom: 809, centerY: 705.5, height: 207, poolId: 'p1' }],
      ]),
      poolBoxes: new Map(),
    };

    const route = routeEdges(input).routes.get('notify-to-receive')!;
    expect(route.edgeType).toBe('cross-lane-up');
    expect(route.sourcePort.side).toBe('top');
    expect(route.waypoints[1]!.x).toBe(route.waypoints[0]!.x);
    expect(route.waypoints[1]!.y).toBeLessThanOrEqual(route.waypoints[0]!.y - CROSS_LANE_UP_MIN_START_STUB);
  });

  it('keeps the final segment perpendicular when detouring near a target', () => {
    const out = detourAroundLocalObstacles({
      waypoints: [
        { x: 1308, y: 112 },
        { x: 1308, y: 212 },
        { x: 112, y: 212 },
        { x: 112, y: 312 },
      ],
      obstacles: [box(110, 224)],
      targetSelf: box(62, 312),
    });

    expect(out.changed).toBe(true);
    expect(out.waypoints.at(-1)).toEqual({ x: 100, y: 312 });
    expect(out.waypoints.at(-2)).toEqual({ x: 100, y: 212 });
    expect(out.waypoints.length).toBe(4);
  });

  it('finalizes gateway ports on the diamond boundary', () => {
    const out = finalizeRoutePorts({
      sourceId: 'task',
      targetId: 'gateway',
      sourceType: 'task',
      targetType: 'exclusiveGateway',
      sourceBox: box(0, 100),
      targetBox: box(200, 100, 50, 50),
      sourceSide: 'right',
      targetSide: 'left',
      waypoints: [
        { x: 100, y: 115 },
        { x: 150, y: 115 },
        { x: 200, y: 115 },
      ],
    });
    expect(out.targetPort.boundary).toBe('diamond');
    expect(out.targetPort.point).toEqual({ x: 210, y: 115 });
    expect(out.waypoints[out.waypoints.length - 1]).toEqual(out.targetPort.point);
  });
});
