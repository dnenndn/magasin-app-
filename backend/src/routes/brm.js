const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { MANAGER_ROLES, isManager, requireRole } = require('../roles');
const { notifyRoles, notifyUsers } = require('../push');

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
      .input('heure_retour', sql.NVarChar, now.toTimeString().slice(0, 8))
      .input('validation', sql.NVarChar, 'Oui');

    const headerResult = n_bsm
      ? await request.input('n_bsm', sql.Int, n_bsm).query(
          `insert into brm (type_retour, type_stock, retour_par, date_retour, heure_retour, n_bsm, validation)
           values (@type_retour, @type_stock, @retour_par, @date_retour, @heure_retour, @n_bsm, @validation)
           select cast(scope_identity() as int) as id`
        )
      : await request.query(
          `insert into brm (type_retour, type_stock, retour_par, date_retour, heure_retour, validation)
           values (@type_retour, @type_stock, @retour_par, @date_retour, @heure_retour, @validation)
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
    const result = await pool
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
    const result = await pool
      .request()
      .input('kind', sql.NVarChar, 'brm')
      .query(`
        select p.id, p.payload, p.created_at, u.login as requester
        from app_pending_request p
        left join utilisateur u on u.id = p.id_requester
        where p.kind = @kind and p.status = 'pending'
        order by p.id desc
      `);

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
        requester: row.requester,
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
  const pool = await getPool();

  try {
    const pendingResult = await pool
      .request()
      .input('id', sql.Int, idPending)
      .input('kind', sql.NVarChar, 'brm')
      .query("select id, id_requester, payload, status from app_pending_request where id = @id and kind = @kind");
    const pending = pendingResult.recordset[0];
    if (!pending) return res.status(404).json({ error: 'Demande introuvable' });
    if (pending.status !== 'pending') return res.status(409).json({ error: 'Cette demande a déjà été traitée' });

    const payload = JSON.parse(pending.payload);
    const idBrm = await commitBrm(pool, payload, pending.id_requester);

    await pool
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
    res.status(400).json({ error: err.message || 'Server error approving the request' });
  }
});

router.post('/pending/:id/reject', requireRole(MANAGER_ROLES), async (req, res) => {
  const idPending = Number(req.params.id);
  const { reason } = req.body || {};

  try {
    const pool = await getPool();
    const pendingResult = await pool
      .request()
      .input('id', sql.Int, idPending)
      .input('kind', sql.NVarChar, 'brm')
      .query("select id, id_requester, status from app_pending_request where id = @id and kind = @kind");
    const pending = pendingResult.recordset[0];
    if (!pending) return res.status(404).json({ error: 'Demande introuvable' });
    if (pending.status !== 'pending') return res.status(409).json({ error: 'Cette demande a déjà été traitée' });

    await pool
      .request()
      .input('id', sql.Int, idPending)
      .input('resolved_by', sql.Int, req.user.id)
      .input('reason', sql.NVarChar, reason || null)
      .query("update app_pending_request set status = 'rejected', resolved_by = @resolved_by, resolved_at = getdate(), reason = @reason where id = @id");

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
    const result = await pool.request().query(`
      select top 100 b.id, b.type_retour, b.type_stock, b.n_bsm, b.date_retour, b.heure_retour, b.validation,
             u.login as retour_par, v.login as validated_by
      from brm b
      left join utilisateur u on u.id = b.retour_par
      left join app_pending_request p on p.kind = 'brm' and p.id_result = b.id and p.status = 'approved'
      left join utilisateur v on v.id = p.resolved_by
      order by b.id desc
    `);
    res.json(result.recordset.map((r) => ({ ...r, type_retour_label: RETURN_REASONS[r.type_retour] })));
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
