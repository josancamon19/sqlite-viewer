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
  modal: document.querySelector('#modal'),
  modalTitle: document.querySelector('#modal-title'),
  modalBody: document.querySelector('#modal-body'),
  modalClose: document.querySelector('#modal-close'),
};

const LIMIT_OPTIONS = [25, 50, 100, 250, 500];

async function fetchJSON(url, options) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data && data.error ? data.error : response.statusText;
    throw new Error(message || 'Request failed');
  }
  return data;
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

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(createHeaderCell('#', 'column-index'));
  if (data.hasRowid) headRow.appendChild(createHeaderCell('rowid', 'column-rowid'));
  for (const column of data.columns) {
    headRow.appendChild(createHeaderCell(column));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!data.rows.length) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = data.columns.length + (data.hasRowid ? 2 : 1);
    emptyCell.textContent = 'No rows found.';
    emptyRow.appendChild(emptyCell);
    tbody.appendChild(emptyRow);
  } else {
    for (const row of data.rows) {
      const tr = document.createElement('tr');
      tr.appendChild(createCell(String(row.offset + 1), 'column-index'));
      if (data.hasRowid) {
        tr.appendChild(createCell(row.rowid != null ? String(row.rowid) : '', 'column-rowid')); 
      }
      for (const column of data.columns) {
        const cellData = row.cells[column];
        tr.appendChild(createDataCell(column, cellData, row));
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

function createHeaderCell(label, className) {
  const th = document.createElement('th');
  th.textContent = label;
  if (className) th.classList.add(className);
  return th;
}

function createCell(content, className) {
  const td = document.createElement('td');
  td.textContent = content;
  if (className) td.classList.add(className);
  return td;
}

function createDataCell(columnName, cellData, row) {
  const td = document.createElement('td');
  if (cellData.kind === 'number') {
    td.classList.add('cell-number');
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'cell-content';

  const metaText = renderMetaText(cellData);
  const meta = document.createElement('div');
  meta.className = 'cell-meta';
  if (metaText) {
    meta.textContent = metaText;
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
      td.append(createExpandButton(columnName, row));
    }
    return td;
  }

  if (cellData.kind === 'blob') {
    wrapper.textContent = formatBlobPreview(cellData);
    td.append(wrapper);
    if (metaText) td.append(meta);
    td.append(createExpandButton(columnName, row));
    return td;
  }

  wrapper.textContent = cellData.preview ?? '';
  td.append(wrapper);
  if (metaText) td.append(meta);
  if (cellData.hasMore) td.append(createExpandButton(columnName, row));
  return td;
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

function setupListeners() {
  els.form.addEventListener('submit', handleOpen);
  els.refreshTables.addEventListener('click', loadTables);
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
