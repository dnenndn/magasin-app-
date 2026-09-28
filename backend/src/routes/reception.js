const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { MANAGER_ROLES, requireRole } = require('../roles');

const router = express.Router();
router.use(requireAuth, requireRole(MANAGER_ROLES));

// Purchase orders still awaiting reception. commande.statut = 1 is the
// desktop app's own "open, awaiting reception" code (confirmed from its
// source); 10 means fully received.
router.get('/commandes/open', async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      select c.id, c.date_commande, c.n_commande, f.nom as fournisseur
      from commande c
      inner join fournisseur f on f.id = c.id_fournisseur
      where c.statut = 1
      order by c.date_commande desc
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('open commandes error:', err);
    res.status(500).json({ error: 'Server error fetching open purchase orders' });
  }
});

// Lines of one purchase order, with ordered vs. already-received quantity.
router.get('/commandes/:id/lines', async (req, res) => {
  const idCommande = Number(req.params.id);

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('h', sql.Int, idCommande)
      .query(`
        select ca.id as id_commande_article, da.id as id_da, a.id as id_article,
               a.code_article, a.designation, ca.qt_commande,
               isnull((select sum(qt_recu) from reception_article ra
                       where ra.id_commande = @h and ra.id_article = a.id), 0) as qt_recu
        from commande_article ca
        inner join da_article da on ca.id_da_article = da.id
        inner join article a on da.id_article = a.id
        where ca.id_commande = @h
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('commande lines error:', err);
    res.status(500).json({ error: 'Server error fetching order lines' });
  }
});

// Receive goods against a purchase order.
// body: {
//   id_commande, commentaire,
//   lines: [{ id_article, id_da, qt_recu, qt_bon_etat, qt_mauvais_etat }]
// }
router.post('/', async (req, res) => {
  const { id_commande, commentaire, lines } = req.body || {};

  if (!id_commande || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'id_commande and at least one line are required' });
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const now = new Date();
    const headerResult = await new sql.Request(transaction)
      .input('date_reception', sql.Date, now)
      .input('heure_reception', sql.NVarChar, now.toTimeString().slice(0, 5))
      .input('reception_par', sql.Int, req.user.id)
      .input('commentaire', sql.NVarChar, commentaire || null)
      .input('statut', sql.Int, 0)
      .input('date_reel', sql.Date, now)
      .query(
        `insert into reception (date_reception, heure_reception, reception_par, commentaire, statut, date_reel)
         values (@date_reception, @heure_reception, @reception_par, @commentaire, @statut, @date_reel)
         select cast(scope_identity() as int) as id`
      );
    const idReception = headerResult.recordset[0].id;

    await new sql.Request(transaction)
      .input('id_reception', sql.Int, idReception)
      .input('id_commande', sql.Int, id_commande)
      .query('insert into reception_commande (id_reception, id_commande) values (@id_reception, @id_commande)');

    for (const line of lines) {
      const qtRecu = Number(line.qt_recu);
      const qtBon = line.qt_bon_etat != null ? Number(line.qt_bon_etat) : qtRecu;
      const qtMauvais = line.qt_mauvais_etat != null ? Number(line.qt_mauvais_etat) : 0;
      // reception_article.etat is a numeric condition score in the real
      // schema (confirmed from source - it's SqlDbType.Real, not text like
      // 'bon'/'mixte' which I'd wrongly guessed before). Using the
      // percentage of the received quantity that was in good condition.
      const etat = qtRecu > 0 ? Math.round((qtBon / qtRecu) * 100) : 100;

      await new sql.Request(transaction)
        .input('id_reception', sql.Int, idReception)
        .input('id_commande', sql.Int, id_commande)
        .input('id_article', sql.Int, line.id_article)
        .input('qt_recu', sql.Real, qtRecu)
        .input('etat', sql.Real, etat)
        .input('qt_bon_etat', sql.Real, qtBon)
        .input('qt_mauvais_etat', sql.Real, qtMauvais)
        .input('id_da', sql.Int, line.id_da)
        .query(
          `insert into reception_article (id_reception, id_commande, id_article, qt_recu, etat, qt_bon_etat, qt_mauvais_etat, id_da)
           values (@id_reception, @id_commande, @id_article, @qt_recu, @etat, @qt_bon_etat, @qt_mauvais_etat, @id_da)`
        );

      // Only the good-condition quantity goes into usable stock.
      const qtyIn = qtBon;

      await new sql.Request(transaction)
        .input('a', sql.Real, qtyIn)
        .input('i', sql.Int, line.id_article)
        .query('update article set stock_neuf = stock_neuf + @a where id = @i');

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

    // Mirror the desktop app: once every line of this commande has been
    // fully received (across possibly multiple reception events over time),
    // mark it closed (statut = 10) so it drops off the "open orders" list.
    const remaining = await new sql.Request(transaction)
      .input('id_commande', sql.Int, id_commande)
      .query(`
        select count(*) as remaining
        from commande_article ca
        inner join da_article da on da.id = ca.id_da_article
        where ca.id_commande = @id_commande
          and ca.qt_commande > isnull((
            select sum(ra.qt_recu) from reception_article ra
            where ra.id_commande = @id_commande and ra.id_article = da.id_article
          ), 0)
      `);

    if (remaining.recordset[0].remaining === 0) {
      await new sql.Request(transaction)
        .input('s', sql.Int, 10)
        .input('h', sql.Int, id_commande)
        .query('update commande set statut = @s where id = @h');
    }

    await transaction.commit();
    res.status(201).json({ id_reception: idReception });
  } catch (err) {
    console.error('reception error:', err);
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error('reception error - rollback also failed (transaction was likely already aborted by SQL Server):', rollbackErr);
    }
    res.status(400).json({ error: err.message || 'Failed to record reception' });
  }
});

module.exports = router;
