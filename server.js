const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'finance-data.json');

app.use(express.json());
app.use(express.static(__dirname));

let store = { expenses: [], sales: [] };

async function loadStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    store = {
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
      sales: Array.isArray(parsed.sales) ? parsed.sales : []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Unable to load data file:', error);
    }
    store = { expenses: [], sales: [] };
  }
}

async function saveStore() {
  try {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (error) {
    console.error('Failed to save data:', error);
    throw new Error(`Cannot save data: ${error.message}`);
  }
}

function genId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function normalizeRecord(record, type) {
  return {
    id: record.id || genId(),
    date: record.date,
    amount: Number(record.amount),
    description: record.description || '',
    category: type === 'expense' ? record.category || '' : undefined,
    type
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'TNT Tax Tracker API is running.' });
});

app.get('/api/expenses', async (_req, res) => {
  await loadStore();
  res.json(store.expenses);
});

app.post('/api/expenses', async (req, res) => {
  try {
    await loadStore();
    const item = normalizeRecord(req.body, 'expense');
    store.expenses.push(item);
    await saveStore();
    res.status(201).json(item);
  } catch (error) {
    console.error('POST /api/expenses error:', error);
    res.status(500).json({ error: error.message || 'Failed to save expense' });
  }
});

app.put('/api/expenses/:id', async (req, res) => {
  try {
    await loadStore();
    const idx = store.expenses.findIndex(item => item.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Expense not found.' });
    store.expenses[idx] = normalizeRecord({ ...store.expenses[idx], ...req.body }, 'expense');
    await saveStore();
    res.json(store.expenses[idx]);
  } catch (error) {
    console.error('PUT /api/expenses/:id error:', error);
    res.status(500).json({ error: error.message || 'Failed to update expense' });
  }
});

app.delete('/api/expenses/:id', async (req, res) => {
  await loadStore();
  const before = store.expenses.length;
  store.expenses = store.expenses.filter(item => item.id !== req.params.id);
  if (store.expenses.length === before) return res.status(404).json({ error: 'Expense not found.' });
  await saveStore();
  res.status(204).send();
});

app.get('/api/sales', async (_req, res) => {
  await loadStore();
  res.json(store.sales);
});

app.post('/api/sales', async (req, res) => {
  try {
    await loadStore();
    const item = normalizeRecord(req.body, 'sale');
    store.sales.push(item);
    await saveStore();
    res.status(201).json(item);
  } catch (error) {
    console.error('POST /api/sales error:', error);
    res.status(500).json({ error: error.message || 'Failed to save revenue' });
  }
});

app.put('/api/sales/:id', async (req, res) => {
  try {
    await loadStore();
    const idx = store.sales.findIndex(item => item.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Sale not found.' });
    store.sales[idx] = normalizeRecord({ ...store.sales[idx], ...req.body }, 'sale');
    await saveStore();
    res.json(store.sales[idx]);
  } catch (error) {
    console.error('PUT /api/sales/:id error:', error);
    res.status(500).json({ error: error.message || 'Failed to update revenue' });
  }
});

app.delete('/api/sales/:id', async (req, res) => {
  await loadStore();
  const before = store.sales.length;
  store.sales = store.sales.filter(item => item.id !== req.params.id);
  if (store.sales.length === before) return res.status(404).json({ error: 'Sale not found.' });
  await saveStore();
  res.status(204).send();
});

app.get('/api/summary', async (_req, res) => {
  await loadStore();
  res.json({ expenses: store.expenses, sales: store.sales });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

loadStore().then(() => {
  app.listen(PORT, () => {
    console.log(`TNT Tax Tracker is running on port ${PORT}`);
  });
});
