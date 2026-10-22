const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { canWriteProduction } = require('../roles');

// Production reports ("rapports de production"), filled from the phone.
//
// Mirrors the desktop screens prod_rapport*.cs, table for table:
//  - a report is one (date, poste in Jour/Soir/Nuit); creating it pre-creates
//    the empty rows every section needs (prod_rapport.cs "Ajouter");
//  - sections: Fabrication (produits + horaire + qualité + chef d'équipe),
//    Four (entrée, sortie, champs), Préparation (qualité, A/S, général),
//    Fuel, Emballage (produits + chef d'équipe), and anomalies (arrêts);
//  - the tonnage maths (wagon weights, hourly average weight, x1.1, the
//    equipement_compteur update + history) are copied from the desktop,
//    constants included.
// Differences from the desktop, on purpose:
//  - every save runs in ONE transaction, and a row can only be changed through
//    the report and unit it belongs to;
//  - negative quantities are refused where the desktop only checks "is a number";
//  - NOT done here: the preventive work orders the desktop opens when a counter
//    or a measure crosses its threshold (lancement_ot_preventive). They are
//    still raised the next time the counter / measure is saved on the PC.
// No table or column is added to the GMAO database.

const router = express.Router();
router.use(requireAuth);

class ProdError extends Error {}

const POSTES = ['Jour', 'Soir', 'Nuit'];
const EPS_COMPTEUR = 0.01;       // desktop: counters move only when |diff| > 0.01
const TONNAGE_FACTOR = 1.1;      // desktop: fabrication tonnage x 1.1
// prod_fuel.type_saisie -> label (prod_rapport_fuel.cs)
const FUEL_TYPES = [
  [1, 'Séchoir 1'], [4, 'Séchoir 2'], [5, 'Séchoir 3'],
  [2, 'Four 1'], [6, 'Four 2'], [3, 'Total']
];

function requireWrite(req, res, next) {
  if (!canWriteProduction(req.user?.fonction)) {
    return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
  }
  next();
}

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(v, allowFuture = false) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ProdError('Date invalide.');
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new ProdError('Date invalide.');
  if (!allowFuture && s > todayIso()) throw new ProdError('La date du rapport ne peut pas être dans le futur.');
  return s;
}

// A number the way the desktop's fonction.is_reel accepts it (comma allowed),
// or null.
function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(',', '.');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function positiveNumber(v, label) {
  const n = toNumber(v);
  if (n === null || n < 0) throw new ProdError(`${label} : nombre positif attendu.`);
  return n;
}

function anyNumber(v, label) {
  const n = toNumber(v);
  if (n === null) throw new ProdError(`${label} : nombre attendu.`);
  return n;
}

// ---- Desktop constants (ported as they are) -------------------------------

// fonction.tonnage_wagon(designation): tonnes per unit of a product
function tonnageWagon(designation) {
  switch (designation) {
    case 'B12': return 0.00324;
    case 'B8': return 0.00459;
    case 'PLATRIERE': return 0.00594;
    case 'H16': return 0.00237;
    case 'H19': return 0.00198;
    default: return 0.00324;
  }
}

// Default weight (kg) of a fabrication product when no hourly sample exists.
function defaultFabWeight(idProduit) {
  switch (idProduit) {
    case 1: return 7200;
    case 2: return 5100;
    case 3: return 9100;
    case 4: return 11100;
    case 5: return 4200;
    default: return 7200;
  }
}

// prod_rapport_fabrication_produit.avg_poid / calcul_nv_tonnage: the average
// of the weight samples taken at the hours linked to the product; hours whose
// sample is 0 do not count; no usable sample -> the default weight.
function averageWeight(idProduit, hoursOfProduct, sampleByHour) {
  let n = hoursOfProduct.length;
  let sum = 0;
  for (const h of hoursOfProduct) {
    const v = Number(sampleByHour[h - 1]) || 0;
    sum += v;
    if (v === 0) n -= 1;
  }
  return n !== 0 ? sum / n : defaultFabWeight(idProduit);
}

// ---- small SQL helpers ----------------------------------------------------

function req(runner, params) {
  const r = new sql.Request(runner);
  for (const [name, type, value] of params || []) r.input(name, type, value);
  return r;
}

async function run(runner, text, params) {
  return (await req(runner, params).query(text)).recordset;
}

async function rollbackQuietly(tx) {
  try { await tx.rollback(); } catch (e) { console.error('production - rollback also failed:', e); }
}

// Runs fn(tx) in a transaction; ProdError -> 400, anything else -> 500.
async function inTx(res, label, fn) {
  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const out = await fn(tx);
      await tx.commit();
      res.json({ ok: true, ...(out || {}) });
    } catch (err) {
      await rollbackQuietly(tx);
      throw err;
    }
  } catch (err) {
    if (err instanceof ProdError) return res.status(400).json({ error: err.message });
    console.error(`production ${label} error:`, err);
    res.status(500).json({ error: 'Server error saving the report' });
  }
}

async function lockReport(tx, idRapport) {
  const r = await run(tx, 'select id from prod_rapport_general with (updlock, rowlock) where id = @r', [['r', sql.Int, idRapport]]);
  if (r.length === 0) throw new ProdError('Rapport introuvable.');
}

// ---- Reports: list / create / delete --------------------------------------

