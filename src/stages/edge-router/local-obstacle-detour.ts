import type { NodeBox, Waypoint } from '../types.ts';

export interface LocalObstacleDetourInput {
  waypoints: Waypoint[];
  obstacles: NodeBox[];
  sourceSelf?: NodeBox;
  targetSelf?: NodeBox;
  margin?: number;
}

export interface LocalObstacleDetourOutput {
  waypoints: Waypoint[];
  changed: boolean;
}

const ENDPOINT_STUB = 8;
const ENDPOINT_CLEARANCE = 2;

/**
 * Second-pass obstacle clearance for routes whose final stage-level transforms
 * (bus routing, handler shifts, cross-pool corridors) can place an orthogonal
 * segment through a node that the initial path shaper did not clear.
 */
export function detourAroundLocalObstacles(input: LocalObstacleDetourInput): LocalObstacleDetourOutput {
  const waypoints = input.waypoints.map((p) => ({ x: p.x, y: p.y }));
  if (waypoints.length < 2 || input.obstacles.length === 0) {
    return { waypoints, changed: false };
  }

  const margin = input.margin ?? 10;
  const findClearance = (
    preferred: number,
    direction: 1 | -1,
    intervals: Array<{ lo: number; hi: number }>,
  ): number => {
    const merged = mergeIntervals(intervals, margin);
    if (direction === 1) {
      for (const iv of merged) {
        if (preferred >= iv.hi) continue;
        if (preferred <= iv.lo) return preferred;
        preferred = iv.hi;
      }
      return preferred;
    }
    for (let i = merged.length - 1; i >= 0; i--) {
      const iv = merged[i];
      if (!iv) continue;
      if (preferred <= iv.lo) continue;
      if (preferred >= iv.hi) return preferred;
      preferred = iv.lo;
    }
    return preferred;
  };

  const trySlide = (i: number, axis: 'x' | 'y'): boolean => {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    if (!a || !b) return false;

    const slide = axis;
    const span = axis === 'y' ? 'x' : 'y';
    const dim = axis === 'y' ? 'h' : 'w';
    const perpDim = span === 'y' ? 'h' : 'w';
    const segSlide = a[slide];
    const segMin = Math.min(a[span], b[span]);
    const segMax = Math.max(a[span], b[span]);

    const band: Array<{ lo: number; hi: number }> = [];
    let crosses = false;
    const isFirstSeg = i === 0;
    const isLastSeg = i === waypoints.length - 2;
    const endpointObstacles: NodeBox[] = [];
    if (isFirstSeg && input.sourceSelf) endpointObstacles.push(input.sourceSelf);
    if (isLastSeg && input.targetSelf) endpointObstacles.push(input.targetSelf);
    const allObstacles = endpointObstacles.length > 0
      ? input.obstacles.concat(endpointObstacles)
      : input.obstacles;

    for (const obs of allObstacles) {
      const oSpan = obs[span];
      const oSpanHi = oSpan + obs[perpDim];
      if (segMax <= oSpan + 1 || segMin >= oSpanHi - 1) continue;
      const oSlide = obs[slide];
      const oSlideHi = oSlide + obs[dim];
      band.push({ lo: oSlide, hi: oSlideHi });
      if (segSlide > oSlide + 1 && segSlide < oSlideHi - 1) crosses = true;
    }
    if (!crosses) return false;

    const lower = findClearance(segSlide, -1, band);
    const upper = findClearance(segSlide, 1, band);
    const distLower = lower > 0 ? segSlide - lower : Infinity;
    const distUpper = upper - segSlide;
    const newVal = distLower <= distUpper ? lower : upper;

    if (isFirstSeg && isLastSeg) return false;
    if (isFirstSeg) {
      const bend: Waypoint = slide === 'x'
        ? { x: newVal, y: a.y }
        : { x: a.x, y: newVal };
      waypoints.splice(i + 1, 0, bend);
      b[slide] = newVal;
    } else if (isLastSeg) {
      if (input.targetSelf && canMoveEndpointAlongTargetSide(b, slide, newVal, input.targetSelf)) {
        a[slide] = newVal;
        b[slide] = newVal;
      } else {
        const bends = endpointPreservingBends(a, b, slide, newVal, input.obstacles);
        if (bends) {
          a[slide] = newVal;
          waypoints.splice(i + 1, 0, ...bends);
        } else {
          a[slide] = newVal;
          const bend: Waypoint = slide === 'x'
            ? { x: newVal, y: b.y }
            : { x: b.x, y: newVal };
          waypoints.splice(i + 1, 0, bend);
        }
      }
    } else {
      a[slide] = newVal;
      b[slide] = newVal;
    }
    return true;
  };

  let changed = false;
  const MAX_ITERS = 8;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let changedThisIter = false;
    for (let i = waypoints.length - 2; i >= 0; i--) {
      const a = waypoints[i];
      const b = waypoints[i + 1];
      if (!a || !b) continue;
      const dxAbs = Math.abs(a.x - b.x);
      const dyAbs = Math.abs(a.y - b.y);
      const moved =
        (dyAbs <= 1 && dxAbs > 1 && trySlide(i, 'y')) ||
        (dxAbs <= 1 && dyAbs > 1 && trySlide(i, 'x'));
      if (moved) {
        changed = true;
        changedThisIter = true;
      }
    }
    if (!changedThisIter) return { waypoints, changed };
  }

  throw new Error('[edge-router] local obstacle detour did not converge');
}

