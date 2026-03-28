import { useEffect, useMemo, useRef, useState } from 'react';
import { hierarchy, tree, type HierarchyNode } from 'd3-hierarchy';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import type { Person, TreeData, Relationship } from './types';
import './D3TreeViz.css';

type TreeNode = {
  id: string;
  person: Person;
  x: number;
  y: number;
  treeX: number;
  treeY: number;
};

type TreeLink = {
  key: string;
  source: string;
  target: string;
};

interface D3TreeVizProps {
  tree: TreeData;
  selectedPersonId: string | null;
  onPersonClick?: (personId: string) => void;
}

const CARD_WIDTH = 120;
const CARD_HEIGHT = 56;
const COLLISION_RADIUS = Math.sqrt(CARD_WIDTH * CARD_WIDTH + CARD_HEIGHT * CARD_HEIGHT) / 2 + 10; // diagonal half + buffer
const TREE_H_GAP = 180; // horizontal cell size (keeps siblings tight)
const TREE_V_GAP = 260; // vertical cell size — MUST exceed H_GAP for top-down tree
const SVG_PADDING = 120;
const FIT_PADDING = 80;
const MIN_VIEWPORT_HEIGHT = 480;

const getNodeLabel = (person: Person): string => {
  const name = `${person.firstName} ${person.lastName}`.trim();
  return name || '?';
};

type HierNode = {
  id: string;
  person: Person;
  children?: HierNode[];
};

const buildHierarchyForest = (
  people: Person[],
  relationships: Relationship[],
): { roots: HierarchyNode<HierNode>[] } => {
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

  const roots = people.filter((p) => !parentsByChild.has(p.id));
  const effectiveRoots = roots.length ? roots : people.slice(0, 1);

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

  const hierarchyRoots: HierarchyNode<HierNode>[] = [];
  for (const rootPerson of effectiveRoots) {
    const rootNode = nodeMap.get(rootPerson.id);
    if (!rootNode) continue;
    try {
      hierarchyRoots.push(hierarchy(rootNode));
    } catch {
      // ignore
    }
  }

  return { roots: hierarchyRoots };
};

const computeTreeLayout = (
  roots: HierarchyNode<HierNode>[],
): { nodes: TreeNode[]; links: TreeLink[] } => {
  const flatNodes: TreeNode[] = [];
  const links: TreeLink[] = [];
  const seenIds = new Set<string>();
  const subtreeBreadth = (node: HierarchyNode<HierNode>) => Math.max(node.leaves().length, 1);

  // Arrange roots in columns: 2-3 roots per "row" to keep everything compact
  const COLS = 3;
  const treeLayout = tree<HierNode>()
    .nodeSize([TREE_H_GAP, TREE_V_GAP])
    .separation((a, b) => {
      const base = a.parent === b.parent ? 1.1 : 1.4;
      return base + (subtreeBreadth(a) + subtreeBreadth(b)) * 0.06;
    });

  for (let ri = 0; ri < roots.length; ri++) {
    // Position each root in a column/row grid to prevent horizontal sprawl
    const col = ri % COLS;
    const row = Math.floor(ri / COLS);
    const offsetX = SVG_PADDING + col * TREE_H_GAP * 5;
    const offsetY = SVG_PADDING + row * (TREE_V_GAP * 4);

    try {
      const laid = treeLayout(roots[ri]);
      laid.each((node) => {
        if (seenIds.has(node.data.id)) return;
        seenIds.add(node.data.id);

        const x = (node.x ?? 0) + offsetX;
        const y = (node.y ?? 0) + offsetY;

        flatNodes.push({
          id: node.data.id,
          person: node.data.person,
          treeX: x,
          treeY: y,
          x,
          y,
        });

        if (node.parent) {
          links.push({
            key: `${node.parent.data.id}--${node.data.id}`,
            source: node.parent.data.id,
            target: node.data.id,
          });
        }
      });
    } catch {
      // ignore
    }
  }

  return { nodes: flatNodes, links };
};

