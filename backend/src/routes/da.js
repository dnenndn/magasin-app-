const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { DA_REVIEW_ROLES, canCreateDa, canCreateDaForOthers } = require('../roles');
const { notifyUsers } = require('../push');
const { loginsByIds } = require('../userLookup');

const router = express.Router();
router.use(requireAuth);

// Demande d'achat (DA), created the same way the desktop app does it
// (creer_da.cs): one row in demande_achat with statut 0 / vue 0, one row per
// article in da_article (qt_restant starts equal to qt), and one row per
// linked equipment in da_article_equipement. From there the desktop app's own
// screens take over (confirm, refuse, postpone, send to the administrator,
// close) - nothing else is needed here and no table is added to the GMAO
// database.

const PERIODES = ['Jour', 'Semaine', 'Mois', 'Année'];

// demande_achat.statut codes, from the desktop app's DA screens.
const STATUT_LABEL = {
  0: 'En attente',
  1: 'Confirmée',
  2: 'Refusée',
  3: "Envoyée à l'administrateur",
  4: 'Reportée',
  10: 'Clôturée'
};

const MAX_LINES = 100;
const MAX_MOTIF = 500;

// A problem with what the user sent (as opposed to a server fault): shown to
// them as-is.
class DaError extends Error {}

function inList(request, prefix, values, type = sql.Int) {
  values.forEach((v, i) => request.input(`${prefix}${i}`, type, v));
  return values.map((_, i) => `@${prefix}${i}`).join(',');
}

// Equipment an article is linked to (what the desktop shows in "Liaison
// Equipement"). Deleted equipment is left out, as on the desktop.
async function equipementsFor(pool, idArticle) {
  const result = await pool
    .request()
    .input('i', sql.Int, idArticle)
    .input('d', sql.Bit, false)
    .query(`
      select e.id, e.designation
      from tableau_article_equipement t
      inner join equipement e on t.id_equipement = e.id
      where e.deleted = @d and t.id_article = @i
      order by e.designation
    `);
  return result.recordset;
}

// What the "new DA" screen needs: whether this user may create one, whether
// they may pick another demandeur (and the list to pick from), the period units.
router.get('/options', async (req, res) => {
  try {
    const fonction = req.user.fonction;
    const options = {
      can_create: canCreateDa(fonction),
      can_choose_demandeur: canCreateDaForOthers(fonction),
      periodes: PERIODES,
      me: { id: req.user.id, login: req.user.login },
      demandeurs: []
    };

    if (options.can_choose_demandeur) {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('d', sql.Bit, false)
        .query('select id, login from utilisateur where deleted = @d order by login');
      options.demandeurs = result.recordset.map((u) => ({ id: u.id, login: (u.login || '').trim() }));
    }
    res.json(options);
  } catch (err) {
    console.error('da options error:', err);
    res.status(500).json({ error: 'Server error fetching DA options' });
  }
});

// Equipment linked to an article. If there is any, the desktop forces the user
// to pick at least one; if there is none, it forces a motif instead.
router.get('/articles/:id/equipements', async (req, res) => {
  const idArticle = Number(req.params.id);
  if (!Number.isInteger(idArticle) || idArticle <= 0) return res.status(400).json({ error: 'Article invalide' });

  try {
    const pool = await getPool();
    const equipements = await equipementsFor(pool, idArticle);
    res.json({ requires_equipement: equipements.length > 0, equipements });
  } catch (err) {
    console.error('da article equipements error:', err);
    res.status(500).json({ error: 'Server error fetching equipment' });
  }
});

