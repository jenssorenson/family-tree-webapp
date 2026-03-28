import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import './App.css';
import { emptyTree } from './data';
import { exportGedcom, importGedcom } from './gedcom';
import { providers } from './providers';
import { buildMergeDecision, emptyPersonDraft, findDuplicateCandidates, getDisplayName, mergeFieldKeys, mergePeople } from './tree-utils';
import type { DuplicateCandidate, MergeDecision, Person, ProviderResult, Relationship, RelationshipType, SearchCandidate, TreeData } from './types';
import { D3TreeViz } from './D3TreeViz';

const relationshipLabels: Record<RelationshipType, string> = {
  parent: 'Parent → Child',
  spouse: 'Spouse ↔ Spouse',
};

const JENS_ID = 'person-jens';
const RAIN_ID = 'person-joanne';

const makeId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const ALL_PROVIDERS_VALUE = '__all__';
const SAVE_DEBOUNCE_MS = 600;
const REMOTE_SYNC_MS = 4000;

const fetchTree = async (): Promise<TreeData> => {
  const response = await fetch('/api/tree');
  if (!response.ok) throw new Error(`Load failed with ${response.status}`);
  const payload = await response.json() as { tree?: TreeData };
  return payload.tree ?? emptyTree;
};

const saveTree = async (tree: TreeData): Promise<string> => {
  const response = await fetch('/api/tree', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tree }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `Save failed with ${response.status}`);
  }

  const payload = await response.json() as { savedAt?: string };
  return payload.savedAt ?? new Date().toISOString();
};

