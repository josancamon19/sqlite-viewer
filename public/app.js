const state = {
  ready: false,
  dbPath: null,
  tables: [],
  selectedTable: null,
  limit: 100,
  offset: 0,
  orderBy: null,
  orderDir: 'asc',
  rowCount: 0,
  hasRowid: false,
  columnWidths: {},
};

const els = {
  form: document.querySelector('#open-form'),
  pathInput: document.querySelector('#db-path'),
  statusText: document.querySelector('#status-text'),
  statusHint: document.querySelector('#status-hint'),
  tableList: document.querySelector('#table-list'),
  refreshTables: document.querySelector('#refresh-tables'),
  tableMeta: document.querySelector('#table-meta'),
  tableData: document.querySelector('#table-data'),
  uploadButton: document.querySelector('#upload-button'),
  fileInput: document.querySelector('#db-file'),
  modal: document.querySelector('#modal'),
  modalTitle: document.querySelector('#modal-title'),
  modalBody: document.querySelector('#modal-body'),
  modalClose: document.querySelector('#modal-close'),
};

const LIMIT_OPTIONS = [25, 50, 100, 250, 500];

async function fetchJSON(url, options = {}) {
  const opts = { ...options };
  const headers = new Headers(opts.headers || {});
  const isFormData = opts.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  opts.headers = headers;

  const response = await fetch(url, opts);
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }
  if (!response.ok) {
    const message = data && data.error ? data.error : (text || response.statusText);
    throw new Error(message || 'Request failed');
  }
  return data ?? {};
}

function updateStatus(status) {
  state.ready = Boolean(status.ready);
  state.dbPath = status.dbPath || null;
  if (state.ready && state.dbPath) {
    els.statusText.textContent = `Active: ${state.dbPath}`;
    els.statusHint.textContent = status.dbExists ? 'Reloading keeps this database active until it is removed.' : 'Last path stored but file is not accessible.';
  } else {
    els.statusText.textContent = 'No database loaded';
    els.statusHint.textContent = 'Provide a database file path to start exploring.';
  }
}

function renderTables() {
  els.tableList.innerHTML = '';
  if (!state.tables.length) {
    const notice = document.createElement('p');
    notice.textContent = state.ready ? 'No tables or views found.' : 'Open a database to view tables.';
    notice.className = 'status-hint';
    els.tableList.appendChild(notice);
    return;
  }
  for (const entry of state.tables) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'table-item';
    item.dataset.name = entry.name;
    item.innerHTML = `
      <span>${entry.name}</span>
      <small>${entry.type}${entry.rowCount != null ? ` · ${entry.rowCount} rows` : ''}</small>
    `;
    if (entry.name === state.selectedTable) {
      item.classList.add('active');
    }
    item.addEventListener('click', () => selectTable(entry.name));
    els.tableList.appendChild(item);
  }
}

function renderTableMeta(info) {
  els.tableMeta.classList.remove('hidden');
  els.tableMeta.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'section-header';
  title.innerHTML = `<h2>${info.name}</h2>`;
  els.tableMeta.appendChild(title);

  const metaGrid = document.createElement('div');
  metaGrid.className = 'table-meta-grid';

  const rowCount = info.rowCount != null ? info.rowCount.toLocaleString('en-US') : 'Unknown';
  metaGrid.appendChild(createMetaItem('Rows', rowCount));
  metaGrid.appendChild(createMetaItem('Columns', info.columns.length));
  metaGrid.appendChild(createMetaItem('RowID', info.hasRowid ? 'Yes' : 'No'));
  metaGrid.appendChild(createMetaItem('Primary Key', info.primaryKeys.length ? info.primaryKeys.join(', ') : '—'));

  els.tableMeta.appendChild(metaGrid);

  if (info.columns.length) {
    const columnList = document.createElement('div');
    columnList.className = 'column-list';
    const heading = document.createElement('strong');
    heading.textContent = 'Columns';
    heading.style.textTransform = 'uppercase';
    heading.style.letterSpacing = '0.05em';
    heading.style.fontSize = '0.75rem';

    columnList.appendChild(heading);

    const chipContainer = document.createElement('div');
    chipContainer.style.display = 'flex';
    chipContainer.style.flexWrap = 'wrap';
    chipContainer.style.gap = '8px';

    for (const column of info.columns) {
      const chip = document.createElement('span');
      chip.style.padding = '4px 8px';
      chip.style.borderRadius = '999px';
      chip.style.background = 'rgba(29, 114, 184, 0.12)';
      chip.style.fontSize = '0.8rem';
      chip.style.display = 'inline-flex';
      chip.style.gap = '6px';
      chip.innerHTML = `<span>${column.name}</span><small style="opacity:0.6;">${column.type || 'TEXT'}</small>`;
      chipContainer.appendChild(chip);
    }

    columnList.appendChild(chipContainer);
    els.tableMeta.appendChild(columnList);
  }
}

