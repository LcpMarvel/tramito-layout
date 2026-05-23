import type { FlowNodeType } from '../loader/types.ts';
import type { LayoutedGraph } from '../serializer/types/elk-output.ts';
import type { EdgeRoute, LaneBox, NodeBox, PoolBox, Waypoint } from '../stages/types.ts';
import type { ParsedFixture } from '../evaluation/layout-evaluator.ts';

export type DebugStage =
  | 'loader'
  | 'subprocess-layout'
  | 'elk-placement'
  | 'lane-constrainer'
  | 'pool-composer'
  | 'subprocess-translator'
  | 'decoration-placer'
  | 'artifact-placer'
  | 'pool-overflow-rebalancer'
  | 'edge-router'
  | 'association-router'
  | 'merger'
  | 'serializer';

export interface SnapshotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapshotNode extends SnapshotRect {
  type: string;
  poolId?: string;
  laneId?: string;
  parentId?: string;
  visualBox?: SnapshotRect;
  layoutBox?: SnapshotRect;
}

export interface SnapshotEdge {
  id: string;
  kind: 'sequenceFlow' | 'messageFlow' | 'association';
  source: string;
  target: string;
  edgeType?: string;
  waypoints: Waypoint[];
  sourcePort?: { side: string; x: number; y: number };
  targetPort?: { side: string; x: number; y: number };
}

export interface StageSnapshot {
  fixture: string;
  stage: DebugStage;
  order: number;
  nodes: Record<string, SnapshotNode>;
  edges: Record<string, SnapshotEdge>;
  pools: Record<string, SnapshotRect>;
  lanes: Record<string, SnapshotRect>;
  labels: Record<string, SnapshotRect>;
  notes: string[];
}

export interface SnapshotNodeMeta {
  type?: FlowNodeType | string;
  poolId?: string | null;
  laneId?: string | null;
  parentId?: string | null;
  visualBox?: NodeBox;
  layoutBox?: NodeBox;
}

export interface SnapshotEdgeInput {
  id: string;
  kind?: SnapshotEdge['kind'];
  source: string;
  target: string;
  edgeType?: string;
  waypoints?: Waypoint[];
  sourcePort?: EdgeRoute['sourcePort'];
  targetPort?: EdgeRoute['targetPort'];
}

export interface SnapshotInput {
  fixture: string;
  stage: DebugStage;
  order: number;
  nodes?: Map<string, NodeBox>;
  nodeMeta?: Map<string, SnapshotNodeMeta>;
  edges?: Iterable<SnapshotEdgeInput>;
  pools?: Map<string, SnapshotRect | PoolBox>;
  lanes?: Map<string, SnapshotRect | (LaneBox & { poolId?: string })>;
  labels?: Map<string, SnapshotRect>;
  notes?: string[];
}

export function createStageSnapshot(input: SnapshotInput): StageSnapshot {
  const nodes: Record<string, SnapshotNode> = {};
  for (const [id, box] of input.nodes ?? []) {
    const meta = input.nodeMeta?.get(id);
    nodes[id] = {
      ...rectFromNodeBox(box),
      type: meta?.type ?? 'unknown',
      ...(meta?.poolId ? { poolId: meta.poolId } : {}),
      ...(meta?.laneId ? { laneId: meta.laneId } : {}),
      ...(meta?.parentId ? { parentId: meta.parentId } : {}),
      ...(meta?.visualBox ? { visualBox: rectFromNodeBox(meta.visualBox) } : {}),
      ...(meta?.layoutBox ? { layoutBox: rectFromNodeBox(meta.layoutBox) } : {}),
    };
  }

  const edges: Record<string, SnapshotEdge> = {};
  for (const edge of input.edges ?? []) {
    edges[edge.id] = {
      id: edge.id,
      kind: edge.kind ?? 'sequenceFlow',
      source: edge.source,
      target: edge.target,
      ...(edge.edgeType ? { edgeType: edge.edgeType } : {}),
      waypoints: edge.waypoints?.map(p => ({ x: p.x, y: p.y })) ?? [],
      ...(edge.sourcePort ? {
        sourcePort: {
          side: edge.sourcePort.side,
          x: edge.sourcePort.point.x,
          y: edge.sourcePort.point.y,
        },
      } : {}),
      ...(edge.targetPort ? {
        targetPort: {
          side: edge.targetPort.side,
          x: edge.targetPort.point.x,
          y: edge.targetPort.point.y,
        },
      } : {}),
    };
  }

  return {
    fixture: input.fixture,
    stage: input.stage,
    order: input.order,
    nodes,
    edges,
    pools: rectMapToRecord(input.pools),
    lanes: rectMapToRecord(input.lanes),
    labels: rectMapToRecord(input.labels),
    notes: input.notes ?? [],
  };
}