// GET /reports?from=&to=   (default: the last 31 days)
router.get('/reports', async (req_, res) => {
  try {
    const to = req_.query.to ? parseDate(req_.query.to, true) : todayIso();
    const fromDefault = new Date(); fromDefault.setDate(fromDefault.getDate() - 31);
    const from = req_.query.from ? parseDate(req_.query.from, true)
      : `${fromDefault.getFullYear()}-${String(fromDefault.getMonth() + 1).padStart(2, '0')}-${String(fromDefault.getDate()).padStart(2, '0')}`;
    const pool = await getPool();
    const rows = await run(pool, `
      select id, convert(varchar(10), date_rapport, 23) as date_rapport, poste
      from prod_rapport_general
      where date_rapport between cast(@a as date) and cast(@b as date)
      order by date_rapport desc, case poste when 'Jour' then 1 when 'Soir' then 2 else 3 end`,
    [['a', sql.VarChar, from], ['b', sql.VarChar, to]]);
    res.json({ reports: rows, can_write: canWriteProduction(req_.user.fonction) });
  } catch (err) {
    if (err instanceof ProdError) return res.status(400).json({ error: err.message });
    console.error('production list error:', err);
    res.status(500).json({ error: 'Server error fetching reports' });
  }
});

// Empty rows of every section (prod_rapport.cs insert_* methods).
async function createSkeleton(tx, r) {
  const p = [['r', sql.Int, r]];
  const stmts = [
    // fabrication: unit x product
    `insert into prod_rapport_fab_produit (id_rapport, id_unite, id_produit, quantite, tonnage)
       select @r, e.id_equipement, b.id, 0, 0 from prod_equipement e cross join prod_type_brique b where e.unite_production = 'Fabrication'`,
    // emballage: unit x product
    `insert into prod_rapport_emb_produit (id_rapport, id_unite, id_produit, quantite)
       select @r, e.id_equipement, b.id, 0 from prod_equipement e cross join prod_type_brique b where e.unite_production = 'Emballage'`,
    // four: unit x product, entrée and sortie
    `insert into prod_rapport_four_entre (id_rapport, id_unite, id_produit, quantite, tonnage)
       select @r, e.id_equipement, b.id, 0, 0 from prod_equipement e cross join prod_type_brique b where e.unite_production = 'Four'`,
    `insert into prod_rapport_four_sortie (id_rapport, id_unite, id_produit, quantite, tonnage)
       select @r, e.id_equipement, b.id, 0, 0 from prod_equipement e cross join prod_type_brique b where e.unite_production = 'Four'`,
    // measurements: unit x active definition of the right target
    `insert into prod_rapport_four_qualite (id_rapport, id_unite, id_qualite, valeur)
       select @r, e.id_equipement, s.id, 0 from prod_equipement e cross join prod_saisie s
       where e.unite_production = 'Four' and s.cible = 3 and s.deleted = 0`,
    `insert into prod_rapport_fabrication_qualite (id_rapport, id_unite, id_qualite, valeur)
       select @r, e.id_equipement, s.id, 0 from prod_equipement e cross join prod_saisie s
       where e.unite_production = 'Fabrication' and s.cible = 2 and s.deleted = 0`,
    `insert into prod_rapport_horaire_fabrication (id_rapport, id_unite, id_qualite, h1, h2, h3, h4, h5, h6, h7, h8)
       select @r, e.id_equipement, s.id, 0, 0, 0, 0, 0, 0, 0, 0 from prod_equipement e cross join prod_saisie s
       where e.unite_production = 'Fabrication' and s.cible = 1 and s.deleted = 0`,
    `insert into prod_fab_tonnage (id_rapport, id_unite, valeur)
       select @r, e.id_equipement, 0 from prod_equipement e where e.unite_production = 'Fabrication'`,
    // préparation: preparation_produit 3 -> A/S pair, 0 -> single value
    `insert into prod_rapport_prep_as (id_rapport, id_unite, id_qualite, valeur_a, valeur_s)
       select @r, e.id_equipement, s.id, 0, 0 from prod_equipement e cross join prod_saisie s
       where e.unite_production = 'Préparation' and s.cible = 5 and s.deleted = 0 and s.preparation_produit = 3`,
    `insert into prod_rapport_prep_qualite (id_rapport, id_unite, id_qualite, valeur)
       select @r, e.id_equipement, s.id, 0 from prod_equipement e cross join prod_saisie s
       where e.unite_production = 'Préparation' and s.cible = 5 and s.deleted = 0 and s.preparation_produit = 0`,
    `insert into prod_rapport_prep_general (id_rapport, id_qualite, valeur)
       select @r, s.id, 0 from prod_saisie s where s.cible = 4 and s.deleted = 0`
  ];
  for (const text of stmts) await req(tx, p).query(text);
}

// POST /reports  { date: 'YYYY-MM-DD', poste: 'Jour'|'Soir'|'Nuit' }
router.post('/reports', requireWrite, async (req_, res) => {
  let date; const poste = String(req_.body?.poste || '');
  try {
    if (!POSTES.includes(poste)) throw new ProdError('Choisir le poste (Jour, Soir ou Nuit).');
    date = parseDate(req_.body?.date);
  } catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const dup = await run(tx, 'select id from prod_rapport_general with (updlock, holdlock) where date_rapport = cast(@d as date) and poste = @p',
        [['d', sql.VarChar, date], ['p', sql.VarChar, poste]]);
      if (dup.length) throw new ProdError('Rapport déjà ajouté pour cette date et ce poste.');
      const ins = await run(tx, 'insert into prod_rapport_general (date_rapport, poste) values (cast(@d as date), @p); select cast(scope_identity() as int) as id',
        [['d', sql.VarChar, date], ['p', sql.VarChar, poste]]);
      const id = ins[0].id;
      await createSkeleton(tx, id);
      await tx.commit();
      res.status(201).json({ ok: true, id, date_rapport: date, poste });
    } catch (err) {
      await rollbackQuietly(tx);
      throw err;
    }
  } catch (err) {
    if (err instanceof ProdError) return res.status(400).json({ error: err.message });
    console.error('production create error:', err);
    res.status(500).json({ error: 'Server error creating the report' });
  }
});

