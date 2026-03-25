import type { DuplicateCandidate, MergeDecision, MergeFieldKey, Person, Relationship, TreeData } from './types';

const mergeFields: MergeFieldKey[] = ['firstName', 'lastName', 'birthYear', 'deathYear', 'birthPlace', 'notes'];

const normalize = (value?: string) => (value ?? '').trim().toLowerCase();
const tokenize = (value?: string) => normalize(value).split(/[^a-z0-9]+/).filter(Boolean);
const yearNumber = (value?: string) => {
  const match = (value ?? '').match(/\d{3,4}/);
  return match ? Number(match[0]) : undefined;
};

const overlapScore = (left?: string, right?: string) => {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap / Math.max(leftTokens.size, rightTokens.size);
};

const relationshipKey = (relationship: Pick<Relationship, 'type' | 'sourceId' | 'targetId'>) =>
  relationship.type === 'spouse'
    ? `${relationship.type}:${[relationship.sourceId, relationship.targetId].sort().join(':')}`
    : `${relationship.type}:${relationship.sourceId}:${relationship.targetId}`;

export const getDisplayName = (person: Person) => `${person.firstName} ${person.lastName}`.trim() || 'Unnamed person';

export const emptyPersonDraft = {
  firstName: '',
  lastName: '',
  birthYear: '',
  deathYear: '',
  birthPlace: '',
  notes: '',
};

export const buildMergeDecision = (left: Person, right: Person): MergeDecision => {
  const decision = {} as MergeDecision;
  for (const field of mergeFields) {
    const leftValue = (left[field] ?? '').trim();
    const rightValue = (right[field] ?? '').trim();
    decision[field] = rightValue.length > leftValue.length ? rightValue : leftValue;
  }
  return decision;
};

export const findDuplicateCandidates = (tree: TreeData): DuplicateCandidate[] => {
  const duplicates: DuplicateCandidate[] = [];

  for (let index = 0; index < tree.people.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < tree.people.length; otherIndex += 1) {
      const left = tree.people[index];
      const right = tree.people[otherIndex];
      const reasons: string[] = [];
      let score = 0;

      const leftFull = normalize(getDisplayName(left));
      const rightFull = normalize(getDisplayName(right));
      const sameFullName = leftFull && leftFull === rightFull;
      const sameLastName = normalize(left.lastName) && normalize(left.lastName) === normalize(right.lastName);
      const sameFirstName = normalize(left.firstName) && normalize(left.firstName) === normalize(right.firstName);
      const firstInitialMatch = left.firstName && right.firstName && normalize(left.firstName)[0] === normalize(right.firstName)[0];
      const birthLeft = yearNumber(left.birthYear);
      const birthRight = yearNumber(right.birthYear);
      const deathLeft = yearNumber(left.deathYear);
      const deathRight = yearNumber(right.deathYear);
      const placeOverlap = overlapScore(left.birthPlace, right.birthPlace);

      if (sameFullName) {
        score += 0.48;
        reasons.push('Same full name');
      } else if (sameLastName && sameFirstName) {
        score += 0.42;
        reasons.push('Matching first and last names');
      } else if (sameLastName && firstInitialMatch) {
        score += 0.2;
        reasons.push('Same last name and first initial');
      }

      if (birthLeft && birthRight) {
        const diff = Math.abs(birthLeft - birthRight);
        if (diff === 0) {
          score += 0.22;
          reasons.push('Same birth year');
        } else if (diff <= 1) {
          score += 0.12;
          reasons.push('Birth years within one year');
        } else if (diff > 8) {
          score -= 0.18;
          reasons.push('Birth years are far apart');
        }
      }

      if (deathLeft && deathRight) {
        const diff = Math.abs(deathLeft - deathRight);
        if (diff === 0) {
          score += 0.08;
          reasons.push('Same death year');
        } else if (diff > 5) {
          score -= 0.08;
        }
      }

      if (placeOverlap >= 0.7) {
        score += 0.18;
        reasons.push('Highly similar birth place');
      } else if (placeOverlap >= 0.34) {
        score += 0.1;
        reasons.push('Partially matching place names');
      }

      const notesOverlap = overlapScore(left.notes, right.notes);
      if (notesOverlap >= 0.4) {
        score += 0.05;
        reasons.push('Notes share uncommon wording');
      }

      if (score >= 0.45) {
        duplicates.push({
          id: `${left.id}:${right.id}`,
          leftPersonId: left.id,
          rightPersonId: right.id,
          score: Number(Math.max(0, Math.min(0.99, score)).toFixed(2)),
          reasons,
        });
      }
    }
  }

  return duplicates.sort((a, b) => b.score - a.score);
};

export const mergePeople = (tree: TreeData, primaryId: string, secondaryId: string, decision: MergeDecision): TreeData => {
  if (primaryId === secondaryId) return tree;
  const primary = tree.people.find((person) => person.id === primaryId);
  const secondary = tree.people.find((person) => person.id === secondaryId);
  if (!primary || !secondary) return tree;

  const mergedPerson: Person = { ...primary, ...decision, id: primary.id };
  const relationshipMap = new Map<string, Relationship>();

  for (const relationship of tree.relationships) {
    const remapped: Relationship = {
      ...relationship,
      sourceId: relationship.sourceId === secondaryId ? primaryId : relationship.sourceId,
      targetId: relationship.targetId === secondaryId ? primaryId : relationship.targetId,
    };

    if (remapped.sourceId === remapped.targetId) continue;

    const key = relationshipKey(remapped);
    if (!relationshipMap.has(key)) {
      relationshipMap.set(key, { ...remapped, id: relationship.id === key ? relationship.id : relationship.id });
    }
  }

  return {
    people: tree.people.filter((person) => person.id !== secondaryId).map((person) => (person.id === primaryId ? mergedPerson : person)),
    relationships: [...relationshipMap.values()],
  };
};

export const mergeFieldKeys = mergeFields;