function createMetaItem(label, value) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-meta-item';
  const labelEl = document.createElement('strong');
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.textContent = value;
  wrapper.append(labelEl, valueEl);
  return wrapper;
}

function renderRows(data) {
  els.tableData.classList.remove('placeholder');
  els.tableData.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'results-header';

  const summary = document.createElement('span');
  if (data.rowCount != null) {
    const start = data.rows.length ? data.offset + 1 : 0;
    const end = data.rows.length ? data.offset + data.rows.length : 0;
    summary.textContent = `${start}-${end} of ${data.rowCount.toLocaleString('en-US')} rows`;
  } else {
    summary.textContent = `${data.rows.length} rows`;
  }
  header.appendChild(summary);

  const limitSelect = document.createElement('select');
  for (const option of LIMIT_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = String(option);
    opt.textContent = `${option} / page`;
    if (option === state.limit) opt.selected = true;
    limitSelect.appendChild(opt);
  }
  limitSelect.addEventListener('change', () => {
    state.limit = Number(limitSelect.value);
    state.offset = 0;
    loadRows();
  });
  header.appendChild(limitSelect);

  const orderSelect = document.createElement('select');
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = state.hasRowid ? 'Default order (rowid)' : 'Default order';
  if (!state.orderBy) defaultOption.selected = true;
  orderSelect.appendChild(defaultOption);
  for (const column of data.columns) {
    const opt = document.createElement('option');
    opt.value = column;
    opt.textContent = `Order by ${column}`;
    if (column === state.orderBy) opt.selected = true;
    orderSelect.appendChild(opt);
  }
  orderSelect.addEventListener('change', () => {
    const value = orderSelect.value || null;
    state.orderBy = value;
    state.offset = 0;
    loadRows();
  });
  header.appendChild(orderSelect);

  const dirToggle = document.createElement('button');
  dirToggle.type = 'button';
  dirToggle.className = 'cell-action';
  dirToggle.textContent = state.orderDir === 'asc' ? 'Ascending' : 'Descending';
  dirToggle.addEventListener('click', () => {
    state.orderDir = state.orderDir === 'asc' ? 'desc' : 'asc';
    loadRows();
  });
  header.appendChild(dirToggle);

  els.tableData.appendChild(header);

  const tableWrapper = document.createElement('div');
  tableWrapper.className = 'data-table-wrapper';
  const table = document.createElement('table');
  table.className = 'table-grid';
  table.dataset.table = state.selectedTable || '';

  const descriptors = [];
  const addDescriptor = (descriptor) => {
    const id = `col-${descriptors.length}`;
    descriptors.push({ ...descriptor, id });
  };

  addDescriptor({ key: '__index__', label: '#', className: 'column-index', minWidth: 56 });
  if (data.hasRowid) {
    addDescriptor({ key: '__rowid__', label: 'rowid', className: 'column-rowid', minWidth: 88 });
  }
  for (const column of data.columns) {
    addDescriptor({ key: column, label: column, minWidth: 120 });
  }

  const colgroup = document.createElement('colgroup');
  for (const descriptor of descriptors) {
    const colEl = document.createElement('col');
    colEl.dataset.colId = descriptor.id;
    const storedWidth = state.columnWidths[descriptor.key];
    if (Number.isFinite(storedWidth)) {
      colEl.style.width = `${storedWidth}px`;
    }
    colgroup.appendChild(colEl);
  }
  table.appendChild(colgroup);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const descriptor of descriptors) {
    const th = createHeaderCell(descriptor, table);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!data.rows.length) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = descriptors.length;
    emptyCell.textContent = 'No rows found.';
    emptyRow.appendChild(emptyCell);
    tbody.appendChild(emptyRow);
  } else {
    for (const row of data.rows) {
      const tr = document.createElement('tr');
      for (const descriptor of descriptors) {
        if (descriptor.key === '__index__') {
          tr.appendChild(createCell(descriptor, String(row.offset + 1)));
        } else if (descriptor.key === '__rowid__') {
          const value = row.rowid != null ? String(row.rowid) : '';
          tr.appendChild(createCell(descriptor, value));
        } else {
          const cellData = row.cells[descriptor.key];
          tr.appendChild(createDataCell(descriptor, cellData, row));
        }
      }
      tbody.appendChild(tr);
    }
  }

  table.appendChild(tbody);
  tableWrapper.appendChild(table);
  els.tableData.appendChild(tableWrapper);

  const pager = document.createElement('div');
  pager.className = 'pagination';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.textContent = 'Prev';
  prev.disabled = state.offset === 0;
  prev.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadRows();
  });
  const next = document.createElement('button');
  next.type = 'button';
  next.textContent = 'Next';
  const total = data.rowCount != null ? data.rowCount : Infinity;
  const nextOffset = state.offset + state.limit;
  next.disabled = data.rows.length < state.limit || nextOffset >= total;
  next.addEventListener('click', () => {
    state.offset += state.limit;
    loadRows();
  });

  pager.append(prev, next);
  els.tableData.appendChild(pager);
}

