const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { RETURN_REASONS } = require('./brm');

const router = express.Router();
router.use(requireAuth);

router.get('/return-reasons', (_req, res) => {
  res.json(Object.entries(RETURN_REASONS).map(([code, label]) => ({ code: Number(code), label })));
});

router.get('/familles', async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('d', sql.Bit, false)
      .query('select id, designation from famille where deleted = @d order by designation');
    res.json(result.recordset);
  } catch (err) {
    console.error('familles error:', err);
    res.status(500).json({ error: 'Server error fetching families' });
  }
});

router.get('/magasins', async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('d', sql.Bit, false)
      .query('select id, code_magasin, designation from magasin where deleted = @d order by designation');
    res.json(result.recordset);
  } catch (err) {
    console.error('magasins error:', err);
    res.status(500).json({ error: 'Server error fetching warehouses' });
  }
});

router.get('/intervenants', async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('d', sql.Bit, false)
      .query('select id, nom from intervenant where deleted = @d order by nom');
    res.json(result.recordset);
  } catch (err) {
    console.error('intervenants error:', err);
    res.status(500).json({ error: 'Server error fetching intervenors' });
  }
});

module.exports = router;
