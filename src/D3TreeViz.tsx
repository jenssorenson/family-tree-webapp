import { useEffect, useRef, useCallback } from 'react';
import {
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
import { drag } from 'd3-drag';
import type { Person, TreeData, Relationship } from './types';
import './D3TreeViz.css';

type TreeNode = SimulationNodeDatum & {
  id: string;
  person: Person;
  treeX: number;
  treeY: number;
};

type TreeLink = SimulationLinkDatum<TreeNode> & {
  source: TreeNode | string;
  target: TreeNode | string;
};

interface D3TreeVizProps {
  tree: TreeData;
  selectedPersonId: string | null;
  onPersonClick?: (personId: string) => void;
}

const NODE_RADIUS = 28;
const TREE_H_GAP = 110;
const TREE_V_GAP = 130;
const SVG_PADDING = 80;

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

  const treeLayout = tree<HierNode>()
    .nodeSize([TREE_H_GAP, TREE_V_GAP])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.3));

  // Assign horizontal offsets per root so multiple trees don't overlap
  const rootOffsets = new Map<number, number>();
  let nextOffset = SVG_PADDING;

  for (let ri = 0; ri < roots.length; ri++) {
    rootOffsets.set(ri, nextOffset);
    const count = roots[ri].descendants().length;
    nextOffset += count * TREE_H_GAP * 1.2 + TREE_H_GAP * 2;
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

export const D3TreeViz = ({ tree, selectedPersonId, onPersonClick }: D3TreeVizProps) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<TreeNode, TreeLink> | null>(null);
  const nodesRef = useRef<TreeNode[]>([]);

  const buildLinks = useCallback(
    (relationships: Relationship[], _collapsedRep: Map<string, string>) => {
      const added = new Set<string>();
      const links: TreeLink[] = [];

      for (const rel of relationships) {
        if (rel.type !== 'parent') continue;
        const sr = rel.sourceId;
        const tr = rel.targetId;
        if (sr === tr) continue;

        const key = [sr, tr].sort().join('--');
        if (added.has(key)) continue;
        added.add(key);

        links.push({ source: sr, target: tr });
      }
      return links;
    },
    [],
  );

  useEffect(() => {
    if (!svgRef.current || !tree.people.length) return;

    const { roots, collapsedRep } = buildHierarchyForest(tree.people, tree.relationships);
    if (!roots.length) return;

    const SVG_W = Math.max(900, tree.people.length * 55);
    const { flatNodes, totalWidth, totalHeight } = computeTreeLayout(roots, SVG_W);

    // Compute visiblePeople inside the effect (collapsedRep is in scope here)
    const seenReps = new Set<string>();
    const visiblePeople: Person[] = [];
    for (const p of tree.people) {
      const rep = collapsedRep.get(p.id) ?? p.id;
      if (!seenReps.has(rep)) {
        seenReps.add(rep);
        visiblePeople.push(p);
      }
    }

    const svg = select(svgRef.current);
    svg.attr('width', totalWidth).attr('height', totalHeight).attr('viewBox', `0 0 ${totalWidth} ${totalHeight}`);

    // Create simulation nodes
    const simNodes: TreeNode[] = flatNodes.map((fn) => ({
      id: fn.id,
      person: fn.person,
      treeX: fn.treeX,
      treeY: fn.treeY,
      x: fn.treeX,
      y: fn.treeY,
    }));

    nodesRef.current = simNodes;

    const links = buildLinks(tree.relationships, collapsedRep);

    // Guard: skip simulation if no valid links or nodes
    if (!visiblePeople.length || !links.length) {
      nodesRef.current = simNodes;
      return;
    }

    // Stop previous simulation
    if (simRef.current) {
      simRef.current.stop();
    }

    const sim = forceSimulation<TreeNode, TreeLink>(simNodes)
      .force(
        'link',
        forceLink<TreeNode, TreeLink>(links)
          .id((d) => d.id)
          .distance(TREE_V_GAP * 0.8)
          .strength(0.5),
      )
      .force('charge', forceManyBody<TreeNode>().strength(-500).distanceMin(50).distanceMax(650))
      .force('y', forceY<TreeNode>().strength(0.1).y((d) => d.treeY))
      .force('x', forceX<TreeNode>(totalWidth / 2).strength(0.03))
      .alphaDecay(0.028)
      .velocityDecay(0.38);

    simRef.current = sim;

    let renderTickCount = 0;
    const MAX_RENDER_TICKS = 500;

    const render = () => {
      if (renderTickCount++ > MAX_RENDER_TICKS) return;
      try {
        svg.select('.links-layer')
          .selectAll<SVGLineElement, TreeLink>('.tree-link')
          .each(function (d) {
            if (d == null) return;
            const src = (d as any).source;
            const tgt = (d as any).target;
            if (src == null || tgt == null) return;
            select(this)
              .attr('x1', src.x ?? 0)
              .attr('y1', src.y ?? 0)
              .attr('x2', tgt.x ?? 0)
              .attr('y2', tgt.y ?? 0);
          });

        svg.select('.nodes-layer')
          .selectAll<SVGGElement, TreeNode>('.tree-node')
          .attr('transform', (d) => {
            if (d == null) return 'translate(0,0)';
            return `translate(${d.x ?? 0},${d.y ?? 0})`;
          });
      } catch (err) {
        console.error('[D3TreeViz] render error:', err);
      }
    };

    sim.on('tick', render);

    // Setup drag
    const dragHandler = drag<SVGGElement, TreeNode>()
      .on('start', (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    svg.select<SVGGElement>('.nodes-layer')
      .selectAll<SVGGElement, TreeNode>('.tree-node')
      .call(dragHandler as never);

    render();

    return () => {
      sim.on('tick', null);
    };
  }, [tree, buildLinks]);

  // Build static structure
  let roots: ReturnType<typeof buildHierarchyForest>['roots'] = [];
  let collapsedRep = new Map<string, string>();
  let SVG_W = 900;
  let totalWidth = 900;
  let totalHeight = 600;
  let visiblePeople: Person[] = [];
  let linkData: Array<{ key: string; source: string; target: string }> = [];

  try {
    ({ roots, collapsedRep } = buildHierarchyForest(tree.people, tree.relationships));
    SVG_W = Math.max(900, tree.people.length * 55);
    ({ totalWidth, totalHeight } = computeTreeLayout(roots, SVG_W));

    // Visible people (one per unique id)
    const seenReps = new Set<string>();
    for (const p of tree.people) {
      const rep = collapsedRep.get(p.id) ?? p.id;
      if (!seenReps.has(rep)) {
        seenReps.add(rep);
        visiblePeople.push(p);
      }
    }

    // Build links for rendering
    const addedLinks = new Set<string>();
    for (const rel of tree.relationships) {
      if (rel.type !== 'parent') continue;
      const sr = rel.sourceId;
      const tr = rel.targetId;
      if (sr === tr) continue;
      const key = [sr, tr].sort().join('--');
      if (addedLinks.has(key)) continue;
      addedLinks.add(key);
      linkData.push({ key, source: sr, target: tr });
    }
  } catch (err) {
    console.error('[D3TreeViz] render setup error:', err);
  }

  return (
    <div className="d3-tree-viz">
      <svg
        ref={svgRef}
        width={totalWidth}
        height={totalHeight}
        viewBox={`0 0 ${totalWidth} ${totalHeight}`}
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

        <g className="links-layer">
          {linkData.map(({ key, source, target }) => (
            <line
              key={key}
              className="tree-link"
              data-source={source}
              data-target={target}
              x1="0"
              y1="0"
              x2="0"
              y2="0"
              markerEnd="url(#tree-arrow)"
            />
          ))}
        </g>

        <g className="nodes-layer">
          {visiblePeople.map((person) => {
            const rep = collapsedRep.get(person.id) ?? person.id;
            const isSelected = selectedPersonId === person.id;
            return (
              <g
                key={rep}
                className={`tree-node${isSelected ? ' tree-node--selected' : ''}`}
                data-id={rep}
                transform="translate(0,0)"
                onClick={() => onPersonClick?.(person.id)}
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
      </svg>
    </div>
  );
};