// Every table that holds rows of one report.
const REPORT_TABLES = [
  'prod_rapport_fab_produit', 'prod_rapport_four_entre', 'prod_rapport_four_sortie', 'prod_rapport_emb_produit',
  'prod_rapport_four_qualite', 'prod_rapport_fabrication_qualite', 'prod_rapport_prep_qualite', 'prod_rapport_prep_as',
  'prod_rapport_prep_general', 'prod_rapport_horaire_fabrication', 'prod_fab_tonnage', 'prod_rapport_heure',
  'prod_fuel', 'prod_rapport_anomalie', 'prod_rapport_cf_fabrication', 'prod_rapport_cf_emballage'
];

// DELETE /reports/:id - what the desktop does: delete the report and take the
// fabrication tonnage back out of the counters.
router.delete('/reports/:id', requireWrite, async (req_, res) => {
  const id = parseId(req_.params.id);
  if (!id) return res.status(400).json({ error: 'Rapport invalide.' });
  await inTx(res, 'delete', async (tx) => {
    await lockReport(tx, id);
    const tonnages = await run(tx, 'select id_unite, valeur from prod_fab_tonnage where id_rapport = @r', [['r', sql.Int, id]]);
    for (const t of tonnages) {
      await req(tx, [['v', sql.Real, Number(t.valeur) || 0], ['u', sql.Int, t.id_unite]])
        .query('update equipement_compteur set valeur = valeur - @v where id in (select id_compteur from prod_fab_compteur where id_unite = @u)');
    }
    for (const t of REPORT_TABLES) await req(tx, [['r', sql.Int, id]]).query(`delete ${t} where id_rapport = @r`);
    await req(tx, [['r', sql.Int, id]]).query('delete prod_rapport_general where id = @r');
  });
});

// ---- One report: everything the screens need --------------------------------

