const express = require('express');
const { sql, getPool } = require('../db');
const { getAppPool } = require('../appDb');
const { loginsByIds } = require('../userLookup');
const { requireAuth } = require('../middleware/auth');
const { MANAGER_ROLES, isManager, requireRole } = require('../roles');
const { notifyRoles, notifyUsers } = require('../push');

// Pending requests (and who approved what) live in the small app database;
// the original GMAO database only ever receives the real BRM once approved.
// brm itself is left exactly as the desktop app defines it (no extra columns).

const router = express.Router();
router.use(requireAuth);

const STOCK_COLUMN = {
  neuf: 'stock_neuf',
  use: 'stock_use',
  rebute: 'stock_rebute'
};

const STOCK_LABEL = {
  neuf: 'Neuf',
  use: 'Usé',
  rebute: 'Rebuté'
};

// brm.type_retour is an integer reason code in the real schema (confirmed
// from the desktop app's source), not free text. These are its 5 options,
// in the desktop app's own wording.
const RETURN_REASONS = {
  1: "Ancienne Pièce lors de la sortie d'une nouvelle pièce",
  2: 'Pièce sortie non utilisée',
  3: "Pièce trouvée dans l'usine",
  4: 'Retour Pièce pour réparation',
  5: 'Retour qualité'
};

function validateShape(body) {
  const { type_retour, type_stock, lines } = body || {};
  if (!RETURN_REASONS[type_retour] || !STOCK_COLUMN[type_stock] || !Array.isArray(lines) || lines.length === 0) {
    return 'A valid type_retour (1-5), a valid type_stock, and at least one line are required';
  }
  return null;
}

// Actually creates the BRM: insert brm/brm_article, increment stock, log
// the change. Used both for managers (immediately) and for approving a
// previously-staged request - `requesterId` becomes brm.retour_par either way.
async function commitBrm(pool, { type_retour, type_stock, n_bsm, lines }, requesterId) {
  const column = STOCK_COLUMN[type_stock];
  const transaction = new sql.Transaction(pool);

  await transaction.begin();
  try {
    const now = new Date();
    const request = new sql.Request(transaction)
      .input('type_retour', sql.Int, type_retour)
      .input('type_stock', sql.NVarChar, STOCK_LABEL[type_stock])
      .input('retour_par', sql.Int, requesterId)
      .input('date_retour', sql.Date, now)
      .input('heure_retour', sql.NVarChar, now.toTimeString().slice(0, 8));

    const headerResult = n_bsm
      ? await request.input('n_bsm', sql.Int, n_bsm).query(
          `insert into brm (type_retour, type_stock, retour_par, date_retour, heure_retour, n_bsm)
           values (@type_retour, @type_stock, @retour_par, @date_retour, @heure_retour, @n_bsm)
           select cast(scope_identity() as int) as id`
        )
      : await request.query(
          `insert into brm (type_retour, type_stock, retour_par, date_retour, heure_retour)
           values (@type_retour, @type_stock, @retour_par, @date_retour, @heure_retour)
           select cast(scope_identity() as int) as id`
        );

    const idBrm = headerResult.recordset[0].id;

    for (const line of lines) {
      await new sql.Request(transaction)
        .input('id_brm', sql.Int, idBrm)
        .input('id_article', sql.Int, line.id_article)
        .input('quantite', sql.Decimal(18, 3), line.quantite)
        .query('insert into brm_article (id_brm, id_article, quantite) values (@id_brm, @id_article, @quantite)');

      await new sql.Request(transaction)
        .input('v', sql.Decimal(18, 3), line.quantite)
        .input('i', sql.Int, line.id_article)
        .query(`update article set ${column} = ${column} + @v where id = @i`);

      const stockRow = await new sql.Request(transaction)
        .input('i', sql.Int, line.id_article)
        .query('select tva, prix_ht, stock_neuf, stock_use, stock_rebute from article where id = @i');
      const s = stockRow.recordset[0];

      await new sql.Request(transaction)
        .input('id_article', sql.Int, line.id_article)
        .input('tva', sql.Decimal(18, 3), s.tva)
        .input('prix_ht', sql.Decimal(18, 3), s.prix_ht)
        .input('stock_neuf', sql.Decimal(18, 3), s.stock_neuf)
        .input('stock_use', sql.Decimal(18, 3), s.stock_use)
        .input('stock_rebute', sql.Decimal(18, 3), s.stock_rebute)
        .input('date_modification', sql.DateTime, now)
        .query(
          `insert into modification_article (id_article, tva, prix_ht, stock_neuf, stock_use, stock_rebute, date_modification)
           values (@id_article, @tva, @prix_ht, @stock_neuf, @stock_use, @stock_rebute, @date_modification)`
        );
    }

    await transaction.commit();
    return idBrm;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error('commitBrm - rollback also failed:', rollbackErr);
    }
    throw err;
  }
}

