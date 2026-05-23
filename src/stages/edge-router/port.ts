import type { FlowNodeType } from '../../loader/types.ts';
import type { Anchor, NodeBox, NodePort, Waypoint } from '../types.ts';
import { adjustGatewayEndpoint } from '../../layout/gateway-endpoint.ts';

export interface FinalizeRoutePortsInput {
  sourceId: string;
  targetId: string;
  sourceType: FlowNodeType;
  targetType: FlowNodeType;
  sourceBox: NodeBox;
  targetBox: NodeBox;
  sourceSide: Anchor;
  targetSide: Anchor;
  waypoints: Waypoint[];
}

export interface FinalizeRoutePortsOutput {
  waypoints: Waypoint[];
  sourcePort: NodePort;
  targetPort: NodePort;
}

export function makeBoxPort(nodeId: string, side: Anchor, point: Waypoint): NodePort {
  return {
    nodeId,
    side,
    point: { x: point.x, y: point.y },
    boundary: 'box',
  };
}

export function finalizeRoutePorts(input: FinalizeRoutePortsInput): FinalizeRoutePortsOutput {
  if (input.waypoints.length < 2) {
    throw new Error(`[edge-router] edge ${input.sourceId}->${input.targetId} has fewer than 2 waypoints`);
  }

  const waypoints = input.waypoints.map((p) => ({ x: p.x, y: p.y }));
  const sourceEndpoint = waypoints[0];
  const sourceNeighbor = waypoints[1];
  const targetEndpoint = waypoints[waypoints.length - 1];
  const targetNeighbor = waypoints[waypoints.length - 2];
  if (!sourceEndpoint || !sourceNeighbor || !targetEndpoint || !targetNeighbor) {
    throw new Error(`[edge-router] edge ${input.sourceId}->${input.targetId} has incomplete endpoints`);
  }

  const sourcePort = resolvePort({
    nodeId: input.sourceId,
    type: input.sourceType,
    box: input.sourceBox,
    side: input.sourceSide,
    endpoint: sourceEndpoint,
    neighbor: sourceNeighbor,
    isSource: true,
  });
  const targetPort = resolvePort({
    nodeId: input.targetId,
    type: input.targetType,
    box: input.targetBox,
    side: input.targetSide,
    endpoint: targetEndpoint,
    neighbor: targetNeighbor,
    isSource: false,
  });

  waypoints[0] = sourcePort.point;
  waypoints[waypoints.length - 1] = targetPort.point;
  return { waypoints, sourcePort, targetPort };
}

function resolvePort(input: {
  nodeId: string;
  type: FlowNodeType;
  box: NodeBox;
  side: Anchor;
  endpoint: Waypoint;
  neighbor: Waypoint;
  isSource: boolean;
}): NodePort {
  if (isGatewayType(input.type)) {
    return {
      nodeId: input.nodeId,
      side: input.side,
      point: adjustGatewayEndpoint(
        input.endpoint,
        input.neighbor,
        { x: input.box.x, y: input.box.y, width: input.box.w, height: input.box.h },
        input.isSource,
      ),
      boundary: 'diamond',
    };
  }
  return makeBoxPort(input.nodeId, input.side, input.endpoint);
}

function isGatewayType(type: FlowNodeType): boolean {
  return type === 'exclusiveGateway'
    || type === 'parallelGateway'
    || type === 'inclusiveGateway'
    || type === 'eventBasedGateway'
    || type === 'complexGateway';
}
