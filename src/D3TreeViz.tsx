import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import { hierarchy, tree, type HierarchyNode } from 'd3-hierarchy';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import type { Person, TreeData, Relationship } from './types';
import './D3TreeViz.css';

type TreeNode = SimulationNodeDatum & {
  id: string;
  person: Person;
  treeX: number;
  treeY: number;
};

type TreeLink = SimulationLinkDatum<TreeNode> & {
  key: string;
  source: TreeNode | string;
  target: TreeNode | string;
};

interface D3TreeVizProps {
  tree: TreeData;
  selectedPersonId: string | null;
  onPersonClick?: (personId: string) => void;
}

const NODE_RADIUS = 28;
const NODE_COLLISION_RADIUS = NODE_RADIUS + 8; // gentle overlap prevention only
const TREE_H_GAP = 200;
const TREE_V_GAP = 240;
const SVG_PADDING = 80;
const FIT_PADDING = 48;
const MIN_VIEWPORT_HEIGHT = 420;
const LINK_DISTANCE = TREE_V_GAP * 0.95;
const LINK_STRENGTH = 0.75;
const CHARGE_STRENGTH = 0; // disabled — tree layout is authority, not many-body
const COLLIDE_STRENGTH = 0.8;
const COLLIDE_ITERATIONS = 3;
const Y_LOCK_STRENGTH = 1;
const X_ANCHOR_STRENGTH = 0.06;
const PARENT_CHILD_X_PULL = 1.4;
const PARENT_CHILD_Y_ENFORCEMENT = 2.2;
const SIM_ALPHA_DECAY = 0.015;
const SIM_VELOCITY_DECAY = 0.5;

const getNodeLabel = (person: Person): string => {
  const name = `${person.firstName} ${person.lastName}`.trim();
  return name || '?';
};

// Hierarchical node type used with d3-hierarchy
type HierNode = {
  id: string;
  person: Person;
  children?: HierNode[];
};

// Build a forest of d3-hierarchy roots from flat tree data.
// Roots = people with no parent relationships.
const buildHierarchyForest = (
  people: Person[],
  relationships: Relationship[],
): {
  roots: HierarchyNode<HierNode>[];
  collapsedRep: Map<string, string>;
} => {
  const parentsByChild = new Map<string, string[]>();
  const childIdsByParent = new Map<string, string[]>();

  for (const rel of relationships) {
    if (rel.type === 'parent') {
      parentsByChild.set(rel.targetId, [
        ...(parentsByChild.get(rel.targetId) ?? []),
        rel.sourceId,
      ]);
      childIdsByParent.set(rel.sourceId, [
        ...(childIdsByParent.get(rel.sourceId) ?? []),
        rel.targetId,
      ]);
    }
  }

  // Roots: people who are not anyone's child
  const roots = people.filter((p) => !parentsByChild.has(p.id));
  const effectiveRoots = roots.length ? roots : people.slice(0, 1);

  // Collapse map: personId -> representative id (for collapsed spouse pairs)
  // Currently no spouse collapsing — each person is their own rep
  const collapsedRep = new Map<string, string>();

  // Build hierarchical node tree
  const nodeMap = new Map<string, HierNode>();
  for (const p of people) {
    nodeMap.set(p.id, { id: p.id, person: p });
  }

  for (const [parentId, childIds] of childIdsByParent) {
    const parentNode = nodeMap.get(parentId);
    if (!parentNode) continue;
    const validChildren = childIds
      .map((cid) => nodeMap.get(cid))
      .filter((n): n is HierNode => Boolean(n));
    if (validChildren.length) {
      parentNode.children = validChildren;
    }
  }

  // Build d3-hierarchy roots
  const hierarchyRoots: HierarchyNode<HierNode>[] = [];
  for (const rootPerson of effectiveRoots) {
    const rootNode = nodeMap.get(rootPerson.id);
    if (!rootNode) continue;
    try {
      const h = hierarchy(rootNode);
      hierarchyRoots.push(h);
    } catch {
      // ignore
    }
  }

  return { roots: hierarchyRoots, collapsedRep };
};