router.get('/reports/:id', async (req_, res) => {
  const id = parseId(req_.params.id);
  if (!id) return res.status(400).json({ error: 'Rapport invalide.' });
  try {
    const pool = await getPool();
    const P = [['r', sql.Int, id]];
    const head = await run(pool, "select id, convert(varchar(10), date_rapport, 23) as date_rapport, poste from prod_rapport_general where id = @r", P);
    if (head.length === 0) return res.status(404).json({ error: 'Rapport introuvable.' });

    const [fabProd, fabHeure, fabHoraire, fabQual, fabTon, fabCf, four, fourEntree, fourSortie, fourChamps,
      prepQual, prepAs, prepGen, fuel, embProd, embCf, anomalies, brique] = await Promise.all([
      run(pool, `select p.id, p.id_unite, e.designation as unite, p.id_produit, b.designation, p.quantite
                 from prod_rapport_fab_produit p join equipement e on e.id = p.id_unite join prod_type_brique b on b.id = p.id_produit
                 where p.id_rapport = @r order by p.id_unite, p.id`, P),
      run(pool, 'select id_unite, heure, id_produit from prod_rapport_heure where id_rapport = @r order by id_unite, heure', P),
      run(pool, `select h.id, h.id_unite, s.designation, h.h1, h.h2, h.h3, h.h4, h.h5, h.h6, h.h7, h.h8
                 from prod_rapport_horaire_fabrication h join prod_saisie s on s.id = h.id_qualite where h.id_rapport = @r order by h.id_unite, h.id`, P),
      run(pool, `select q.id, q.id_unite, s.designation, q.valeur
                 from prod_rapport_fabrication_qualite q join prod_saisie s on s.id = q.id_qualite where q.id_rapport = @r order by q.id_unite, q.id`, P),
      run(pool, 'select id_unite, valeur from prod_fab_tonnage where id_rapport = @r', P),
      run(pool, 'select id_unite, id_cf from prod_rapport_cf_fabrication where id_rapport = @r', P),
      run(pool, `select distinct x.id_unite, e.designation as unite from prod_rapport_four_entre x join equipement e on e.id = x.id_unite where x.id_rapport = @r`, P),
      run(pool, `select x.id, x.id_unite, b.designation, x.quantite, x.tonnage
                 from prod_rapport_four_entre x join prod_type_brique b on b.id = x.id_produit where x.id_rapport = @r order by x.id_unite, x.id`, P),
      run(pool, `select x.id, x.id_unite, b.designation, x.quantite, x.tonnage
                 from prod_rapport_four_sortie x join prod_type_brique b on b.id = x.id_produit where x.id_rapport = @r order by x.id_unite, x.id`, P),
      run(pool, `select q.id, q.id_unite, s.designation, q.valeur
                 from prod_rapport_four_qualite q join prod_saisie s on s.id = q.id_qualite where q.id_rapport = @r order by q.id_unite, q.id`, P),
      run(pool, `select q.id, q.id_unite, e.designation as unite, s.designation, q.valeur
                 from prod_rapport_prep_qualite q join prod_saisie s on s.id = q.id_qualite join equipement e on e.id = q.id_unite
                 where q.id_rapport = @r order by q.id_unite, q.id`, P),
      run(pool, `select a.id, a.id_unite, e.designation as unite, s.designation, a.valeur_a, a.valeur_s
                 from prod_rapport_prep_as a join prod_saisie s on s.id = a.id_qualite join equipement e on e.id = a.id_unite
                 where a.id_rapport = @r order by a.id_unite, a.id`, P),
      run(pool, `select g.id, s.designation, g.valeur
                 from prod_rapport_prep_general g join prod_saisie s on s.id = g.id_qualite where g.id_rapport = @r order by g.id`, P),
      run(pool, 'select type_saisie, quantite from prod_fuel where id_rapport = @r', P),
      run(pool, `select p.id, p.id_unite, e.designation as unite, b.designation, p.quantite,
                        isnull(p.nbr_bobine_feuillard, 0) as nbr_bobine_feuillard, isnull(p.nbr_pallette, 0) as nbr_pallette
                 from prod_rapport_emb_produit p join equipement e on e.id = p.id_unite join prod_type_brique b on b.id = p.id_produit
                 where p.id_rapport = @r order by p.id_unite, p.id`, P),
      run(pool, 'select id_unite, id_cf from prod_rapport_cf_emballage where id_rapport = @r', P),
      run(pool, `select a.id, a.id_unite, e.designation as unite, n.anomalie, a.duree
                 from prod_rapport_anomalie a join prod_anomalie n on n.id = a.id_anomalie join equipement e on e.id = a.id_unite
                 where a.id_rapport = @r order by a.id`, P),
      run(pool, 'select id, designation from prod_type_brique order by id', [])
    ]);

    const by = (rows, key = 'id_unite') => {
      const m = new Map();
      for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); }
      return m;
    };
    const unitsOf = (rows) => {
      const seen = new Map();
      for (const r of rows) if (!seen.has(r.id_unite)) seen.set(r.id_unite, r.unite);
      return [...seen].map(([id_unite, unite]) => ({ id_unite, unite }));
    };
    const strip = (r) => { const { id_unite, unite, ...rest } = r; return rest; }; // eslint-disable-line no-unused-vars
    const mapBy = (rows) => { const m = by(rows); return (u) => (m.get(u) || []).map(strip); };

    const fabProdBy = mapBy(fabProd);
    const heureBy = by(fabHeure);
    const horaireBy = mapBy(fabHoraire);
    const qualBy = mapBy(fabQual);
    const tonBy = new Map(fabTon.map((t) => [t.id_unite, Number(t.valeur) || 0]));
    const cfBy = new Map(fabCf.map((c) => [c.id_unite, c.id_cf]));

    const fabrication = unitsOf(fabProd).map((u) => {
      const heures = Array(8).fill(0);
      for (const h of heureBy.get(u.id_unite) || []) if (h.heure >= 1 && h.heure <= 8) heures[h.heure - 1] = h.id_produit;
      return {
        ...u,
        produits: fabProdBy(u.id_unite),
        heures,
        horaire: horaireBy(u.id_unite),
        qualite: qualBy(u.id_unite),
        tonnage: tonBy.get(u.id_unite) || 0,
        id_cf: cfBy.get(u.id_unite) || 0
      };
    });

    const entBy = mapBy(fourEntree); const sorBy = mapBy(fourSortie); const chBy = mapBy(fourChamps);
    const fourUnits = four.map((u) => ({
      id_unite: u.id_unite, unite: u.unite,
      entree: entBy(u.id_unite), sortie: sorBy(u.id_unite), champs: chBy(u.id_unite)
    }));

    const pqBy = mapBy(prepQual); const paBy = mapBy(prepAs);
    const prepUnits = unitsOf([...prepQual, ...prepAs]).map((u) => ({
      ...u, qualite: pqBy(u.id_unite), as: paBy(u.id_unite)
    }));

    const embBy = mapBy(embProd);
    const embCfBy = new Map(embCf.map((c) => [c.id_unite, c.id_cf]));
    const emballage = unitsOf(embProd).map((u) => ({ ...u, produits: embBy(u.id_unite), id_cf: embCfBy.get(u.id_unite) || 0 }));

    const fuelBy = new Map(fuel.map((f) => [f.type_saisie, Number(f.quantite)]));
    const fuelOut = FUEL_TYPES.map(([type, label]) => ({ type, label, quantite: fuelBy.has(type) ? fuelBy.get(type) : null }));

    // Units that can carry an anomaly + the catalog for each
    const unitIds = [...new Set([...fabProd, ...four, ...prepQual, ...prepAs, ...embProd].map((r) => r.id_unite))];
    const catalog = {};
    if (unitIds.length) {
      const cat = await run(pool, `
        select e.id_equipement as id_unite, n.id, n.anomalie
        from prod_equipement e join prod_anomalie n on n.unite_production = e.unite_production order by n.anomalie`, []);
      for (const c of cat) (catalog[c.id_unite] = catalog[c.id_unite] || []).push({ id: c.id, anomalie: c.anomalie });
    }

    res.json({
      ...head[0],
      can_write: canWriteProduction(req_.user.fonction),
      produits: brique,
      fabrication,
      four: fourUnits,
      preparation: { unites: prepUnits, general: prepGen },
      fuel: fuelOut,
      emballage,
      anomalies,
      anomalie_options: catalog
    });
  } catch (err) {
    console.error('production detail error:', err);
    res.status(500).json({ error: 'Server error fetching the report' });
  }
});

