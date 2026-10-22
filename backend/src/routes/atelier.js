const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { canWriteAtelier } = require('../roles');

// Atelier work orders (OF = ordres de fabrication) - "solder" an OF.
//
// Mirrors the desktop app's reception screen (atelier_list_reception.cs):
//  - receiving quantity q on an OF adds one row to atelier_reception, adds q
//    to article.stock_neuf, and sets atelier_creer.etat to
//      "Soldé"                when everything ordered has now been received,
//      "Partiellement Soldé"  when only part of it has;
//  - the total received can never exceed atelier_creer.quantite;
//  - deleting a reception takes the quantity back out of stock and recomputes
//    the état (back to the last état in atelier_etat when no reception is left).
// Unlike the desktop, every change here runs in ONE transaction with the OF
// row locked, so two people receiving at once cannot both pass the quantity
// check, and a failure half-way leaves nothing behind.
// No table or column is added to the GMAO database.

const router = express.Router();
router.use(requireAuth);

const SOLDE = 'Soldé';
const PARTIEL = 'Partiellement Soldé';
const EPS = 1e-4; // quantities are SQL "real" (float32): never compare with ===

class OfError extends Error {}

function requireWrite(req, res, next) {
  if (!canWriteAtelier(req.user?.fonction)) {
    return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
  }
  next();
}

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function round(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 'YYYY-MM-DD', a real calendar date, not in the future (a typo like 2062
// would otherwise sit in the reception reports forever).
function parseDate(v) {
  if (v === undefined || v === null || v === '') return todayIso();
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new OfError('Date invalide.');
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new OfError('Date invalide.');
  if (s > todayIso()) throw new OfError('La date de réception ne peut pas être dans le futur.');
  return s;
}

const OF_SELECT = `
  select a.id, a.n_of, isnull(a.etat, '') as etat, a.date_consultation, a.date_prevu,
         a.quantite, isnull(r.recu, 0) as qt_recue,
         art.code_article, art.designation
  from atelier_creer a
  left join article art on art.id = a.id_article
  outer apply (select sum(qt_recu) as recu from atelier_reception where id_atelier = a.id) r
`;

function shapeOf(r) {
  const quantite = Number(r.quantite) || 0;
  const recue = Number(r.qt_recue) || 0;
  return {
    id: r.id,
    n_of: r.n_of,
    etat: r.etat,
    date_consultation: r.date_consultation,
    date_prevu: r.date_prevu,
    code_article: r.code_article,
    designation: r.designation,
    quantite,
    qt_recue: round(recue),
    reste: Math.max(0, round(quantite - recue))
  };
}

// GET /of?statut=open|solde&search=
//   open  = every OF whose état is not "Soldé" (partially received ones stay here)
//   solde = OFs already fully received
router.get('/of', async (req, res) => {
  const solde = req.query.statut === 'solde';
  const search = String(req.query.search || '').trim().slice(0, 60);
  try {
    const pool = await getPool();
    const request = pool.request().input('s', sql.NVarChar, SOLDE);
    let where = solde ? "where isnull(a.etat, '') = @s" : "where isnull(a.etat, '') <> @s";
    if (search) {
      request.input('q', sql.NVarChar, `%${search}%`);
      where += ' and (cast(a.n_of as nvarchar(50)) like @q or art.code_article like @q or art.designation like @q)';
    }
    const result = await request.query(`
      select top 100 * from (${OF_SELECT} ${where}) t
      order by date_consultation desc, id desc
    `);
    res.json(result.recordset.map(shapeOf));
  } catch (err) {
    console.error('atelier list error:', err);
    res.status(500).json({ error: 'Server error fetching OF' });
  }
});

async function loadOf(runner, id) {
  const r = await runner.request().input('i', sql.Int, id).query(`${OF_SELECT} where a.id = @i`);
  return r.recordset[0] ? shapeOf(r.recordset[0]) : null;
}

// GET /of/:id  -> the OF and its receptions
router.get('/of/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'OF invalide.' });
  try {
    const pool = await getPool();
    const of = await loadOf(pool, id);
    if (!of) return res.status(404).json({ error: 'OF introuvable.' });
    const rec = await pool.request().input('i', sql.Int, id)
      .query('select id, date_reception, qt_recu, etat from atelier_reception where id_atelier = @i order by id');
    res.json({ ...of, receptions: rec.recordset, can_write: canWriteAtelier(req.user.fonction) });
  } catch (err) {
    console.error('atelier detail error:', err);
    res.status(500).json({ error: 'Server error fetching OF' });
  }
});

async function rollbackQuietly(tx) {
  try { await tx.rollback(); } catch (e) { console.error('atelier - rollback also failed:', e); }
}

// POST /of/:id/receptions  { qt, date? }
router.post('/of/:id/receptions', requireWrite, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'OF invalide.' });
  const qt = Number(req.body?.qt);
  if (!Number.isFinite(qt) || qt <= 0) return res.status(400).json({ error: 'La quantité doit être un nombre supérieur à 0.' });

  let date;
  try { date = parseDate(req.body?.date); } catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      // Lock the OF so concurrent receptions are checked one after the other.
      const row = await new sql.Request(tx).input('i', sql.Int, id)
        .query('select quantite, id_article from atelier_creer with (updlock, rowlock) where id = @i');
      if (row.recordset.length === 0) throw new OfError('OF introuvable.');
      const quantite = Number(row.recordset[0].quantite) || 0;
      const idArticle = row.recordset[0].id_article;
      if (!idArticle) throw new OfError("Cet OF n'a pas d'article : réception impossible.");

      const sum = await new sql.Request(tx).input('i', sql.Int, id)
        .query('select isnull(sum(qt_recu), 0) as recu from atelier_reception where id_atelier = @i');
      const dejaRecu = Number(sum.recordset[0].recu) || 0;
      const total = dejaRecu + qt;

      if (total > quantite + EPS) {
        throw new OfError(`Quantité trop grande : il reste ${round(Math.max(0, quantite - dejaRecu))} à recevoir (quantité de l'OF : ${quantite}).`);
      }
      const etat = Math.abs(quantite - total) <= EPS ? SOLDE : PARTIEL;

      await new sql.Request(tx)
        .input('i', sql.Int, id).input('d', sql.Date, date).input('q', sql.Real, qt).input('e', sql.NVarChar, etat)
        .query('insert into atelier_reception (id_atelier, date_reception, qt_recu, etat) values (@i, @d, @q, @e)');
      const stock = await new sql.Request(tx).input('a', sql.Int, idArticle).input('q', sql.Real, qt)
        .query('update article set stock_neuf = isnull(stock_neuf, 0) + @q where id = @a');
      if (stock.rowsAffected[0] !== 1) throw new OfError('Article introuvable : stock non mis à jour.');
      await new sql.Request(tx).input('i', sql.Int, id).input('e', sql.NVarChar, etat)
        .query('update atelier_creer set etat = @e where id = @i');

      await tx.commit();
      const of = await loadOf(pool, id);
      res.status(201).json({ ok: true, etat, of });
    } catch (err) {
      await rollbackQuietly(tx);
      throw err;
    }
  } catch (err) {
    if (err instanceof OfError) return res.status(400).json({ error: err.message });
    console.error('atelier receive error:', err);
    res.status(500).json({ error: 'Server error saving the reception' });
  }
});