// body: {
//   delai, periode,                     // e.g. 2, 'Semaine'
//   id_demandeur,                       // optional, only honoured for the roles that may
//   lines: [{ id_article, qt, motif, id_equipements: [..] }]
// }
router.post('/', async (req, res) => {
  const fonction = req.user.fonction;
  if (!canCreateDa(fonction)) {
    return res.status(403).json({ error: "Votre rôle ne peut pas créer de demande d'achat." });
  }

  try {
    const { delai, periode, id_demandeur, lines } = req.body || {};

    const delaiNum = Number(delai);
    if (delai === '' || delai == null || !Number.isFinite(delaiNum) || delaiNum <= 0) {
      throw new DaError('Le délai est obligatoire (un nombre supérieur à 0).');
    }
    if (!PERIODES.includes(periode)) throw new DaError('La période est obligatoire.');
    if (!Array.isArray(lines) || lines.length === 0) throw new DaError('Ajoutez au moins un article.');
    if (lines.length > MAX_LINES) throw new DaError(`Maximum ${MAX_LINES} articles par demande.`);

    // Shape-check every line first (cheap, no database yet).
    const seen = new Set();
    const clean = lines.map((l) => {
      const idArticle = Number(l && l.id_article);
      const qt = Number(l && l.qt);
      if (!Number.isInteger(idArticle) || idArticle <= 0) throw new DaError('Article invalide.');
      if (seen.has(idArticle)) throw new DaError('Le même article est présent deux fois.');
      seen.add(idArticle);
      if (l.qt === '' || l.qt == null || !Number.isFinite(qt) || qt <= 0) {
        throw new DaError('Chaque quantité doit être un nombre supérieur à 0.');
      }
      const motif = l.motif == null ? '' : String(l.motif).trim();
      if (motif.length > MAX_MOTIF) throw new DaError(`Le motif est trop long (${MAX_MOTIF} caractères maximum).`);
      const equipements = Array.isArray(l.id_equipements)
        ? [...new Set(l.id_equipements.map(Number))]
        : [];
      if (equipements.some((e) => !Number.isInteger(e) || e <= 0)) throw new DaError('Équipement invalide.');
      return { id_article: idArticle, qt, motif, equipements };
    });

    const pool = await getPool();

    // Demandeur: the user themself, unless their role may create on behalf of
    // someone else (then it must be an existing, active user).
    let demandeurId = req.user.id;
    if (canCreateDaForOthers(fonction) && id_demandeur != null && Number(id_demandeur) !== req.user.id) {
      const found = await pool
        .request()
        .input('i', sql.Int, Number(id_demandeur))
        .input('d', sql.Bit, false)
        .query('select id from utilisateur where id = @i and deleted = @d');
      if (!found.recordset[0]) throw new DaError('Demandeur introuvable.');
      demandeurId = found.recordset[0].id;
    }

    // Same rules as the desktop: an article linked to equipment needs at
    // least one of them chosen; an article with no equipment needs a motif.
    for (const line of clean) {
      const art = await pool
        .request()
        .input('i', sql.Int, line.id_article)
        .input('d', sql.Bit, false)
        .query('select designation from article where id = @i and deleted = @d');
      if (!art.recordset[0]) throw new DaError(`Article ${line.id_article} introuvable.`);
      const name = art.recordset[0].designation;

      const allowed = (await equipementsFor(pool, line.id_article)).map((e) => e.id);
      if (allowed.length > 0) {
        if (line.equipements.length === 0) throw new DaError(`Choisissez au moins un équipement pour « ${name} ».`);
        if (line.equipements.some((e) => !allowed.includes(e))) {
          throw new DaError(`Un équipement choisi n'est pas lié à « ${name} ».`);
        }
      } else {
        if (!line.motif) throw new DaError(`Le motif est obligatoire pour « ${name} ».`);
        line.equipements = [];
      }
    }

    const now = new Date();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    let idDa;
    try {
      const header = await new sql.Request(transaction)
        .input('date_da', sql.Date, now)
        .input('heure_da', sql.NVarChar, now.toTimeString().slice(0, 5))
        .input('delai', sql.Real, delaiNum)
        .input('periode', sql.NVarChar, periode)
        .input('createur', sql.Int, req.user.id)
        .input('demandeur', sql.Int, demandeurId)
        .query(
          `insert into demande_achat (date_da, heure_da, delai, periode, createur, demandeur, statut, vue)
           values (@date_da, @heure_da, @delai, @periode, @createur, @demandeur, 0, 0)
           select cast(scope_identity() as int) as id`
        );
      idDa = header.recordset[0].id;

      for (const line of clean) {
        const row = await new sql.Request(transaction)
          .input('id_da', sql.Int, idDa)
          .input('id_article', sql.Int, line.id_article)
          .input('qt', sql.Real, line.qt)
          .input('motif', sql.NVarChar, line.motif)
          .input('qt_restant', sql.Real, line.qt)
          .query(
            `insert into da_article (id_da, id_article, qt, motif, qt_restant)
             values (@id_da, @id_article, @qt, @motif, @qt_restant)
             select cast(scope_identity() as int) as id`
          );
        const idLis = row.recordset[0].id;

        for (const idEquipement of line.equipements) {
          await new sql.Request(transaction)
            .input('id_da', sql.Int, idDa)
            .input('id_article', sql.Int, line.id_article)
            .input('id_equipement', sql.Int, idEquipement)
            .input('id_lis', sql.Int, idLis)
            .query(
              `insert into da_article_equipement (id_da, id_article, id_equipement, id_lis)
               values (@id_da, @id_article, @id_equipement, @id_lis)`
            );
        }
      }

      await transaction.commit();
    } catch (err) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error('da create - rollback also failed:', rollbackErr);
      }
      throw err;
    }

    notifyReviewers(pool, idDa, req.user, demandeurId).catch((err) => console.error('notify DA reviewers failed:', err));

    res.status(201).json({ id_da: idDa });
  } catch (err) {
    if (err instanceof DaError) return res.status(400).json({ error: err.message });
    console.error('da create error:', err);
    res.status(500).json({ error: "Erreur serveur pendant la création de la demande d'achat." });
  }
});

