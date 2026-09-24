const api = window.app;

const state = {
  workflow: 'tasks',
  range: { since: 0, until: 0 },
  taskItems: new Map(),
  selectedTaskItemIds: new Set(),
  tasks: [],
  entityItems: new Map(),
  activeEntityId: null,
  entities: new Map(),
  pendingRoutingCalls: [],
  routingCases: [],
};

const MCP_TOOLS = [
  // Source of truth: features/mcp-server/server.js `TOOLS`. Keep this copy in sync by hand.
  ['list_items', 'List items, optionally filtered by tags or type'],
  ['search_items', 'Search item titles and content'],
  ['get_item', 'Get one item by ID'],
  ['create_item', 'Create a new item'],
  ['update_item', 'Update an existing item'],
  ['delete_item', 'Delete an item'],
  ['list_tags', 'List tags'],
  ['tag_item', 'Add a tag to an item'],
  ['untag_item', 'Remove a tag from an item'],
  ['record_event', 'Record an event for an item'],
  ['list_tasks', 'List task items'],
  ['complete_task', 'Mark a task complete'],
  ['get_task_context', 'Get context related to a task'],
];

const $ = (selector) => document.querySelector(selector);
const asArray = (result) => result?.success && Array.isArray(result.data) ? result.data : [];
const itemUrl = (item) => item.type === 'url' ? (item.url || item.content || '') : (item.url || null);
const itemTitle = (item) => item.title || (item.type === 'url' ? itemUrl(item) : String(item.content || '').slice(0, 80)) || 'Untitled';

function normalizedItem(item, extra = {}) {
  return {
    id: String(item.id),
    type: item.type || 'url',
    title: itemTitle(item),
    url: itemUrl(item),
    content: item.content ?? null,
    createdAt: Number(item.createdAt || 0),
    lastVisitAt: Number(extra.lastVisitAt ?? item.lastVisitAt ?? 0),
  };
}

function makeSyntheticUrlItem(url) {
  return normalizedItem({
    id: `url:${url}`,
    type: 'url',
    title: url,
    url,
    content: url,
    createdAt: Date.now(),
  });
}

function setDefaultRange() {
  const until = new Date();
  const since = new Date(until.getTime() - 6 * 24 * 60 * 60 * 1000);
  const dateValue = (date) => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  };
  $('#rangeSince').value = dateValue(since);
  $('#rangeUntil').value = dateValue(until);
  readRange();
}

function readRange() {
  const since = new Date(`${$('#rangeSince').value}T00:00:00`).getTime();
  const until = new Date(`${$('#rangeUntil').value}T23:59:59.999`).getTime();
  state.range = { since, until };
  return state.range;
}

function createCard(item, { selectable = false, selected = false, entity = false } = {}) {
  const card = document.createElement('peek-card');
  card.className = 'item-card';
  card.dataset.itemId = item.id;
  card.setAttribute('bordered', '');
  const content = document.createElement('div');
  content.className = 'item-card-content';
  if (selectable) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected;
    checkbox.setAttribute('aria-label', `Select ${itemTitle(item)}`);
    checkbox.addEventListener('change', () => {
      checkbox.checked ? state.selectedTaskItemIds.add(item.id) : state.selectedTaskItemIds.delete(item.id);
    });
    content.append(checkbox);
  }
  const title = document.createElement('div');
  title.className = 'item-card-title';
  title.textContent = itemTitle(item);
  content.append(title);
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const group = state.tasks.find((task) => task.itemIds.includes(item.id));
  meta.textContent = entity ? item.type : `${item.type}${group ? ` · ${group.label}` : ' · unassigned'}`;
  content.append(meta);
  card.append(content);
  if (entity) {
    card.tabIndex = 0;
    card.addEventListener('click', () => showEntityItem(item.id));
  }
  return card;
}

function renderTaskItems() {
  const grid = $('#taskGrid');
  grid.innerHTML = '';
  if (!state.taskItems.size) {
    grid.innerHTML = '<div class="empty">No pages or notes in this range. Search or paste URLs to add candidates.</div>';
    return;
  }
  for (const item of state.taskItems.values()) {
    grid.append(createCard(item, { selectable: true, selected: state.selectedTaskItemIds.has(item.id) }));
  }
}

