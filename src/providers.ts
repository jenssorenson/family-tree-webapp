import type { ProviderResult, SearchCandidate, SearchProvider, TreeData } from './types';

type WikidataSearchItem = {
  id: string;
  label?: string;
  description?: string;
  match?: {
    type?: string;
    language?: string;
    text?: string;
  };
};

type WikidataEntity = {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  aliases?: Record<string, { value: string }[]>;
  claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
  sitelinks?: Record<string, { title: string }>;
};

type WikipediaSearchItem = {
  pageid: number;
  title: string;
  snippet: string;
};

type WikipediaExtractPage = {
  pageid: number;
  title: string;
  extract?: string;
};

const recordPool: SearchCandidate[] = [
  {
    id: 'c1',
    provider: 'sample-archive',
    score: 0.94,
    summary: '1950 census index, Portland household',
    person: {
      id: 'import-elias-hart',
      firstName: 'Elias',
      lastName: 'Hart',
      birthYear: '1914',
      deathYear: '1988',
      birthPlace: 'Portland, Oregon',
      notes: 'Sample archive record: possible father of Eleanor Hart.',
    },
    hints: ['Lives in same neighborhood as Eleanor in 1950', 'Occupation listed as dock supervisor'],
    suggestedRelationship: { type: 'parent', relatedPersonId: 'p1', direction: 'to-candidate' },
  },
  {
    id: 'c2',
    provider: 'sample-archive',
    score: 0.88,
    summary: 'Marriage ledger entry, Santa Clara County',
    person: {
      id: 'import-nora-chen',
      firstName: 'Nora',
      lastName: 'Chen',
      birthYear: '1995',
      birthPlace: 'San Jose, California',
      notes: 'Potential spouse record connected to Lucas Hart.',
    },
    hints: ['Marriage license application in 2021', 'Witness surname matches Hart family friend'],
    suggestedRelationship: { type: 'spouse', relatedPersonId: 'p5', direction: 'from-candidate' },
  },
  {
    id: 'c3',
    provider: 'sample-archive',
    score: 0.83,
    summary: 'Birth announcement clipping',
    person: {
      id: 'import-ada-hart',
      firstName: 'Ada',
      lastName: 'Hart',
      birthYear: '2024',
      birthPlace: 'Oakland, California',
      notes: 'Possible daughter record for Ivy Hart branch.',
    },
    hints: ['Announcement names mother as Ivy Hart', 'No second parent listed in clipping'],
    suggestedRelationship: { type: 'parent', relatedPersonId: 'p6', direction: 'from-candidate' },
  },
  {
    id: 'c4',
    provider: 'sample-archive',
    score: 0.79,
    summary: 'Draft card transcription, Idaho',
    person: {
      id: 'import-james-hart',
      firstName: 'James',
      lastName: 'Hart',
      birthYear: '1918',
      deathYear: '1977',
      birthPlace: 'Boise, Idaho',
      notes: 'Could be a sibling branch related to Thomas Hart.',
    },
    hints: ['Same hometown as Thomas', 'Nearest relative line partially matches Hart household'],
    suggestedRelationship: { type: 'parent', relatedPersonId: 'p2', direction: 'to-candidate' },
  },
];

const normalize = (value: string) => value.toLowerCase().trim();
const unique = <T,>(values: T[]) => [...new Set(values)];
const queryKeywords = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const cleanSnippet = (value: string) => value.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const matchesQuery = (candidate: SearchCandidate, query: string) => {
  const haystack = [
    candidate.person.firstName,
    candidate.person.lastName,
    candidate.person.birthPlace,
    candidate.summary,
    candidate.person.notes,
    candidate.hints.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(normalize(query));
};

const parseName = (label: string) => {
  const cleaned = label.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);

  if (parts.length <= 1) {
    return {
      firstName: cleaned,
      lastName: '',
    };
  }

  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts.at(-1) ?? '',
  };
};

const extractYear = (value: unknown) => {
  if (!value || typeof value !== 'object' || !("time" in value)) return '';
  const time = String((value as { time?: string }).time ?? '');
  const match = time.match(/([+-]\d{4})/);
  return match ? match[1].replace('+', '') : '';
};

const getClaimEntityId = (entity: WikidataEntity, property: string) => {
  const value = entity.claims?.[property]?.[0]?.mainsnak?.datavalue?.value;
  if (!value || typeof value !== 'object' || !("id" in value)) return undefined;
  return String((value as { id?: string }).id ?? '');
};

const getClaimEntityIds = (entity: WikidataEntity, property: string) =>
  (entity.claims?.[property] ?? [])
    .map((claim) => claim.mainsnak?.datavalue?.value)
    .filter((value): value is { id?: string } => value !== null && typeof value === 'object' && 'id' in value)
    .map((value) => String(value.id ?? ''))
    .filter(Boolean);

