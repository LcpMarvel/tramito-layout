/**
 * Internal Types for Layout Processing
 * These types are used internally by the layout engine and are not part of the public API.
 */

import type { ElkLayoutOptions } from './elk-bpmn';

// ============================================================================
// Basic Geometry Types
// ============================================================================

/**
 * A point in 2D space
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * A rectangle in 2D space
 */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rectangle with optional ID for obstacle tracking
 */
export interface Obstacle extends Bounds {
  id: string;
}

// ============================================================================
// Edge Section Types
// ============================================================================

/**
 * A section of an edge with waypoints
 */
export interface EdgeSection {
  id: string;
  startPoint: Point;
  endPoint: Point;
  bendPoints?: Point[];
}

/**
 * Label with optional position and dimensions
 */
export interface EdgeLabel {
  text?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

// ============================================================================
// Internal Node Types
// ============================================================================

/**
 * Internal node representation with BPMN metadata
 * Used throughout the layout processing pipeline
 */
export interface NodeWithBpmn {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  bpmn: {
    type: string;
    name?: string;
    isExpanded?: boolean;
    isBlackBox?: boolean;
    processRef?: string;
    triggeredByEvent?: boolean;
    groupedElements?: string[];
    padding?: number;
    participantMultiplicity?: { minimum?: number; maximum?: number };
    [key: string]: unknown;
  };
  layoutOptions?: ElkLayoutOptions;
  children?: (NodeWithBpmn | object)[];
  edges?: EdgeWithBpmn[];
  boundaryEvents?: BoundaryEventNode[];
  labels?: EdgeLabel[];
  ports?: PortNode[];
  artifacts?: object[];
}

/**
 * Internal edge representation with BPMN metadata
 */
export interface EdgeWithBpmn {
  id: string;
  sources: string[];
  targets: string[];
  bpmn?: {
    type?: string;
    name?: string;
    messageRef?: string;
    conditionExpression?: object;
    isDefault?: boolean;
    associationDirection?: string;
    [key: string]: unknown;
  };
  layoutOptions?: ElkLayoutOptions;
  labels?: EdgeLabel[];
  sections?: EdgeSection[];
  // Internal flags for coordinate handling
  _absoluteCoords?: boolean;
  _poolRelativeCoords?: boolean;
}

/**
 * Boundary event node attached to a task or subprocess
 */
export interface BoundaryEventNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  attachedToRef: string;
  bpmn: {
    type: 'boundaryEvent';
    name?: string;
    eventDefinitionType?: string;
    isInterrupting?: boolean;
    cancelActivity?: boolean;
    [key: string]: unknown;
  };
  labels?: EdgeLabel[];
}

/**
 * Port node for element connection points
 */
export interface PortNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

// ============================================================================
// Info Collection Types (used for post-processing)
// ============================================================================

/**
 * Information about a boundary event and its targets
 */
export interface BoundaryEventInfo {
  attachedToRef: string;
  targets: string[];
  boundaryIndex: number;
  totalBoundaries: number;
}

/**
 * Information about an artifact and its associated task
 */
export interface ArtifactInfo {
  associatedTaskId: string;
  isInput: boolean;
}

/**
 * Information about a group element
 */
export interface GroupInfo {
  groupedElements: string[];
  padding: number;
  name?: string;
  parentId: string;
}

/**
 * Information about node movement during boundary event repositioning
 */
export interface NodeMoveInfo {
  newY: number;
  offset: number;
  newX?: number;
}