function renderEntityItems() {
  const grid = $('#entityItems');
  grid.innerHTML = '';
  if (!state.entityItems.size) {
    grid.innerHTML = '<div class="empty">Search or paste URLs to add candidates.</div>';
    return;
  }
  for (const item of state.entityItems.values()) grid.append(createCard(item, { entity: true }));
}

function renderTaskGroups() {
  const select = $('#taskGroupSelect');
  select.options = state.tasks.map((task) => ({ value: task.id, label: task.label }));
  if (!state.tasks.some((task) => task.id === select.value)) select.value = '';
}

function addCandidate(workflow, item) {
  const normalized = normalizedItem(item);
  if (workflow === 'tasks') {
    state.taskItems.set(normalized.id, normalized);
    renderTaskItems();
  } else {
    if (!['url', 'text'].includes(normalized.type)) return;
    state.entityItems.set(normalized.id, normalized);
    if (!state.entities.has(normalized.id)) state.entities.set(normalized.id, []);
    renderEntityItems();
  }
}

async function searchPicker(workflow, query, results) {
  results.innerHTML = '';
  if (!query.trim()) return;
  const response = await api.datastore.queryItems({ search: query.trim(), limit: 20 });
  for (const raw of asArray(response).filter((item) => workflow === 'tasks' || ['url', 'text'].includes(item.type))) {
    const item = normalizedItem(raw);
    const button = document.createElement('peek-button');
    button.className = 'picker-result';
    button.setAttribute('variant', 'secondary');
    button.setAttribute('size', 'sm');
    button.textContent = `Add ${itemTitle(item)}`;
    button.addEventListener('click', () => addCandidate(workflow, item));
    results.append(button);
  }
  if (!results.children.length) results.innerHTML = '<span class="status">No matching items.</span>';
}

function createPicker(host, workflow) {
  host.innerHTML = `
    <div class="picker">
      <strong class="picker-title">Add items to label</strong>
      <div class="picker-controls">
        <peek-input class="picker-search" type="search" placeholder="Search existing items"></peek-input>
        <peek-button class="picker-search-button" variant="secondary">Search</peek-button>
        <textarea class="picker-urls" rows="2" aria-label="URLs to add" placeholder="Paste URLs, one per line"></textarea>
        <peek-button class="picker-url-button" variant="secondary">Add URLs</peek-button>
      </div>
      <div class="picker-results"></div>
    </div>`;
  const search = host.querySelector('.picker-search');
  const results = host.querySelector('.picker-results');
  host.querySelector('.picker-search-button').addEventListener('click', () => searchPicker(workflow, search.value || '', results));
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') searchPicker(workflow, search.value || '', results);
  });
  host.querySelector('.picker-url-button').addEventListener('click', async () => {
    const textarea = host.querySelector('.picker-urls');
    const urls = textarea.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    for (const value of urls) {
      let url;
      try {
        url = new URL(value).href;
        if (!['http:', 'https:'].includes(new URL(url).protocol)) continue;
      } catch { continue; }
      const response = await api.datastore.queryItems({ type: 'url', search: url, limit: 10 });
      const existing = asArray(response).find((item) => item.content === url || item.url === url);
      addCandidate(workflow, existing || makeSyntheticUrlItem(url));
    }
    textarea.value = '';
  });
}

function replaceRangeTaskItems(items) {
  state.taskItems = new Map(items.map((item) => {
    const normalized = normalizedItem(item);
    return [normalized.id, normalized];
  }));
  const loadedIds = new Set(state.taskItems.keys());
  for (const task of state.tasks) task.itemIds = task.itemIds.filter((id) => loadedIds.has(id));
  state.selectedTaskItemIds = new Set([...state.selectedTaskItemIds].filter((id) => loadedIds.has(id)));
}

