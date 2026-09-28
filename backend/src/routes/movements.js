const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { RETURN_REASONS } = require('./brm');

const router = express.Router();
router.use(requireAuth);

// A personal activity feed for the Accueil "Derniers mouvements" section -
// works the same for every role, unlike /bsm/history or /brm/history which
// are manager-only. Merges three sources into one shape:
//   - real BSMs/BRMs this user created (status: 'approved')
//   - their own requests still awaiting a manager (status: 'pending')
//   - their own requests a manager turned down (status: 'rejected')
router.get('/mine', async (req, res) => {
  try {
    const pool = await getPool();
    const userId = req.user.id;

    const bsmResult = await pool
      .request()
      .input('u', sql.Int, userId)
      .query(`
        select top 20 id, type_stock, n_ot, date_bsm as date
        from bsm where createur = @u
        order by id desc
      `);

    const brmResult = await pool
      .request()
      .input('u', sql.Int, userId)
      .query(`
        select top 20 id, type_stock, type_retour, date_retour as date
        from brm where retour_par = @u
        order by id desc
      `);

    const pendingResult = await pool
      .request()
      .input('u', sql.Int, userId)
      .query(`
        select id, kind, payload, status, created_at, resolved_at, reason
        from app_pending_request
        where id_requester = @u and status in ('pending', 'rejected')
        order by id desc
      `);

    const rows = [];

    bsmResult.recordset.forEach((r) => rows.push({
      kind: 'bsm',
      id: r.id,
      ref: r.n_ot ? `OT ${r.n_ot}` : `BSM-${String(r.id).padStart(4, '0')}`,
      detail: r.type_stock,
      status: 'approved',
      date: r.date
    }));

    brmResult.recordset.forEach((r) => rows.push({
      kind: 'brm',
      id: r.id,
      ref: `BRM-${String(r.id).padStart(4, '0')}`,
      detail: RETURN_REASONS[r.type_retour] || r.type_stock,
      status: 'approved',
      date: r.date
    }));

    pendingResult.recordset.forEach((r) => {
      let payload = {};
      try { payload = JSON.parse(r.payload); } catch (e) { /* ignore malformed payload */ }
      rows.push({
        kind: r.kind,
        id: r.id,
        ref: r.kind === 'bsm'
          ? (payload.n_ot ? `OT ${payload.n_ot}` : `Demande #${r.id}`)
          : `Demande #${r.id}`,
        detail: r.status === 'rejected' ? (r.reason || 'Refusée') : 'En attente de validation',
        status: r.status, // 'pending' | 'rejected'
        date: r.status === 'rejected' ? (r.resolved_at || r.created_at) : r.created_at
      });
    });

    rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(rows.slice(0, 20));
  } catch (err) {
    console.error('movements mine error:', err);
    res.status(500).json({ error: 'Server error fetching your movements' });
  }
});

module.exports = router;