function App() {
  const [tree, setTree] = useState<TreeData>(emptyTree);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [personDraft, setPersonDraft] = useState<Omit<Person, 'id'>>(emptyPersonDraft);
  const [relationshipDraft, setRelationshipDraft] = useState<{ sourceId: string; targetId: string; type: RelationshipType }>({
    sourceId: '',
    targetId: '',
    type: 'parent',
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchPlace, setSearchPlace] = useState('');
  const [searchYear, setSearchYear] = useState('');
  const [searchBranchPersonId, setSearchBranchPersonId] = useState<string>('');
  const [searchProviderId, setSearchProviderId] = useState<string>(ALL_PROVIDERS_VALUE);
  const [searchResults, setSearchResults] = useState<SearchCandidate[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchMeta, setSearchMeta] = useState<ProviderResult[]>([]);
  const [gedcomStatus, setGedcomStatus] = useState<string>('');
  const [importError, setImportError] = useState<string>('');
  const [mergeCandidate, setMergeCandidate] = useState<DuplicateCandidate | null>(null);
  const [mergePrimaryId, setMergePrimaryId] = useState<string>('');
  const [mergeDecision, setMergeDecision] = useState<MergeDecision | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null);
  const [personMenu, setPersonMenu] = useState<{ personId: string; x: number; y: number } | null>(null);
  const [collapsedAncestorRootIds, setCollapsedAncestorRootIds] = useState<string[]>([]);
  const [, setIsLoadingTree] = useState(true);
  const [loadError, setLoadError] = useState<string>('');
  const [saveError, setSaveError] = useState<string>('');
  const [, setIsSaving] = useState(false);
  const [, setLastSavedAt] = useState<string>('');
  const [, setRecentlyUpdatedIds] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasHydratedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const remoteHighlightTimerRef = useRef<number | null>(null);
  const latestTreeJsonRef = useRef(JSON.stringify(emptyTree));

  // BFS upward from Jens and Joanne to find all ancestors
  const ancestorIds = useMemo<Set<string>>(() => {
    const parentsByChild = new Map<string, string[]>();
    for (const rel of tree.relationships) {
      if (rel.type === 'parent') {
        parentsByChild.set(rel.targetId, [...(parentsByChild.get(rel.targetId) ?? []), rel.sourceId]);
      }
    }

    const ancestors = new Set<string>();
    const queue: string[] = [JENS_ID, RAIN_ID];
    while (queue.length) {
      const childId = queue.shift()!;
      for (const parentId of parentsByChild.get(childId) ?? []) {
        if (!ancestors.has(parentId)) {
          ancestors.add(parentId);
          queue.push(parentId);
        }
      }
    }

    return ancestors;
  }, [tree]);

  // People who share a parent with an ancestor, but are not themselves ancestors (aunts/uncles of Jens/Rain)
  const hiddenSiblingIds = useMemo<Set<string>>(() => {
    const parentsByChild = new Map<string, string[]>();
    for (const rel of tree.relationships) {
      if (rel.type === 'parent') {
        parentsByChild.set(rel.targetId, [...(parentsByChild.get(rel.targetId) ?? []), rel.sourceId]);
      }
    }

    const siblingIds = new Set<string>();
    for (const ancestorId of ancestorIds) {
      for (const parentId of parentsByChild.get(ancestorId) ?? []) {
        for (const siblingId of parentsByChild.get(parentId) ?? []) {
          if (siblingId !== ancestorId && !ancestorIds.has(siblingId)) {
            siblingIds.add(siblingId);
          }
        }
      }
    }

    return siblingIds;
  }, [tree, ancestorIds]);

  // hiddenChildIds starts seeded with aunts/uncles (siblings of ancestors); stays in sync via this effect
  const [hiddenChildIds, setHiddenChildIds] = useState<Set<string>>(hiddenSiblingIds);
  useEffect(() => {
    setHiddenChildIds(hiddenSiblingIds);
  }, [hiddenSiblingIds]);

  const loadRemoteTree = useCallback(async (options?: { silent?: boolean; clearSearch?: boolean }) => {
    const silent = options?.silent ?? false;
    const clearSearch = options?.clearSearch ?? true;

    if (!silent) {
      setIsLoadingTree(true);
      setLoadError('');
    }

    try {
      const remoteTree = await fetchTree();
      const remoteTreeJson = JSON.stringify(remoteTree);
      const changed = latestTreeJsonRef.current !== remoteTreeJson;

      if (changed) {
        const previousTree = JSON.parse(latestTreeJsonRef.current) as TreeData;
        const previousPeopleById = new Map(previousTree.people.map((person) => [person.id, JSON.stringify(person)]));
        const updatedIds = remoteTree.people
          .filter((person) => previousPeopleById.get(person.id) !== JSON.stringify(person))
          .map((person) => person.id);

        latestTreeJsonRef.current = remoteTreeJson;
        setTree(remoteTree);
        setSelectedPersonId((current) => (current && remoteTree.people.some((person) => person.id === current) ? current : remoteTree.people[0]?.id ?? null));
        if (clearSearch) {
          setSearchResults([]);
          setSearchMeta([]);
        }
        setGedcomStatus(silent ? 'Tree updated from the server.' : 'Loaded the shared tree from the server.');
        setRecentlyUpdatedIds(updatedIds);
        if (remoteHighlightTimerRef.current) window.clearTimeout(remoteHighlightTimerRef.current);
        remoteHighlightTimerRef.current = window.setTimeout(() => setRecentlyUpdatedIds([]), 2500);
      }

      setSaveError('');
      hasHydratedRef.current = true;
      return changed;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load the shared tree.');
      return false;
    } finally {
      if (!silent) setIsLoadingTree(false);
    }
  }, []);

  useEffect(() => {
    void loadRemoteTree({ clearSearch: true });
  }, [loadRemoteTree]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadRemoteTree({ silent: true, clearSearch: false });
    }, REMOTE_SYNC_MS);

    return () => window.clearInterval(intervalId);
  }, [loadRemoteTree]);

  useEffect(() => {
    const person = tree.people.find((entry) => entry.id === selectedPersonId);
    setPersonDraft(person ? { ...emptyPersonDraft, ...person } : emptyPersonDraft);
  }, [selectedPersonId, tree.people]);

  useEffect(() => {
    setCollapsedAncestorRootIds((current) => current.filter((personId) => tree.people.some((person) => person.id === personId)));
  }, [tree.people]);

  useEffect(() => {
    if (!hasHydratedRef.current) return;
    const currentTreeJson = JSON.stringify(tree);
    if (latestTreeJsonRef.current === currentTreeJson) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

    saveTimerRef.current = window.setTimeout(async () => {
      setIsSaving(true);
      try {
        const savedAt = await saveTree(tree);
        latestTreeJsonRef.current = currentTreeJson;
        setLastSavedAt(savedAt);
        setSaveError('');
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'Unable to save the shared tree.');
      } finally {
        setIsSaving(false);
      }
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [tree]);

  const selectedPerson = useMemo(() => tree.people.find((person) => person.id === selectedPersonId) ?? null, [tree.people, selectedPersonId]);
  const collapsedAncestorRoots = useMemo(() => new Set(collapsedAncestorRootIds), [collapsedAncestorRootIds]);

  const duplicateCandidates = useMemo(() => findDuplicateCandidates(tree), [tree]);

  const activeMergePeople = useMemo(() => {
    if (!mergeCandidate) return null;
    const left = tree.people.find((person) => person.id === mergeCandidate.leftPersonId);
    const right = tree.people.find((person) => person.id === mergeCandidate.rightPersonId);
    return left && right ? { left, right } : null;
  }, [mergeCandidate, tree.people]);

  useEffect(() => {
    if (!activeMergePeople) return;
    const primaryId = mergePrimaryId || activeMergePeople.left.id;
    const secondary = primaryId === activeMergePeople.left.id ? activeMergePeople.right : activeMergePeople.left;
    const primary = primaryId === activeMergePeople.left.id ? activeMergePeople.left : activeMergePeople.right;
    setMergePrimaryId(primary.id);
    setMergeDecision(buildMergeDecision(primary, secondary));
  }, [activeMergePeople, mergePrimaryId]);

  const selectPersonForEdit = (personId: string | null) => {
    setSelectedPersonId(personId);
  };

  const stats = useMemo(() => ({
    people: tree.people.length,
    parentRelationships: tree.relationships.filter((rel) => rel.type === 'parent').length,
    spouseRelationships: tree.relationships.filter((rel) => rel.type === 'spouse').length,
    duplicates: duplicateCandidates.length,
  }), [duplicateCandidates.length, tree.relationships, tree.people.length]);

  const updateSelectedPerson = () => {
    if (!selectedPerson) return;
    setTree((current) => ({
      ...current,
      people: current.people.map((person) => (person.id === selectedPerson.id ? { ...person, ...personDraft } : person)),
    }));
    setGedcomStatus('Saved person changes to the shared tree.');
  };

  const createPerson = () => {
    if (!personDraft.firstName.trim() || !personDraft.lastName.trim()) return;
    const person: Person = { id: makeId('person'), ...personDraft, firstName: personDraft.firstName.trim(), lastName: personDraft.lastName.trim() };
    setTree((current) => ({ ...current, people: [...current.people, person] }));
    selectPersonForEdit(person.id);
    setGedcomStatus(`Added ${getDisplayName(person)} to the shared tree.`);
  };

  const addRelationship = (draft = relationshipDraft) => {
    if (!draft.sourceId || !draft.targetId || draft.sourceId === draft.targetId) return;
    const exists = tree.relationships.some((rel) => rel.type === draft.type && ((rel.sourceId === draft.sourceId && rel.targetId === draft.targetId) || (draft.type === 'spouse' && rel.sourceId === draft.targetId && rel.targetId === draft.sourceId)));
    if (exists) return;

    const relationship: Relationship = { id: makeId('rel'), sourceId: draft.sourceId, targetId: draft.targetId, type: draft.type };
    setTree((current) => ({ ...current, relationships: [...current.relationships, relationship] }));
    setGedcomStatus(draft.type === 'parent'
      ? 'Added a parent link and reorganized the family layout.'
      : 'Added a relationship to the shared tree.');
  };

  const runSearch = async () => {
    setIsSearching(true);

    try {
      const selectedProviders =
        searchProviderId === ALL_PROVIDERS_VALUE ? providers : providers.filter((provider) => provider.id === searchProviderId);
      const results = await Promise.all(
        selectedProviders.map((provider) =>
          provider
            .search(
              {
                query: searchQuery,
                place: searchPlace,
                year: searchYear,
                branchPersonId: searchBranchPersonId || undefined,
              },
              tree,
            )
            .catch((error) => ({
              providerId: provider.id,
              providerLabel: provider.label,
              providerDescription: provider.description,
              query: [searchQuery, searchPlace, searchYear].filter(Boolean).join(' '),
              candidates: [],
              mocked: false,
              warning: error instanceof Error ? error.message : 'Provider request failed.',
              limitations: provider.limitations,
            })),
        ),
      );

      setSearchMeta(results);
      setSearchResults(results.flatMap((result) => result.candidates).sort((left, right) => right.score - left.score));
    } finally {
      setIsSearching(false);
    }
  };

  const importCandidate = (candidate: SearchCandidate) => {
    const importedId = makeId('person');
    const importedPerson: Person = { ...candidate.person, id: importedId };

    setTree((current) => {
      const relationships = [...current.relationships];
      if (candidate.suggestedRelationship) {
        const { direction = 'from-candidate', relatedPersonId, type } = candidate.suggestedRelationship;
        const exists = relationships.some((rel) => rel.type === type && ((rel.sourceId === (direction === 'from-candidate' ? importedId : relatedPersonId) && rel.targetId === (direction === 'from-candidate' ? relatedPersonId : importedId)) || (type === 'spouse' && rel.sourceId === (direction === 'from-candidate' ? relatedPersonId : importedId) && rel.targetId === (direction === 'from-candidate' ? importedId : relatedPersonId))));
        if (!exists) {
          relationships.push({
            id: makeId('rel'),
            type,
            sourceId: direction === 'from-candidate' ? importedId : relatedPersonId,
            targetId: direction === 'from-candidate' ? relatedPersonId : importedId,
          });
        }
      }
      return { people: [...current.people, importedPerson], relationships };
    });

    selectPersonForEdit(importedId);
    setGedcomStatus(`Imported ${getDisplayName(importedPerson)} into the shared tree.`);
  };

  const clearTree = () => {
    setTree(emptyTree);
    selectPersonForEdit(null);
    setSearchResults([]);
    setSearchMeta([]);
    setGedcomStatus('Cleared the shared tree.');
    setImportError('');
  };



  const getChildIds = (personId: string): string[] => {
    return tree.relationships
      .filter((rel) => rel.type === 'parent' && rel.sourceId === personId)
      .map((rel) => rel.targetId);
  };

  const toggleChildVisibility = (personId: string) => {
    const childIds = getChildIds(personId);
    if (!childIds.length) return;

    const someHidden = childIds.some((id) => hiddenChildIds.has(id));
    setHiddenChildIds((current) => {
      const next = new Set(current);
      if (someHidden) {
        childIds.forEach((id) => next.delete(id));
      } else {
        childIds.forEach((id) => next.add(id));
      }
      return next;
    });

    const person = tree.people.find((entry) => entry.id === personId);
    if (person) {
      setGedcomStatus(someHidden
        ? `Showing children of ${getDisplayName(person)}.`
        : `Hiding children of ${getDisplayName(person)}.`);
    }
    closeMenus();
  };

  const toggleAncestorCollapse = (personId: string) => {
    setCollapsedAncestorRootIds((current) => current.includes(personId)
      ? current.filter((id) => id !== personId)
      : [...current, personId]);

    const person = tree.people.find((entry) => entry.id === personId);
    if (person) {
      setGedcomStatus(collapsedAncestorRoots.has(personId)
        ? `Expanded ancestors above ${getDisplayName(person)}.`
        : `Collapsed ancestors above ${getDisplayName(person)}.`);
    }

    setEdgeMenu(null);
  };

  const closeMenus = () => {
    setEdgeMenu(null);
    setPersonMenu(null);
  };

  const deleteRelationship = (edgeId: string) => {
    setTree((current) => ({
      ...current,
      relationships: current.relationships.filter((relationship) => relationship.id !== edgeId),
    }));
    setGedcomStatus('Deleted relationship from the shared tree.');
    closeMenus();
  };

  const editRelationship = (edgeId: string) => {
    const relationship = tree.relationships.find((entry) => entry.id === edgeId);
    if (!relationship) return;
    setRelationshipDraft({
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      type: relationship.type,
    });
    setGedcomStatus('Loaded relationship into the editor. Delete the old link after changing endpoints or type.');
    closeMenus();
  };

  const editPerson = (personId: string) => {
    selectPersonForEdit(personId);
    const person = tree.people.find((entry) => entry.id === personId);
    if (person) setGedcomStatus(`Loaded ${getDisplayName(person)} into the editor.`);
    closeMenus();
  };

  const deletePerson = (personId: string) => {
    const person = tree.people.find((entry) => entry.id === personId);
    if (!person) return;

    const linkedRelationshipCount = tree.relationships.filter((relationship) => relationship.sourceId === personId || relationship.targetId === personId).length;
    const deletedMergePerson = mergeCandidate && (mergeCandidate.leftPersonId === personId || mergeCandidate.rightPersonId === personId);

    setTree((current) => ({
      people: current.people.filter((entry) => entry.id !== personId),
      relationships: current.relationships.filter((relationship) => relationship.sourceId !== personId && relationship.targetId !== personId),
    }));
    setCollapsedAncestorRootIds((current) => current.filter((id) => id !== personId));
    setSelectedPersonId((current) => (current === personId ? null : current));
    setRelationshipDraft((current) => ({
      ...current,
      sourceId: current.sourceId === personId ? '' : current.sourceId,
      targetId: current.targetId === personId ? '' : current.targetId,
    }));
    setSearchBranchPersonId((current) => (current === personId ? '' : current));
    if (deletedMergePerson) {
      setMergeCandidate(null);
      setMergeDecision(null);
      setMergePrimaryId('');
    } else {
      setMergePrimaryId((current) => (current === personId ? '' : current));
    }
    setGedcomStatus(`Deleted ${getDisplayName(person)} and removed ${linkedRelationshipCount} linked relationship${linkedRelationshipCount === 1 ? '' : 's'}.`);
    closeMenus();
  };

  const openMergeReview = (candidate: DuplicateCandidate) => {
    setMergeCandidate(candidate);
    setMergePrimaryId(candidate.leftPersonId);
    const left = tree.people.find((person) => person.id === candidate.leftPersonId);
    const right = tree.people.find((person) => person.id === candidate.rightPersonId);
    if (left && right) setMergeDecision(buildMergeDecision(left, right));
  };

  const applyMerge = () => {
    if (!mergeCandidate || !mergeDecision || !activeMergePeople) return;
    const secondaryId = mergePrimaryId === activeMergePeople.left.id ? activeMergePeople.right.id : activeMergePeople.left.id;
    const merged = mergePeople(tree, mergePrimaryId, secondaryId, mergeDecision);
    setTree(merged);
    setMergeCandidate(null);
    setMergeDecision(null);
    setMergePrimaryId('');
    selectPersonForEdit(mergePrimaryId);
    setGedcomStatus('Merged duplicate people and preserved linked relationships.');
  };

  const handleGedcomPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();
      const imported = importGedcom(content);
      setTree(imported);
      selectPersonForEdit(imported.people[0]?.id ?? null);
      setGedcomStatus(`Imported ${imported.people.length} people and ${imported.relationships.length} relationships from ${file.name}.`);
      setImportError('');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Unable to import GEDCOM file.');
      setGedcomStatus('');
    } finally {
      event.target.value = '';
    }
  };

  const handleExportGedcom = () => {
    const content = exportGedcom(tree);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'family-tree-export.ged';
    link.click();
    URL.revokeObjectURL(url);
    setGedcomStatus(`Exported ${tree.people.length} people to GEDCOM.`);
    setImportError('');
  };

  const mergePrimary = activeMergePeople ? (mergePrimaryId === activeMergePeople.left.id ? activeMergePeople.left : activeMergePeople.right) : null;
  const mergeSecondary = activeMergePeople ? (mergePrimaryId === activeMergePeople.left.id ? activeMergePeople.right : activeMergePeople.left) : null;
  const branchPerson = tree.people.find((person) => person.id === searchBranchPersonId);
  const personMenuPerson = personMenu ? tree.people.find((person) => person.id === personMenu.personId) ?? null : null;
  const relationshipPreview = (candidate: SearchCandidate) => {
    if (!candidate.suggestedRelationship) return '';
    const relatedPerson = tree.people.find((person) => person.id === candidate.suggestedRelationship?.relatedPersonId);
    if (!relatedPerson) return '';
    if (candidate.suggestedRelationship.type === 'spouse') {
      return `Suggested spouse link with ${getDisplayName(relatedPerson)}`;
    }
    return candidate.suggestedRelationship.direction === 'from-candidate'
      ? `Suggested parent link from imported record to ${getDisplayName(relatedPerson)}`
      : `Suggested child link from ${getDisplayName(relatedPerson)} to imported record`;
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="panel hero-panel compact-stats-panel">
          <div className="stats-grid four-up compact-stats-grid">
            <div><strong>{stats.people}</strong><span>People</span></div>
            <div><strong>{stats.parentRelationships}</strong><span>Parent links</span></div>
            <div><strong>{stats.spouseRelationships}</strong><span>Spouse links</span></div>
            <div><strong>{stats.duplicates}</strong><span>Possible duplicates</span></div>
          </div>
          {loadError && (
            <div className="inline-error-card">
              <p>Could not load the shared tree: {loadError}</p>
              <button className="secondary" onClick={() => void loadRemoteTree()}>Retry load</button>
            </div>
          )}
          {saveError && !loadError && <p className="status-error">Changes stay on screen, but the server save failed: {saveError}</p>}
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Person editor</h2>
            {selectedPerson ? <span className="badge">Editing {getDisplayName(selectedPerson)}</span> : <span className="badge">New person</span>}
          </div>
          <div className="form-grid">
            <label>First name<input value={personDraft.firstName} onChange={(e) => setPersonDraft((d) => ({ ...d, firstName: e.target.value }))} /></label>
            <label>Last name<input value={personDraft.lastName} onChange={(e) => setPersonDraft((d) => ({ ...d, lastName: e.target.value }))} /></label>
            <label>Birth year<input value={personDraft.birthYear ?? ''} onChange={(e) => setPersonDraft((d) => ({ ...d, birthYear: e.target.value }))} /></label>
            <label>Death year<input value={personDraft.deathYear ?? ''} onChange={(e) => setPersonDraft((d) => ({ ...d, deathYear: e.target.value }))} /></label>
            <label className="full-span">Birth place<input value={personDraft.birthPlace ?? ''} onChange={(e) => setPersonDraft((d) => ({ ...d, birthPlace: e.target.value }))} /></label>
            <label className="full-span">Notes<textarea rows={4} value={personDraft.notes ?? ''} onChange={(e) => setPersonDraft((d) => ({ ...d, notes: e.target.value }))} /></label>
          </div>
          <div className="button-row">
            <button className="primary" onClick={selectedPerson ? updateSelectedPerson : createPerson}>{selectedPerson ? 'Save changes' : 'Create person'}</button>
            <button className="secondary" onClick={() => selectPersonForEdit(null)}>New blank person</button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Relationships</h2>
            <span className="badge">Manual linking</span>
          </div>
          <div className="form-grid single-column">
            <label>Relationship type<select value={relationshipDraft.type} onChange={(e) => setRelationshipDraft((d) => ({ ...d, type: e.target.value as RelationshipType }))}><option value="parent">{relationshipLabels.parent}</option><option value="spouse">{relationshipLabels.spouse}</option></select></label>
            <label>Source person<select value={relationshipDraft.sourceId} onChange={(e) => setRelationshipDraft((d) => ({ ...d, sourceId: e.target.value }))}><option value="">Select person</option>{tree.people.map((person) => <option key={person.id} value={person.id}>{getDisplayName(person)}</option>)}</select></label>
            <label>Target person<select value={relationshipDraft.targetId} onChange={(e) => setRelationshipDraft((d) => ({ ...d, targetId: e.target.value }))}><option value="">Select person</option>{tree.people.map((person) => <option key={person.id} value={person.id}>{getDisplayName(person)}</option>)}</select></label>
          </div>
          <div className="button-row"><button className="primary" onClick={() => addRelationship()}>Add relationship</button></div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Search &amp; import</h2>
            <span className="badge">Live + sample providers</span>
          </div>
          <div className="form-grid single-column">
            <label>Person name<input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Name to search for" /></label>
            <div className="form-grid">
              <label>Place context<input value={searchPlace} onChange={(e) => setSearchPlace(e.target.value)} placeholder="Town, county, state, or country" /></label>
              <label>Year context<input value={searchYear} onChange={(e) => setSearchYear(e.target.value)} placeholder="Birth year or record year" /></label>
            </div>
            <label>Focus branch (optional)<select value={searchBranchPersonId} onChange={(e) => setSearchBranchPersonId(e.target.value)}><option value="">Whole tree</option>{tree.people.map((person) => <option key={person.id} value={person.id}>{getDisplayName(person)}</option>)}</select></label>
            <label>Provider<select value={searchProviderId} onChange={(e) => setSearchProviderId(e.target.value)}><option value={ALL_PROVIDERS_VALUE}>All providers</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
          </div>
          <div className="button-row">
            <button className="primary" onClick={runSearch} disabled={isSearching}>{isSearching ? 'Searching...' : 'Search records'}</button>
            <button className="secondary" onClick={clearTree}>Clear tree</button>
            <button className="secondary" onClick={() => void loadRemoteTree()}>Reload from server</button>
          </div>
          {branchPerson && <p className="muted search-meta">Branch focus: {getDisplayName(branchPerson)}. Searches use this person as a family-match anchor when ranking and suggesting links.</p>}
          {searchMeta.length > 0 && (
            <div className="provider-summary-list">
              {searchMeta.map((meta) => (
                <article key={meta.providerId} className="provider-summary-card">
                  <div className="candidate-topline">
                    <strong>{meta.providerLabel}</strong>
                    <span>{meta.mocked ? 'sample' : 'live'} &middot; {meta.candidates.length} result{meta.candidates.length === 1 ? '' : 's'}</span>
                  </div>
                  <p className="muted tiny">{meta.providerDescription}</p>
                  {meta.warning && <p className="muted tiny">{meta.warning}</p>}
                  {!!meta.limitations?.length && <p className="muted tiny">Limits: {meta.limitations.join(' &middot; ')}</p>}
                </article>
              ))}
            </div>
          )}
          <div className="candidate-list">
            {searchResults.map((candidate) => (
              <article className="candidate-card" key={candidate.id}>
                <div className="candidate-topline"><strong>{getDisplayName(candidate.person)}</strong><span>{Math.round(candidate.score * 100)}% match</span></div>
                <p className="muted tiny provider-inline">{candidate.providerLabel}{candidate.providerRecordId ? ` &middot; ${candidate.providerRecordId}` : ''}</p>
                {candidate.recordLabel && <p className="muted tiny">{candidate.recordLabel}</p>}
                <p>{candidate.summary}</p>
                <p className="muted tiny">{candidate.person.birthYear || '--'} &middot; {candidate.person.birthPlace || 'Location unknown'}</p>
                {candidate.familyMatch && <p className="muted tiny">Family signal: {candidate.familyMatch.label} ({Math.round(candidate.familyMatch.score * 100)}%)</p>}
                <ul>{candidate.hints.map((hint) => <li key={hint}>{hint}</li>)}</ul>
                {candidate.recordUrl && <p className="muted tiny"><a href={candidate.recordUrl} target="_blank" rel="noreferrer">Open source record</a></p>}
                {candidate.suggestedRelationship && <p className="muted tiny">{relationshipPreview(candidate)}</p>}
                <button className="primary small" onClick={() => importCandidate(candidate)}>{candidate.suggestedRelationship ? 'Import with suggested link' : 'Import into tree'}</button>
              </article>
            ))}
            {!searchResults.length && <p className="muted">No search results yet. Try a person name plus optional place or year context to pull records into the current branch.</p>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Possible duplicates</h2>
            <span className="badge">Review before merge</span>
          </div>
          <div className="candidate-list compact-list">
            {duplicateCandidates.length ? duplicateCandidates.map((candidate) => {
              const left = tree.people.find((person) => person.id === candidate.leftPersonId);
              const right = tree.people.find((person) => person.id === candidate.rightPersonId);
              if (!left || !right) return null;
              return (
                <article className="candidate-card" key={candidate.id}>
                  <div className="candidate-topline">
                    <strong>{getDisplayName(left)} &harr; {getDisplayName(right)}</strong>
                    <span>{Math.round(candidate.score * 100)}%</span>
                  </div>
                  <p className="muted tiny">{[left.birthYear || '--', left.birthPlace || 'Unknown place'].join(' &middot; ')} vs {[right.birthYear || '--', right.birthPlace || 'Unknown place'].join(' &middot; ')}</p>
                  <ul>
                    {candidate.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                  <div className="button-row">
                    <button className="primary small" onClick={() => openMergeReview(candidate)}>Review merge</button>
                    <button className="secondary small" onClick={() => selectPersonForEdit(left.id)}>Jump to record</button>
                  </div>
                </article>
              );
            }) : <p className="muted">No likely duplicates right now. Add people, import GEDCOM, or pull in records to give the matcher something to compare.</p>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>GEDCOM</h2>
            <span className="badge">Import / export</span>
          </div>
          <div className="button-row">
            <button className="primary" onClick={() => fileInputRef.current?.click()}>Import .ged file</button>
            <button className="secondary" onClick={handleExportGedcom}>Export current tree</button>
            <input ref={fileInputRef} className="hidden-input" type="file" accept=".ged,.GED,text/plain" onChange={handleGedcomPick} />
          </div>
          {gedcomStatus && <p className="muted status-ok">{gedcomStatus}</p>}
          {importError && <p className="status-error">{importError}</p>}
        </div>
      </aside>

      <main className="canvas-panel">
        <div className="flow-wrap d3-tree-wrap">
          <D3TreeViz
            tree={tree}
            selectedPersonId={selectedPersonId}
            onPersonClick={(personId) => {
              selectPersonForEdit(personId);
            }}
          />
        </div>
      </main>

      {personMenu && personMenuPerson && (() => {
        const childIds = getChildIds(personMenu.personId);
        const hasChildren = childIds.length > 0;
        const someChildrenHidden = hasChildren && childIds.some((id) => hiddenChildIds.has(id));
        return (
          <div className="context-menu" style={{ left: personMenu.x, top: personMenu.y }}>
            <div className="context-menu-title">{getDisplayName(personMenuPerson)}</div>
            <button className="secondary" onClick={() => editPerson(personMenu.personId)}>Edit person</button>
            <button className="secondary" onClick={() => toggleAncestorCollapse(personMenu.personId)}>{collapsedAncestorRoots.has(personMenu.personId) ? 'Expand ancestors' : 'Collapse ancestors'}</button>
            {hasChildren && ancestorIds.has(personMenu.personId) && (
              <button className="secondary" onClick={() => toggleChildVisibility(personMenu.personId)}>
                {someChildrenHidden ? 'Show Children' : 'Hide Children'}
              </button>
            )}
            <button className="secondary danger" onClick={() => deletePerson(personMenu.personId)}>Delete person</button>
          </div>
        );
      })()}

      {edgeMenu && (
        <div className="context-menu" style={{ left: edgeMenu.x, top: edgeMenu.y }}>
          <button className="secondary" onClick={() => editRelationship(edgeMenu.edgeId)}>Edit link</button>
          <button className="secondary danger" onClick={() => deleteRelationship(edgeMenu.edgeId)}>Delete link</button>
        </div>
      )}

      {activeMergePeople && mergeDecision && mergePrimary && mergeSecondary && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card">
            <div className="panel-header"><h2>Review duplicate merge</h2><span className="badge">No silent merges</span></div>
            <p className="muted">Pick the surviving record, then choose the value to keep for each field. Relationships from both people will be remapped and deduplicated.</p>
            <label>
              Surviving person
              <select value={mergePrimaryId} onChange={(e) => setMergePrimaryId(e.target.value)}>
                <option value={activeMergePeople.left.id}>{getDisplayName(activeMergePeople.left)}</option>
                <option value={activeMergePeople.right.id}>{getDisplayName(activeMergePeople.right)}</option>
              </select>
            </label>
            <div className="merge-grid">
              <div className="merge-grid-header">Field</div>
              <div className="merge-grid-header">{getDisplayName(mergePrimary)}</div>
              <div className="merge-grid-header">{getDisplayName(mergeSecondary)}</div>
              <div className="merge-grid-header">Merged value</div>
              {mergeFieldKeys.map((field) => (
                <Fragment key={field}>
                  <div className="merge-field-name">{field}</div>
                  <button key={`${field}-left`} className={`choice-button ${mergeDecision[field] === (mergePrimary[field] ?? '') ? 'selected' : ''}`} onClick={() => setMergeDecision((current) => current ? { ...current, [field]: mergePrimary[field] ?? '' } : current)}>{mergePrimary[field] || '--'}</button>
                  <button key={`${field}-right`} className={`choice-button ${mergeDecision[field] === (mergeSecondary[field] ?? '') ? 'selected' : ''}`} onClick={() => setMergeDecision((current) => current ? { ...current, [field]: mergeSecondary[field] ?? '' } : current)}>{mergeSecondary[field] || '--'}</button>
                  <input key={`${field}-merged`} value={mergeDecision[field]} onChange={(e) => setMergeDecision((current) => current ? { ...current, [field]: e.target.value } : current)} />
                </Fragment>
              ))}
            </div>

            <div className="button-row"><button className="primary" onClick={applyMerge}>Confirm merge</button><button className="secondary" onClick={() => setMergeCandidate(null)}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