function createHeaderCell(descriptor, table) {
  const th = document.createElement('th');
  th.textContent = descriptor.label;
  if (descriptor.className) th.classList.add(descriptor.className);
  th.dataset.colId = descriptor.id;
  const storedWidth = state.columnWidths[descriptor.key];
  if (Number.isFinite(storedWidth)) {
    th.style.width = `${storedWidth}px`;
  }
  if (descriptor.resizable !== false) {
    attachColumnResizer(th, descriptor, table);
  }
  return th;
}

function createCell(descriptor, content) {
  const td = document.createElement('td');
  if (descriptor.className) td.classList.add(descriptor.className);
  td.dataset.colId = descriptor.id;
  const storedWidth = state.columnWidths[descriptor.key];
  if (Number.isFinite(storedWidth)) {
    td.style.width = `${storedWidth}px`;
  }
  td.textContent = content;
  return td;
}

function createDataCell(descriptor, cellData, row) {
  const td = document.createElement('td');
  td.dataset.colId = descriptor.id;
  const storedWidth = state.columnWidths[descriptor.key];
  if (Number.isFinite(storedWidth)) {
    td.style.width = `${storedWidth}px`;
  }
  if (cellData?.kind === 'number') {
    td.classList.add('cell-number');
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'cell-content';

  const metaText = cellData ? renderMetaText(cellData) : null;
  const meta = document.createElement('div');
  meta.className = 'cell-meta';
  if (metaText) {
    meta.textContent = metaText;
  }

  if (!cellData) {
    wrapper.textContent = '';
    td.append(wrapper);
    if (metaText) td.append(meta);
    return td;
  }

  if (cellData.kind === 'null') {
    wrapper.textContent = 'NULL';
    wrapper.style.opacity = '0.6';
    td.append(wrapper);
    if (metaText) td.append(meta);
    return td;
  }

  if (cellData.kind === 'number') {
    wrapper.textContent = String(cellData.value);
    td.append(wrapper);
    if (metaText) td.append(meta);
    return td;
  }

  if (cellData.kind === 'text') {
    wrapper.textContent = cellData.preview || '';
    td.append(wrapper);
    if (metaText) td.append(meta);
    if (cellData.hasMore) {
      td.append(createExpandButton(descriptor.key, row));
    }
    return td;
  }

  if (cellData.kind === 'blob') {
    wrapper.textContent = formatBlobPreview(cellData);
    td.append(wrapper);
    if (metaText) td.append(meta);
    td.append(createExpandButton(descriptor.key, row));
    return td;
  }

  wrapper.textContent = cellData.preview ?? '';
  td.append(wrapper);
  if (metaText) td.append(meta);
  if (cellData.hasMore) td.append(createExpandButton(descriptor.key, row));
  return td;
}

function attachColumnResizer(th, descriptor, table) {
  const resizer = document.createElement('span');
  resizer.className = 'column-resizer';
  resizer.title = 'Drag to resize';
  resizer.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.pageX;
    const initialWidth = Number.isFinite(state.columnWidths[descriptor.key])
      ? state.columnWidths[descriptor.key]
      : th.getBoundingClientRect().width;
    const minWidth = descriptor.minWidth || 80;

    const baselineWidth = Math.max(minWidth, initialWidth);

    state.columnWidths[descriptor.key] = baselineWidth;
    applyColumnWidth(table, descriptor, baselineWidth);
    document.body.classList.add('resizing-columns');
    table.classList.add('is-resizing');

    const onMouseMove = (moveEvent) => {
      const delta = moveEvent.pageX - startX;
      const nextWidth = Math.max(minWidth, baselineWidth + delta);
      state.columnWidths[descriptor.key] = nextWidth;
      applyColumnWidth(table, descriptor, nextWidth);
      th.classList.add('resizing');
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      th.classList.remove('resizing');
      table.classList.remove('is-resizing');
      document.body.classList.remove('resizing-columns');
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
  th.appendChild(resizer);
}

function applyColumnWidth(table, descriptor, width) {
  if (!Number.isFinite(width)) return;
  const resolved = `${Math.max(40, Math.round(width))}px`;
  const col = table.querySelector(`col[data-col-id="${descriptor.id}"]`);
  if (col) {
    col.style.width = resolved;
  }
  table
    .querySelectorAll(`th[data-col-id="${descriptor.id}"], td[data-col-id="${descriptor.id}"]`)
    .forEach((cell) => {
      cell.style.width = resolved;
    });
}

function renderMetaText(cellData) {
  if (cellData.kind === 'text') {
    return `${cellData.length ?? cellData.preview?.length ?? ''} chars${cellData.hasMore ? ' · truncated' : ''}`;
  }
  if (cellData.kind === 'blob') {
    return `${cellData.size} bytes · base64 preview`;
  }
  return null;
}

function formatBlobPreview(cellData) {
  if (!cellData.preview) return '[binary]';
  const preview = cellData.preview.slice(0, 120);
  return `${preview}${cellData.preview.length > 120 ? '…' : ''}`;
}

function createExpandButton(columnName, row) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cell-action';
  btn.textContent = 'View';
  btn.addEventListener('click', () => openCellModal(columnName, row));
  return btn;
}

function showModal(title, bodyContent) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = '';
  if (typeof bodyContent === 'string') {
    els.modalBody.textContent = bodyContent;
  } else if (bodyContent instanceof Node) {
    els.modalBody.appendChild(bodyContent);
  }
  els.modal.classList.remove('hidden');
}

