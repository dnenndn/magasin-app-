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

// The desktop app stores these exact capitalized French strings in
// bsm.type_stock (confirmed from its source) - matching them keeps app-
// created rows consistent with existing desktop-created ones for any
// reporting/filtering that reads this column.
const STOCK_LABEL = {
  neuf: 'Neuf',
  use: 'Usé',
  rebute: 'Rebuté'
};

function validateShape(body) {
  const { id_receptionniste, type_stock, lines } = body || {};
  if (!id_receptionniste || !STOCK_COLUMN[type_stock] || !Array.isArray(lines) || lines.length === 0) {
    return 'id_receptionniste, a valid type_stock, and at least one line are required';
  }
  return null;
}

// Actually creates the BSM: stock check, insert bsm/bsm_article, decrement
// stock, log the change. Used both for managers (immediately, on POST /)
// and for approving a previously-staged request (POST /pending/:id/approve)
// - in both cases `requesterId` becomes bsm.createur, so the record always
// shows who actually asked for the stock, not who approved it.
async function commitBsm(pool, { id_receptionniste, n_ot, type_stock, id_equipement, lines }, requesterId) {
  const column = STOCK_COLUMN[type_stock];
  const transaction = new sql.Transaction(pool);

  await transaction.begin();
  try {
    // 1. Check every line has enough stock BEFORE writing anything.
    for (const line of lines) {
      const stockCheck = await new sql.Request(transaction)
        .input('i', sql.Int, line.id_article)
        .query(`select ${column} as qty, tva, prix_ht, stock_neuf, stock_use, stock_rebute from article with (updlock, rowlock) where id = @i`);

      const row = stockCheck.recordset[0];
      if (!row) throw new Error(`Article ${line.id_article} not found`);
      if (row.qty < line.quantite) {
        throw new Error(`Not enough stock for article ${line.id_article}: have ${row.qty}, need ${line.quantite}`);
      }
      line._article = row;
    }

    // 2. Create the bsm header. Always validation='Oui' - by the time this
    // function runs, the request has already been approved (or the
    // requester is a manager, auto-approved).
    const now = new Date();
    const bsmResult = await new sql.Request(transaction)
      .input('type_stock', sql.NVarChar, STOCK_LABEL[type_stock])
      .input('bsm_maintenance', sql.NVarChar, id_equipement ? 'Oui' : 'Non')
      .input('id_receptionniste', sql.Int, id_receptionniste)
      .input('n_ot', sql.NVarChar, n_ot || null)
      .input('createur', sql.Int, requesterId)
      .input('date_bsm', sql.Date, now)
      .input('heure_bsm', sql.NVarChar, now.toTimeString().slice(0, 8))
      .input('validation', sql.NVarChar, 'Oui')
      .query(
        `insert into bsm (type_stock, bsm_maintenance, id_receptionniste, n_ot, createur, date_bsm, heure_bsm, validation)
         values (@type_stock, @bsm_maintenance, @id_receptionniste, @n_ot, @createur, @date_bsm, @heure_bsm, @validation)
         select cast(scope_identity() as int) as id`
      );
    const idBsm = bsmResult.recordset[0].id;

    if (id_equipement) {
      await new sql.Request(transaction)
        .input('id_bsm', sql.Int, idBsm)
        .input('id_equipement', sql.Int, id_equipement)
        .query('insert into bsm_equipement (id_bsm, id_equipement) values (@id_bsm, @id_equipement)');
    }

    // 3. Insert each line, decrement stock, log the change.
    for (const line of lines) {
      const art = line._article;

      await new sql.Request(transaction)
        .input('id_bsm', sql.Int, idBsm)
        .input('id_article', sql.Int, line.id_article)
        .input('quantite', sql.Decimal(18, 3), line.quantite)
        .input('prix_ht', sql.Decimal(18, 3), art.prix_ht)
        .query(
          `insert into bsm_article (id_bsm, id_article, quantite, prix_ht)
           values (@id_bsm, @id_article, @quantite, @prix_ht)`
        );

      await new sql.Request(transaction)
        .input('v', sql.Decimal(18, 3), line.quantite)
        .input('i', sql.Int, line.id_article)
        .query(`update article set ${column} = ${column} - @v where id = @i`);

      const newStock = { ...art, [column]: art[column] - line.quantite };
      await new sql.Request(transaction)
        .input('id_article', sql.Int, line.id_article)
        .input('tva', sql.Decimal(18, 3), art.tva)
        .input('prix_ht', sql.Decimal(18, 3), art.prix_ht)
        .input('stock_neuf', sql.Decimal(18, 3), newStock.stock_neuf)
        .input('stock_use', sql.Decimal(18, 3), newStock.stock_use)
        .input('stock_rebute', sql.Decimal(18, 3), newStock.stock_rebute)
        .input('date_modification', sql.DateTime, now)
        .query(
          `insert into modification_article (id_article, tva, prix_ht, stock_neuf, stock_use, stock_rebute, date_modification)
           values (@id_article, @tva, @prix_ht, @stock_neuf, @stock_use, @stock_rebute, @date_modification)`
        );
    }

    await transaction.commit();
    return idBsm;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error('commitBsm - rollback also failed:', rollbackErr);
    }
    throw err;
  }
}

