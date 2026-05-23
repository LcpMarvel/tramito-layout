/**
 * Lane Resolver
 * Builds flowNodeRef arrays for BPMN lanes
 */

export interface LaneInfo {
  id: string;
  name?: string;
  flowNodeRefs: string[];
  childLaneSet?: LaneSetInfo;
}

export interface LaneSetInfo {
  id: string;
  lanes: LaneInfo[];
}

export class LaneResolver {
  private laneIdCounter = 0;

  /**
   * Resolve lanes from a participant or process
   */
  resolve(container: ContainerNode): LaneSetInfo | undefined {
    const lanes = this.findLanes(container.children);

    if (lanes.length === 0) {
      return undefined;
    }

    return {
      id: this.generateLaneSetId(),
      lanes: lanes.map((lane) => this.processLane(lane)),
    };
  }

  /**
   * Find all lanes in children
   */
  private findLanes(children?: ChildNode[]): LaneNode[] {
    if (!children) return [];
    return children.filter((c): c is LaneNode => c.bpmn?.type === 'lane');
  }

  /**
   * Process a lane and collect all flow node refs
   */
  private processLane(lane: LaneNode): LaneInfo {
    const flowNodeRefs = this.collectFlowNodeRefs(lane.children);
    const nestedLanes = this.findLanes(lane.children);

    const result: LaneInfo = {
      id: lane.id,
      name: lane.bpmn?.name,
      flowNodeRefs,
    };

    // Handle nested lanes
    if (nestedLanes.length > 0) {
      result.childLaneSet = {
        id: this.generateLaneSetId(),
        lanes: nestedLanes.map((l) => this.processLane(l)),
      };
    }

    return result;
  }

  /**
   * Collect all flow node IDs within a lane (excluding nested lanes)
   */
  private collectFlowNodeRefs(children?: ChildNode[]): string[] {
    if (!children) return [];

    const refs: string[] = [];

    for (const child of children) {
      // Skip lanes - their content belongs to them
      if (child.bpmn?.type === 'lane') {
        continue;
      }

      // Add this node's ID
      refs.push(child.id);

      // For subprocesses, don't traverse children - they're internal
      // Boundary events are still part of the lane though
      if (child.boundaryEvents) {
        for (const be of child.boundaryEvents) {
          refs.push(be.id);
        }
      }
    }

    return refs;
  }

  /**
   * Generate a unique lane set ID
   */
  private generateLaneSetId(): string {
    return `LaneSet_${++this.laneIdCounter}`;
  }

  /**
   * Reset the ID counter
   */
  reset(): void {
    this.laneIdCounter = 0;
  }
}

// Internal types
interface ChildNode {
  id: string;
  bpmn?: { type: string; name?: string };
  children?: ChildNode[];
  boundaryEvents?: Array<{ id: string }>;
}

interface LaneNode extends ChildNode {
  bpmn: { type: 'lane'; name?: string };
}

interface ContainerNode {
  id: string;
  children?: ChildNode[];
}