function closeModal() {
  els.modal.classList.add('hidden');
}

async function openCellModal(columnName, row) {
  showModal(`${columnName}`, createLoading());
  try {
    const params = new URLSearchParams({ column: columnName });
    if (state.orderBy) params.set('orderBy', state.orderBy);
    if (state.orderDir === 'desc') params.set('dir', 'desc');
    if (state.hasRowid && row.rowid != null) {
      params.set('rowid', String(row.rowid));
    } else {
      params.set('offset', String(row.offset));
    }
    const data = await fetchJSON(`/api/table/${encodeURIComponent(state.selectedTable)}/cell?${params.toString()}`);
    const content = renderFullValue(columnName, data.value);
    showModal(`${columnName}`, content);
  } catch (err) {
    showModal(`${columnName}`, document.createTextNode(err.message));
  }
}

function createLoading() {
  const el = document.createElement('div');
  el.textContent = 'Loading…';
  return el;
}

function renderFullValue(columnName, cell) {
  if (cell.kind === 'null') {
    return document.createTextNode('NULL');
  }
  if (cell.kind === 'number') {
    return document.createTextNode(String(cell.value));
  }
  if (cell.kind === 'text') {
    const container = document.createElement('div');
    const pre = document.createElement('pre');
    pre.textContent = cell.value ?? '';
    container.appendChild(pre);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-button';
    copy.textContent = 'Copy to clipboard';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cell.value ?? '');
        copy.textContent = 'Copied!';
        setTimeout(() => (copy.textContent = 'Copy to clipboard'), 1600);
      } catch (err) {
        copy.textContent = 'Copy failed';
      }
    });
    container.appendChild(copy);
    return container;
  }
  if (cell.kind === 'blob') {
    const container = document.createElement('div');
    const info = document.createElement('p');
    info.textContent = `${cell.size} bytes (base64 view)`;
    container.appendChild(info);

    const pre = document.createElement('pre');
    pre.textContent = cell.data || '';
    container.appendChild(pre);

    const download = document.createElement('a');
    download.className = 'download-button';
    download.textContent = 'Download blob';
    download.href = `data:application/octet-stream;base64,${cell.data}`;
    download.download = `${state.selectedTable || 'blob'}-${columnName}-${Date.now()}.bin`;
    container.appendChild(download);
    return container;
  }
  return document.createTextNode(JSON.stringify(cell));
}

