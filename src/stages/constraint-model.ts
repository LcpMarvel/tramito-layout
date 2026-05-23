import type {
  EdgeRoute,
  LayoutConstraint,
  LayoutConstraintSummary,
  LayoutDecision,
  NodeBox,
  PoolBox,
} from './types.ts';

export interface NodeMembership {
  id: string;
  poolId: string | null;
  laneId: string | null;
}

export interface ContainmentConstraintInput {
  nodes: Iterable<NodeMembership>;
  lanes: Iterable<{ id: string; poolId: string }>;
}

export interface BoundaryConstraintInput {
  boundaryEvents: Iterable<{ id: string; hostId: string }>;
  boundaryEventBoxes?: Map<string, NodeBox>;
}

export function summarizeConstraints(constraints: readonly LayoutConstraint[]): LayoutConstraintSummary {
  const byKind: LayoutConstraintSummary['byKind'] = {};
  for (const c of constraints) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  }
  return { total: constraints.length, byKind };
}

export function collectPoolStackConstraints(
  poolBoxes: Map<string, PoolBox & { name?: string; isBlackBox?: boolean }>,
): LayoutConstraint[] {
  const pools = sortedPools(poolBoxes);
  if (pools.length < 2) return [];
  const minGap = Math.min(...pools.slice(1).map((p, i) => p.y - (pools[i]!.y + pools[i]!.h)));
  return [{
    kind: 'stack-vertical',
    subjects: pools.map(p => ({ kind: 'pool', id: p.id })),
    gap: minGap,
    strength: 'required',
    reason: 'collaboration participants must be vertically stacked',
  }];
}

export function collectPoolStackDecisions(
  poolBoxes: Map<string, PoolBox & { name?: string; isBlackBox?: boolean }>,
): LayoutDecision[] {
  return sortedPools(poolBoxes).map((p, index) => ({
    stage: 'PoolComposer',
    kind: 'pool-stack',
    subject: { kind: 'pool', id: p.id },
    reason: 'pool absolute y-position chosen by vertical composition',
    output: { index, x: p.x, y: p.y, width: p.w, height: p.h },
  }));
}

export function collectContainmentConstraints(input: ContainmentConstraintInput): LayoutConstraint[] {
  const constraints: LayoutConstraint[] = [];
  for (const lane of input.lanes) {
    constraints.push({
      kind: 'contains',
      parent: { kind: 'pool', id: lane.poolId },
      child: { kind: 'lane', id: lane.id },
      strength: 'required',
      reason: 'lane is declared inside the owning pool',
    });
  }
  for (const node of input.nodes) {
    if (node.poolId) {
      constraints.push({
        kind: 'contains',
        parent: { kind: 'pool', id: node.poolId },
        child: { kind: 'node', id: node.id },
        strength: 'required',
        reason: 'flow node must remain inside its owning pool',
      });
    }
    if (node.laneId) {
      constraints.push({
        kind: 'contains',
        parent: { kind: 'lane', id: node.laneId },
        child: { kind: 'node', id: node.id },
        strength: 'required',
        reason: 'flow node must remain inside its BPMN lane',
      });
    }
  }
  return constraints;
}

export function collectBoundaryConstraints(input: BoundaryConstraintInput): LayoutConstraint[] {
  const constraints: LayoutConstraint[] = [];
  for (const be of input.boundaryEvents) {
    constraints.push({
      kind: 'rides-boundary',
      node: { kind: 'node', id: be.id },
      host: { kind: 'node', id: be.hostId },
      side: 'bottom',
      strength: 'required',
      reason: 'boundary event must sit half-inside and half-outside its host',
    });
  }
  return constraints;
}

export function collectBoundaryDecisions(input: BoundaryConstraintInput): LayoutDecision[] {
  const decisions: LayoutDecision[] = [];
  for (const be of input.boundaryEvents) {
    const box = input.boundaryEventBoxes?.get(be.id);
    decisions.push({
      stage: 'DecorationPlacer',
      kind: 'boundary-placement',
      subject: { kind: 'node', id: be.id },
      reason: 'boundary event attached to host bottom side',
      input: { hostId: be.hostId, side: 'bottom' },
      output: box ? { x: box.x, y: box.y, width: box.w, height: box.h } : undefined,
    });
  }
  return decisions;
}

export function collectRouteConstraints(routes: Map<string, EdgeRoute>): LayoutConstraint[] {
  const constraints: LayoutConstraint[] = [];
  for (const route of routes.values()) {
    constraints.push({
      kind: 'port-side',
      port: { kind: 'port', id: `${route.edgeId}:source` },
      node: { kind: 'node', id: route.sourcePort.nodeId },
      side: route.sourcePort.side,
      strength: 'required',
      reason: 'edge source endpoint must use the router-selected port side',
    });
    constraints.push({
      kind: 'port-side',
      port: { kind: 'port', id: `${route.edgeId}:target` },
      node: { kind: 'node', id: route.targetPort.nodeId },
      side: route.targetPort.side,
      strength: 'required',
      reason: 'edge target endpoint must use the router-selected port side',
    });
  }
  return constraints;
}

export function collectRouteDecisions(routes: Map<string, EdgeRoute>): LayoutDecision[] {
  const decisions: LayoutDecision[] = [];
  for (const route of routes.values()) {
    decisions.push({
      stage: 'EdgeRouter',
      kind: 'edge-route',
      subject: { kind: 'edge', id: route.edgeId },
      reason: 'edge classification, channel, and finalized ports determine waypoints',
      output: {
        edgeType: route.edgeType,
        channel: route.channel,
        waypointCount: route.waypoints.length,
        sourceSide: route.sourcePort.side,
        targetSide: route.targetPort.side,
        sourceBoundary: route.sourcePort.boundary,
        targetBoundary: route.targetPort.boundary,
      },
    });
  }
  return decisions;
}

function sortedPools(poolBoxes: Map<string, PoolBox & { name?: string; isBlackBox?: boolean }>): PoolBox[] {
  return Array.from(poolBoxes.values()).sort((a, b) => (a.y - b.y) || a.id.localeCompare(b.id));
}
