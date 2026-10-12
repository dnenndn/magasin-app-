const { sql, getPool } = require('./db');

// The app database stores user ids only (id_requester, resolved_by, ...).
// Anything that needs a readable login looks it up here from the original
// database's utilisateur table, instead of joining across the two databases.
// Returns a plain object: { [id]: 'login' }.
async function loginsByIds(ids) {
  const unique = [...new Set((ids || []).filter((id) => id != null))];
  if (unique.length === 0) return {};

  const pool = await getPool();
  const request = pool.request();
  unique.forEach((id, i) => request.input(`u${i}`, sql.Int, id));
  const result = await request.query(
    `select id, login from utilisateur where id in (${unique.map((_, i) => `@u${i}`).join(',')})`
  );
  return Object.fromEntries(result.recordset.map((u) => [u.id, (u.login || '').trim()]));
}

module.exports = { loginsByIds };