// Compute initial tree-layout positions
const computeTreeLayout = (
  roots: HierarchyNode<HierNode>[],
  svgWidth: number,
) => {
  interface FlatNode {
    id: string;
    treeX: number;
    treeY: number;
    depth: number;
    person: Person;
    rootIndex: number;
  }

  const flatNodes: FlatNode[] = [];
  const seenIds = new Set<string>();
  const subtreeWidth = (node: HierarchyNode<HierNode>) => Math.max(node.leaves().length, 1);

  const treeLayout = tree<HierNode>()
    .nodeSize([TREE_H_GAP, TREE_V_GAP])
    .separation((a, b) => {
      const siblingSpread = a.parent === b.parent ? 1.35 : 2.1;
      const breadthWeight = Math.min(subtreeWidth(a) + subtreeWidth(b), 8) * 0.12;
      return siblingSpread + breadthWeight;
    });

  // Assign horizontal offsets per root so multiple trees don't overlap
  const rootOffsets = new Map<number, number>();
  let nextOffset = SVG_PADDING;

  for (let ri = 0; ri < roots.length; ri++) {
    rootOffsets.set(ri, nextOffset);
    const breadth = subtreeWidth(roots[ri]);
    nextOffset += Math.max(breadth * TREE_H_GAP * 2.2, TREE_H_GAP * 3.5);
  }

  for (let ri = 0; ri < roots.length; ri++) {
    const offsetX = rootOffsets.get(ri) ?? SVG_PADDING;
    try {
      const laid = treeLayout(roots[ri]);
      laid.each((node) => {
        if (seenIds.has(node.data.id)) return;
        seenIds.add(node.data.id);
        flatNodes.push({
          id: node.data.id,
          treeX: (node.x ?? 0) + offsetX,
          treeY: (node.y ?? 0) + SVG_PADDING,
          depth: node.depth,
          person: node.data.person,
          rootIndex: ri,
        });
      });
    } catch {
      // ignore
    }
  }

  const totalWidth = Math.max(svgWidth, nextOffset + SVG_PADDING);
  const maxY = flatNodes.reduce((m, n) => Math.max(m, n.treeY), 0);
  const totalHeight = maxY + SVG_PADDING * 2;

  return { flatNodes, totalWidth, totalHeight };
};

const buildLinks = (relationships: Relationship[], nodeIds: Set<string>): TreeLink[] => {
  const added = new Set<string>();
  const links: TreeLink[] = [];

  for (const rel of relationships) {
    if (rel.type !== 'parent') continue;
    const sourceId = rel.sourceId;
    const targetId = rel.targetId;
    if (sourceId === targetId) continue;
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) continue;

    const key = `${sourceId}--${targetId}`;
    if (added.has(key)) continue;
    added.add(key);

    links.push({ key, source: sourceId, target: targetId });
  }

  return links;
};