async function loadRange() {
  const range = readRange();
  const status = $('#rangeStatus');
  status.textContent = 'Loading…';
  try {
    const [visitsResponse, notesResponse] = await Promise.all([
      api.datastore.queryItemVisits(range),
      api.datastore.queryItems({ type: 'text', sortBy: 'created', limit: 10000 }),
    ]);
    const visits = asArray(visitsResponse);
    const latestVisits = new Map();
    for (const visit of visits) latestVisits.set(String(visit.itemId), Math.max(latestVisits.get(String(visit.itemId)) || 0, Number(visit.timestamp || 0)));
    const visitedItems = await Promise.all([...latestVisits.keys()].map(async (id) => {
      const result = await api.datastore.getItem(id);
      return result?.success && result.data ? normalizedItem(result.data, { lastVisitAt: latestVisits.get(id) }) : null;
    }));
    const loadedItems = visitedItems.filter(Boolean);
    for (const note of asArray(notesResponse)) {
      const createdAt = Number(note.createdAt || 0);
      if (createdAt >= range.since && createdAt <= range.until) loadedItems.push(note);
    }
    replaceRangeTaskItems(loadedItems);
    state.selectedTaskItemIds.clear();
    renderTaskItems();
    status.textContent = `${state.taskItems.size} candidate${state.taskItems.size === 1 ? '' : 's'}`;
  } catch (error) {
    status.textContent = `Could not load range: ${error.message}`;
  }
}

function createTask() {
  const input = $('#taskLabel');
  const label = String(input.value || '').trim();
  if (!label) return;
  state.tasks.push({ id: crypto.randomUUID(), label, itemIds: [] });
  input.value = '';
  renderTaskGroups();
  $('#taskGroupSelect').value = state.tasks.at(-1).id;
}

function assignSelected(groupId) {
  const selected = [...state.selectedTaskItemIds];
  if (!groupId || !selected.length) return;
  for (const task of state.tasks) task.itemIds = task.itemIds.filter((id) => !state.selectedTaskItemIds.has(id));
  const task = state.tasks.find((candidate) => candidate.id === groupId);
  if (task) task.itemIds.push(...selected);
  state.selectedTaskItemIds.clear();
  renderTaskItems();
}

function unassignSelected() {
  for (const task of state.tasks) task.itemIds = task.itemIds.filter((id) => !state.selectedTaskItemIds.has(id));
  state.selectedTaskItemIds.clear();
  renderTaskItems();
}

async function showEntityItem(itemId) {
  const item = state.entityItems.get(itemId);
  if (!item) return;
  state.activeEntityId = itemId;
  $('#entityTitle').textContent = itemTitle(item);
  $('#entityLoading').textContent = item.type === 'url' ? 'Loading page text…' : '';
  let text = item.type === 'text' ? String(item.content || '') : '';
  if (item.type === 'url') {
    try {
      const result = await api.datastore.extractPageContent(itemUrl(item));
      if (result?.success) text = String(result.data?.text ?? result.data ?? '');
      else $('#entityLoading').textContent = result?.error || 'Page text unavailable';
    } catch (error) {
      $('#entityLoading').textContent = error.message;
    }
  }
  item.labelText = text;
  $('#entityText').textContent = text;
  if (text) $('#entityLoading').textContent = '';
  renderEntitySpans();
}

function selectedEntitySpan() {
  const container = $('#entityText');
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const span = range.toString();
  const text = container.textContent || '';
  const end = start + span.length;
  if (!span || text.slice(start, end) !== span) return null;
  return { span, start, end };
}

function tagSelectedEntity() {
  if (!state.activeEntityId) return;
  const selected = selectedEntitySpan();
  const type = $('#entityType').value;
  if (!selected || !type) return;
  state.entities.get(state.activeEntityId).push({ type, ...selected });
  window.getSelection()?.removeAllRanges();
  renderEntitySpans();
}

