import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'tree.json');

export const seededTree = {
  people: [
    { id: 'person-jens', firstName: 'Jens', lastName: 'Sorenson', notes: 'Child of Olaf and Joanne Sorenson.' },
    { id: 'person-olaf', firstName: 'Olaf', lastName: 'Sorenson', notes: 'Parent of Jens. Child of Dale and Elizabeth Sorenson.' },
    { id: 'person-joanne', firstName: 'Joanne', lastName: 'Sorenson', notes: 'Parent of Jens. Child of Edgar and Jacqueline Langham.' },
    { id: 'person-dale', firstName: 'Dale', lastName: 'Sorenson', birthYear: '1925', deathYear: '2006', birthPlace: 'Racine, Racine, Wisconsin, United States', notes: 'Parent of Olaf. Likely Dale Harry Sorenson, born 29 Oct 1925 in Racine, Wisconsin; child of Harry Nels Sorenson and Emma Flora Timler.' },
    { id: 'person-elizabeth', firstName: 'Elizabeth', lastName: 'Sorenson', birthYear: '1924', deathYear: '1989', birthPlace: 'Milwaukee, Milwaukee, Wisconsin, United States', notes: 'Parent of Olaf. Maiden name: Spies. Likely Elizabeth Jane Spies, born 17 Nov 1924 in Milwaukee, Wisconsin; daughter of John Spies Jr.' },
    { id: 'person-john-spies', firstName: 'John', lastName: 'Spies', birthYear: '1890', deathYear: '1965', birthPlace: 'Meidling, Vienna, Austria', notes: 'Parent of Elizabeth Sorenson. Likely John Spies Jr., born 20 Dec 1890 in Meidling, Vienna, Austria; child of John Spies and Katherine Karabec.' },
    { id: 'person-harry-sorenson', firstName: 'Harry Nels', lastName: 'Sorenson', birthYear: '1898', deathYear: '1979', birthPlace: 'Menominee, Menominee, Michigan, United States', notes: 'Parent of Dale Harry Sorenson. Find a Grave memorial gives birth 10 Dec 1898 in Menominee, Michigan; death 24 Mar 1979 in Largo, Florida; burial in Racine, Wisconsin. Listed spouse: Emma Flora Timler Sorenson (m. 1924).' },
    { id: 'person-emma-timler', firstName: 'Emma Flora', lastName: 'Timler', birthYear: '1904', deathYear: '1990', birthPlace: 'Russia', notes: 'Parent of Dale Harry Sorenson. Find a Grave memorial gives birth 12 Oct 1904 in Russia; death 3 Nov 1990 in Seminole, Florida; burial in Racine, Wisconsin.' },
    { id: 'person-julius-sorenson', firstName: 'Julius Laurentius', lastName: 'Sørensen', birthYear: '1865', deathYear: '1932', birthPlace: 'Vesterborg, Halsted Klosters, Denmark', notes: 'Parent of Harry Nels Sorenson. Born 13 Jul 1865 in Vesterborg, Halsted Klosters, Denmark; died 6 Nov 1932 in Racine, Wisconsin; buried in Graceland Cemetery, Racine, Wisconsin. Married Anna Olsson on 9 Mar 1889 in Vesterborg, Halsted Klosters, Denmark. Immigrated to New York County, New York in 1891. Lived in Vesterborg, Denmark in 1890 and Racine, Wisconsin in 1920. Parents: Søren Nielsen and Johanne Lorentzen. They were the parents of at least 2 sons and 5 daughters.' },
    { id: 'person-anna-olsson', firstName: 'Anna', lastName: 'Olsson', birthYear: '1867', deathYear: '1945', notes: 'Likely parent of Harry Nels Sorenson, per Harry Nels Sorenson Find a Grave memorial family listing.' },
    { id: 'person-nancy-hanson', firstName: 'Nancy Lee', lastName: 'Hanson', birthYear: '1930', deathYear: '2015', notes: 'Likely sibling of Dale Harry Sorenson. Harry Nels Sorenson Find a Grave memorial lists children Dale Harry Sorenson (1925–2006) and Nancy Lee Sorenson Hanson (1930–2015).' },
    { id: 'person-johanna-sorenson', firstName: 'Johanna', lastName: 'Sorenson', birthYear: '1889', deathYear: '1989', notes: 'Likely sibling of Harry Nels Sorenson. Public FamilySearch profile for Harry Nels Sorenson (G6M4-5GR) lists Johanna Sorenson (1889–1989) among the children of Julius Laurentius Sørensen and Anna Olsson.' },
    { id: 'person-selma-sorenson', firstName: 'Selma Sissa', lastName: 'Sorenson', birthYear: '1890', deathYear: '1969', notes: 'Likely sibling of Harry Nels Sorenson. Public FamilySearch profile for Harry Nels Sorenson (G6M4-5GR) lists Selma Sissa Sorenson (1890–1969) among the children of Julius Laurentius Sørensen and Anna Olsson.' },
    { id: 'person-ebba-sorenson', firstName: 'Ebba Bernadotte', lastName: 'Sorenson', birthYear: '1892', deathYear: '1967', notes: 'Likely sibling of Harry Nels Sorenson. Public FamilySearch profile for Harry Nels Sorenson (G6M4-5GR) lists Ebba Bernadotte Sorenson (1892–1967) among the children of Julius Laurentius Sørensen and Anna Olsson.' },
    { id: 'person-arthur-sorenson', firstName: 'Arthur Julius', lastName: 'Sorenson', birthYear: '1895', deathYear: '1988', notes: 'Likely sibling of Harry Nels Sorenson. Public FamilySearch profile for Harry Nels Sorenson (G6M4-5GR) lists Arthur Julius Sorenson (1895–1988) among the children of Julius Laurentius Sørensen and Anna Olsson.' },
    { id: 'person-myrtle-sorenson', firstName: 'Myrtle J', lastName: 'Sorenson', birthYear: '1897', deathYear: '1951', notes: 'Likely sibling of Harry Nels Sorenson. Public FamilySearch profile for Harry Nels Sorenson (G6M4-5GR) lists Myrtle J Sorenson (1897–1951) among the children of Julius Laurentius Sørensen and Anna Olsson.' },
    { id: 'person-lily-sorenson', firstName: 'Lily Ann', lastName: 'Sorenson', birthYear: '1900', deathYear: '1987', notes: 'Likely sibling of Harry Nels Sorenson. Public FamilySearch profile for Harry Nels Sorenson (G6M4-5GR) lists Lily Ann Sorenson (1900–1987) among the children of Julius Laurentius Sørensen and Anna Olsson.' },
    { id: 'person-jacqueline', firstName: 'Jacqueline Avis', lastName: 'Langham', notes: 'Parent of Joanne Sorenson. Married Edgar Donald Langham. Preceded in death by husband Edgar (2010). Three daughters including Joanne Sorenson, five grandchildren, five great-grandchildren.' },
    { id: 'person-edgar', firstName: 'Edgar Donald', lastName: 'Langham', birthYear: '1924', deathYear: '2012', birthPlace: 'Huntington, West Virginia', notes: 'Parent of Joanne Sorenson. Born Aug. 25, 1924 in Huntington, WV; died Sept. 15, 2012 in Longview, WA; buried Satsop Cemetery. Navy veteran served in South Pacific during WWII. Worked for Northern Pacific Railroad and retired from Burlington Northern Railroad. Preceded in death by wife Jacqueline Avis (White) Langham (2010) and son Donald Arthur Langham (2011). Survived by three daughters including Joanne and Olaf Sorenson, five grandchildren, and five great-grandchildren.' }
  ],
  relationships: [
    { id: 'rel-olaf-jens', type: 'parent', sourceId: 'person-olaf', targetId: 'person-jens' },
    { id: 'rel-joanne-jens', type: 'parent', sourceId: 'person-joanne', targetId: 'person-jens' },
    { id: 'rel-olaf-joanne', type: 'spouse', sourceId: 'person-olaf', targetId: 'person-joanne' },
    { id: 'rel-dale-olaf', type: 'parent', sourceId: 'person-dale', targetId: 'person-olaf' },
    { id: 'rel-elizabeth-olaf', type: 'parent', sourceId: 'person-elizabeth', targetId: 'person-olaf' },
    { id: 'rel-dale-elizabeth', type: 'spouse', sourceId: 'person-dale', targetId: 'person-elizabeth' },
    { id: 'rel-john-spies-elizabeth', type: 'parent', sourceId: 'person-john-spies', targetId: 'person-elizabeth' },
    { id: 'rel-harry-dale', type: 'parent', sourceId: 'person-harry-sorenson', targetId: 'person-dale' },
    { id: 'rel-emma-dale', type: 'parent', sourceId: 'person-emma-timler', targetId: 'person-dale' },
    { id: 'rel-harry-emma', type: 'spouse', sourceId: 'person-harry-sorenson', targetId: 'person-emma-timler' },
    { id: 'rel-julius-harry', type: 'parent', sourceId: 'person-julius-sorenson', targetId: 'person-harry-sorenson' },
    { id: 'rel-anna-harry', type: 'parent', sourceId: 'person-anna-olsson', targetId: 'person-harry-sorenson' },
    { id: 'rel-harry-nancy', type: 'parent', sourceId: 'person-harry-sorenson', targetId: 'person-nancy-hanson' },
    { id: 'rel-emma-nancy', type: 'parent', sourceId: 'person-emma-timler', targetId: 'person-nancy-hanson' },
    { id: 'rel-julius-johanna', type: 'parent', sourceId: 'person-julius-sorenson', targetId: 'person-johanna-sorenson' },
    { id: 'rel-anna-johanna', type: 'parent', sourceId: 'person-anna-olsson', targetId: 'person-johanna-sorenson' },
    { id: 'rel-julius-selma', type: 'parent', sourceId: 'person-julius-sorenson', targetId: 'person-selma-sorenson' },
    { id: 'rel-anna-selma', type: 'parent', sourceId: 'person-anna-olsson', targetId: 'person-selma-sorenson' },
    { id: 'rel-julius-ebba', type: 'parent', sourceId: 'person-julius-sorenson', targetId: 'person-ebba-sorenson' },
    { id: 'rel-anna-ebba', type: 'parent', sourceId: 'person-anna-olsson', targetId: 'person-ebba-sorenson' },
    { id: 'rel-julius-arthur', type: 'parent', sourceId: 'person-julius-sorenson', targetId: 'person-arthur-sorenson' },
    { id: 'rel-anna-arthur', type: 'parent', sourceId: 'person-anna-olsson', targetId: 'person-arthur-sorenson' },
    { id: 'rel-julius-myrtle', type: 'parent', sourceId: 'person-julius-sorenson', targetId: 'person-myrtle-sorenson' },
    { id: 'rel-anna-myrtle', type: 'parent', sourceId: 'person-anna-olsson', targetId: 'person-myrtle-sorenson' },
    { id: 'rel-julius-lilyann', type: 'parent', sourceId: 'person-julius-sorenson', targetId: 'person-lily-sorenson' },
    { id: 'rel-anna-lilyann', type: 'parent', sourceId: 'person-anna-olsson', targetId: 'person-lily-sorenson' },
    { id: 'rel-edgar-joanne', type: 'parent', sourceId: 'person-edgar', targetId: 'person-joanne' },
    { id: 'rel-jacqueline-joanne', type: 'parent', sourceId: 'person-jacqueline', targetId: 'person-joanne' },
    { id: 'rel-edgar-jacqueline', type: 'spouse', sourceId: 'person-edgar', targetId: 'person-jacqueline' }
  ]
};

const normalizeTree = (tree) => ({
  people: Array.isArray(tree?.people) ? tree.people : [],
  relationships: Array.isArray(tree?.relationships) ? tree.relationships : [],
});

export const ensureTreeFile = async () => {
  await mkdir(dataDir, { recursive: true });

  try {
    await access(dataFile);
  } catch {
    await writeFile(dataFile, JSON.stringify(seededTree, null, 2));
  }

  return dataFile;
};

export const readTree = async () => {
  await ensureTreeFile();
  const raw = await readFile(dataFile, 'utf8');
  return normalizeTree(JSON.parse(raw));
};

export const writeTree = async (tree) => {
  await ensureTreeFile();
  const normalized = normalizeTree(tree);
  await writeFile(dataFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
};

export const getTreeFilePath = () => dataFile;
