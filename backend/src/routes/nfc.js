const express = require('express');
const { sql, getPool } = require('../db');
const { getAppPool } = require('../appDb');
const { requireAuth } = require('../middleware/auth');
const { MANAGER_ROLES, requireRole } = require('../roles');

// NFC tags <-> articles. The tag is only identified by its UID (nothing is
// written on the tag). The mapping lives in the small GMAO_APP database.
//   GET    /resolve?uid=       any user   -> the article behind a tag
//   GET    /article/:id        manager    -> tags attached to an article
//   POST   /tags               manager    -> attach a tag to an article
//   DELETE /tags/:uid          manager    -> detach a tag
const router = express.Router();
router.use(requireAuth);

// The phone reports the UID as hex, sometimes with ':' or spaces. Store one
// canonical form so the same tag always matches.
function normalizeUid(raw) {
  const uid = String(raw ?? '').replace(/[\s:\-]/g, '').toUpperCase();
  return /^[0-9A-F]{8,20}$/.test(uid) ? uid : null;
}

async function loadArticle(idArticle) {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('i', sql.Int, idArticle)
    .input('d', sql.Bit, false)
    .query('select id, code_article, designation from article where id = @i and deleted = @d');
  return r.recordset[0] || null;
}

router.get('/resolve', async (req, res) => {
  const uid = normalizeUid(req.query.uid);
  if (!uid) return res.status(400).json({ error: 'Identifiant de tag invalide.' });
  try {
    const appPool = await getAppPool();
    const t = await appPool
      .request()
      .input('u', sql.NVarChar, uid)
      .query('select id_article from app_nfc_tag where uid = @u');
    if (t.recordset.length === 0) {
      return res.status(404).json({ error: "Ce tag n'est associé à aucun article.", code: 'unknown_tag', uid });
    }
    const article = await loadArticle(t.recordset[0].id_article);
    if (!article) {
      return res.status(404).json({ error: "L'article de ce tag n'existe plus.", code: 'article_gone', uid });
    }
    res.json({ uid, article });
  } catch (err) {
    console.error('nfc resolve error:', err);
    res.status(500).json({ error: 'Server error reading NFC tag' });
  }
});

router.get('/article/:id', requireRole(MANAGER_ROLES), async (req, res) => {
  const idArticle = Number(req.params.id);
  if (!Number.isInteger(idArticle) || idArticle <= 0) return res.status(400).json({ error: 'Article invalide.' });
  try {
    const appPool = await getAppPool();
    const r = await appPool
      .request()
      .input('i', sql.Int, idArticle)
      .query('select uid, created_at from app_nfc_tag where id_article = @i order by created_at desc');
    res.json(r.recordset);
  } catch (err) {
    console.error('nfc article tags error:', err);
    res.status(500).json({ error: 'Server error reading NFC tags' });
  }
});

router.post('/tags', requireRole(MANAGER_ROLES), async (req, res) => {
  const uid = normalizeUid(req.body?.uid);
  const idArticle = Number(req.body?.id_article);
  const replace = req.body?.replace === true;
  if (!uid) return res.status(400).json({ error: 'Identifiant de tag invalide.' });
  if (!Number.isInteger(idArticle) || idArticle <= 0) return res.status(400).json({ error: 'Article invalide.' });
  try {
    const article = await loadArticle(idArticle);
    if (!article) return res.status(400).json({ error: 'Article introuvable.' });

    const appPool = await getAppPool();
    const existing = await appPool
      .request()
      .input('u', sql.NVarChar, uid)
      .query('select id_article from app_nfc_tag where uid = @u');

    if (existing.recordset.length > 0) {
      const current = existing.recordset[0].id_article;
      if (current === idArticle) return res.json({ uid, article, already: true });
      if (!replace) {
        const other = await loadArticle(current);
        return res.status(409).json({
          error: `Ce tag est déjà associé à « ${other ? other.designation : 'article #' + current} ».`,
          code: 'tag_in_use',
          current: other
        });
      }
      await appPool
        .request()
        .input('u', sql.NVarChar, uid)
        .input('i', sql.Int, idArticle)
        .input('by', sql.Int, req.user.id)
        .query('update app_nfc_tag set id_article = @i, created_by = @by, created_at = getdate() where uid = @u');
    } else {
      await appPool
        .request()
        .input('u', sql.NVarChar, uid)
        .input('i', sql.Int, idArticle)
        .input('by', sql.Int, req.user.id)
        .query('insert into app_nfc_tag (uid, id_article, created_by) values (@u, @i, @by)');
    }
    res.status(201).json({ uid, article });
  } catch (err) {
    console.error('nfc assign error:', err);
    res.status(500).json({ error: 'Server error saving NFC tag' });
  }
});

router.delete('/tags/:uid', requireRole(MANAGER_ROLES), async (req, res) => {
  const uid = normalizeUid(req.params.uid);
  if (!uid) return res.status(400).json({ error: 'Identifiant de tag invalide.' });
  try {
    const appPool = await getAppPool();
    const r = await appPool.request().input('u', sql.NVarChar, uid).query('delete from app_nfc_tag where uid = @u');
    if (r.rowsAffected[0] === 0) return res.status(404).json({ error: 'Tag introuvable.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('nfc delete error:', err);
    res.status(500).json({ error: 'Server error deleting NFC tag' });
  }
});

module.exports = router;