function renderEntitySpans() {
  const host = $('#entitySpans');
  host.innerHTML = '';
  for (const entity of state.entities.get(state.activeEntityId) || []) {
    const row = document.createElement('div');
    row.className = 'entity-span';
    const code = document.createElement('code');
    code.textContent = `${entity.type}: “${entity.span}”`;
    const offsets = document.createElement('span');
    offsets.className = 'item-meta';
    offsets.textContent = `${entity.start}–${entity.end}`;
    row.append(code, offsets);
    host.append(row);
  }
}

function renderPendingRoutingCalls() {
  const host = $('#pendingCalls');
  host.innerHTML = '';
  for (const [index, call] of state.pendingRoutingCalls.entries()) {
    const row = document.createElement('div');
    row.className = 'pending-call';
    row.textContent = `${index + 1}. ${call.tool} ${JSON.stringify(call.args)}`;
    host.append(row);
  }
}

function setRefusal(checked) {
  const tool = $('#toolSelect');
  const args = $('#toolArgs');
  tool.disabled = checked;
  args.disabled = checked;
  $('#addCallButton').disabled = checked;
  if (checked) {
    tool.value = '';
    args.value = '';
    state.pendingRoutingCalls = [];
    renderPendingRoutingCalls();
  } else if (!args.value) args.value = '{}';
}

function addRoutingCall() {
  const error = $('#routingError');
  error.textContent = '';
  const tool = $('#toolSelect').value;
  if (!tool) {
    error.textContent = 'Choose a tool to add.';
    return false;
  }
  try {
    const args = JSON.parse($('#toolArgs').value || '{}');
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error();
    state.pendingRoutingCalls.push({ tool, args });
  } catch {
    error.textContent = 'Arguments must be a JSON object.';
    return false;
  }
  $('#toolSelect').value = '';
  $('#toolArgs').value = '{}';
  renderPendingRoutingCalls();
  return true;
}

function addRoutingCase() {
  const error = $('#routingError');
  error.textContent = '';
  const utterance = $('#utterance').value.trim();
  const refusal = Boolean($('#refusalToggle').checked);
  if (!utterance) {
    error.textContent = 'Enter an utterance.';
    return;
  }
  if (!refusal && !state.pendingRoutingCalls.length) {
    error.textContent = 'Add at least one expected call or mark this as a refusal.';
    return;
  }
  const expectedCalls = refusal ? [] : state.pendingRoutingCalls.map((call) => ({ tool: call.tool, args: structuredClone(call.args) }));
  state.routingCases.push({ utterance, expectedCalls, refusal });
  state.pendingRoutingCalls = [];
  $('#utterance').value = '';
  $('#refusalToggle').checked = false;
  $('#toolSelect').disabled = false;
  $('#toolArgs').disabled = false;
  $('#addCallButton').disabled = false;
  $('#toolSelect').value = '';
  $('#toolArgs').value = '{}';
  renderPendingRoutingCalls();
  renderRoutingCases();
}

function renderRoutingCases() {
  const host = $('#routingCases');
  host.innerHTML = '';
  for (const [index, routingCase] of state.routingCases.entries()) {
    const card = document.createElement('peek-card');
    card.className = 'routing-case';
    card.setAttribute('bordered', '');
    const title = document.createElement('strong');
    title.slot = 'header';
    title.textContent = routingCase.utterance;
    const summary = document.createElement('div');
    summary.className = 'case-summary';
    summary.textContent = routingCase.refusal ? 'refusal' : routingCase.expectedCalls.map((call) => `${call.tool} ${JSON.stringify(call.args)}`).join(' → ');
    card.dataset.caseIndex = String(index);
    card.append(title, summary);
    host.append(card);
  }
}

export function buildTaskPayload(source = state) {
  const itemIds = new Set(source.taskItems.keys());
  const tasks = source.tasks.map((task) => ({
    id: task.id,
    label: task.label,
    itemIds: task.itemIds.filter((id) => itemIds.has(id)),
  }));
  const assigned = new Set(tasks.flatMap((task) => task.itemIds));
  return {
    generatedAt: new Date().toISOString(),
    range: { since: source.range.since, until: source.range.until },
    tasks,
    unassignedItemIds: [...itemIds].filter((id) => !assigned.has(id)),
    items: [...source.taskItems.values()].map((item) => normalizedItem(item)),
  };
}