// Tell the people who review new DAs on the desktop that one is waiting
// (the creator themself is left out).
async function notifyReviewers(pool, idDa, creator, demandeurId) {
  const request = pool.request();
  const placeholders = inList(request, 'r', DA_REVIEW_ROLES, sql.NVarChar);
  const users = await request.query(
    `select id from utilisateur where deleted = 0 and fonction in (${placeholders})`
  );
  const ids = users.recordset.map((u) => u.id).filter((id) => id !== creator.id);
  if (ids.length === 0) return;

  const onBehalf = demandeurId !== creator.id ? ' (pour un autre demandeur)' : '';
  await notifyUsers(ids, {
    type: 'da_created',
    idRef: idDa,
    title: "Nouvelle demande d'achat",
    body: `${creator.login} a créé la demande d'achat #${idDa}${onBehalf}, en attente de confirmation.`
  });
}

// The current user's own DAs (created by them or made for them), newest
// first, with their lines and the desktop-side status.
router.get('/mine', async (req, res) => {
  try {
    const pool = await getPool();
    const das = await pool
      .request()
      .input('u', sql.Int, req.user.id)
      .query(`
        select top 30 id, date_da, heure_da, delai, periode, createur, demandeur, statut
        from demande_achat
        where createur = @u or demandeur = @u
        order by id desc
      `);
    const rows = das.recordset;
    if (rows.length === 0) return res.json([]);

    const ids = rows.map((r) => r.id);

    const linesRequest = pool.request();
    const linesResult = await linesRequest.query(`
      select da.id_da, a.code_article, a.designation, da.qt, da.motif
      from da_article da
      inner join article a on a.id = da.id_article
      where da.id_da in (${inList(linesRequest, 'd', ids)})
      order by da.id
    `);
    const linesByDa = {};
    linesResult.recordset.forEach((l) => {
      (linesByDa[l.id_da] = linesByDa[l.id_da] || []).push({
        code_article: l.code_article,
        designation: l.designation,
        qt: l.qt,
        motif: l.motif
      });
    });

    // Why a DA was refused (the desktop stores it in da_refuser.cause; if it
    // was refused more than once, the latest one wins).
    const causeByDa = {};
    const refusedIds = rows.filter((r) => r.statut === 2).map((r) => r.id);
    if (refusedIds.length > 0) {
      const refusedRequest = pool.request();
      const refused = await refusedRequest.query(`
        select id_da, cause from da_refuser
        where id_da in (${inList(refusedRequest, 'f', refusedIds)})
        order by date_refus, heure_refus
      `);
      refused.recordset.forEach((r) => { causeByDa[r.id_da] = r.cause; });
    }

    const logins = await loginsByIds(rows.flatMap((r) => [r.createur, r.demandeur]));

    res.json(rows.map((r) => ({
      id: r.id,
      date_da: r.date_da,
      heure_da: r.heure_da,
      delai: r.delai,
      periode: r.periode,
      statut: r.statut,
      statut_label: STATUT_LABEL[r.statut] || `Statut ${r.statut}`,
      createur: logins[r.createur] || null,
      demandeur: logins[r.demandeur] || null,
      cause: causeByDa[r.id] || null,
      lines: linesByDa[r.id] || []
    })));
  } catch (err) {
    console.error('da mine error:', err);
    res.status(500).json({ error: "Server error fetching your purchase requests" });
  }
});

module.exports = router;