// Return stock to the warehouse.
// Managers: committed immediately. Everyone else: staged as a pending
// request - nothing in brm/article changes until a manager approves it.
router.post('/', async (req, res) => {
  const shapeError = validateShape(req.body);
  if (shapeError) return res.status(400).json({ error: shapeError });

  const pool = await getPool();

  if (isManager(req.user.fonction)) {
    try {
      const idBrm = await commitBrm(pool, req.body, req.user.id);
      res.status(201).json({ id_brm: idBrm, pending: false });
    } catch (err) {
      console.error('brm error:', err);
      res.status(400).json({ error: err.message || 'Failed to record return' });
    }
    return;
  }

  try {
    const appPool = await getAppPool();
    const result = await appPool
      .request()
      .input('kind', sql.NVarChar, 'brm')
      .input('id_requester', sql.Int, req.user.id)
      .input('payload', sql.NVarChar, JSON.stringify(req.body))
      .query(
        `insert into app_pending_request (kind, id_requester, payload)
         values (@kind, @id_requester, @payload)
         select cast(scope_identity() as int) as id`
      );
    const idPending = result.recordset[0].id;

    notifyRoles(MANAGER_ROLES, {
      type: 'brm_created',
      idRef: idPending,
      title: 'Nouveau retour à valider',
      body: `${req.user.login} a demandé un retour magasin, en attente de validation.`
    }).catch((err) => console.error('notifyRoles (brm_created) failed:', err));

    res.status(201).json({ id_pending: idPending, pending: true });
  } catch (err) {
    console.error('brm pending create error:', err);
    res.status(500).json({ error: 'Server error staging the request' });
  }
});

// Pending BRM requests awaiting approval (managers only).
router.get('/pending', requireRole(MANAGER_ROLES), async (_req, res) => {
  try {
    const pool = await getPool();
    const appPool = await getAppPool();
    const result = await appPool
      .request()
      .input('kind', sql.NVarChar, 'brm')
      .query(`
        select id, id_requester, payload, created_at
        from app_pending_request
        where kind = @kind and status = 'pending'
        order by id desc
      `);

    // Requester logins come from the original database's utilisateur table
    // (the two databases are never joined in SQL).
    const logins = await loginsByIds(result.recordset.map((r) => r.id_requester));

    const rows = [];
    for (const row of result.recordset) {
      const payload = JSON.parse(row.payload);
      const articleIds = (payload.lines || []).map((l) => l.id_article);
      let articleNames = {};
      if (articleIds.length > 0) {
        const req2 = pool.request();
        articleIds.forEach((id, i) => req2.input(`a${i}`, sql.Int, id));
        const artResult = await req2.query(`select id, designation from article where id in (${articleIds.map((_, i) => `@a${i}`).join(',')})`);
        articleNames = Object.fromEntries(artResult.recordset.map((a) => [a.id, a.designation]));
      }
      rows.push({
        id: row.id,
        created_at: row.created_at,
        requester: logins[row.id_requester],
        type_stock: payload.type_stock,
        type_retour: payload.type_retour,
        type_retour_label: RETURN_REASONS[payload.type_retour],
        n_bsm: payload.n_bsm,
        lines: (payload.lines || []).map((l) => ({ ...l, designation: articleNames[l.id_article] }))
      });
    }
    res.json(rows);
  } catch (err) {
    console.error('brm pending error:', err);
    res.status(500).json({ error: 'Server error fetching pending BRM requests' });
  }
});

