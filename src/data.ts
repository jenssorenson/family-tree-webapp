import type { TreeData } from './types';

export const emptyTree: TreeData = {
  people: [],
  relationships: [],
};

export const seedTree: TreeData = {
  people: [
    {
      id: 'p1',
      firstName: 'Eleanor',
      lastName: 'Hart',
      birthYear: '1942',
      birthPlace: 'Portland, Oregon',
      notes: 'Family matriarch; loved keeping handwritten records.',
    },
    {
      id: 'p2',
      firstName: 'Thomas',
      lastName: 'Hart',
      birthYear: '1940',
      deathYear: '2016',
      birthPlace: 'Boise, Idaho',
      notes: 'Mechanic and amateur radio operator.',
    },
    {
      id: 'p3',
      firstName: 'Mara',
      lastName: 'Hart',
      birthYear: '1968',
      birthPlace: 'Seattle, Washington',
      notes: 'Daughter of Eleanor and Thomas.',
    },
    {
      id: 'p4',
      firstName: 'Daniel',
      lastName: 'Hart',
      birthYear: '1965',
      birthPlace: 'Sacramento, California',
      notes: 'Married to Mara in 1989.',
    },
    {
      id: 'p5',
      firstName: 'Lucas',
      lastName: 'Hart',
      birthYear: '1993',
      birthPlace: 'San Jose, California',
      notes: 'Grandson; software engineer.',
    },
    {
      id: 'p6',
      firstName: 'Ivy',
      lastName: 'Hart',
      birthYear: '1997',
      birthPlace: 'San Jose, California',
      notes: 'Granddaughter; photographer.',
    },
  ],
  relationships: [
    { id: 'r1', type: 'spouse', sourceId: 'p1', targetId: 'p2' },
    { id: 'r2', type: 'spouse', sourceId: 'p3', targetId: 'p4' },
    { id: 'r3', type: 'parent', sourceId: 'p1', targetId: 'p3' },
    { id: 'r4', type: 'parent', sourceId: 'p2', targetId: 'p3' },
    { id: 'r5', type: 'parent', sourceId: 'p3', targetId: 'p5' },
    { id: 'r6', type: 'parent', sourceId: 'p4', targetId: 'p5' },
    { id: 'r7', type: 'parent', sourceId: 'p3', targetId: 'p6' },
    { id: 'r8', type: 'parent', sourceId: 'p4', targetId: 'p6' },
  ],
};