const getClaimYear = (entity: WikidataEntity, property: string) => extractYear(entity.claims?.[property]?.[0]?.mainsnak?.datavalue?.value);

const labelForEntity = (entity: WikidataEntity | undefined) => entity?.labels?.en?.value ?? entity?.labels?.mul?.value ?? entity?.id ?? '';

const keywordScoreBoost = (candidate: SearchCandidate, query: string) => {
  const keywords = queryKeywords(query);
  if (!keywords.length) return 0;

  const haystack = [
    candidate.person.firstName,
    candidate.person.lastName,
    candidate.person.birthYear,
    candidate.person.deathYear,
    candidate.person.birthPlace,
    candidate.summary,
    candidate.person.notes,
    candidate.hints.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const matched = keywords.filter((keyword) => haystack.includes(keyword)).length;
  return Math.min(0.12, matched * 0.025);
};

const branchSuggestion = (candidate: SearchCandidate, tree: TreeData, branchPersonId?: string) => {
  if (!branchPersonId) return undefined;
  const branchPerson = tree.people.find((person) => person.id === branchPersonId);
  if (!branchPerson) return undefined;

  const branchLastName = branchPerson.lastName.toLowerCase();
  const candidateLastName = candidate.person.lastName.toLowerCase();
  if (branchLastName && candidateLastName && branchLastName === candidateLastName) {
    return {
      type: 'parent' as const,
      relatedPersonId: branchPersonId,
      direction: 'to-candidate' as const,
    };
  }

  return undefined;
};

const branchBoost = (candidate: SearchCandidate, tree: TreeData, branchPersonId?: string) => {
  if (!branchPersonId) return candidate.score;
  const branchPerson = tree.people.find((person) => person.id === branchPersonId);
  if (!branchPerson) return candidate.score;

  const sameLastName =
    candidate.person.lastName && branchPerson.lastName
      ? candidate.person.lastName.toLowerCase() === branchPerson.lastName.toLowerCase()
      : false;

  const samePlace =
    candidate.person.birthPlace && branchPerson.birthPlace
      ? candidate.person.birthPlace.toLowerCase().includes(branchPerson.birthPlace.split(',')[0].toLowerCase())
      : false;

  return Number((candidate.score + (sameLastName ? 0.03 : 0) + (samePlace ? 0.02 : 0)).toFixed(2));
};

const fetchJson = async <T,>(url: string) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeout);
  }
};

const wikidataApi = 'https://www.wikidata.org/w/api.php';
const wikipediaApi = 'https://en.wikipedia.org/w/api.php';

const sampleArchiveProvider: SearchProvider = {
  id: 'sample-archive',
  label: 'Sample Archive',
  description: 'Mock genealogy provider with deterministic sample records for demos and offline-ish UI testing.',
  limitations: ['Not a live source', 'Returns fixed sample candidates only'],
  search: async ({ query, branchPersonId }, tree) => {
    const effectiveQuery = query.trim();
    const base = effectiveQuery ? recordPool.filter((candidate) => matchesQuery(candidate, effectiveQuery)) : recordPool;

    const candidates = base
      .map((candidate) => ({
        ...candidate,
        score: branchBoost(candidate, tree, branchPersonId),
      }))
      .sort((a, b) => b.score - a.score);

    await new Promise((resolve) => window.setTimeout(resolve, 250));

    return {
      providerId: 'sample-archive',
      providerLabel: 'Sample Archive',
      providerDescription: 'Mock genealogy provider with deterministic sample records for demos and offline-ish UI testing.',
      query: effectiveQuery,
      candidates,
      mocked: true,
    } satisfies ProviderResult;
  },
};

