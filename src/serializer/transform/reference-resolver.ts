/**
 * Reference Resolver
 * Builds incoming/outgoing references for BPMN flow nodes
 */

import type { LayoutedGraph } from '../types/elk-output';

interface EdgeInfo {
  id: string;
  sourceRef: string;
  targetRef: string;
  type: 'sequenceFlow' | 'messageFlow' | 'dataInputAssociation' | 'dataOutputAssociation' | 'association';
}

interface NodeInfo {
  id: string;
  type: string;
  parentId?: string;
}

export class ReferenceResolver {
  private nodeMap: Map<string, NodeInfo> = new Map();
  private edgesBySource: Map<string, EdgeInfo[]> = new Map();
  private edgesByTarget: Map<string, EdgeInfo[]> = new Map();
  private allEdges: EdgeInfo[] = [];

  /**
   * Resolve all references in the graph
   */
  resolve(graph: LayoutedGraph): void {
    this.clear();
    this.indexGraph(graph);
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    this.nodeMap.clear();
    this.edgesBySource.clear();
    this.edgesByTarget.clear();
    this.allEdges = [];
  }

  /**
   * Get incoming edge IDs for a node
   */
  getIncoming(nodeId: string): string[] {
    const edges = this.edgesByTarget.get(nodeId);
    return edges?.map((e) => e.id) ?? [];
  }

  /**
   * Get outgoing edge IDs for a node
   */
  getOutgoing(nodeId: string): string[] {
    const edges = this.edgesBySource.get(nodeId);
    return edges?.map((e) => e.id) ?? [];
  }

  /**
   * Get incoming sequence flows for a node
   */
  getIncomingSequenceFlows(nodeId: string): string[] {
    const edges = this.edgesByTarget.get(nodeId);
    return edges?.filter((e) => e.type === 'sequenceFlow').map((e) => e.id) ?? [];
  }

  /**
   * Get outgoing sequence flows for a node
   */
  getOutgoingSequenceFlows(nodeId: string): string[] {
    const edges = this.edgesBySource.get(nodeId);
    return edges?.filter((e) => e.type === 'sequenceFlow').map((e) => e.id) ?? [];
  }

  /**
   * Get all edges
   */
  getAllEdges(): EdgeInfo[] {
    return this.allEdges;
  }

  /**
   * Get node by ID
   */
  getNode(nodeId: string): NodeInfo | undefined {
    return this.nodeMap.get(nodeId);
  }

  /**
   * Get all nodes
   */
  getAllNodes(): Map<string, NodeInfo> {
    return this.nodeMap;
  }

  /**
   * Check if a node exists
   */
  hasNode(nodeId: string): boolean {
    return this.nodeMap.has(nodeId);
  }

  /**
   * Index the entire graph
   */
  private indexGraph(graph: LayoutedGraph): void {
    for (const child of graph.children) {
      this.indexNode(child as unknown as GraphNode);
    }
  }

  /**
   * Recursively index a node and its children
   */
  private indexNode(node: GraphNode, parentId?: string): void {
    // Index the node itself (skip containers like collaboration)
    if (node.bpmn && node.bpmn.type !== 'collaboration') {
      this.nodeMap.set(node.id, {
        id: node.id,
        type: node.bpmn.type,
        parentId,
      });
    }

    // Index children
    if (node.children) {
      for (const child of node.children) {
        this.indexNode(child as GraphNode, node.id);
      }
    }

    // Index boundary events
    if (node.boundaryEvents) {
      for (const be of node.boundaryEvents) {
        this.nodeMap.set(be.id, {
          id: be.id,
          type: 'boundaryEvent',
          parentId: node.id,
        });
      }
    }

    // Index edges
    if (node.edges) {
      for (const edge of node.edges) {
        this.indexEdge(edge);
      }
    }
  }

  /**
   * Index an edge
   */
  private indexEdge(edge: GraphEdge): void {
    const sourceRef = edge.sources[0];
    const targetRef = edge.targets[0];

    if (!sourceRef || !targetRef) return;

    const edgeType = edge.bpmn?.type;
    const validTypes = ['sequenceFlow', 'messageFlow', 'dataInputAssociation', 'dataOutputAssociation', 'association'] as const;
    const edgeInfo: EdgeInfo = {
      id: edge.id,
      sourceRef,
      targetRef,
      type: (validTypes.includes(edgeType as typeof validTypes[number]) ? edgeType : 'sequenceFlow') as EdgeInfo['type'],
    };

    this.allEdges.push(edgeInfo);

    // Index by source
    if (!this.edgesBySource.has(sourceRef)) {
      this.edgesBySource.set(sourceRef, []);
    }
    this.edgesBySource.get(sourceRef)!.push(edgeInfo);

    // Index by target
    if (!this.edgesByTarget.has(targetRef)) {
      this.edgesByTarget.set(targetRef, []);
    }
    this.edgesByTarget.get(targetRef)!.push(edgeInfo);
  }
}

// Internal types
interface GraphNode {
  id: string;
  bpmn?: { type: string };
  children?: GraphNode[];
  edges?: GraphEdge[];
  boundaryEvents?: Array<{ id: string; bpmn: { type: string } }>;
}

interface GraphEdge {
  id: string;
  sources: string[];
  targets: string[];
  bpmn?: { type: string };
}
