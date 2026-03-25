import type { Person, Relationship, TreeData } from './types';

const normalizeText = (value: string) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const trimAt = (value: string) => value.replace(/^@|@$/g, '');
const makeId = (prefix: string, seed: string) => `${prefix}-${seed.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || Math.random().toString(36).slice(2, 10)}`;

const parseName = (value: string) => {
  const cleaned = value.replace(/\//g, ' ').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(' ').filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  return {
    firstName: parts.slice(0, -1).join(' ') || parts[0],
    lastName: parts.length > 1 ? parts.at(-1) ?? '' : '',
  };
};

const formatName = (person: Person) => {
  const first = person.firstName.trim() || 'Unknown';
  const last = person.lastName.trim();
  return last ? `${first} /${last}/` : first;
};

const parseDateYear = (value: string) => {
  const match = value.match(/(1[5-9]\d{2}|20\d{2})/);
  return match?.[1] ?? '';
};

export const importGedcom = (content: string): TreeData => {
  const lines = normalizeText(content).split('\n').map((line) => line.trimEnd()).filter(Boolean);
  if (!lines.length) {
    throw new Error('The GEDCOM file is empty.');
  }

  const individualRows = new Map<string, Record<string, string>>();
  const familyRows = new Map<string, { husband?: string; wife?: string; children: string[] }>();
  let currentIndividual: string | null = null;
  let currentFamily: string | null = null;
  let currentEvent: 'BIRT' | 'DEAT' | null = null;

  for (const line of lines) {
    const parts = line.split(/\s+/);
    const level = Number(parts[0]);
    if (Number.isNaN(level)) {
      throw new Error(`Malformed GEDCOM line: ${line}`);
    }

    if (level === 0) {
      currentEvent = null;
      currentIndividual = null;
      currentFamily = null;
      if (parts[2] === 'INDI') {
        currentIndividual = trimAt(parts[1] ?? '');
        individualRows.set(currentIndividual, individualRows.get(currentIndividual) ?? {});
      } else if (parts[2] === 'FAM') {
        currentFamily = trimAt(parts[1] ?? '');
        familyRows.set(currentFamily, familyRows.get(currentFamily) ?? { children: [] });
      }
      continue;
    }

    if (currentIndividual) {
      const record = individualRows.get(currentIndividual)!;
      const tag = parts[1];
      const value = parts.slice(2).join(' ');

      if (level === 1 && (tag === 'BIRT' || tag === 'DEAT')) {
        currentEvent = tag;
        continue;
      }

      if (level === 1) {
        currentEvent = null;
      }

      if (level === 1 && tag === 'NAME') record.NAME = value;
      if (level === 1 && tag === 'SEX') record.SEX = value;
      if (level === 1 && tag === 'NOTE') record.NOTE = [record.NOTE, value].filter(Boolean).join('\n');
      if (level === 2 && currentEvent && tag === 'DATE') record[`${currentEvent}_DATE`] = value;
      if (level === 2 && currentEvent && tag === 'PLAC') record[`${currentEvent}_PLAC`] = value;
      continue;
    }

    if (currentFamily) {
      const family = familyRows.get(currentFamily)!;
      const tag = parts[1];
      const value = trimAt(parts[2] ?? '');
      if (level === 1 && tag === 'HUSB') family.husband = value;
      if (level === 1 && tag === 'WIFE') family.wife = value;
      if (level === 1 && tag === 'CHIL') family.children.push(value);
    }
  }

  const people: Person[] = [...individualRows.entries()].map(([gedId, record]) => {
    const name = parseName(record.NAME ?? '');
    return {
      id: makeId('person', gedId),
      firstName: name.firstName || 'Unknown',
      lastName: name.lastName,
      birthYear: parseDateYear(record.BIRT_DATE ?? ''),
      deathYear: parseDateYear(record.DEAT_DATE ?? ''),
      birthPlace: record.BIRT_PLAC ?? '',
      notes: [record.NOTE, record.SEX ? `Sex: ${record.SEX}` : '', record.DEAT_PLAC ? `Death place: ${record.DEAT_PLAC}` : '']
        .filter(Boolean)
        .join('\n'),
    };
  });

  if (!people.length) {
    throw new Error('No INDI records were found in this GEDCOM file.');
  }

  const idMap = new Map<string, string>();
  [...individualRows.keys()].forEach((gedId, index) => {
    idMap.set(gedId, people[index].id);
  });

  const relationships: Relationship[] = [];
  for (const [famId, family] of familyRows.entries()) {
    const spouseIds = [family.husband, family.wife].filter(Boolean).map((id) => idMap.get(id!)).filter(Boolean) as string[];
    if (spouseIds.length === 2) {
      relationships.push({ id: `rel-spouse-${famId}`, type: 'spouse', sourceId: spouseIds[0], targetId: spouseIds[1] });
    }

    for (const child of family.children) {
      const childId = idMap.get(child);
      if (!childId) continue;
      for (const parent of spouseIds) {
        relationships.push({
          id: `rel-parent-${famId}-${parent}-${childId}`,
          type: 'parent',
          sourceId: parent,
          targetId: childId,
        });
      }
    }
  }

  const deduped = new Map<string, Relationship>();
  for (const relationship of relationships) {
    const key = relationship.type === 'spouse'
      ? `${relationship.type}:${[relationship.sourceId, relationship.targetId].sort().join(':')}`
      : `${relationship.type}:${relationship.sourceId}:${relationship.targetId}`;
    if (!deduped.has(key)) deduped.set(key, relationship);
  }

  return {
    people,
    relationships: [...deduped.values()],
  };
};

