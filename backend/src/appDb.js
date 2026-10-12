const sql = require('mssql');

// Connection to the small app-only database (pending BSM/BRM requests,
// device push tokens, notification log). The original GMAO database is never
// written to for any of that - see db.js for that connection.
//
// By default this points at a database called GMAO_APP on the same SQL Server
// as the GMAO database and reuses its login. Set APPDB_* in .env to point it
// at a different database name, login, or even a different server.
const config = {
  server: process.env.APPDB_SERVER || process.env.DB_SERVER,
  database: process.env.APPDB_NAME || 'GMAO_APP',
  user: process.env.APPDB_USER || process.env.DB_USER,
  password: process.env.APPDB_PASSWORD || process.env.DB_PASSWORD,
  port: Number(process.env.APPDB_PORT || process.env.DB_PORT || 1433),
  options: {
    encrypt: process.env.DB_ENCRYPT !== 'false',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false'
  },
  pool: {
    max: 5,
    min: 1,
    idleTimeoutMillis: 30000
  }
};

let poolPromise;

function getAppPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        console.log('Connected to app database:', config.server, '/', config.database);
        return pool;
      })
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

module.exports = { sql, getAppPool };