export function edgeRouteToSnapshotInput(
  id: string,
  route: EdgeRoute,
  source: string,
  target: string,
  kind: SnapshotEdge['kind'],
): SnapshotEdgeInput {
  return {
    id,
    source,
    target,
    kind,
    edgeType: route.edgeType,
    waypoints: route.waypoints,
    sourcePort: route.sourcePort,
    targetPort: route.targetPort,
  };
}

export function snapshotFromLayoutedGraph(
  fixture: string,
  stage: DebugStage,
  order: number,
  graph: LayoutedGraph,
  notes: string[] = [],
): StageSnapshot {
  const nodes = new Map<string, NodeBox>();
  const nodeMeta = new Map<string, SnapshotNodeMeta>();
  const pools = new Map<string, SnapshotRect>();
  const lanes = new Map<string, SnapshotRect>();
  const labels = new Map<string, SnapshotRect>();
  const edges: SnapshotEdgeInput[] = [];

  const walk = (
    node: any,
    baseX: number,
    baseY: number,
    parentId: string | null,
    poolId: string | null,
    laneId: string | null,
  ): void => {
    if (!node || typeof node !== 'object') return;
    const type = node.bpmn?.type ?? node.type;
    const hasBox = typeof node.x === 'number'
      && typeof node.y === 'number'
      && typeof node.width === 'number'
      && typeof node.height === 'number';
    const absX = baseX + (typeof node.x === 'number' ? node.x : 0);
    const absY = baseY + (typeof node.y === 'number' ? node.y : 0);

    let nextPoolId = poolId;
    let nextLaneId = laneId;
    if (hasBox && typeof node.id === 'string') {
      const rect = { x: absX, y: absY, w: node.width, h: node.height };
      if (type === 'participant' || type === 'process' || type === 'collaboration') {
        pools.set(node.id, rect);
        nextPoolId = node.id;
      } else if (type === 'lane') {
        lanes.set(node.id, rect);
        nextLaneId = node.id;
      } else {
        nodes.set(node.id, rect);
        nodeMeta.set(node.id, {
          type: type ?? 'unknown',
          poolId: nextPoolId,
          laneId: nextLaneId,
          parentId,
        });
      }
    }

    collectLabels(node, labels);
    collectEdges(node, edges);

    for (const boundaryEvent of node.boundaryEvents ?? []) {
      if (typeof boundaryEvent.x === 'number'
        && typeof boundaryEvent.y === 'number'
        && typeof boundaryEvent.width === 'number'
        && typeof boundaryEvent.height === 'number') {
        const rect = {
          x: boundaryEvent.x,
          y: boundaryEvent.y,
          w: boundaryEvent.width,
          h: boundaryEvent.height,
        };
        nodes.set(boundaryEvent.id, rect);
        nodeMeta.set(boundaryEvent.id, {
          type: boundaryEvent.bpmn?.type ?? 'boundaryEvent',
          poolId: nextPoolId,
          laneId: nextLaneId,
          parentId: node.id,
        });
        collectLabels(boundaryEvent, labels);
      }
    }

    const childBaseX = hasBox ? absX : baseX;
    const childBaseY = hasBox ? absY : baseY;
    for (const child of node.children ?? []) {
      walk(child, childBaseX, childBaseY, node.id ?? parentId, nextPoolId, nextLaneId);
    }
    for (const artifact of node.artifacts ?? []) {
      walk(artifact, childBaseX, childBaseY, node.id ?? parentId, nextPoolId, nextLaneId);
    }
  };

  walk(graph, 0, 0, null, null, null);
  return createStageSnapshot({ fixture, stage, order, nodes, nodeMeta, edges, pools, lanes, labels, notes });
}

