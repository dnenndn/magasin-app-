const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT || 1433),
  options: {
    encrypt: process.env.DB_ENCRYPT !== 'false',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false'
  },
  pool: {
    max: 10,
    // Keeping a couple of connections warm avoids paying a fresh
    // connect+login round trip (which can be the whole perceived delay)
    // every time a request comes in after the app has been idle for a
    // while - min: 0 closed everything after idleTimeoutMillis, so the
    // very next request always had to reconnect from scratch.
    min: 2,
    idleTimeoutMillis: 30000
  }
};

let poolPromise;

// Reuses one connection pool for the whole service instead of opening a new
// connection per request (this is what the desktop app does NOT do well -
// it opens `bd.cnn` per form).
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        console.log('Connected to SQL Server:', process.env.DB_SERVER, '/', process.env.DB_NAME);
        return pool;
      })
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

module.exports = { sql, getPool };