// Issue stock to a work order / intervenor.
// Managers: committed immediately, real BSM created right away.
// Everyone else: staged as a pending request - nothing in bsm/article
// changes until a manager approves it.
router.post('/', async (req, res) => {
  const shapeError = validateShape(req.body);
  if (shapeError) return res.status(400).json({ error: shapeError });

  const pool = await getPool();

  if (isManager(req.user.fonction)) {
    try {
      const idBsm = await commitBsm(pool, req.body, req.user.id);
      res.status(201).json({ id_bsm: idBsm, pending: false });
    } catch (err) {
      console.error('bsm error:', err);
      res.status(400).json({ error: err.message || 'Failed to issue stock' });
    }
    return;
  }

  try {
    const result = await pool
      .request()
      .input('kind', sql.NVarChar, 'bsm')
      .input('id_requester', sql.Int, req.user.id)
      .input('payload', sql.NVarChar, JSON.stringify(req.body))
      .query(
        `insert into app_pending_request (kind, id_requester, payload)
         values (@kind, @id_requester, @payload)
         select cast(scope_identity() as int) as id`
      );
    const idPending = result.recordset[0].id;

    notifyRoles(MANAGER_ROLES, {
      type: 'bsm_created',
      idRef: idPending,
      title: 'Nouvelle sortie à valider',
      body: `${req.user.login} a demandé une sortie de stock, en attente de validation.`
    }).catch((err) => console.error('notifyRoles (bsm_created) failed:', err));

    res.status(201).json({ id_pending: idPending, pending: true });
  } catch (err) {
    console.error('bsm pending create error:', err);
    res.status(500).json({ error: 'Server error staging the request' });
  }
});

// Pending BSM requests awaiting approval (managers only).
router.get('/pending', requireRole(MANAGER_ROLES), async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('kind', sql.NVarChar, 'bsm')
      .query(`
        select p.id, p.payload, p.created_at, u.login as requester
        from app_pending_request p
        left join utilisateur u on u.id = p.id_requester
        where p.kind = @kind and p.status = 'pending'
        order by p.id desc
      `);

    // Hydrate readable names (receptionniste, article designations) from
    // the stored JSON payload's ids, so the app doesn't show raw numbers.
    const rows = [];
    for (const row of result.recordset) {
      const payload = JSON.parse(row.payload);
      const intervenantResult = payload.id_receptionniste
        ? await pool.request().input('i', sql.Int, payload.id_receptionniste).query('select nom from intervenant where id = @i')
        : { recordset: [] };
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
        n_ot: payload.n_ot,
        receptionniste: intervenantResult.recordset[0]?.nom,
        lines: (payload.lines || []).map((l) => ({ ...l, designation: articleNames[l.id_article] }))
      });
    }
    res.json(rows);
  } catch (err) {
    console.error('bsm pending error:', err);
    res.status(500).json({ error: 'Server error fetching pending BSM requests' });
  }
});