const buildGraphModel = (tree: TreeData) => {
  const { roots, collapsedRep } = buildHierarchyForest(tree.people, tree.relationships);
  const svgWidth = Math.max(900, tree.people.length * 55);
  const { flatNodes, totalWidth, totalHeight } = computeTreeLayout(roots, svgWidth);
  const nodes: TreeNode[] = flatNodes.map((node) => ({
    id: node.id,
    person: node.person,
    treeX: node.treeX,
    treeY: node.treeY,
    x: node.treeX,
    y: node.treeY,
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = buildLinks(tree.relationships, nodeIds);

  return { collapsedRep, nodes, links, totalWidth, totalHeight };
};

const forceParentChildConstraint = (links: TreeLink[]) => {
  let nodesById = new Map<string, TreeNode>();

  const resolveNode = (node: TreeNode | string) => (
    typeof node === 'string' ? nodesById.get(node) ?? null : node
  );

  const force = (alpha: number) => {
    for (const link of links) {
      const parent = resolveNode(link.source);
      const child = resolveNode(link.target);
      if (!parent || !child) continue;

      const desiredYGap = Math.max(child.treeY - parent.treeY, TREE_V_GAP * 0.9);
      const parentY = parent.y ?? parent.treeY;
      const childY = child.y ?? child.treeY;
      const currentYGap = childY - parentY;

      if (currentYGap < desiredYGap) {
        const correction = ((desiredYGap - currentYGap) * PARENT_CHILD_Y_ENFORCEMENT * alpha) / 2;
        parent.y = parentY - correction;
        child.y = childY + correction;
        parent.vy = (parent.vy ?? 0) - correction * 0.35;
        child.vy = (child.vy ?? 0) + correction * 0.35;
      }

      const parentX = parent.x ?? parent.treeX;
      const childX = child.x ?? child.treeX;
      const midpointX = (parentX + childX) / 2;
      const xAdjustment = (parentX - childX) * PARENT_CHILD_X_PULL * alpha * 0.5;

      parent.x = midpointX + xAdjustment * 0.25;
      child.x = midpointX - xAdjustment * 0.25;
      parent.vx = (parent.vx ?? 0) - xAdjustment * 0.18;
      child.vx = (child.vx ?? 0) + xAdjustment * 0.18;
    }
  };

  force.initialize = (nodes: TreeNode[]) => {
    nodesById = new Map(nodes.map((node) => [node.id, node]));
  };

  return force;
};

const enforceHierarchyOrder = (links: TreeLink[]) => {
  for (const link of links) {
    const parent = typeof link.source === 'string' ? null : link.source;
    const child = typeof link.target === 'string' ? null : link.target;
    if (!parent || !child) continue;

    const minChildY = (parent.y ?? parent.treeY) + Math.max(child.treeY - parent.treeY, TREE_V_GAP * 0.9);
    if ((child.y ?? child.treeY) < minChildY) {
      child.y = minChildY;
      child.vy = Math.max(child.vy ?? 0, 0);
    }
  }
};

export const D3TreeViz = ({ tree, selectedPersonId, onPersonClick }: D3TreeVizProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const simRef = useRef<Simulation<TreeNode, TreeLink> | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: MIN_VIEWPORT_HEIGHT });

  const { collapsedRep, nodes, links } = useMemo(() => buildGraphModel(tree), [tree]);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const updateViewportSize = () => {
      const nextWidth = Math.max(container.clientWidth, 1);
      const nextHeight = Math.max(container.clientHeight, MIN_VIEWPORT_HEIGHT);
      setViewportSize((current) => (
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight }
      ));
    };

    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }

    if (!svgRef.current || !viewportRef.current || !nodes.length) return;

    const svg = select(svgRef.current);
    const viewport = select(viewportRef.current);
    const { width, height } = viewportSize;
    svg.attr('width', width).attr('height', height).attr('viewBox', `0 0 ${width} ${height}`);

    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 4])
      .on('zoom', (event) => {
        viewport.attr('transform', event.transform.toString());
      });

    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior).on('dblclick.zoom', null);

    const linkSelection = viewport
      .select<SVGGElement>('.links-layer')
      .selectAll<SVGLineElement, TreeLink>('.tree-link')
      .data(links);
    const nodeSelection = viewport
      .select<SVGGElement>('.nodes-layer')
      .selectAll<SVGGElement, TreeNode>('.tree-node')
      .data(nodes);

    const render = () => {
      enforceHierarchyOrder(links);

      linkSelection.each(function (d) {
        const source = typeof d.source === 'string' ? null : d.source;
        const target = typeof d.target === 'string' ? null : d.target;
        select(this)
          .attr('x1', source?.x ?? 0)
          .attr('y1', source?.y ?? 0)
          .attr('x2', target?.x ?? 0)
          .attr('y2', target?.y ?? 0);
      });

      nodeSelection.attr('transform', (d) => `translate(${d.x ?? d.treeX},${d.y ?? d.treeY})`);
    };

    render();

    const fitToScreen = () => {
      if (!viewportRef.current || !zoomRef.current) return;

      const bounds = viewportRef.current.getBBox();
      if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width === 0 || bounds.height === 0) {
        return;
      }

      const scale = Math.min(
        4,
        0.95 / Math.max(
          (bounds.width + FIT_PADDING * 2) / width,
          (bounds.height + FIT_PADDING * 2) / height,
        ),
      );
      const translateX = width / 2 - scale * (bounds.x + bounds.width / 2);
      const translateY = height / 2 - scale * (bounds.y + bounds.height / 2);
      const nextTransform = zoomIdentity.translate(translateX, translateY).scale(scale);

      svg.call(zoomRef.current.transform, nextTransform);
    };

    requestAnimationFrame(fitToScreen);

    if (!links.length) {
      return () => {
        svg.on('.zoom', null);
      };
    }

    const sim = forceSimulation<TreeNode, TreeLink>(nodes)
      .force(
        'link',
        forceLink<TreeNode, TreeLink>(links)
          .id((d) => d.id)
          .distance(LINK_DISTANCE)
          .strength(LINK_STRENGTH),
      )
      .force('parentChildConstraint', forceParentChildConstraint(links))
      .force(
        'charge',
        forceManyBody<TreeNode>()
          .strength(CHARGE_STRENGTH)
          .distanceMin(NODE_COLLISION_RADIUS * 1.4)
          .distanceMax(TREE_H_GAP * 6),
      )
      .force(
        'collide',
        forceCollide<TreeNode>(NODE_COLLISION_RADIUS)
          .iterations(COLLIDE_ITERATIONS)
          .strength(COLLIDE_STRENGTH),
      )
      .force('y', forceY<TreeNode>().strength(Y_LOCK_STRENGTH).y((d) => d.treeY))
      .force('x', forceX<TreeNode>().strength(X_ANCHOR_STRENGTH).x((d) => d.treeX))
      .alphaDecay(SIM_ALPHA_DECAY)
      .velocityDecay(SIM_VELOCITY_DECAY);

    simRef.current = sim;

    let renderTickCount = 0;
    const MAX_RENDER_TICKS = 500;

    const renderTick = () => {
      if (renderTickCount++ > MAX_RENDER_TICKS) return;
      try {
        render();
      } catch (err) {
        console.error('[D3TreeViz] render error:', err);
      }
    };

    sim.on('tick', renderTick);

    return () => {
      sim.on('tick', null);
      sim.stop();
      svg.on('.zoom', null);
    };
  }, [links, nodes, viewportSize]);

  return (
    <div ref={containerRef} className="d3-tree-viz">
      <svg
        ref={svgRef}
        className="d3-tree-svg"
      >
        <defs>
          <marker
            id="tree-arrow"
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="5"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#5b8cff" />
          </marker>
        </defs>

        <g ref={viewportRef} className="tree-viewport">
          <g className="links-layer">
            {links.map(({ key, source, target }) => (
              <line
                key={key}
                className="tree-link"
                data-source={typeof source === 'string' ? source : source.id}
                data-target={typeof target === 'string' ? target : target.id}
                x1="0"
                y1="0"
                x2="0"
                y2="0"
                markerEnd="url(#tree-arrow)"
              />
            ))}
          </g>

          <g className="nodes-layer">
            {nodes.map((node) => {
              const rep = collapsedRep.get(node.id) ?? node.id;
              const isSelected = selectedPersonId === node.id;
              const person = node.person;
              return (
                <g
                  key={rep}
                  className={`tree-node${isSelected ? ' tree-node--selected' : ''}`}
                  data-id={rep}
                  transform="translate(0,0)"
                  onClick={() => onPersonClick?.(node.id)}
                  role="button"
                  aria-label={`${person.firstName} ${person.lastName}`}
                >
                  <rect
                    x={-(NODE_RADIUS + 14)}
                    y={-(NODE_RADIUS + 14)}
                    width={(NODE_RADIUS + 14) * 2}
                    height={(NODE_RADIUS + 14) * 2}
                    rx="18"
                    className="tree-node-bg"
                  />
                  <circle r={NODE_RADIUS} className="tree-node-circle" />
                  <text y={NODE_RADIUS + 20} textAnchor="middle" className="tree-node-name">
                    {getNodeLabel(person)}
                  </text>
                  {(person.birthYear || person.deathYear) && (
                    <text y={NODE_RADIUS + 36} textAnchor="middle" className="tree-node-years">
                      {person.birthYear || '?'}
                      {person.deathYear ? ` – ${person.deathYear}` : ''}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
};