async function refreshStatus() {
  try {
    const status = await fetchJSON('/api/status');
    updateStatus(status);
    if (status.ready) {
      await loadTables();
    } else {
      state.tables = [];
      state.selectedTable = null;
      state.columnWidths = {};
      renderTables();
      els.tableData.classList.add('placeholder');
      els.tableData.innerHTML = '<p>Select a table to view its rows.</p>';
      els.tableMeta.classList.add('hidden');
      els.tableMeta.innerHTML = '';
    }
  } catch (err) {
    els.statusText.textContent = `Status error: ${err.message}`;
  }
}

async function loadTables() {
  try {
    const data = await fetchJSON('/api/tables');
    state.tables = data.tables || [];
    renderTables();
    if (state.selectedTable && !state.tables.find((t) => t.name === state.selectedTable)) {
      state.selectedTable = null;
    }
  } catch (err) {
    els.tableList.innerHTML = `<p class="status-hint">Failed to load tables: ${err.message}</p>`;
  }
}

async function selectTable(name) {
  state.selectedTable = name;
  state.offset = 0;
  state.orderBy = null;
  state.orderDir = 'asc';
  state.columnWidths = {};
  renderTables();
  await loadTableDetails();
}

async function loadTableDetails() {
  if (!state.selectedTable) return;
  try {
    const info = await fetchJSON(`/api/table/${encodeURIComponent(state.selectedTable)}`);
    renderTableMeta(info);
    state.rowCount = info.rowCount ?? state.rowCount;
    state.hasRowid = info.hasRowid;
    await loadRows();
  } catch (err) {
    els.tableMeta.classList.add('hidden');
    els.tableMeta.innerHTML = '';
    els.tableData.innerHTML = `<p class="status-hint">Failed to load table: ${err.message}</p>`;
  }
}

async function loadRows() {
  if (!state.selectedTable) return;
  els.tableData.innerHTML = '<p>Loading rows…</p>';
  try {
    const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
    if (state.orderBy) params.set('orderBy', state.orderBy);
    if (state.orderDir === 'desc') params.set('dir', 'desc');
    const data = await fetchJSON(`/api/table/${encodeURIComponent(state.selectedTable)}/rows?${params.toString()}`);
    state.rowCount = data.rowCount ?? state.rowCount;
    state.hasRowid = data.hasRowid;
    renderRows(data);
  } catch (err) {
    els.tableData.innerHTML = `<p class="status-hint">Failed to load rows: ${err.message}</p>`;
  }
}

async function handleOpen(event) {
  event.preventDefault();
  const path = els.pathInput.value.trim();
  if (!path) return;
  els.statusText.textContent = 'Opening…';
  try {
    const data = await fetchJSON('/api/open', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
    els.statusText.textContent = `Opened: ${data.dbPath}`;
    await refreshStatus();
    els.pathInput.blur();
  } catch (err) {
    els.statusText.textContent = `Error: ${err.message}`;
  }
}

async function handleUploadFile(file) {
  if (!file) return;
  els.statusText.textContent = `Uploading ${file.name}…`;
  els.statusHint.textContent = 'Processing upload';
  els.uploadButton.disabled = true;
  try {
    const form = new FormData();
    form.append('file', file, file.name);
    const data = await fetchJSON('/api/upload', {
      method: 'POST',
      body: form,
    });
    els.statusText.textContent = `Uploaded: ${data.filename || file.name}`;
    els.statusHint.textContent = 'Database loaded from uploaded file.';
    await refreshStatus();
  } catch (err) {
    els.statusText.textContent = `Upload error: ${err.message}`;
    els.statusHint.textContent = '';
  } finally {
    els.uploadButton.disabled = false;
    els.fileInput.value = '';
  }
}

function setupListeners() {
  els.form.addEventListener('submit', handleOpen);
  els.refreshTables.addEventListener('click', loadTables);
  els.uploadButton.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (event) => {
    const [file] = event.target.files;
    if (file) {
      handleUploadFile(file);
    }
  });
  els.modalClose.addEventListener('click', closeModal);
  els.modal.addEventListener('click', (event) => {
    if (event.target === els.modal) {
      closeModal();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
}

setupListeners();
refreshStatus();