// GET /chefs - chefs d'équipe (intervenant.chef_equipe)
router.get('/chefs', async (_req, res) => {
  try {
    const pool = await getPool();
    res.json(await run(pool, 'select id, nom from intervenant where chef_equipe = 1 and deleted = 0 order by nom', []));
  } catch (err) {
    console.error('production chefs error:', err);
    res.status(500).json({ error: 'Server error fetching chefs' });
  }
});

// ---- Section saves ---------------------------------------------------------

// Rows are sent as { id, ... }; each id must belong to this report and unit.
function lignes(body, label) {
  const l = body?.lignes;
  if (!Array.isArray(l) || l.length === 0) throw new ProdError(`${label} : aucune ligne.`);
  if (l.length > 200) throw new ProdError('Trop de lignes.');
  const seen = new Set();
  for (const x of l) {
    if (!parseId(x?.id)) throw new ProdError('Ligne invalide.');
    if (seen.has(Number(x.id))) throw new ProdError('Ligne en double.');
    seen.add(Number(x.id));
  }
  return l;
}

async function ownedIds(tx, table, idRapport, idUnite, ids) {
  const rows = await run(tx, `select id from ${table} where id_rapport = @r ${idUnite ? 'and id_unite = @u' : ''}`,
    idUnite ? [['r', sql.Int, idRapport], ['u', sql.Int, idUnite]] : [['r', sql.Int, idRapport]]);
  const have = new Set(rows.map((r) => r.id));
  for (const id of ids) if (!have.has(Number(id))) throw new ProdError('Ligne introuvable dans ce rapport.');
}

// FUEL: PUT /reports/:id/fuel  { valeurs: { "1": 12, "2": "", ... } }
// Desktop: delete all, then insert the fields that hold a number.
router.put('/reports/:id/fuel', requireWrite, async (req_, res) => {
  const id = parseId(req_.params.id);
  if (!id) return res.status(400).json({ error: 'Rapport invalide.' });
  await inTx(res, 'fuel', async (tx) => {
    const v = req_.body?.valeurs || {};
    const items = [];
    for (const [type, label] of FUEL_TYPES) {
      const raw = v[type];
      if (raw === '' || raw === null || raw === undefined) continue;
      items.push([type, positiveNumber(raw, `Qt Fuel ${label}`)]);
    }
    await lockReport(tx, id);
    await req(tx, [['r', sql.Int, id]]).query('delete prod_fuel where id_rapport = @r');
    for (const [type, q] of items) {
      await req(tx, [['r', sql.Int, id], ['t', sql.Int, type], ['q', sql.Real, q]])
        .query('insert into prod_fuel (id_rapport, type_saisie, quantite) values (@r, @t, @q)');
    }
  });
});

// Simple "valeur" tables: fabrication qualité, four champs, préparation qualité.
function simpleValueRoute(path, table, unitScoped) {
  router.put(path, requireWrite, async (req_, res) => {
    const id = parseId(req_.params.id);
    const unite = unitScoped ? parseId(req_.params.unite) : null;
    if (!id || (unitScoped && !unite)) return res.status(400).json({ error: 'Identifiant invalide.' });
    await inTx(res, table, async (tx) => {
      const rows = lignes(req_.body, 'Champs');
      const vals = rows.map((x) => anyNumber(x.valeur, 'Valeur'));
      await lockReport(tx, id);
      await ownedIds(tx, table, id, unite, rows.map((x) => x.id));
      for (let i = 0; i < rows.length; i++) {
        await req(tx, [['v', sql.Real, vals[i]], ['i', sql.Int, rows[i].id]]).query(`update ${table} set valeur = @v where id = @i`);
      }
      if (table === 'prod_rapport_four_qualite') await retotalFour(tx, id, unite);
    });
  });
}

simpleValueRoute('/reports/:id/fabrication/:unite/qualite', 'prod_rapport_fabrication_qualite', true);
simpleValueRoute('/reports/:id/four/:unite/champs', 'prod_rapport_four_qualite', true);
simpleValueRoute('/reports/:id/preparation/:unite/qualite', 'prod_rapport_prep_qualite', true);
simpleValueRoute('/reports/:id/preparation/general', 'prod_rapport_prep_general', false);

// Préparation A/S: PUT /reports/:id/preparation/:unite/as { lignes:[{id, valeur_a, valeur_s}] }
router.put('/reports/:id/preparation/:unite/as', requireWrite, async (req_, res) => {
  const id = parseId(req_.params.id); const unite = parseId(req_.params.unite);
  if (!id || !unite) return res.status(400).json({ error: 'Identifiant invalide.' });
  await inTx(res, 'prep_as', async (tx) => {
    const rows = lignes(req_.body, 'Champs');
    const vals = rows.map((x) => [anyNumber(x.valeur_a, 'Valeur A'), anyNumber(x.valeur_s, 'Valeur S')]);
    await lockReport(tx, id);
    await ownedIds(tx, 'prod_rapport_prep_as', id, unite, rows.map((x) => x.id));
    for (let i = 0; i < rows.length; i++) {
      await req(tx, [['a', sql.Real, vals[i][0]], ['s', sql.Real, vals[i][1]], ['i', sql.Int, rows[i].id]])
        .query('update prod_rapport_prep_as set valeur_a = @a, valeur_s = @s where id = @i');
    }
  });
});