router.post('/pending/:id/approve', requireRole(MANAGER_ROLES), async (req, res) => {
  const idPending = Number(req.params.id);
  const pool = await getPool();

  try {
    const pendingResult = await pool
      .request()
      .input('id', sql.Int, idPending)
      .input('kind', sql.NVarChar, 'bsm')
      .query("select id, id_requester, payload, status from app_pending_request where id = @id and kind = @kind");
    const pending = pendingResult.recordset[0];
    if (!pending) return res.status(404).json({ error: 'Demande introuvable' });
    if (pending.status !== 'pending') return res.status(409).json({ error: 'Cette demande a déjà été traitée' });

    const payload = JSON.parse(pending.payload);
    const idBsm = await commitBsm(pool, payload, pending.id_requester);

    await pool
      .request()
      .input('id', sql.Int, idPending)
      .input('id_result', sql.Int, idBsm)
      .input('resolved_by', sql.Int, req.user.id)
      .query("update app_pending_request set status = 'approved', id_result = @id_result, resolved_by = @resolved_by, resolved_at = getdate() where id = @id");

    notifyRoles(MANAGER_ROLES, {
      type: 'bsm_validated',
      idRef: idBsm,
      title: 'Sortie validée',
      body: `La sortie de stock (BSM #${idBsm}) a été validée par ${req.user.login}.`
    }).catch((err) => console.error('notifyRoles (bsm_validated) failed:', err));

    if (pending.id_requester !== req.user.id) {
      notifyUsers([pending.id_requester], {
        type: 'bsm_validated',
        idRef: idBsm,
        title: 'Votre sortie a été validée',
        body: `Votre demande de sortie de stock a été validée par ${req.user.login}.`
      }).catch((err) => console.error('notifyUsers (bsm_validated, requester) failed:', err));
    }

    res.json({ ok: true, id_bsm: idBsm });
  } catch (err) {
    console.error('bsm approve error:', err);
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
      .input('kind', sql.NVarChar, 'bsm')
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
        type: 'bsm_rejected',
        idRef: idPending,
        title: 'Sortie refusée',
        body: `Votre demande de sortie de stock a été refusée par ${req.user.login}${reason ? ' : ' + reason : ''}.`
      }).catch((err) => console.error('notifyUsers (bsm_rejected) failed:', err));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('bsm reject error:', err);
    res.status(500).json({ error: 'Server error rejecting the request' });
  }
});

// Full history of real (already-committed, always validated) BSMs (managers only).
router.get('/history', requireRole(MANAGER_ROLES), async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      select top 100 b.id, b.type_stock, b.n_ot, b.date_bsm, b.heure_bsm, b.validation,
             u.login as createur, i.nom as receptionniste, v.login as validated_by
      from bsm b
      left join utilisateur u on u.id = b.createur
      left join intervenant i on i.id = b.id_receptionniste
      left join app_pending_request p on p.kind = 'bsm' and p.id_result = b.id and p.status = 'approved'
      left join utilisateur v on v.id = p.resolved_by
      order by b.id desc
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('bsm history error:', err);
    res.status(500).json({ error: 'Server error fetching BSM history' });
  }
});

router.get('/:id/lines', requireRole(MANAGER_ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('id_bsm', sql.Int, Number(req.params.id))
      .query(`
        select a.code_article, a.designation, ba.quantite
        from bsm_article ba
        inner join article a on a.id = ba.id_article
        where ba.id_bsm = @id_bsm
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('bsm lines error:', err);
    res.status(500).json({ error: 'Server error fetching BSM lines' });
  }
});

// A user's own BSMs, with how much of each line is still returnable (original
// quantity minus whatever's already been returned against it via brm.n_bsm).
// Open to everyone (not just managers) - this is what powers "create a
// return from a previous BSM" in the BRM tab.
router.get('/mine', async (req, res) => {
  try {
    const pool = await getPool();
    const bsmResult = await pool
      .request()
      .input('createur', sql.Int, req.user.id)
      .query(`
        select top 50 id, type_stock, n_ot, date_bsm
        from bsm
        where createur = @createur
        order by id desc
      `);

    const rows = [];
    for (const bsm of bsmResult.recordset) {
      const linesResult = await pool
        .request()
        .input('id_bsm', sql.Int, bsm.id)
        .query(`
          select ba.id_article, a.code_article, a.designation, ba.quantite,
                 isnull((
                   select sum(bra.quantite) from brm_article bra
                   inner join brm br on br.id = bra.id_brm
                   where br.n_bsm = @id_bsm and bra.id_article = ba.id_article
                 ), 0) as deja_retourne
          from bsm_article ba
          inner join article a on a.id = ba.id_article
          where ba.id_bsm = @id_bsm
        `);
      const lines = linesResult.recordset
        .map((l) => ({ ...l, restant: l.quantite - l.deja_retourne }))
        .filter((l) => l.restant > 0);
      if (lines.length > 0) {
        rows.push({ id: bsm.id, type_stock: bsm.type_stock, n_ot: bsm.n_ot, date_bsm: bsm.date_bsm, lines });
      }
    }
    res.json(rows);
  } catch (err) {
    console.error('bsm mine error:', err);
    res.status(500).json({ error: 'Server error fetching your BSMs' });
  }
});

module.exports = router;
