// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  pipelineToGraph,
  topologicalSort,
  type WorkflowGraph,
} from '@gratis-gis/shared-types';
import type { ToolStep } from '@gratis-gis/shared-types';

/**
 * Unit tests for the workflow graph helpers introduced in
 * #157 Phase 1. Exercises the topological sort (success +
 * every error case) and the linear-pipeline-to-graph adapter
 * that the runtime uses to give the executor a single shape.
 */

function emptyStep(): ToolStep {
  // Filter step shaped well enough to satisfy the type; the
  // graph helpers never inspect the step body.
  return {
    kind: 'filter',
    predicate: { kind: 'parameter', name: 'predicate' },
  } as unknown as ToolStep;
}

describe('topologicalSort', () => {
  it('returns the only order for a single-node graph', () => {
    const graph: WorkflowGraph = {
      graphVersion: 1,
      nodes: [{ id: 'a', step: emptyStep() }],
      edges: [],
    };
    const res = topologicalSort(graph);
    expect(res.error).toBeUndefined();
    expect(res.order).toEqual(['a']);
  });

  it('linearizes a simple chain in source order', () => {
    const graph: WorkflowGraph = {
      graphVersion: 1,
      nodes: [
        { id: 'a', step: emptyStep() },
        { id: 'b', step: emptyStep() },
        { id: 'c', step: emptyStep() },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    };
    const res = topologicalSort(graph);
    expect(res.order).toEqual(['a', 'b', 'c']);
  });

  it('handles fan-out + fan-in', () => {
    // a -> b -> d
    // a -> c -> d
    const graph: WorkflowGraph = {
      graphVersion: 1,
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, step: emptyStep() })),
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
      ],
    };
    const res = topologicalSort(graph);
    expect(res.error).toBeUndefined();
    expect(res.order).toBeDefined();
    const order = res.order!;
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
    expect(order.length).toBe(4);
  });

  it('detects a 2-node cycle', () => {
    const graph: WorkflowGraph = {
      graphVersion: 1,
      nodes: [
        { id: 'a', step: emptyStep() },
        { id: 'b', step: emptyStep() },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    };
    const res = topologicalSort(graph);
    expect(res.error).toBe('cycle');
    expect(res.order).toBeUndefined();
  });

  it('detects a self-loop as a cycle', () => {
    const graph: WorkflowGraph = {
      graphVersion: 1,
      nodes: [{ id: 'a', step: emptyStep() }],
      edges: [{ source: 'a', target: 'a' }],
    };
    expect(topologicalSort(graph).error).toBe('cycle');
  });

  it('rejects edges to a missing node', () => {
    const graph: WorkflowGraph = {
      graphVersion: 1,
      nodes: [{ id: 'a', step: emptyStep() }],
      edges: [{ source: 'a', target: 'ghost' }],
    };
    expect(topologicalSort(graph).error).toBe('missing-node');
  });

  it('rejects duplicate node ids', () => {
    const graph: WorkflowGraph = {
      graphVersion: 1,
      nodes: [
        { id: 'a', step: emptyStep() },
        { id: 'a', step: emptyStep() },
      ],
      edges: [],
    };
    expect(topologicalSort(graph).error).toBe('duplicate-node');
  });

  it('handles disconnected components by preserving author order', () => {
    // Two independent islands: a -> b and c -> d
    const graph: WorkflowGraph = {
      graphVersion: 1,
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, step: emptyStep() })),
      edges: [
        { source: 'a', target: 'b' },
        { source: 'c', target: 'd' },
      ],
    };
    const res = topologicalSort(graph);
    expect(res.error).toBeUndefined();
    expect(res.order).toBeDefined();
    const order = res.order!;
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
    expect(new Set(order)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});

describe('pipelineToGraph', () => {
  it('returns an empty graph for an empty pipeline', () => {
    const graph = pipelineToGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.graphVersion).toBe(1);
  });

  it('builds a single-node graph with no edges', () => {
    const graph = pipelineToGraph([emptyStep()]);
    expect(graph.nodes.length).toBe(1);
    expect(graph.edges.length).toBe(0);
  });

  it('chains every step in order', () => {
    const graph = pipelineToGraph([emptyStep(), emptyStep(), emptyStep()]);
    expect(graph.nodes.length).toBe(3);
    expect(graph.edges.length).toBe(2);
    // Topological sort of the produced graph matches the
    // original pipeline order: n0 -> n1 -> n2.
    const order = topologicalSort(graph).order!;
    expect(order).toEqual(['n0', 'n1', 'n2']);
  });
});