// Horaire fabrication: PUT /reports/:id/fabrication/:unite/horaire { lignes:[{id, h:[8]}] }
router.put('/reports/:id/fabrication/:unite/horaire', requireWrite, async (req_, res) => {
  const id = parseId(req_.params.id); const unite = parseId(req_.params.unite);
  if (!id || !unite) return res.status(400).json({ error: 'Identifiant invalide.' });
  await inTx(res, 'horaire', async (tx) => {
    const rows = lignes(req_.body, 'Horaire');
    const vals = rows.map((x) => {
      if (!Array.isArray(x.h) || x.h.length !== 8) throw new ProdError('Horaire : 8 valeurs attendues.');
      return x.h.map((v, k) => anyNumber(v, `H${k + 1}`));
    });
    await lockReport(tx, id);
    await ownedIds(tx, 'prod_rapport_horaire_fabrication', id, unite, rows.map((x) => x.id));
    for (let i = 0; i < rows.length; i++) {
      const r = req(tx, [['i', sql.Int, rows[i].id]]);
      vals[i].forEach((v, k) => r.input(`h${k + 1}`, sql.Real, v));
      await r.query('update prod_rapport_horaire_fabrication set h1=@h1, h2=@h2, h3=@h3, h4=@h4, h5=@h5, h6=@h6, h7=@h7, h8=@h8 where id = @i');
    }
  });
});

// Chef d'équipe: PUT /reports/:id/(fabrication|emballage)/:unite/cf { id_cf }
for (const [section, table] of [['fabrication', 'prod_rapport_cf_fabrication'], ['emballage', 'prod_rapport_cf_emballage']]) {
  router.put(`/reports/:id/${section}/:unite/cf`, requireWrite, async (req_, res) => {
    const id = parseId(req_.params.id); const unite = parseId(req_.params.unite);
    const cf = parseId(req_.body?.id_cf);
    if (!id || !unite || !cf) return res.status(400).json({ error: 'Choisir un chef d\'équipe.' });
    await inTx(res, table, async (tx) => {
      await lockReport(tx, id);
      const ok = await run(tx, 'select id from intervenant where id = @c and chef_equipe = 1 and deleted = 0', [['c', sql.Int, cf]]);
      if (ok.length === 0) throw new ProdError("Chef d'équipe introuvable.");
      await req(tx, [['r', sql.Int, id], ['u', sql.Int, unite]]).query(`delete ${table} where id_rapport = @r and id_unite = @u`);
      await req(tx, [['r', sql.Int, id], ['u', sql.Int, unite], ['c', sql.Int, cf]])
        .query(`insert into ${table} (id_rapport, id_unite, id_cf) values (@r, @u, @c)`);
    });
  });
}

// Emballage: PUT /reports/:id/emballage/:unite/produits
//   { lignes:[{id, quantite, nbr_bobine_feuillard, nbr_pallette}] }
router.put('/reports/:id/emballage/:unite/produits', requireWrite, async (req_, res) => {
  const id = parseId(req_.params.id); const unite = parseId(req_.params.unite);
  if (!id || !unite) return res.status(400).json({ error: 'Identifiant invalide.' });
  await inTx(res, 'emballage', async (tx) => {
    const rows = lignes(req_.body, 'Produits');
    const vals = rows.map((x) => [
      positiveNumber(x.quantite, 'Quantité'),
      positiveNumber(x.nbr_bobine_feuillard, 'Nombre de bobines de feuillard'),
      positiveNumber(x.nbr_pallette, 'Nombre de palettes')
    ]);
    await lockReport(tx, id);
    await ownedIds(tx, 'prod_rapport_emb_produit', id, unite, rows.map((x) => x.id));
    for (let i = 0; i < rows.length; i++) {
      await req(tx, [['q', sql.Real, vals[i][0]], ['b', sql.Real, vals[i][1]], ['p', sql.Real, vals[i][2]], ['i', sql.Int, rows[i].id]])
        .query('update prod_rapport_emb_produit set quantite = @q, nbr_bobine_feuillard = @b, nbr_pallette = @p where id = @i');
    }
  });
});

// ---- Four: tonnage ----------------------------------------------------------

// Value of the "poids four" measure (prod_saisie.poid_four = 1) of this unit, or 0.
async function poidFour(tx, idRapport, idUnite) {
  const r = await run(tx, `select top 1 valeur from prod_rapport_four_qualite
    where id_rapport = @r and id_unite = @u and id_qualite = (select top 1 id from prod_saisie where poid_four = 1 order by id)`,
  [['r', sql.Int, idRapport], ['u', sql.Int, idUnite]]);
  return r.length ? Number(r[0].valeur) || 0 : 0;
}

async function productWeight(tx, idProduit, column) {
  const r = await run(tx, `select isnull(${column}, 1) as w from prod_type_brique where id = @i`, [['i', sql.Int, idProduit]]);
  return r.length ? Number(r[0].w) || 0 : 1;
}