export function buildEntityPayload(source = state) {
  return {
    generatedAt: new Date().toISOString(),
    items: [...source.entityItems.values()].map((item) => ({
      itemId: item.id,
      type: item.type,
      url: itemUrl(item),
      text: String(item.labelText ?? (item.type === 'text' ? item.content || '' : '')),
      entities: (source.entities.get(item.id) || []).map((entity) => ({ ...entity })),
    })),
  };
}

export function buildRoutingPayload(source = state) {
  return {
    generatedAt: new Date().toISOString(),
    cases: source.routingCases.map((routingCase) => ({
      utterance: routingCase.utterance,
      expectedCalls: routingCase.expectedCalls.map((call) => ({ tool: call.tool, args: structuredClone(call.args) })),
      refusal: routingCase.refusal,
    })),
  };
}

async function exportCurrent() {
  const builders = { tasks: buildTaskPayload, entities: buildEntityPayload, routing: buildRoutingPayload };
  const filenames = { tasks: 'peek-task-clusters.json', entities: 'peek-entities.json', routing: 'peek-command-routing.json' };
  const payload = builders[state.workflow]();
  await api.dialogs.save(JSON.stringify(payload, null, 2), { filename: filenames[state.workflow], mimeType: 'application/json' });
}

function switchWorkflow(value) {
  state.workflow = value;
  for (const panel of document.querySelectorAll('.workflow')) panel.hidden = panel.dataset.workflow !== value;
  $('#exportButton').textContent = `Export ${{ tasks: 'task clustering', entities: 'entities', routing: 'command routing' }[value]}`;
}

function installTestHook() {
  window.__bakeOffLabelingTest = {
    buildTaskPayload,
    buildEntityPayload,
    buildRoutingPayload,
    setTaskItems(items) {
      state.taskItems = new Map(items.map((item) => [String(item.id), normalizedItem(item)]));
      state.tasks = [];
      state.selectedTaskItemIds.clear();
      renderTaskItems();
      renderTaskGroups();
    },
    replaceRangeTaskItems(items) {
      replaceRangeTaskItems(items);
      renderTaskItems();
    },
    setEntityItems(items) {
      state.entityItems = new Map(items.map((item) => [String(item.id), normalizedItem(item)]));
      state.entities = new Map(items.map((item) => [String(item.id), []]));
      renderEntityItems();
    },
    getState() { return state; },
  };
}

async function init() {
  await api.initialize();
  setDefaultRange();
  createPicker($('#taskPicker'), 'tasks');
  createPicker($('#entityPicker'), 'entities');
  $('#entityType').options = ['person', 'organization', 'place', 'event'];
  $('#entityType').value = 'person';
  $('#toolSelect').options = MCP_TOOLS.map(([value, description]) => ({ value, label: `${value} — ${description}` }));
  $('#workflowTabs').addEventListener('change', (event) => switchWorkflow(event.detail.value));
  $('#loadRangeButton').addEventListener('click', loadRange);
  $('#createTaskButton').addEventListener('click', createTask);
  $('#assignTaskButton').addEventListener('click', () => assignSelected($('#taskGroupSelect').value));
  $('#unassignTaskButton').addEventListener('click', unassignSelected);
  $('#tagEntityButton').addEventListener('click', tagSelectedEntity);
  $('#refusalToggle').addEventListener('change', (event) => setRefusal(event.detail.checked));
  $('#addCallButton').addEventListener('click', addRoutingCall);
  $('#addCaseButton').addEventListener('click', addRoutingCase);
  $('#exportButton').addEventListener('click', exportCurrent);
  $('#taskToolbar').target = $('#taskGrid');
  renderTaskItems();
  renderEntityItems();
  renderPendingRoutingCalls();
  renderRoutingCases();
  installTestHook();
  document.body.dataset.ready = 'true';
}

init().catch((error) => {
  console.error('[bake-off-labeling] initialization failed', error);
  document.body.dataset.error = error.message;
});