// Resolve string links to node objects
const resolveLinks = (links: TreeLink[], nodeMap: Map<string, TreeNode>) =>
  links
    .map((l) => ({
      ...l,
      sourceNode: nodeMap.get(l.source)!,
      targetNode: nodeMap.get(l.target)!,
    }))
    .filter((l) => l.sourceNode && l.targetNode);

// Resolve node positions after collision pass
const resolveCollisions = (nodes: TreeNode[], radius: number) => {
  const resolved = nodes.map((n) => ({ ...n }));
  let settled = false;
  let iterations = 0;
  const MAX_ITER = 50;

  while (!settled && iterations < MAX_ITER) {
    settled = true;
    iterations++;

    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        const a = resolved[i];
        const b = resolved[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = radius * 2;

        if (dist < minDist && dist > 0) {
          const overlap = (minDist - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;

          a.x += nx * overlap;
          a.y += ny * overlap;
          b.x -= nx * overlap;
          b.y -= ny * overlap;

          // Keep within treeY band for this node (no vertical hijacking)
          // Allow horizontal settlement freely
          settled = false;
        }
      }
    }
  }
  return resolved;
};

export const D3TreeViz = ({ tree, selectedPersonId, onPersonClick }: D3TreeVizProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: MIN_VIEWPORT_HEIGHT });

  const { nodes, links } = useMemo(() => {
    const { roots } = buildHierarchyForest(tree.people, tree.relationships);
    return computeTreeLayout(roots);
  }, [tree]);

  // Build node lookup for quick access
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Zoom to selected person when selection changes
  useEffect(() => {
    if (!selectedPersonId || !zoomRef.current || !svgRef.current) return;
    const node = nodeById.get(selectedPersonId);
    if (!node) return;

    const svg = select(svgRef.current);
    const { width, height } = viewportSize;
    const targetScale = 1.4;
    const tx = width / 2 - targetScale * node.x;
    const ty = height / 2 - targetScale * node.y;
    svg.call(zoomRef.current!.transform, zoomIdentity.translate(tx, ty).scale(targetScale));
  }, [selectedPersonId, nodeById, viewportSize]);

  // Zoom helpers
  const zoomIn = () => {
    if (!svgRef.current || !zoomRef.current) return;
    select(svgRef.current).call(zoomRef.current.scaleBy, 1.3);
  };
  const zoomOut = () => {
    if (!svgRef.current || !zoomRef.current) return;
    select(svgRef.current).call(zoomRef.current.scaleBy, 0.77);
  };
  const resetZoom = () => {
    if (!svgRef.current || !zoomRef.current || !viewportRef.current) return;
    const bounds = viewportRef.current.getBBox();
    const { width, height } = viewportSize;
    const scale = Math.min(1.5, Math.max(0.5, Math.min(
      (width - FIT_PADDING * 2) / bounds.width,
      (height - FIT_PADDING * 2) / bounds.height,
    )));
    const tx = width / 2 - scale * (bounds.x + bounds.width / 2);
    const ty = height / 2 - scale * (bounds.y + bounds.height / 2);
    select(svgRef.current).call(
      zoomRef.current.transform,
      zoomIdentity.translate(tx, ty).scale(scale),
    );
  };

  // Sync viewport size
  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      const w = Math.max(containerRef.current!.clientWidth, 1);
      const h = Math.max(containerRef.current!.clientHeight, MIN_VIEWPORT_HEIGHT);
      setViewportSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!svgRef.current || !viewportRef.current || !nodes.length) return;

    const svg = select(svgRef.current);
    const viewport = select(viewportRef.current);
    const { width, height } = viewportSize;

    svg.attr('width', width).attr('height', height).attr('viewBox', `0 0 ${width} ${height}`);

    // --- Zoom behaviour ---
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => {
        viewport.attr('transform', event.transform.toString());
      });
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior).on('dblclick.zoom', null);

    // --- Collision pass: settle nodes that overlap ---
    const nodeMap = new Map(nodes.map((n) => [n.id, { ...n }]));
    const settledNodes = resolveCollisions(nodes, COLLISION_RADIUS);
    settledNodes.forEach((n) => {
      const orig = nodeMap.get(n.id)!;
      orig.x = n.x;
      orig.y = n.y;
    });

    // --- Render ---
    const resolvedLinks = resolveLinks(links, nodeMap);

    const render = () => {
      const linkSel = viewport
        .select<SVGGElement>('.links-layer')
        .selectAll<SVGPathElement, typeof resolvedLinks[0]>('.tree-link')
        .data(resolvedLinks);

      linkSel.attr('d', (d) => {
        const sx = d.sourceNode.x;
        const sy = d.sourceNode.y;
        const tx = d.targetNode.x;
        const ty = d.targetNode.y;
        const midY = sy + (ty - sy) * 0.5;
        return `M ${sx} ${sy} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${ty}`;
      });

      viewport
        .select<SVGGElement>('.nodes-layer')
        .selectAll<SVGGElement, TreeNode>('.tree-node')
        .data(settledNodes)
        .attr('transform', (d) => `translate(${d.x},${d.y})`);
    };

    render();

    // --- Fit to screen: show the whole cluster, but at a readable minimum scale ---
    const fitToScreen = () => {
      if (!viewportRef.current || !zoomRef.current) return;
      const bounds = viewportRef.current.getBBox();
      if (!Number.isFinite(bounds.width) || bounds.width === 0) return;

      const scaleX = (width - FIT_PADDING * 2) / bounds.width;
      const scaleY = (height - FIT_PADDING * 2) / bounds.height;
      // Ensure at least 0.5 scale so nodes remain somewhat visible
      const scale = Math.min(1.5, Math.max(0.5, Math.min(scaleX, scaleY)));

      const tx = width / 2 - scale * (bounds.x + bounds.width / 2);
      const ty = height / 2 - scale * (bounds.y + bounds.height / 2);

      svg.call(zoomRef.current.transform, zoomIdentity.translate(tx, ty).scale(scale));
    };

    requestAnimationFrame(fitToScreen);

    return () => {
      svg.on('.zoom', null);
    };
  }, [nodes, links, viewportSize]);

  return (
    <div ref={containerRef} className="d3-tree-viz">
      {/* Zoom controls */}
      <div className="zoom-controls">
        <button className="zoom-btn" onClick={zoomIn} title="Zoom in">+</button>
        <button className="zoom-btn" onClick={zoomOut} title="Zoom out">−</button>
        <button className="zoom-btn" onClick={resetZoom} title="Fit to screen">⌂</button>
      </div>

      <svg ref={svgRef} className="d3-tree-svg">
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
            {links.map((link) => (
              <path
                key={link.key}
                className="tree-link"
                d=""
                markerEnd="url(#tree-arrow)"
              />
            ))}
          </g>

          <g className="nodes-layer">
            {nodes.map((node) => {
              const isSelected = selectedPersonId === node.id;
              const person = node.person;
              return (
                <g
                  key={node.id}
                  className={`tree-node${isSelected ? ' tree-node--selected' : ''}`}
                  transform={`translate(0,0)`}
                  onClick={() => onPersonClick?.(node.id)}
                  role="button"
                  aria-label={`${person.firstName} ${person.lastName}`}
                >
                  {/* Node card — name + dates inside, no text outside */}
                  <rect
                    x={-CARD_WIDTH / 2}
                    y={-CARD_HEIGHT / 2}
                    width={CARD_WIDTH}
                    height={CARD_HEIGHT}
                    rx="10"
                    className="tree-node-card"
                  />
                  <text
                    x="0"
                    y={-4}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="tree-node-name"
                  >
                    {getNodeLabel(person)}
                  </text>
                  {(person.birthYear || person.deathYear) && (
                    <text
                      x="0"
                      y={14}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="tree-node-years"
                    >
                      {person.birthYear || '?'}
                      {person.deathYear ? `–${person.deathYear}` : ''}
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