// PUT /reports/:id/four/:unite/(entree|sortie)  { lignes:[{id, quantite}] }
//   entrée: tonnage = (poids four measure, else poid_vert) x wagon x quantité
//   sortie: tonnage = (poids four measure, else poid)      x wagon x quantité
for (const [kind, table, column] of [['entree', 'prod_rapport_four_entre', 'poid_vert'], ['sortie', 'prod_rapport_four_sortie', 'poid']]) {
  router.put(`/reports/:id/four/:unite/${kind}`, requireWrite, async (req_, res) => {
    const id = parseId(req_.params.id); const unite = parseId(req_.params.unite);
    if (!id || !unite) return res.status(400).json({ error: 'Identifiant invalide.' });
    await inTx(res, table, async (tx) => {
      const rows = lignes(req_.body, 'Produits');
      const qts = rows.map((x) => positiveNumber(x.quantite, 'Quantité'));
      await lockReport(tx, id);
      await ownedIds(tx, table, id, unite, rows.map((x) => x.id));
      const measured = await poidFour(tx, id, unite);
      for (let i = 0; i < rows.length; i++) {
        const line = await run(tx, `select x.id_produit, b.designation from ${table} x join prod_type_brique b on b.id = x.id_produit where x.id = @i`, [['i', sql.Int, rows[i].id]]);
        const w = measured !== 0 ? measured : await productWeight(tx, line[0].id_produit, column);
        const tonnage = w * tonnageWagon(line[0].designation) * qts[i];
        await req(tx, [['q', sql.Real, qts[i]], ['t', sql.Real, tonnage], ['i', sql.Int, rows[i].id]])
          .query(`update ${table} set quantite = @q, tonnage = @t where id = @i`);
      }
    });
  });
}

// After the "champs" of a four are saved the desktop recomputes every tonnage
// of that unit from the stored quantities (prod_rapport_four_champ.cs). Its
// defaults differ from the entrée/sortie screens (entrée: 7200, or 4200 for
// product 5; sortie: poid_vert); they are kept as they are.
async function retotalFour(tx, idRapport, idUnite) {
  const measured = await poidFour(tx, idRapport, idUnite);
  const P = [['r', sql.Int, idRapport], ['u', sql.Int, idUnite]];
  const entrees = await run(tx, `select x.id, x.id_produit, b.designation from prod_rapport_four_entre x
    join prod_type_brique b on b.id = x.id_produit where x.id_rapport = @r and x.id_unite = @u`, P);
  for (const e of entrees) {
    const w = measured !== 0 ? measured : (e.id_produit === 5 ? 4200 : 7200);
    await req(tx, [['t', sql.Real, w * tonnageWagon(e.designation)], ['i', sql.Int, e.id]])
      .query('update prod_rapport_four_entre set tonnage = quantite * @t where id = @i');
  }
  const sorties = await run(tx, `select x.id, x.id_produit, b.designation from prod_rapport_four_sortie x
    join prod_type_brique b on b.id = x.id_produit where x.id_rapport = @r and x.id_unite = @u`, P);
  for (const s of sorties) {
    const w = measured !== 0 ? measured : await productWeight(tx, s.id_produit, 'poid_vert');
    await req(tx, [['t', sql.Real, w * tonnageWagon(s.designation)], ['i', sql.Int, s.id]])
      .query('update prod_rapport_four_sortie set tonnage = quantite * @t where id = @i');
  }
}

// ---- Fabrication: produits + horaires -> tonnage + compteurs ---------------