function mergeIntervals(
  intervals: Array<{ lo: number; hi: number }>,
  margin: number,
): Array<{ lo: number; hi: number }> {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .map((iv) => ({ lo: iv.lo - margin, hi: iv.hi + margin }))
    .sort((a, b) => a.lo - b.lo);
  const first = sorted[0];
  if (!first) return [];
  const merged: Array<{ lo: number; hi: number }> = [first];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (!last || !cur) {
      throw new Error('[edge-router] cannot merge missing obstacle interval');
    }
    if (cur.lo <= last.hi) {
      if (cur.hi > last.hi) last.hi = cur.hi;
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function canMoveEndpointAlongTargetSide(
  endpoint: Waypoint,
  slide: 'x' | 'y',
  newVal: number,
  target: NodeBox,
): boolean {
  const TOL = 0.5;
  if (slide === 'x') {
    const onTopOrBottom = Math.abs(endpoint.y - target.y) <= TOL
      || Math.abs(endpoint.y - (target.y + target.h)) <= TOL;
    return onTopOrBottom && newVal >= target.x + TOL && newVal <= target.x + target.w - TOL;
  }

  const onLeftOrRight = Math.abs(endpoint.x - target.x) <= TOL
    || Math.abs(endpoint.x - (target.x + target.w)) <= TOL;
  return onLeftOrRight && newVal >= target.y + TOL && newVal <= target.y + target.h - TOL;
}

function endpointPreservingBends(
  segmentStart: Waypoint,
  endpoint: Waypoint,
  slide: 'x' | 'y',
  newVal: number,
  obstacles: NodeBox[],
): [Waypoint, Waypoint] | null {
  const span = slide === 'x' ? 'y' : 'x';
  const dim = slide === 'x' ? 'w' : 'h';
  const perpDim = span === 'x' ? 'w' : 'h';
  const startSpan = segmentStart[span];
  const endSpan = endpoint[span];
  if (Math.abs(startSpan - endSpan) <= ENDPOINT_STUB + 1) return null;

  const slideLo = Math.min(newVal, endpoint[slide]);
  const slideHi = Math.max(newVal, endpoint[slide]);
  const spanLo = Math.min(startSpan, endSpan);
  const spanHi = Math.max(startSpan, endSpan);
  const intervals: Array<{ lo: number; hi: number }> = [];
  for (const obs of obstacles) {
    const obsSlideLo = obs[slide];
    const obsSlideHi = obsSlideLo + obs[dim];
    if (slideHi <= obsSlideLo + 1 || slideLo >= obsSlideHi - 1) continue;
    const obsSpanLo = obs[span];
    const obsSpanHi = obsSpanLo + obs[perpDim];
    if (obsSpanHi <= spanLo + 1 || obsSpanLo >= spanHi - 1) continue;
    intervals.push({ lo: obsSpanLo, hi: obsSpanHi });
  }

  const approachSpan = chooseEndpointApproachSpan(startSpan, endSpan, intervals);
  if (approachSpan === null) return null;

  return slide === 'x'
    ? [{ x: newVal, y: approachSpan }, { x: endpoint.x, y: approachSpan }]
    : [{ x: approachSpan, y: newVal }, { x: approachSpan, y: endpoint.y }];
}

function chooseEndpointApproachSpan(
  startSpan: number,
  endSpan: number,
  intervals: Array<{ lo: number; hi: number }>,
): number | null {
  const direction = endSpan > startSpan ? 1 : -1;
  const fallback = endSpan - direction * ENDPOINT_STUB;
  if (intervals.length === 0) return fallback;

  if (direction === 1) {
    const blockingHi = intervals.reduce((max, iv) => Math.max(max, iv.hi), -Infinity);
    const approach = Math.max(fallback, blockingHi + ENDPOINT_CLEARANCE);
    return approach < endSpan - 1 ? approach : null;
  }

  const blockingLo = intervals.reduce((min, iv) => Math.min(min, iv.lo), Infinity);
  const approach = Math.min(fallback, blockingLo - ENDPOINT_CLEARANCE);
  return approach > endSpan + 1 ? approach : null;
}
