import {
  forceCollide,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { getDisplayName } from './tree-utils';
import type { Person, TreeData } from './types';

const CARD_WIDTH = 180;
const CARD_HEIGHT = 72;
const PARTNER_GAP = 48;
const GENERATION_GAP = 210;
const INITIAL_X_GAP = CARD_WIDTH + 150;
const LAYOUT_PADDING = 80;
const PERSON_COLLISION_PADDING = 56;
const SAME_LEVEL_EXTRA_PADDING = 84;
const SIMULATION_TICKS = 320;
const SPOUSE_ATTRACTION_STRENGTH = 0.55;
const SAME_LEVEL_SPOUSE_STRENGTH = 1.8;
const GENERATION_Y_STRENGTH = 1.2;
const PREVIOUS_POSITION_X_STRENGTH = 0.14;
const PREVIOUS_POSITION_Y_STRENGTH = 0.14;
const CHILD_CENTERING_STRENGTH = 0.46;
const CHILD_LEVEL_STRENGTH = 0.62;
const HOUSEHOLD_MEMBER_ALIGNMENT = 0.4;
const HOUSEHOLD_CHILD_ALIGNMENT = 0.22;
const SAME_LEVEL_BRANCH_SEPARATION = 0.22;
const CROSS_LEVEL_BRANCH_SEPARATION = 0.08;
const MANY_BODY_STRENGTH = -1500;
const VELOCITY_DECAY = 0.38;
const ALPHA_DECAY = 0.045;
const LIVE_ALPHA_TARGET = 0.014;
const REHEAT_ALPHA = 0.38;
const MIN_HORIZONTAL_SEPARATION = CARD_WIDTH + PERSON_COLLISION_PADDING;
const NORMALIZED_TOP_SLACK = GENERATION_GAP * 0.18;

export type Position = { x: number; y: number };

type BuildLayoutOptions = {
  previousPositions?: Map<string, Position>;
};

type Household = {
  id: string;
  memberIds: string[];
  level: number;
};

type LayoutNode = SimulationNodeDatum & {
  id: string;
  person: Person;
  level: number;
  householdId: string;
  order: number;
  anchorX: number;
  anchorY: number;
  baseRadius: number;
  entropyPhase: number;
  entropyRate: number;
};

type LayoutSnapshot = {
  nodes: LayoutNode[];
  nodesById: Map<string, LayoutNode>;
  households: Household[];
  householdsById: Map<string, Household>;
  householdByPersonId: Map<string, string>;
  parentsByChild: Map<string, string[]>;
  childrenByParent: Map<string, string[]>;
  spouseEdges: TreeData['relationships'];
};

type HouseholdOrderingContext = {
  orderedHouseholds: Household[];
  rowHouseholds: Map<number, Household[]>;
};

export type LayoutRuntime = {
  updateTree: (tree: TreeData) => void;
  getPositions: () => Map<string, Position>;
  subscribe: (listener: (positions: Map<string, Position>) => void) => () => void;
  destroy: () => void;
};

const sortPeople = (left: Person | undefined, right: Person | undefined) => {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.lastName.localeCompare(right.lastName)
    || left.firstName.localeCompare(right.firstName)
    || left.id.localeCompare(right.id);
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

const createSeededRandom = (seedText: string) => {
  let seed = 2166136261;

  for (let index = 0; index < seedText.length; index += 1) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }

  return () => {
    seed += 0x6D2B79F5;
    let result = Math.imul(seed ^ (seed >>> 15), seed | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
};

const computeGenerationLevels = (tree: TreeData) => {
  const parentsByChild = new Map<string, string[]>();
  const parentEdges: Array<{ sourceId: string; targetId: string }> = [];
  const spouseEdges: Array<{ sourceId: string; targetId: string }> = [];

  for (const relationship of tree.relationships) {
    if (relationship.type === 'parent') {
      parentsByChild.set(relationship.targetId, [...(parentsByChild.get(relationship.targetId) ?? []), relationship.sourceId]);
      parentEdges.push({ sourceId: relationship.sourceId, targetId: relationship.targetId });
      continue;
    }

    if (relationship.type === 'spouse') {
      spouseEdges.push({ sourceId: relationship.sourceId, targetId: relationship.targetId });
    }
  }

  const memo = new Map<string, number>();
  const visit = (personId: string, trail = new Set<string>()): number => {
    if (memo.has(personId)) return memo.get(personId)!;
    if (trail.has(personId)) return 0;

    trail.add(personId);
    const parents = parentsByChild.get(personId) ?? [];
    const generation = parents.length
      ? Math.max(...parents.map((parentId) => visit(parentId, new Set(trail)) + 1))
      : 0;

    memo.set(personId, generation);
    return generation;
  };

  const levels = new Map<string, number>();
  tree.people.forEach((person) => levels.set(person.id, visit(person.id)));

  let changed = true;
  let guard = 0;
  while (changed && guard < tree.people.length * 4) {
    changed = false;
    guard += 1;

    spouseEdges.forEach(({ sourceId, targetId }) => {
      const alignedLevel = Math.max(levels.get(sourceId) ?? 0, levels.get(targetId) ?? 0);
      if ((levels.get(sourceId) ?? 0) !== alignedLevel) {
        levels.set(sourceId, alignedLevel);
        changed = true;
      }
      if ((levels.get(targetId) ?? 0) !== alignedLevel) {
        levels.set(targetId, alignedLevel);
        changed = true;
      }
    });

    parentEdges.forEach(({ sourceId, targetId }) => {
      const requiredChildLevel = (levels.get(sourceId) ?? 0) + 1;
      if ((levels.get(targetId) ?? 0) < requiredChildLevel) {
        levels.set(targetId, requiredChildLevel);
        changed = true;
      }
    });
  }

  return levels;
};

const buildHouseholds = (tree: TreeData, levels: Map<string, number>) => {
  const peopleById = new Map(tree.people.map((person) => [person.id, person]));
  const spousesByPerson = new Map<string, Set<string>>();

  for (const relationship of tree.relationships) {
    if (relationship.type !== 'spouse') continue;
    spousesByPerson.set(relationship.sourceId, new Set([...(spousesByPerson.get(relationship.sourceId) ?? new Set()), relationship.targetId]));
    spousesByPerson.set(relationship.targetId, new Set([...(spousesByPerson.get(relationship.targetId) ?? new Set()), relationship.sourceId]));
  }

  const visited = new Set<string>();
  const households: Household[] = [];
  const householdByPersonId = new Map<string, string>();

  for (const person of [...tree.people].sort(sortPeople)) {
    if (visited.has(person.id)) continue;

    const level = levels.get(person.id) ?? 0;
    const queue = [person.id];
    const memberIds: string[] = [];
    visited.add(person.id);

    while (queue.length) {
      const currentId = queue.shift()!;
      memberIds.push(currentId);

      for (const spouseId of spousesByPerson.get(currentId) ?? []) {
        if (visited.has(spouseId)) continue;
        if (!peopleById.has(spouseId)) continue; // skip if person not in tree
        if ((levels.get(spouseId) ?? 0) !== level) continue;
        visited.add(spouseId);
        queue.push(spouseId);
      }
    }

    memberIds.sort((leftId, rightId) => sortPeople(peopleById.get(leftId), peopleById.get(rightId)));
    const id = memberIds.join('__');
    households.push({ id, memberIds, level });
    memberIds.forEach((memberId) => householdByPersonId.set(memberId, id));
  }

  households.sort((left, right) => {
    if (left.level !== right.level) return left.level - right.level;
    const leftKey = left.memberIds.map((memberId) => getDisplayName(peopleById.get(memberId)!)).join(' · ');
    const rightKey = right.memberIds.map((memberId) => getDisplayName(peopleById.get(memberId)!)).join(' · ');
    return leftKey.localeCompare(rightKey);
  });

  return { households, householdByPersonId };
};

const buildHouseholdOrdering = (
  households: Household[],
  householdByPersonId: Map<string, string>,
  tree: TreeData,
  previousPositions: Map<string, Position>,
): HouseholdOrderingContext => {
  const householdsById = new Map(households.map((household) => [household.id, household]));
  const rowHouseholds = new Map<number, Household[]>();
  const initialRank = new Map<string, number>();
  const parentHouseholdsByChildHousehold = new Map<string, Set<string>>();
  const childHouseholdsByParentHousehold = new Map<string, Set<string>>();

  households.forEach((household, index) => {
    initialRank.set(household.id, index);
    rowHouseholds.set(household.level, [...(rowHouseholds.get(household.level) ?? []), household]);
  });

  tree.relationships.forEach((relationship) => {
    if (relationship.type !== 'parent') return;
    const parentHouseholdId = householdByPersonId.get(relationship.sourceId);
    const childHouseholdId = householdByPersonId.get(relationship.targetId);
    if (!parentHouseholdId || !childHouseholdId || parentHouseholdId === childHouseholdId) return;

    parentHouseholdsByChildHousehold.set(
      childHouseholdId,
      new Set([...(parentHouseholdsByChildHousehold.get(childHouseholdId) ?? new Set<string>()), parentHouseholdId]),
    );
    childHouseholdsByParentHousehold.set(
      parentHouseholdId,
      new Set([...(childHouseholdsByParentHousehold.get(parentHouseholdId) ?? new Set<string>()), childHouseholdId]),
    );
  });

  const rowOrder = new Map<string, number>();
  Array.from(rowHouseholds.entries())
    .sort((left, right) => left[0] - right[0])
    .forEach(([, row]) => {
      row.forEach((household, index) => rowOrder.set(household.id, index));
    });

  const getStableCenter = (household: Household) => {
    const previous = household.memberIds
      .map((memberId) => previousPositions.get(memberId)?.x)
      .filter((value): value is number => typeof value === 'number');
    return previous.length ? average(previous) : (rowOrder.get(household.id) ?? 0);
  };

  for (let pass = 0; pass < 8; pass += 1) {
    const levels = Array.from(rowHouseholds.keys()).sort((left, right) => left - right);
    const sweepLevels = pass % 2 === 0 ? levels : [...levels].reverse();

    sweepLevels.forEach((level) => {
      const row = rowHouseholds.get(level);
      if (!row) return;

      row.sort((left, right) => {
        const leftNeighbors = [
          ...(parentHouseholdsByChildHousehold.get(left.id) ?? new Set<string>()),
          ...(childHouseholdsByParentHousehold.get(left.id) ?? new Set<string>()),
        ];
        const rightNeighbors = [
          ...(parentHouseholdsByChildHousehold.get(right.id) ?? new Set<string>()),
          ...(childHouseholdsByParentHousehold.get(right.id) ?? new Set<string>()),
        ];

        const leftScore = leftNeighbors.length
          ? average(leftNeighbors.map((householdId) => rowOrder.get(householdId) ?? getStableCenter(householdsById.get(householdId)!)))
          : getStableCenter(left);
        const rightScore = rightNeighbors.length
          ? average(rightNeighbors.map((householdId) => rowOrder.get(householdId) ?? getStableCenter(householdsById.get(householdId)!)))
          : getStableCenter(right);

        return leftScore - rightScore
          || leftNeighbors.length - rightNeighbors.length
          || (initialRank.get(left.id) ?? 0) - (initialRank.get(right.id) ?? 0);
      });

      row.forEach((household, index) => rowOrder.set(household.id, index));
    });
  }

  const orderedHouseholds = Array.from(rowHouseholds.entries())
    .sort((left, right) => left[0] - right[0])
    .flatMap(([, row]) => row);

  return { orderedHouseholds, rowHouseholds };
};

const createLevelClampForce = (nodes: LayoutNode[]): Force<LayoutNode, undefined> => {
  let currentNodes = nodes;

  const force = () => {
    currentNodes.forEach((node) => {
      const minY = node.anchorY - NORMALIZED_TOP_SLACK;
      const maxY = node.anchorY + NORMALIZED_TOP_SLACK;
      node.y = clamp(node.y ?? node.anchorY, minY, maxY);
    });
  };

  force.initialize = (nextNodes: LayoutNode[]) => {
    currentNodes = nextNodes;
  };

  return force;
};

const createPreviousPositionForce = (
  previousPositions: Map<string, Position>,
  nodes: LayoutNode[],
): Force<LayoutNode, undefined> => {
  let currentNodes = nodes;

  const force = (alpha: number) => {
    currentNodes.forEach((node) => {
      const previous = previousPositions.get(node.id);
      if (!previous) return;
      node.vx = (node.vx ?? 0) + (previous.x - (node.x ?? node.anchorX)) * PREVIOUS_POSITION_X_STRENGTH * alpha;
      node.vy = (node.vy ?? 0) + (previous.y - (node.y ?? node.anchorY)) * PREVIOUS_POSITION_Y_STRENGTH * alpha;
    });
  };

  force.initialize = (nextNodes: LayoutNode[]) => {
    currentNodes = nextNodes;
  };

  return force;
};

const createHouseholdForce = (
  households: Household[],
  nodesById: Map<string, LayoutNode>,
  childrenByParent: Map<string, string[]>,
): Force<LayoutNode, undefined> => {
  const force = (alpha: number) => {
    households.forEach((household) => {
      const householdNodes = household.memberIds
        .map((memberId) => nodesById.get(memberId))
        .filter((node): node is LayoutNode => Boolean(node));

      if (!householdNodes.length) return;

      const householdCenterX = average(householdNodes.map((node) => node.x ?? node.anchorX));
      householdNodes.forEach((node) => {
        node.vx = (node.vx ?? 0) + (householdCenterX - (node.x ?? node.anchorX)) * HOUSEHOLD_MEMBER_ALIGNMENT * alpha;
      });

      const uniqueChildren = household.memberIds
        .flatMap((memberId) => childrenByParent.get(memberId) ?? [])
        .filter((childId, index, list) => list.indexOf(childId) === index)
        .map((childId) => nodesById.get(childId))
        .filter((node): node is LayoutNode => Boolean(node));

      if (!uniqueChildren.length) return;

      const childCenterX = average(uniqueChildren.map((node) => node.x ?? node.anchorX));
      householdNodes.forEach((node) => {
        node.vx = (node.vx ?? 0) + (childCenterX - (node.x ?? node.anchorX)) * HOUSEHOLD_CHILD_ALIGNMENT * alpha;
      });
    });
  };

  return force;
};

const createParentConstraintForce = (
  parentsByChild: Map<string, string[]>,
  householdsById: Map<string, Household>,
  householdByPersonId: Map<string, string>,
  nodesById: Map<string, LayoutNode>,
): Force<LayoutNode, undefined> => {
  let currentNodes = [...nodesById.values()];

  const force = (alpha: number) => {
    currentNodes.forEach((node) => {
      const parentIds = parentsByChild.get(node.id) ?? [];
      if (!parentIds.length) return;

      const parentAnchors = parentIds
        .map((parentId) => householdsById.get(householdByPersonId.get(parentId) ?? parentId))
        .filter((household): household is Household => Boolean(household))
        .map((household) => average(
          household.memberIds
            .map((memberId) => nodesById.get(memberId))
            .filter((member): member is LayoutNode => Boolean(member))
            .map((member) => member.x ?? member.anchorX),
        ));

      if (!parentAnchors.length) return;

      const targetX = average(parentAnchors);
      const currentX = node.x ?? node.anchorX;
      const currentY = node.y ?? node.anchorY;

      node.vx = (node.vx ?? 0) + (targetX - currentX) * CHILD_CENTERING_STRENGTH * alpha;
      node.vy = (node.vy ?? 0) + (node.anchorY - currentY) * CHILD_LEVEL_STRENGTH * alpha;
    });
  };

  force.initialize = (nextNodes: LayoutNode[]) => {
    currentNodes = nextNodes;
  };

  return force;
};

const createBranchSeparationForce = (
  households: Household[],
  nodesById: Map<string, LayoutNode>,
): Force<LayoutNode, undefined> => {
  const force = (alpha: number) => {
    for (let leftIndex = 0; leftIndex < households.length; leftIndex += 1) {
      const leftHousehold = households[leftIndex];
      const leftMembers = leftHousehold.memberIds
        .map((memberId) => nodesById.get(memberId))
        .filter((node): node is LayoutNode => Boolean(node));
      if (!leftMembers.length) continue;
      const leftCenterX = average(leftMembers.map((node) => node.x ?? node.anchorX));

      for (let rightIndex = leftIndex + 1; rightIndex < households.length; rightIndex += 1) {
        const rightHousehold = households[rightIndex];
        const rightMembers = rightHousehold.memberIds
          .map((memberId) => nodesById.get(memberId))
          .filter((node): node is LayoutNode => Boolean(node));
        if (!rightMembers.length) continue;

        const rightCenterX = average(rightMembers.map((node) => node.x ?? node.anchorX));
        const sameLevel = leftHousehold.level === rightHousehold.level;
        const minSeparation = sameLevel
          ? (leftMembers.length + rightMembers.length) * 0.5 * MIN_HORIZONTAL_SEPARATION + SAME_LEVEL_EXTRA_PADDING
          : (leftMembers.length + rightMembers.length) * 0.3 * MIN_HORIZONTAL_SEPARATION;
        const delta = rightCenterX - leftCenterX;
        const overlap = minSeparation - Math.abs(delta);

        if (overlap <= 0) continue;

        const direction = delta === 0 ? (leftIndex % 2 === 0 ? -1 : 1) : Math.sign(delta);
        const strength = (sameLevel ? SAME_LEVEL_BRANCH_SEPARATION : CROSS_LEVEL_BRANCH_SEPARATION) * alpha;
        const push = overlap * strength;

        leftMembers.forEach((node) => {
          node.vx = (node.vx ?? 0) - push * direction;
        });
        rightMembers.forEach((node) => {
          node.vx = (node.vx ?? 0) + push * direction;
        });
      }
    }
  };

  return force;
};

const createSpouseForce = (
  spouseEdges: TreeData['relationships'],
  nodesById: Map<string, LayoutNode>,
): Force<LayoutNode, undefined> => {
  const force = (alpha: number) => {
    spouseEdges.forEach((relationship) => {
      const source = nodesById.get(relationship.sourceId);
      const target = nodesById.get(relationship.targetId);
      if (!source || !target) return;

      const deltaX = (target.x ?? target.anchorX) - (source.x ?? source.anchorX);
      const deltaY = (target.y ?? target.anchorY) - (source.y ?? source.anchorY);
      const direction = deltaX === 0 ? (source.order < target.order ? 1 : -1) : Math.sign(deltaX);
      const desiredGap = CARD_WIDTH + PARTNER_GAP;
      const gapError = Math.abs(deltaX) - desiredGap;
      const xAdjust = gapError * SPOUSE_ATTRACTION_STRENGTH * alpha;
      const yAdjust = deltaY * SAME_LEVEL_SPOUSE_STRENGTH * alpha;

      source.vx = (source.vx ?? 0) + xAdjust * direction;
      target.vx = (target.vx ?? 0) - xAdjust * direction;
      source.vy = (source.vy ?? 0) + yAdjust;
      target.vy = (target.vy ?? 0) - yAdjust;
    });
  };

  return force;
};

const createAmbientEntropyForce = (nodes: LayoutNode[]): Force<LayoutNode, undefined> => {
  let currentNodes = nodes;
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const force = (alpha: number) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const time = (now - startedAt) / 1000;
    const baseStrength = Math.max(alpha, LIVE_ALPHA_TARGET) * 0.16;

    currentNodes.forEach((node) => {
      const targetX = node.anchorX + Math.sin(time * node.entropyRate + node.entropyPhase) * 8;
      const targetY = node.anchorY + Math.cos(time * (node.entropyRate * 0.85) + node.entropyPhase) * 3;
      node.vx = (node.vx ?? 0) + (targetX - (node.x ?? node.anchorX)) * baseStrength * 0.02;
      node.vy = (node.vy ?? 0) + (targetY - (node.y ?? node.anchorY)) * baseStrength * 0.012;
    });
  };

  force.initialize = (nextNodes: LayoutNode[]) => {
    currentNodes = nextNodes;
  };

  return force;
};

const normalizePositions = (nodes: LayoutNode[]) => {
  if (!nodes.length) return new Map<string, Position>();

  const minX = Math.min(...nodes.map((node) => node.x ?? node.anchorX));
  const normalized = new Map<string, Position>();

  nodes.forEach((node) => {
    const x = Math.round((node.x ?? node.anchorX) - minX + LAYOUT_PADDING);
    // All nodes at the same level get identical Y — level 0 (newest gen) at bottom, oldest ancestors at top
    const y = Math.round(node.level * GENERATION_GAP + LAYOUT_PADDING);
    normalized.set(node.id, { x, y });
  });

  return normalized;
};

const createSnapshot = (tree: TreeData, previousPositions: Map<string, Position>) => {
  const levels = computeGenerationLevels(tree);
  const { households, householdByPersonId } = buildHouseholds(tree, levels);
  const { orderedHouseholds } = buildHouseholdOrdering(households, householdByPersonId, tree, previousPositions);
  const childrenByParent = new Map<string, string[]>();
  const parentsByChild = new Map<string, string[]>();
  const householdsById = new Map(households.map((household) => [household.id, household]));
  const orderedPeople = [...tree.people].sort(sortPeople);
  const rowOffsets = new Map<number, number>();
  const initialPositions = new Map<string, Position>();

  orderedHouseholds.forEach((household) => {
    const previousMembers = household.memberIds
      .map((memberId) => previousPositions.get(memberId))
      .filter((value): value is Position => Boolean(value));
    const memberSpacing = household.memberIds.length > 1 ? CARD_WIDTH + PARTNER_GAP : INITIAL_X_GAP;
    const rowOffset = rowOffsets.get(household.level) ?? 0;
    const relatedCenters = [
      ...household.memberIds.flatMap((memberId) => {
        const related: number[] = [];
        tree.relationships.forEach((relationship) => {
          if (relationship.type !== 'parent') return;
          if (relationship.sourceId === memberId) {
            const childHouseholdId = householdByPersonId.get(relationship.targetId);
            const childHousehold = childHouseholdId ? householdsById.get(childHouseholdId) : null;
            const center = childHousehold?.memberIds
              .map((id) => previousPositions.get(id)?.x)
              .filter((value): value is number => typeof value === 'number');
            if (center?.length) related.push(average(center));
          }
          if (relationship.targetId === memberId) {
            const parentHouseholdId = householdByPersonId.get(relationship.sourceId);
            const parentHousehold = parentHouseholdId ? householdsById.get(parentHouseholdId) : null;
            const center = parentHousehold?.memberIds
              .map((id) => previousPositions.get(id)?.x)
              .filter((value): value is number => typeof value === 'number');
            if (center?.length) related.push(average(center));
          }
        });
        return related;
      }),
    ];

    const preferredCenter = previousMembers.length
      ? average(previousMembers.map((entry) => entry.x))
      : (relatedCenters.length ? average(relatedCenters) : rowOffset + ((household.memberIds.length - 1) * memberSpacing) / 2);
    const householdStartX = Math.max(rowOffset, preferredCenter - ((household.memberIds.length - 1) * memberSpacing) / 2);

    household.memberIds.forEach((memberId, index) => {
      const previous = previousPositions.get(memberId);
      initialPositions.set(memberId, {
        x: previous?.x ?? (householdStartX + index * memberSpacing),
        y: previous?.y ?? household.level * GENERATION_GAP,
      });
    });

    rowOffsets.set(
      household.level,
      householdStartX + Math.max(INITIAL_X_GAP, household.memberIds.length * memberSpacing + INITIAL_X_GAP * 0.5),
    );
  });

  for (const relationship of tree.relationships) {
    if (relationship.type !== 'parent') continue;
    childrenByParent.set(relationship.sourceId, [...(childrenByParent.get(relationship.sourceId) ?? []), relationship.targetId]);
    parentsByChild.set(relationship.targetId, [...(parentsByChild.get(relationship.targetId) ?? []), relationship.sourceId]);
  }

  const treeSeed = JSON.stringify({
    people: orderedPeople.map((person) => person.id),
    relationships: [...tree.relationships]
      .map((relationship) => `${relationship.type}:${relationship.sourceId}:${relationship.targetId}`)
      .sort(),
  });
  const random = createSeededRandom(treeSeed);

  const nodes = orderedPeople.map<LayoutNode>((person, order) => {
    const previous = initialPositions.get(person.id) ?? previousPositions.get(person.id);
    const level = levels.get(person.id) ?? 0;
    const anchorY = level * GENERATION_GAP;
    const anchorX = previous?.x ?? order * INITIAL_X_GAP;

    return {
      id: person.id,
      person,
      level,
      householdId: householdByPersonId.get(person.id) ?? person.id,
      order,
      anchorX,
      anchorY,
      x: previous?.x ?? anchorX,
      y: previous?.y ?? anchorY,
      vx: 0,
      vy: 0,
      baseRadius: Math.hypot(CARD_WIDTH / 2, CARD_HEIGHT / 2) * 0.72,
      entropyPhase: random() * Math.PI * 2,
      entropyRate: 0.35 + random() * 0.45,
    };
  });

  return {
    nodes,
    nodesById: new Map(nodes.map((node) => [node.id, node])),
    households,
    householdsById,
    householdByPersonId,
    parentsByChild,
    childrenByParent,
    spouseEdges: tree.relationships.filter((relationship) => relationship.type === 'spouse'),
  } satisfies LayoutSnapshot;
};

const applyForces = (
  simulation: Simulation<LayoutNode, undefined>,
  snapshot: LayoutSnapshot,
  previousPositions: Map<string, Position>,
) => {
  simulation.nodes(snapshot.nodes);
  simulation
    .velocityDecay(VELOCITY_DECAY)
    .alphaDecay(ALPHA_DECAY)
    .force('charge', forceManyBody<LayoutNode>().strength(MANY_BODY_STRENGTH).distanceMin(70).distanceMax(900))
    .force('collide', forceCollide<LayoutNode>().radius((node: LayoutNode) => node.baseRadius + PERSON_COLLISION_PADDING).strength(1))
    .force('generationY', forceY<LayoutNode>((node: LayoutNode) => node.anchorY).strength(GENERATION_Y_STRENGTH))
    .force('anchorX', forceX<LayoutNode>((node: LayoutNode) => node.anchorX).strength(0.035))
    .force('spouseEdges', createSpouseForce(snapshot.spouseEdges, snapshot.nodesById))
    .force('parentConstraint', createParentConstraintForce(snapshot.parentsByChild, snapshot.householdsById, snapshot.householdByPersonId, snapshot.nodesById))
    .force('household', createHouseholdForce(snapshot.households, snapshot.nodesById, snapshot.childrenByParent))
    .force('branchSeparation', createBranchSeparationForce(snapshot.households, snapshot.nodesById))
    .force('previous', createPreviousPositionForce(previousPositions, snapshot.nodes))
    .force('levelClamp', createLevelClampForce(snapshot.nodes))
    .force('ambientEntropy', createAmbientEntropyForce(snapshot.nodes));
};

export const createLayoutRuntime = (initialTree: TreeData): LayoutRuntime => {
  let previousPositions = new Map<string, Position>();
  let snapshot = createSnapshot(initialTree, previousPositions);
  let positions = normalizePositions(snapshot.nodes);
  previousPositions = positions;

  const listeners = new Set<(nextPositions: Map<string, Position>) => void>();
  const simulation = forceSimulation<LayoutNode>(snapshot.nodes)
    .randomSource(Math.random)
    .stop();

  let rafId = 0;

  const emit = () => {
    positions = normalizePositions(snapshot.nodes);
    previousPositions = positions;
    listeners.forEach((listener) => listener(positions));
  };

  applyForces(simulation, snapshot, previousPositions);

  simulation.on('tick', () => {
    if (rafId) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      emit();
    });
  });

  simulation.alpha(0.9).alphaTarget(LIVE_ALPHA_TARGET).restart();
  emit();

  return {
    updateTree(nextTree) {
      const existingPositions = normalizePositions(snapshot.nodes);
      snapshot = createSnapshot(nextTree, existingPositions);
      applyForces(simulation, snapshot, existingPositions);

      snapshot.nodes.forEach((node) => {
        node.vx = (node.vx ?? 0) + (Math.random() - 0.5) * 0.8;
        node.vy = (node.vy ?? 0) + (Math.random() - 0.5) * 0.4;
      });

      simulation.alpha(Math.max(simulation.alpha(), REHEAT_ALPHA)).alphaTarget(LIVE_ALPHA_TARGET).restart();
      emit();
    },
    getPositions() {
      return positions;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(positions);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (rafId) window.cancelAnimationFrame(rafId);
      simulation.stop();
      listeners.clear();
    },
  };
};

export const buildLayout = (tree: TreeData, options?: BuildLayoutOptions) => {
  const snapshot = createSnapshot(tree, options?.previousPositions ?? new Map<string, Position>());
  const simulation = forceSimulation<LayoutNode>(snapshot.nodes)
    .randomSource(Math.random)
    .stop();

  applyForces(simulation, snapshot, options?.previousPositions ?? new Map<string, Position>());
  simulation.alpha(1);
  for (let tick = 0; tick < SIMULATION_TICKS; tick += 1) {
    simulation.tick();
  }
  simulation.stop();

  return normalizePositions(snapshot.nodes);
};