// PUT /reports/:id/fabrication/:unite/produits
//   { lignes:[{id, quantite}], heures:[8 x id_produit] }
// (prod_rapport_fabrication_produit.cs guna2Button1_Click)
router.put('/reports/:id/fabrication/:unite/produits', requireWrite, async (req_, res) => {
  const id = parseId(req_.params.id); const unite = parseId(req_.params.unite);
  if (!id || !unite) return res.status(400).json({ error: 'Identifiant invalide.' });
  await inTx(res, 'fabrication', async (tx) => {
    const rows = lignes(req_.body, 'Produits');
    const qts = rows.map((x) => positiveNumber(x.quantite, 'Quantité'));
    const heures = req_.body?.heures;
    if (!Array.isArray(heures) || heures.length !== 8 || heures.some((h) => !parseId(h))) {
      throw new ProdError("Associer chaque heure d'échantillonnage à un produit.");
    }
    await lockReport(tx, id);
    await ownedIds(tx, 'prod_rapport_fab_produit', id, unite, rows.map((x) => x.id));
    const known = new Set((await run(tx, 'select id from prod_type_brique', [])).map((b) => b.id));
    if (heures.some((h) => !known.has(Number(h)))) throw new ProdError('Produit inconnu.');

    // hour -> product links
    await req(tx, [['r', sql.Int, id], ['u', sql.Int, unite]]).query('delete prod_rapport_heure where id_rapport = @r and id_unite = @u');
    for (let k = 0; k < 8; k++) {
      await req(tx, [['r', sql.Int, id], ['u', sql.Int, unite], ['h', sql.Int, k + 1], ['p', sql.Int, Number(heures[k])]])
        .query('insert into prod_rapport_heure (id_rapport, id_unite, heure, id_produit) values (@r, @u, @h, @p)');
    }

    // weight samples (prod_saisie.poid_sec_fab = 1) for this unit
    const saisie = await run(tx, 'select top 1 id from prod_saisie where poid_sec_fab = 1 order by id', []);
    let samples = [];
    if (saisie.length) {
      const h = await run(tx, 'select h1,h2,h3,h4,h5,h6,h7,h8 from prod_rapport_horaire_fabrication where id_rapport = @r and id_unite = @u and id_qualite = @q',
        [['r', sql.Int, id], ['u', sql.Int, unite], ['q', sql.Int, saisie[0].id]]);
      if (h.length) samples = [h[0].h1, h[0].h2, h[0].h3, h[0].h4, h[0].h5, h[0].h6, h[0].h7, h[0].h8];
    }

    let nvTonnage = 0;
    const perLine = [];
    for (let i = 0; i < rows.length; i++) {
      const line = await run(tx, `select p.id_produit, b.designation from prod_rapport_fab_produit p join prod_type_brique b on b.id = p.id_produit where p.id = @i`,
        [['i', sql.Int, rows[i].id]]);
      const idProduit = line[0].id_produit;
      const hrs = heures.map((p, k) => (Number(p) === idProduit ? k + 1 : 0)).filter(Boolean);
      const avg = averageWeight(idProduit, hrs, samples);
      const wagon = tonnageWagon(line[0].designation);
      nvTonnage += qts[i] * wagon * avg;
      perLine.push({ id: rows[i].id, q: qts[i], t: wagon * qts[i] * avg * TONNAGE_FACTOR });
    }
    nvTonnage *= TONNAGE_FACTOR;

    const old = await run(tx, 'select valeur from prod_fab_tonnage with (updlock, rowlock) where id_rapport = @r and id_unite = @u',
      [['r', sql.Int, id], ['u', sql.Int, unite]]);
    if (old.length === 0) throw new ProdError('Tonnage du rapport introuvable.');
    const ancien = Number(old[0].valeur) || 0;

    for (const l of perLine) {
      await req(tx, [['q', sql.Real, l.q], ['t', sql.Real, l.t], ['i', sql.Int, l.id]])
        .query('update prod_rapport_fab_produit set quantite = @q, tonnage = @t where id = @i');
    }
    await req(tx, [['v', sql.Real, nvTonnage], ['r', sql.Int, id], ['u', sql.Int, unite]])
      .query('update prod_fab_tonnage set valeur = @v where id_rapport = @r and id_unite = @u');

    // counters of the unit follow the change of tonnage
    const diff = nvTonnage - ancien;
    let moved = 0;
    if (Math.abs(diff) > EPS_COMPTEUR) {
      const compteurs = await run(tx, 'select id_compteur from prod_fab_compteur where id_unite = @u', [['u', sql.Int, unite]]);
      for (const c of compteurs) {
        await req(tx, [['c', sql.Int, c.id_compteur], ['v', sql.Real, nvTonnage]])
          .query('insert into equipement_compteur_historique (id_compteur, valeur, date_mesure) values (@c, @v, cast(getdate() as date))');
        await req(tx, [['c', sql.Int, c.id_compteur], ['d', sql.Real, diff]])
          .query('update equipement_compteur set valeur = valeur + @d where id = @c');
        const now = await run(tx, 'select valeur from equipement_compteur where id = @c', [['c', sql.Int, c.id_compteur]]);
        await req(tx, [['c', sql.Int, c.id_compteur], ['v', sql.Real, Number(now[0]?.valeur) || 0]])
          .query('insert into equipement_compteur_nv (id_compteur, valeur, date_nv) values (@c, @v, cast(getdate() as date))');
        moved += 1;
      }
    }
    return { tonnage: nvTonnage, compteurs_modifies: moved };
  });
});

// ---- Anomalies (arrêts) -------------------------------------------------------

// POST /reports/:id/anomalies { id_unite, id_anomalie, duree }  (duree: whole minutes > 0)
router.post('/reports/:id/anomalies', requireWrite, async (req_, res) => {
  const id = parseId(req_.params.id);
  if (!id) return res.status(400).json({ error: 'Rapport invalide.' });
  await inTx(res, 'anomalie', async (tx) => {
    const unite = parseId(req_.body?.id_unite); const anomalie = parseId(req_.body?.id_anomalie);
    const duree = Number(req_.body?.duree);
    if (!unite || !anomalie) throw new ProdError('Choisir une anomalie.');
    if (!Number.isInteger(duree) || duree <= 0) throw new ProdError('La durée doit être un nombre entier de minutes supérieur à 0.');
    await lockReport(tx, id);
    // the unit must be part of the report, and the anomaly must exist for its production unit
    const ok = await run(tx, `select 1 as ok from prod_equipement e join prod_anomalie n on n.unite_production = e.unite_production
      where e.id_equipement = @u and n.id = @a`, [['u', sql.Int, unite], ['a', sql.Int, anomalie]]);
    if (ok.length === 0) throw new ProdError('Anomalie non valable pour cette unité.');
    await req(tx, [['r', sql.Int, id], ['u', sql.Int, unite], ['a', sql.Int, anomalie], ['d', sql.Int, duree]])
      .query('insert into prod_rapport_anomalie (id_rapport, id_unite, id_anomalie, duree) values (@r, @u, @a, @d)');
  });
});

router.delete('/reports/:id/anomalies/:aid', requireWrite, async (req_, res) => {
  const id = parseId(req_.params.id); const aid = parseId(req_.params.aid);
  if (!id || !aid) return res.status(400).json({ error: 'Identifiant invalide.' });
  await inTx(res, 'anomalie-delete', async (tx) => {
    await lockReport(tx, id);
    const r = await req(tx, [['a', sql.Int, aid], ['r', sql.Int, id]]).query('delete prod_rapport_anomalie where id = @a and id_rapport = @r');
    if (r.rowsAffected[0] !== 1) throw new ProdError('Anomalie introuvable.');
  });
});

module.exports = router;
module.exports._test = { tonnageWagon, defaultFabWeight, averageWeight, toNumber, parseDate };