const wikidataProvider: SearchProvider = {
  id: 'wikidata',
  label: 'Wikidata',
  description: 'Live public structured data from Wikidata. Best for notable historical people and records with linked places/dates.',
  limitations: [
    'Coverage is strongest for notable or well-documented people, not ordinary census-style records',
    'Free-text genealogy queries are approximate; results depend on Wikidata labels and descriptions',
  ],
  search: async ({ query, branchPersonId }, tree) => {
    const branchPerson = tree.people.find((person) => person.id === branchPersonId);
    const fallbackQuery = branchPerson ? `${branchPerson.firstName} ${branchPerson.lastName}`.trim() : '';
    const effectiveQuery = query.trim() || fallbackQuery;

    if (!effectiveQuery) {
      return {
        providerLabel: 'Wikidata',
        query: effectiveQuery,
        candidates: [],
        mocked: false,
        warning: 'Enter a name or choose a branch person so Wikidata has something concrete to search for.',
      };
    }

    const searchUrl = `${wikidataApi}?action=wbsearchentities&format=json&language=en&limit=8&type=item&origin=*&search=${encodeURIComponent(
      effectiveQuery,
    )}`;
    const searchData = await fetchJson<{ search?: WikidataSearchItem[] }>(searchUrl);
    const searchItems = (searchData.search ?? []).filter((item) => item.label);

    if (!searchItems.length) {
      return {
        providerLabel: 'Wikidata',
        query: effectiveQuery,
        candidates: [],
        mocked: false,
      };
    }

    const entityIds = searchItems.map((item) => item.id).join('|');
    const entityUrl = `${wikidataApi}?action=wbgetentities&format=json&languages=en&props=labels|descriptions|aliases|claims|sitelinks&origin=*&ids=${encodeURIComponent(
      entityIds,
    )}`;
    const entityData = await fetchJson<{ entities?: Record<string, WikidataEntity> }>(entityUrl);
    const entities = entityData.entities ?? {};

    const placeIds = unique(
      searchItems
        .flatMap((item) => {
          const entity = entities[item.id];
          return [getClaimEntityId(entity, 'P19'), getClaimEntityId(entity, 'P20')];
        })
        .filter((value): value is string => Boolean(value)),
    );

    const instanceOfIds = unique(
      searchItems.flatMap((item) => {
        const entity = entities[item.id];
        return entity ? getClaimEntityIds(entity, 'P31') : [];
      }),
    );

    const auxIds = unique([...placeIds, ...instanceOfIds]);
    const auxEntities = auxIds.length
      ? (
          await fetchJson<{ entities?: Record<string, WikidataEntity> }>(
            `${wikidataApi}?action=wbgetentities&format=json&languages=en&props=labels&origin=*&ids=${encodeURIComponent(auxIds.join('|'))}`,
          )
        ).entities ?? {}
      : {};

    const humanishTerms = ['human', 'person', 'man', 'woman', 'biologist', 'mathematician', 'scientist', 'actor', 'writer', 'politician'];

    const candidates = searchItems
      .map((item, index) => {
        const entity = entities[item.id];
        if (!entity) return null;

        const label = item.label ?? labelForEntity(entity);
        const name = parseName(label);
        const birthPlaceId = getClaimEntityId(entity, 'P19');
        const deathPlaceId = getClaimEntityId(entity, 'P20');
        const birthPlace = labelForEntity(auxEntities[birthPlaceId ?? '']);
        const deathPlace = labelForEntity(auxEntities[deathPlaceId ?? '']);
        const birthYear = getClaimYear(entity, 'P569');
        const deathYear = getClaimYear(entity, 'P570');
        const description = entity.descriptions?.en?.value ?? item.description ?? 'Wikidata person entry';
        const aliases = (entity.aliases?.en ?? []).slice(0, 2).map((alias) => alias.value);
        const wikipediaTitle = entity.sitelinks?.enwiki?.title;
        const wikipediaUrl = wikipediaTitle ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wikipediaTitle.replace(/ /g, '_'))}` : undefined;
        const instanceLabels = getClaimEntityIds(entity, 'P31').map((id) => labelForEntity(auxEntities[id]).toLowerCase());
        const looksLikePerson = instanceLabels.includes('human') || humanishTerms.some((term) => description.toLowerCase().includes(term));
        if (!looksLikePerson) return null;

        const candidate: SearchCandidate = {
          id: `wikidata-${item.id}`,
          provider: 'wikidata',
          score: Number((0.9 - index * 0.05).toFixed(2)),
          summary: description,
          person: {
            id: `wikidata-person-${item.id}`,
            firstName: name.firstName,
            lastName: name.lastName,
            birthYear,
            deathYear,
            birthPlace: birthPlace || deathPlace,
            notes: [
              `Wikidata item: ${item.id}`,
              deathPlace ? `Death place: ${deathPlace}` : '',
              wikipediaUrl ? `Wikipedia: ${wikipediaUrl}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          },
          hints: unique([
            item.match?.text ? `Matched on: ${item.match.text}` : '',
            ...aliases.map((alias) => `Alias: ${alias}`),
            birthYear && deathYear ? `Life dates: ${birthYear}–${deathYear}` : '',
            birthPlace ? `Birth place: ${birthPlace}` : '',
          ].filter(Boolean)),
          suggestedRelationship: branchSuggestion(
            {
              id: `wikidata-${item.id}`,
              provider: 'wikidata',
              score: 0,
              summary: description,
              person: {
                id: `wikidata-person-${item.id}`,
                firstName: name.firstName,
                lastName: name.lastName,
              },
              hints: [],
            },
            tree,
            branchPersonId,
          ),
        };

        candidate.score = Number((branchBoost(candidate, tree, branchPersonId) + keywordScoreBoost(candidate, effectiveQuery)).toFixed(2));
        return candidate;
      })
      .filter((candidate): candidate is SearchCandidate => Boolean(candidate))
      .sort((a, b) => b.score - a.score);

    return {
      providerLabel: 'Wikidata',
      query: effectiveQuery,
      candidates,
      mocked: false,
      warning:
        'Wikidata is best at notable people and linked facts. It is not a replacement for dedicated census/birth/death archives.',
    };
  },
};