export const exportGedcom = (tree: TreeData) => {
  const personIds = new Map<string, string>();
  const lines: string[] = ['0 HEAD', '1 SOUR family-tree-webapp', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8'];

  tree.people.forEach((person, index) => {
    const gedId = `I${index + 1}`;
    personIds.set(person.id, gedId);
    lines.push(`0 @${gedId}@ INDI`);
    lines.push(`1 NAME ${formatName(person)}`);
    if (person.birthYear || person.birthPlace) {
      lines.push('1 BIRT');
      if (person.birthYear) lines.push(`2 DATE ${person.birthYear}`);
      if (person.birthPlace) lines.push(`2 PLAC ${person.birthPlace}`);
    }
    if (person.deathYear) {
      lines.push('1 DEAT');
      lines.push(`2 DATE ${person.deathYear}`);
    }
    if (person.notes) {
      person.notes.split(/\n+/).forEach((noteLine) => lines.push(`1 NOTE ${noteLine}`));
    }
  });

  const spouseFamilies = tree.relationships.filter((relationship) => relationship.type === 'spouse');
  const processedChildren = new Set<string>();

  spouseFamilies.forEach((spouse, index) => {
    const famId = `F${index + 1}`;
    lines.push(`0 @${famId}@ FAM`);
    lines.push(`1 HUSB @${personIds.get(spouse.sourceId)}@`);
    lines.push(`1 WIFE @${personIds.get(spouse.targetId)}@`);
    tree.relationships
      .filter(
        (relationship) =>
          relationship.type === 'parent' &&
          (relationship.sourceId === spouse.sourceId || relationship.sourceId === spouse.targetId),
      )
      .forEach((relationship) => {
        const key = `${famId}:${relationship.targetId}`;
        if (processedChildren.has(key)) return;
        processedChildren.add(key);
        lines.push(`1 CHIL @${personIds.get(relationship.targetId)}@`);
      });
  });

  const parentOnlyRelationships = tree.relationships.filter(
    (relationship) =>
      relationship.type === 'parent' &&
      !spouseFamilies.some(
        (spouse) =>
          spouse.sourceId === relationship.sourceId ||
          spouse.targetId === relationship.sourceId,
      ),
  );

  parentOnlyRelationships.forEach((relationship, index) => {
    const famId = `FP${index + 1}`;
    lines.push(`0 @${famId}@ FAM`);
    lines.push(`1 HUSB @${personIds.get(relationship.sourceId)}@`);
    lines.push(`1 CHIL @${personIds.get(relationship.targetId)}@`);
  });

  lines.push('0 TRLR');
  return `${lines.join('\n')}\n`;
};
