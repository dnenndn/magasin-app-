const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Search / list articles with current stock levels.
// Mirrors the columns liste_article.cs pulls, plus the unit of measure.
router.get('/', async (req, res) => {
  const { search = '', famille_id, magasin_id } = req.query;

  try {
    const pool = await getPool();
    const request = pool
      .request()
      .input('d', sql.Bit, false)
      .input('search', sql.NVarChar, `%${search}%`);

    let query = `
      select top 100
        a.id, a.code_article, a.reference, a.designation, a.marque,
        a.stock_neuf, a.stock_use, a.stock_rebute,
        a.stock_mini, a.stock_maxi, a.stock_securite,
        a.prix_ht, a.tva, a.id_magasin,
        u.designation as unite
      from article a
      left join tableau_article_unite tau on tau.id_article = a.id
      left join parametre_unite_article u on u.id = tau.id_unite
      where a.deleted = @d
        and (a.designation like @search or a.code_article like @search or a.reference like @search)
    `;

    if (famille_id) {
      request.input('famille_id', sql.Int, Number(famille_id));
      query += `
        and a.id in (
          select tasf.id_article from tableau_article_sous_famille tasf
          inner join sous_famille sf on sf.id = tasf.id_sous_famille
          where sf.id_famille = @famille_id
        )
      `;
    }

    if (magasin_id) {
      request.input('magasin_id', sql.Int, Number(magasin_id));
      query += ` and a.id_magasin = @magasin_id`;
    }

    query += ` order by a.designation`;

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error('list articles error:', err);
    res.status(500).json({ error: 'Server error fetching articles' });
  }
});

// Full detail for one article: identity + stock + suppliers.
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);

  try {
    const pool = await getPool();

    const articleResult = await pool
      .request()
      .input('i', sql.Int, id)
      .query(
        `select id, code_article, reference, designation, marque, methode_gestion,
                stock_neuf, stock_use, stock_rebute, stock_mini, stock_maxi,
                stock_securite, point_commande, prix_ht, tva, id_magasin
         from article where id = @i`
      );

    const article = articleResult.recordset[0];
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const suppliersResult = await pool
      .request()
      .input('i', sql.Int, id)
      .input('d', sql.Bit, false)
      .query(
        `select f.id, f.nom from fournisseur f
         inner join tableau_article_fournisseur t on f.id = t.id_fournisseur
         where t.id_article = @i and f.deleted = @d`
      );

    res.json({ ...article, fournisseurs: suppliersResult.recordset });
  } catch (err) {
    console.error('article detail error:', err);
    res.status(500).json({ error: 'Server error fetching article' });
  }
});

module.exports = router;