const wikipediaProvider: SearchProvider = {
  id: 'wikipedia',
  label: 'Wikipedia people search',
  description: 'Live public encyclopedia search. Useful as a broad fallback when you want human-readable bios and snippets.',
  limitations: [
    'Search results are not guaranteed to be people',
    'Structured genealogy fields are inferred from article text, so dates/places can be missing or rough',
  ],
  search: async ({ query, branchPersonId }, tree) => {
    const branchPerson = tree.people.find((person) => person.id === branchPersonId);
    const fallbackQuery = branchPerson ? `${branchPerson.firstName} ${branchPerson.lastName}`.trim() : '';
    const effectiveQuery = query.trim() || fallbackQuery;

    if (!effectiveQuery) {
      return {
        providerLabel: 'Wikipedia people search',
        query: effectiveQuery,
        candidates: [],
        mocked: false,
        warning: 'Enter a name or branch focus to search Wikipedia.',
      };
    }

    const searchUrl = `${wikipediaApi}?action=query&list=search&srsearch=${encodeURIComponent(
      effectiveQuery,
    )}&srlimit=8&format=json&origin=*`;
    const searchData = await fetchJson<{ query?: { search?: WikipediaSearchItem[] } }>(searchUrl);
    const searchItems = searchData.query?.search ?? [];

    if (!searchItems.length) {
      return {
        providerLabel: 'Wikipedia people search',
        query: effectiveQuery,
        candidates: [],
        mocked: false,
      };
    }

    const extractUrl = `${wikipediaApi}?action=query&prop=extracts&exintro=1&explaintext=1&format=json&origin=*&pageids=${searchItems
      .map((item) => item.pageid)
      .join('|')}`;
    const extractData = await fetchJson<{ query?: { pages?: Record<string, WikipediaExtractPage> } }>(extractUrl);
    const pages = extractData.query?.pages ?? {};

    const candidates = searchItems
      .map((item, index) => {
        const page = pages[String(item.pageid)];
        const extract = page?.extract ?? '';
        const combinedText = `${item.title} ${cleanSnippet(item.snippet)} ${extract}`;
        const yearMatches = [...combinedText.matchAll(/\b(1[5-9]\d{2}|20\d{2})\b/g)].map((match) => match[1]);
        const birthYear = yearMatches[0] ?? '';
        const deathYear = yearMatches[1] ?? '';
        const placeMatch = extract.match(/(?:born in|from) ([A-Z][A-Za-z .'-]+(?:, [A-Z][A-Za-z .'-]+){0,2})/);
        const name = parseName(item.title);

        const candidate: SearchCandidate = {
          id: `wikipedia-${item.pageid}`,
          provider: 'wikipedia',
          score: Number((0.82 - index * 0.04).toFixed(2)),
          summary: cleanSnippet(item.snippet) || extract.slice(0, 160) || 'Wikipedia article result',
          person: {
            id: `wikipedia-person-${item.pageid}`,
            firstName: name.firstName,
            lastName: name.lastName,
            birthYear,
            deathYear,
            birthPlace: placeMatch?.[1] ?? '',
            notes: `Wikipedia: https://en.wikipedia.org/?curid=${item.pageid}`,
          },
          hints: unique(
            [
              extract ? `${extract.slice(0, 180)}${extract.length > 180 ? '…' : ''}` : '',
              birthYear && deathYear ? `Possible life dates: ${birthYear}–${deathYear}` : '',
            ].filter(Boolean),
          ),
          suggestedRelationship: branchSuggestion(
            {
              id: `wikipedia-${item.pageid}`,
              provider: 'wikipedia',
              score: 0,
              summary: item.title,
              person: {
                id: `wikipedia-person-${item.pageid}`,
                firstName: name.firstName,
                lastName: name.lastName,
              },
              hints: [],
            },
            tree,
            branchPersonId,
          ),
        };

        candidate.score = Number((branchBoost(candidate, tree, branchPersonId) + keywordScoreBoost(candidate, effectiveQuery)).toFixed(2));
        return candidate;
      })
      .sort((a, b) => b.score - a.score);

    return {
      providerLabel: 'Wikipedia people search',
      query: effectiveQuery,
      candidates,
      mocked: false,
      warning: 'Wikipedia search is broad and human-readable, but some results may be organizations, places, or disambiguation pages.',
    };
  },
};

export const providers: SearchProvider[] = [sampleArchiveProvider, wikidataProvider, wikipediaProvider];
