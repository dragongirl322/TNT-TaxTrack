const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

app.use(express.json());
app.use(express.static(__dirname));

let pool = null;

// Initialize database connection
async function initDb() {
  if (!DATABASE_URL) {
    console.log('DATABASE_URL not set, using in-memory storage');
    return null;
  }

  pool = new Pool({ connectionString: DATABASE_URL });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id VARCHAR(36) PRIMARY KEY,
        date DATE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        category VARCHAR(255),
        description TEXT,
        type VARCHAR(20)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id VARCHAR(36) PRIMARY KEY,
        date DATE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        description TEXT,
        type VARCHAR(20)
      )
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

let inMemoryStore = { expenses: [], sales: [] };

async function loadStore() {
  if (!pool) {
    return inMemoryStore;
  }

  try {
    const expensesResult = await pool.query('SELECT * FROM expenses ORDER BY date DESC');
    const salesResult = await pool.query('SELECT * FROM sales ORDER BY date DESC');

    return {
      expenses: expensesResult.rows,
      sales: salesResult.rows
    };
  } catch (error) {
    console.error('Failed to load from database:', error);
    return inMemoryStore;
  }
}

async function saveStore(store) {
  if (!pool) {
    inMemoryStore = store;
    return;
  }

  try {
    for (const expense of store.expenses) {
      await pool.query(
        'INSERT INTO expenses (id, date, amount, category, description, type) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO UPDATE SET date = $2, amount = $3, category = $4, description = $5',
        [expense.id, expense.date, expense.amount, expense.category, expense.description, expense.type]
      );
    }

    for (const sale of store.sales) {
      await pool.query(
        'INSERT INTO sales (id, date, amount, description, type) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET date = $2, amount = $3, description = $4',
        [sale.id, sale.date, sale.amount, sale.description, sale.type]
      );
    }
  } catch (error) {
    console.error('Failed to save to database:', error);
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
  try {
    const store = await loadStore();
    res.json(store.expenses);
  } catch (error) {
    console.error('GET /api/expenses error:', error);
    res.status(500).json({ error: 'Failed to load expenses' });
  }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const store = await loadStore();
    const item = normalizeRecord(req.body, 'expense');
    store.expenses.push(item);
    await saveStore(store);
    res.status(201).json(item);
  } catch (error) {
    console.error('POST /api/expenses error:', error);
    res.status(500).json({ error: error.message || 'Failed to save expense' });
  }
});

app.put('/api/expenses/:id', async (req, res) => {
  try {
    const store = await loadStore();
    const idx = store.expenses.findIndex(item => item.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Expense not found.' });
    store.expenses[idx] = normalizeRecord({ ...store.expenses[idx], ...req.body }, 'expense');
    await saveStore(store);
    res.json(store.expenses[idx]);
  } catch (error) {
    console.error('PUT /api/expenses/:id error:', error);
    res.status(500).json({ error: error.message || 'Failed to update expense' });
  }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    if (pool) {
      const result = await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Expense not found.' });
    } else {
      const store = await loadStore();
      const before = store.expenses.length;
      store.expenses = store.expenses.filter(item => item.id !== req.params.id);
      if (store.expenses.length === before) return res.status(404).json({ error: 'Expense not found.' });
      await saveStore(store);
    }
    res.status(204).send();
  } catch (error) {
    console.error('DELETE /api/expenses/:id error:', error);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

app.get('/api/sales', async (_req, res) => {
  try {
    const store = await loadStore();
    res.json(store.sales);
  } catch (error) {
    console.error('GET /api/sales error:', error);
    res.status(500).json({ error: 'Failed to load sales' });
  }
});

app.post('/api/sales', async (req, res) => {
  try {
    const store = await loadStore();
    const item = normalizeRecord(req.body, 'sale');
    store.sales.push(item);
    await saveStore(store);
    res.status(201).json(item);
  } catch (error) {
    console.error('POST /api/sales error:', error);
    res.status(500).json({ error: error.message || 'Failed to save revenue' });
  }
});

app.put('/api/sales/:id', async (req, res) => {
  try {
    const store = await loadStore();
    const idx = store.sales.findIndex(item => item.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Sale not found.' });
    store.sales[idx] = normalizeRecord({ ...store.sales[idx], ...req.body }, 'sale');
    await saveStore(store);
    res.json(store.sales[idx]);
  } catch (error) {
    console.error('PUT /api/sales/:id error:', error);
    res.status(500).json({ error: error.message || 'Failed to update revenue' });
  }
});

app.delete('/api/sales/:id', async (req, res) => {
  try {
    if (pool) {
      const result = await pool.query('DELETE FROM sales WHERE id = $1', [req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Sale not found.' });
    } else {
      const store = await loadStore();
      const before = store.sales.length;
      store.sales = store.sales.filter(item => item.id !== req.params.id);
      if (store.sales.length === before) return res.status(404).json({ error: 'Sale not found.' });
      await saveStore(store);
    }
    res.status(204).send();
  } catch (error) {
    console.error('DELETE /api/sales/:id error:', error);
    res.status(500).json({ error: 'Failed to delete sale' });
  }
});

app.get('/api/summary', async (_req, res) => {
  try {
    const store = await loadStore();
    res.json({ expenses: store.expenses, sales: store.sales });
  } catch (error) {
    console.error('GET /api/summary error:', error);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile('index.html', { root: __dirname });
});

(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`TNT Tax Tracker is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();
