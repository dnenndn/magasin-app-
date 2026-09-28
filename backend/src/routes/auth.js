const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { sql, getPool } = require('../db');

const router = express.Router();

// Looks like a bcrypt hash ($2a$/$2b$/$2y$...)? Otherwise we treat the
// stored value as the legacy plaintext password the desktop app still uses.
// This lets the mobile app work against the existing `utilisateur` table
// today, while giving you a path to migrate rows to real hashes over time
// (once a row is hashed, this function stops falling back to plaintext for it).
function looksHashed(value) {
  return typeof value === 'string' && /^\$2[aby]\$/.test(value);
}

router.post('/login', async (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'login and password are required' });
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('login', sql.NVarChar, login)
      .input('d', sql.Bit, false)
      .query(
        `select id, login, mot_passe, fonction
         from utilisateur
         where login = @login and deleted = @d`
      );

    const user = result.recordset[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid login or password' });
    }

    const stored = user.mot_passe;
    const valid = looksHashed(stored)
      ? await bcrypt.compare(password, stored)
      : password === stored;

    if (!valid) {
      return res.status(401).json({ error: 'Invalid login or password' });
    }

    // If utilisateur.fonction is a fixed-width CHAR column, SQL Server pads
    // it with trailing spaces (e.g. "Administrateur   ") which would break
    // every exact role check downstream with no visible error. Trim it once
    // here so nothing else has to think about it.
    const fonction = (user.fonction || '').trim();
    const login2 = (user.login || '').trim();

    const token = jwt.sign(
      { id: user.id, login: login2, fonction },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
    );

    res.json({
      token,
      user: { id: user.id, login: login2, fonction }
    });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

module.exports = router;