router.post('/pending/:id/approve', requireRole(MANAGER_ROLES), async (req, res) => {
  const idPending = Number(req.params.id);
  let appPool = null;
  let claimed = false;
  let idBrm = null;

  try {
    const pool = await getPool();
    appPool = await getAppPool();

    const pendingResult = await appPool
      .request()
      .input('id', sql.Int, idPending)
      .input('kind', sql.NVarChar, 'brm')
      .query("select id, id_requester, payload, status from app_pending_request where id = @id and kind = @kind");
    const pending = pendingResult.recordset[0];
    if (!pending) return res.status(404).json({ error: 'Demande introuvable' });
    if (pending.status !== 'pending') return res.status(409).json({ error: 'Cette demande a déjà été traitée' });

    // The request lives in the app database and the real BRM is created in
    // the GMAO database, so the two writes can't share one transaction.
    // Claim the request first (atomic: only one manager can win), so two
    // managers tapping "Valider" at once can't both return the stock.
    const claim = await appPool
      .request()
      .input('id', sql.Int, idPending)
      .query("update app_pending_request set status = 'approving' where id = @id and status = 'pending'");
    if (claim.rowsAffected[0] !== 1) return res.status(409).json({ error: 'Cette demande a déjà été traitée' });
    claimed = true;

    const payload = JSON.parse(pending.payload);
    idBrm = await commitBrm(pool, payload, pending.id_requester);

    // From here on the real BRM exists in GMAO - the request must never go
    // back to 'pending' (that would let it be applied a second time).
    await appPool
      .request()
      .input('id', sql.Int, idPending)
      .input('id_result', sql.Int, idBrm)
      .input('resolved_by', sql.Int, req.user.id)
      .query("update app_pending_request set status = 'approved', id_result = @id_result, resolved_by = @resolved_by, resolved_at = getdate() where id = @id");

    notifyRoles(MANAGER_ROLES, {
      type: 'brm_validated',
      idRef: idBrm,
      title: 'Retour validé',
      body: `Le retour magasin (BRM #${idBrm}) a été validé par ${req.user.login}.`
    }).catch((err) => console.error('notifyRoles (brm_validated) failed:', err));

    if (pending.id_requester !== req.user.id) {
      notifyUsers([pending.id_requester], {
        type: 'brm_validated',
        idRef: idBrm,
        title: 'Votre retour a été validé',
        body: `Votre demande de retour magasin a été validée par ${req.user.login}.`
      }).catch((err) => console.error('notifyUsers (brm_validated, requester) failed:', err));
    }

    res.json({ ok: true, id_brm: idBrm });
  } catch (err) {
    console.error('brm approve error:', err);

    if (idBrm != null) {
      // The BRM was created but recording that on the request failed. Leave
      // the request as 'approving' so it can't be applied twice.
      console.error(`brm approve: BRM #${idBrm} created but request #${idPending} could not be marked approved - fix app_pending_request manually.`);
      return res.status(500).json({ error: `Le retour a été créé (BRM #${idBrm}) mais la demande n'a pas pu être mise à jour.` });
    }

    if (claimed) {
      // Nothing was written to GMAO - hand the request back so it shows up
      // in the pending list again.
      try {
        await appPool
          .request()
          .input('id', sql.Int, idPending)
          .query("update app_pending_request set status = 'pending' where id = @id and status = 'approving'");
      } catch (releaseErr) {
        console.error('brm approve: could not release request back to pending:', releaseErr);
      }
    }
    res.status(400).json({ error: err.message || 'Server error approving the request' });
  }
});

