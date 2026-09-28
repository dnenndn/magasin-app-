const express = require('express');
const bcrypt = require('bcryptjs');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ADMIN_ROLES, requireRole } = require('../roles');

const router = express.Router();
router.use(requireAuth, requireRole(ADMIN_ROLES));

// List users. Deliberately never selects mot_passe - see the password note
// in README/BUILD_APK.md for why admins get a reset button, not a viewer.
router.get('/users', async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .query('select id, login, fonction, deleted from utilisateur order by login');
    res.json(result.recordset);
  } catch (err) {
    console.error('list users error:', err);
    res.status(500).json({ error: 'Server error fetching users' });
  }
});

router.post('/users', async (req, res) => {
  const { login, password, fonction } = req.body || {};
  if (!login || !password || !fonction) {
    return res.status(400).json({ error: 'login, password, and fonction are required' });
  }

  try {
    const pool = await getPool();
    const existing = await pool.request().input('login', sql.NVarChar, login).query('select id from utilisateur where login = @login');
    if (existing.recordset.length > 0) {
      return res.status(409).json({ error: 'Ce login existe déjà' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool
      .request()
      .input('login', sql.NVarChar, login)
      .input('mot_passe', sql.NVarChar, hash)
      .input('fonction', sql.NVarChar, fonction)
      .input('d', sql.Bit, false)
      .query(
        `insert into utilisateur (login, mot_passe, fonction, deleted)
         values (@login, @mot_passe, @fonction, @d)
         select cast(scope_identity() as int) as id`
      );
    res.status(201).json({ id: result.recordset[0].id });
  } catch (err) {
    console.error('create user error:', err);
    res.status(500).json({ error: 'Server error creating user' });
  }
});

// Edit login/fonction/active-status. Never touches mot_passe here.
router.put('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { login, fonction, deleted } = req.body || {};

  try {
    const pool = await getPool();
    await pool
      .request()
      .input('id', sql.Int, id)
      .input('login', sql.NVarChar, login)
      .input('fonction', sql.NVarChar, fonction)
      .input('deleted', sql.Bit, Boolean(deleted))
      .query('update utilisateur set login = @login, fonction = @fonction, deleted = @deleted where id = @id');
    res.json({ ok: true });
  } catch (err) {
    console.error('update user error:', err);
    res.status(500).json({ error: 'Server error updating user' });
  }
});

// The password feature: admin sets a NEW password, never sees the old one.
router.post('/users/:id/reset-password', async (req, res) => {
  const id = Number(req.params.id);
  const { new_password } = req.body || {};
  if (!new_password || new_password.length < 4) {
    return res.status(400).json({ error: 'new_password is required (at least 4 characters)' });
  }

  try {
    const pool = await getPool();
    const hash = await bcrypt.hash(new_password, 10);
    await pool.request().input('id', sql.Int, id).input('mot_passe', sql.NVarChar, hash).query('update utilisateur set mot_passe = @mot_passe where id = @id');
    res.json({ ok: true });
  } catch (err) {
    console.error('reset password error:', err);
    res.status(500).json({ error: 'Server error resetting password' });
  }
});

module.exports = router;
