import type { LaneBox, LayoutConstraint, LayoutDecision, NodeBox, PoolBox } from './types.ts';
import { POOL_HEADER_W, POOL_PAD_X } from '../layout/node-sizes.ts';

export type PreviousBoxes = Map<string, NodeBox>;

export interface IncrementalNodeMeta {
  poolId: string;
  laneId: string | null;
}

export interface IncrementalStabilizeInput {
  nodes: Map<string, NodeBox>;
  previousBoxes: PreviousBoxes;
  nodeMeta: Map<string, IncrementalNodeMeta>;
  poolBoxes: Map<string, PoolBox & { name?: string; isBlackBox?: boolean }>;
  laneBoxes: Map<string, LaneBox & { poolId: string }>;
}

export interface IncrementalStabilizeOutput {
  nodes: Map<string, NodeBox>;
  constraints: LayoutConstraint[];
  decisions: LayoutDecision[];
  appliedCount: number;
  skippedCount: number;
}

const SIZE_EPS = 0.001;
const OVERLAP_EPS = 0.001;

export function stabilizeWithPreviousBoxes(input: IncrementalStabilizeInput): IncrementalStabilizeOutput {
  if (input.previousBoxes.size === 0) {
    return {
      nodes: new Map(input.nodes),
      constraints: [],
      decisions: [],
      appliedCount: 0,
      skippedCount: 0,
    };
  }

  const nodes = new Map(input.nodes);
  const constraints: LayoutConstraint[] = [];
  const decisions: LayoutDecision[] = [];
  let appliedCount = 0;
  let skippedCount = 0;

  const orderedNodeIds = Array.from(nodes.keys()).sort((a, b) => {
    const ap = input.previousBoxes.has(a) ? 0 : 1;
    const bp = input.previousBoxes.has(b) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.localeCompare(b);
  });

  for (const nodeId of orderedNodeIds) {
    const current = nodes.get(nodeId)!;
    const previous = input.previousBoxes.get(nodeId);
    if (!previous) continue;

    constraints.push({
      kind: 'preserve-position',
      node: { kind: 'node', id: nodeId },
      previousBox: previous,
      strength: 'medium',
      reason: 'previous layout box is available as an incremental stability hint',
    });

    const meta = input.nodeMeta.get(nodeId);
    const skip = (reason: string): void => {
      skippedCount++;
      decisions.push({
        stage: 'IncrementalStabilizer',
        kind: 'incremental-preserve',
        subject: { kind: 'node', id: nodeId },
        reason,
        input: { previousX: previous.x, currentX: current.x },
        output: { applied: false, x: current.x },
      });
    };

    if (!meta) {
      skip('node has no stable pool/lane metadata');
      continue;
    }
    if (!sameSize(current, previous)) {
      skip('previous box size differs from current layout size');
      continue;
    }

    const pool = input.poolBoxes.get(meta.poolId);
    if (!pool) {
      skip('owning pool box is missing');
      continue;
    }
    const candidate = {
      ...current,
      x: clamp(previous.x, pool.x + POOL_HEADER_W + POOL_PAD_X, pool.x + pool.w - POOL_PAD_X - current.w),
    };

    if (sameBox(candidate, current)) {
      appliedCount++;
      decisions.push({
        stage: 'IncrementalStabilizer',
        kind: 'incremental-preserve',
        subject: { kind: 'node', id: nodeId },
        reason: 'current box already matches the previous safe position',
        input: { previousX: previous.x, currentX: current.x, poolId: meta.poolId, laneId: meta.laneId },
        output: { applied: true, x: candidate.x, deltaX: 0 },
      });
      continue;
    }

    const lane = meta.laneId ? input.laneBoxes.get(meta.laneId) : undefined;
    if (lane && !fitsLaneY(candidate, lane)) {
      skip('candidate would not fit its lane vertical band');
      continue;
    }
    if (!fitsPool(candidate, pool)) {
      skip('candidate would not fit inside its pool');
      continue;
    }
    if (overlapsPeer(candidate, nodeId, nodes, input.nodeMeta, meta)) {
      skip('candidate would overlap another node in the same pool/lane context');
      continue;
    }

    nodes.set(nodeId, candidate);
    appliedCount++;
    decisions.push({
      stage: 'IncrementalStabilizer',
      kind: 'incremental-preserve',
      subject: { kind: 'node', id: nodeId },
      reason: 'previous x-position passed bounds and overlap checks',
      input: { previousX: previous.x, currentX: current.x, poolId: meta.poolId, laneId: meta.laneId },
      output: { applied: true, x: candidate.x, deltaX: candidate.x - current.x },
    });
  }

  return { nodes, constraints, decisions, appliedCount, skippedCount };
}

function sameSize(a: NodeBox, b: NodeBox): boolean {
  return Math.abs(a.w - b.w) < SIZE_EPS && Math.abs(a.h - b.h) < SIZE_EPS;
}

function sameBox(a: NodeBox, b: NodeBox): boolean {
  return Math.abs(a.x - b.x) < SIZE_EPS
    && Math.abs(a.y - b.y) < SIZE_EPS
    && sameSize(a, b);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function fitsLaneY(box: NodeBox, lane: LaneBox): boolean {
  return box.y >= lane.top - OVERLAP_EPS && box.y + box.h <= lane.bottom + OVERLAP_EPS;
}

function fitsPool(box: NodeBox, pool: PoolBox): boolean {
  return box.x >= pool.x - OVERLAP_EPS
    && box.y >= pool.y - OVERLAP_EPS
    && box.x + box.w <= pool.x + pool.w + OVERLAP_EPS
    && box.y + box.h <= pool.y + pool.h + OVERLAP_EPS;
}

function overlapsPeer(
  candidate: NodeBox,
  nodeId: string,
  nodes: Map<string, NodeBox>,
  nodeMeta: Map<string, IncrementalNodeMeta>,
  meta: IncrementalNodeMeta,
): boolean {
  for (const [otherId, otherBox] of nodes) {
    if (otherId === nodeId) continue;
    const otherMeta = nodeMeta.get(otherId);
    if (!otherMeta) continue;
    if (otherMeta.poolId !== meta.poolId) continue;
    if (otherMeta.laneId !== meta.laneId) continue;
    if (rectsOverlap(candidate, otherBox)) return true;
  }
  return false;
}

function rectsOverlap(a: NodeBox, b: NodeBox): boolean {
  return a.x < b.x + b.w - OVERLAP_EPS
    && b.x < a.x + a.w - OVERLAP_EPS
    && a.y < b.y + b.h - OVERLAP_EPS
    && b.y < a.y + a.h - OVERLAP_EPS;
}
