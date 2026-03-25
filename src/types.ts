export type RelationshipType = 'parent' | 'spouse';

export type Person = {
  id: string;
  firstName: string;
  lastName: string;
  birthYear?: string;
  deathYear?: string;
  birthPlace?: string;
  notes?: string;
};

export type Relationship = {
  id: string;
  type: RelationshipType;
  sourceId: string;
  targetId: string;
};

export type TreeData = {
  people: Person[];
  relationships: Relationship[];
};

export type SearchCandidate = {
  id: string;
  provider: string;
  providerLabel?: string;
  providerRecordId?: string;
  score: number;
  summary: string;
  recordLabel?: string;
  familyMatch?: { label: string; score: number };
  recordUrl?: string;
  person: Person;
  hints: string[];
  suggestedRelationship?: {
    type: RelationshipType;
    relatedPersonId: string;
    direction?: 'from-candidate' | 'to-candidate';
  };
};

export type SearchParams = {
  query: string;
  place?: string;
  year?: string;
  branchPersonId?: string;
};

export type ProviderResult = {
  providerId?: string;
  providerLabel: string;
  providerDescription?: string;
  query: string;
  candidates: SearchCandidate[];
  mocked: boolean;
  warning?: string;
  limitations?: string[];
};

export type SearchProvider = {
  id: string;
  label: string;
  description: string;
  limitations?: string[];
  search: (params: SearchParams, tree: TreeData) => Promise<ProviderResult>;
};

export type DuplicateCandidate = {
  id: string;
  leftPersonId: string;
  rightPersonId: string;
  score: number;
  reasons: string[];
};

export type MergeFieldKey = 'firstName' | 'lastName' | 'birthYear' | 'deathYear' | 'birthPlace' | 'notes';

export type MergeDecision = Record<MergeFieldKey, string>;