export function snapshotFromParsedFixture(
  parsed: ParsedFixture,
  stage: DebugStage,
  order: number,
  notes: string[] = [],
): StageSnapshot {
  const nodes = new Map<string, NodeBox>();
  const nodeMeta = new Map<string, SnapshotNodeMeta>();
  const pools = new Map<string, SnapshotRect>();
  const lanes = new Map<string, SnapshotRect>();
  const labels = new Map<string, SnapshotRect>();
  const edges: SnapshotEdgeInput[] = [];

  for (const [id, box] of parsed.boxes) {
    const kind = parsed.kindOf.get(id) ?? 'other';
    const rect = { x: box.x, y: box.y, w: box.w, h: box.h };
    if (kind === 'pool' || kind === 'process' || kind === 'collaboration') {
      pools.set(id, rect);
    } else if (kind === 'lane') {
      lanes.set(id, rect);
    } else {
      nodes.set(id, rect);
      nodeMeta.set(id, { type: parsed.bpmnTagOf.get(id) ?? kind });
    }
  }

  for (const [ownerId, label] of parsed.labels) {
    labels.set(ownerId, { x: label.x, y: label.y, w: label.w, h: label.h });
  }

  for (const edge of parsed.edges) {
    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edgeKindFromBpmnType(edge.bpmnType),
      waypoints: edge.waypoints,
    });
  }

  return createStageSnapshot({
    fixture: parsed.fixture,
    stage,
    order,
    nodes,
    nodeMeta,
    edges,
    pools,
    lanes,
    labels,
    notes,
  });
}

function collectLabels(node: any, out: Map<string, SnapshotRect>): void {
  for (const label of node.labels ?? []) {
    if (typeof label.x !== 'number'
      || typeof label.y !== 'number'
      || typeof label.width !== 'number'
      || typeof label.height !== 'number') {
      continue;
    }
    const ownerId = typeof node.id === 'string' ? node.id : 'unknown';
    out.set(ownerId, { x: label.x, y: label.y, w: label.width, h: label.height });
  }
}

function collectEdges(node: any, out: SnapshotEdgeInput[]): void {
  for (const edge of node.edges ?? []) {
    const section = edge.sections?.[0];
    const source = edge.sources?.[0];
    const target = edge.targets?.[0];
    if (!edge.id || !source || !target) continue;
    const waypoints = section
      ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
        .filter((p: any): p is Waypoint => p && typeof p.x === 'number' && typeof p.y === 'number')
      : [];
    out.push({
      id: edge.id,
      source,
      target,
      kind: edgeKindFromBpmnType(edge.bpmn?.type),
      waypoints,
    });
  }
}

function edgeKindFromBpmnType(type: string | undefined): SnapshotEdge['kind'] {
  if (type === 'messageFlow') return 'messageFlow';
  if (type === 'association' || type === 'dataInputAssociation' || type === 'dataOutputAssociation') {
    return 'association';
  }
  return 'sequenceFlow';
}

function rectFromNodeBox(box: NodeBox): SnapshotRect {
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

function rectMapToRecord(
  input: Map<string, SnapshotRect | PoolBox | (LaneBox & { poolId?: string })> | undefined,
): Record<string, SnapshotRect> {
  const out: Record<string, SnapshotRect> = {};
  for (const [id, value] of input ?? []) {
    if ('w' in value && 'h' in value) {
      out[id] = { x: value.x, y: value.y, w: value.w, h: value.h };
    } else {
      out[id] = { x: 0, y: value.top, w: 0, h: value.height };
    }
  }
  return out;
}