// DELETE /of/:id/receptions/:rid  - undo one reception
router.delete('/of/:id/receptions/:rid', requireWrite, async (req, res) => {
  const id = parseId(req.params.id);
  const rid = parseId(req.params.rid);
  if (!id || !rid) return res.status(400).json({ error: 'Identifiant invalide.' });

  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const row = await new sql.Request(tx).input('i', sql.Int, id)
        .query('select quantite, id_article from atelier_creer with (updlock, rowlock) where id = @i');
      if (row.recordset.length === 0) throw new OfError('OF introuvable.');
      const quantite = Number(row.recordset[0].quantite) || 0;
      const idArticle = row.recordset[0].id_article;

      const rec = await new sql.Request(tx).input('r', sql.Int, rid).input('i', sql.Int, id)
        .query('select qt_recu from atelier_reception where id = @r and id_atelier = @i');
      if (rec.recordset.length === 0) throw new OfError('Réception introuvable.');
      const qt = Number(rec.recordset[0].qt_recu) || 0;

      // The desktop lets stock go negative here; refuse instead when the
      // received pieces have already been used.
      const st = await new sql.Request(tx).input('a', sql.Int, idArticle)
        .query('select isnull(stock_neuf, 0) as s from article with (updlock, rowlock) where id = @a');
      if (st.recordset.length === 0) throw new OfError('Article introuvable.');
      if ((Number(st.recordset[0].s) || 0) + EPS < qt) {
        throw new OfError(`Annulation impossible : le stock neuf (${round(st.recordset[0].s)}) est inférieur à la quantité reçue (${round(qt)}).`);
      }

      await new sql.Request(tx).input('r', sql.Int, rid).query('delete from atelier_reception where id = @r');
      await new sql.Request(tx).input('a', sql.Int, idArticle).input('q', sql.Real, qt)
        .query('update article set stock_neuf = isnull(stock_neuf, 0) - @q where id = @a');

      const left = await new sql.Request(tx).input('i', sql.Int, id)
        .query('select isnull(sum(qt_recu), 0) as recu, count(*) as n from atelier_reception where id_atelier = @i');
      const restant = Number(left.recordset[0].recu) || 0;
      const n = left.recordset[0].n;

      let etat;
      if (n === 0) {
        // Nothing received any more: back to the last état the OF had.
        const last = await new sql.Request(tx).input('i', sql.Int, id)
          .query('select top 1 etat from atelier_etat where id_atelier = @i order by id desc');
        etat = last.recordset[0]?.etat || 'En Attente';
      } else {
        etat = Math.abs(quantite - restant) <= EPS ? SOLDE : PARTIEL;
        // The reports count an OF as "Soldé" from the reception row's état.
        await new sql.Request(tx).input('i', sql.Int, id).input('e', sql.NVarChar, PARTIEL)
          .query('update atelier_reception set etat = @e where id_atelier = @i');
      }
      await new sql.Request(tx).input('i', sql.Int, id).input('e', sql.NVarChar, etat)
        .query('update atelier_creer set etat = @e where id = @i');

      await tx.commit();
      const of = await loadOf(pool, id);
      res.json({ ok: true, etat, of });
    } catch (err) {
      await rollbackQuietly(tx);
      throw err;
    }
  } catch (err) {
    if (err instanceof OfError) return res.status(400).json({ error: err.message });
    console.error('atelier undo error:', err);
    res.status(500).json({ error: 'Server error cancelling the reception' });
  }
});

module.exports = router;