router.post('/pending/:id/reject', requireRole(MANAGER_ROLES), async (req, res) => {
  const idPending = Number(req.params.id);
  const { reason } = req.body || {};

  try {
    const appPool = await getAppPool();
    const pendingResult = await appPool
      .request()
      .input('id', sql.Int, idPending)
      .input('kind', sql.NVarChar, 'brm')
      .query("select id, id_requester, status from app_pending_request where id = @id and kind = @kind");
    const pending = pendingResult.recordset[0];
    if (!pending) return res.status(404).json({ error: 'Demande introuvable' });
    if (pending.status !== 'pending') return res.status(409).json({ error: 'Cette demande a déjà été traitée' });

    // Only reject if it's still pending - an approval in progress wins.
    const rejected = await appPool
      .request()
      .input('id', sql.Int, idPending)
      .input('resolved_by', sql.Int, req.user.id)
      .input('reason', sql.NVarChar, reason || null)
      .query("update app_pending_request set status = 'rejected', resolved_by = @resolved_by, resolved_at = getdate(), reason = @reason where id = @id and status = 'pending'");
    if (rejected.rowsAffected[0] !== 1) return res.status(409).json({ error: 'Cette demande a déjà été traitée' });

    if (pending.id_requester !== req.user.id) {
      notifyUsers([pending.id_requester], {
        type: 'brm_rejected',
        idRef: idPending,
        title: 'Retour refusé',
        body: `Votre demande de retour magasin a été refusée par ${req.user.login}${reason ? ' : ' + reason : ''}.`
      }).catch((err) => console.error('notifyUsers (brm_rejected) failed:', err));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('brm reject error:', err);
    res.status(500).json({ error: 'Server error rejecting the request' });
  }
});

// Full history of real (already-committed, always validated) BRMs (managers only).
router.get('/history', requireRole(MANAGER_ROLES), async (_req, res) => {
  try {
    const pool = await getPool();
    // brm has no validation column of its own (see top of file); 'Oui' is a
    // constant because this list only shows BRMs that already exist, i.e.
    // were validated (or auto-approved).
    const result = await pool.request().query(`
      select top 100 b.id, b.type_retour, b.type_stock, b.n_bsm, b.date_retour, b.heure_retour, 'Oui' as validation,
             u.login as retour_par
      from brm b
      left join utilisateur u on u.id = b.retour_par
      order by b.id desc
    `);
    const rows = result.recordset;

    // Who approved each one comes from the app database (only BRMs that went
    // through a pending request have an entry; manager-created ones don't).
    const approvals = {};
    if (rows.length > 0) {
      const appPool = await getAppPool();
      const request = appPool.request().input('kind', sql.NVarChar, 'brm');
      rows.forEach((r, i) => request.input(`b${i}`, sql.Int, r.id));
      const approved = await request.query(`
        select id_result, resolved_by
        from app_pending_request
        where kind = @kind and status = 'approved'
          and id_result in (${rows.map((_, i) => `@b${i}`).join(',')})
      `);
      const logins = await loginsByIds(approved.recordset.map((a) => a.resolved_by));
      approved.recordset.forEach((a) => { approvals[a.id_result] = logins[a.resolved_by] || null; });
    }

    res.json(rows.map((r) => ({ ...r, validated_by: approvals[r.id] || null, type_retour_label: RETURN_REASONS[r.type_retour] })));
  } catch (err) {
    console.error('brm history error:', err);
    res.status(500).json({ error: 'Server error fetching BRM history' });
  }
});

router.get('/:id/lines', requireRole(MANAGER_ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('id_brm', sql.Int, Number(req.params.id))
      .query(`
        select a.code_article, a.designation, ba.quantite
        from brm_article ba
        inner join article a on a.id = ba.id_article
        where ba.id_brm = @id_brm
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('brm lines error:', err);
    res.status(500).json({ error: 'Server error fetching BRM lines' });
  }
});

module.exports = router;
module.exports.RETURN_REASONS = RETURN_REASONS;
