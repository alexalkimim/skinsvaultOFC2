// dbService.js — Cache persistente
const { Pool } = require('pg');
const logger   = require('../utils/logger');

const STALE_HOURS = Number(process.env.PRICE_STALE_HOURS || 6);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => logger.error(`Pool error: ${err.message}`));

async function setupDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS item_prices_usd (
        id               SERIAL PRIMARY KEY,
        market_hash_name TEXT UNIQUE NOT NULL,
        buff             NUMERIC(12, 4) DEFAULT 0,
        youpin           NUMERIC(12, 4) DEFAULT 0,
        updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_item_prices_usd_name ON item_prices_usd (market_hash_name);
    `);
    logger.success(`Banco pronto (Cache: ${STALE_HOURS}h)`);
  } finally {
    client.release();
  }
}

async function savePriceToDB(marketHashName, { buff, youpin }) {
  try {
    await pool.query(
      `INSERT INTO item_prices_usd (market_hash_name, buff, youpin, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (market_hash_name) DO UPDATE SET
         buff          = EXCLUDED.buff,
         youpin        = EXCLUDED.youpin,
         updated_at    = NOW()
       WHERE item_prices_usd.updated_at < NOW() - INTERVAL '${STALE_HOURS} hours'`,
      [marketHashName, buff || 0, youpin || 0]
    );
  } catch (err) {
    logger.error(`Erro ao salvar "${marketHashName}": ${err.message}`);
  }
}

async function getBatchPricesFromDB(marketHashNames) {
  const result = new Map();
  if (marketHashNames.length === 0) return result;

  try {
    const rows = await pool.query(
      `SELECT market_hash_name, buff, youpin
       FROM item_prices_usd
       WHERE market_hash_name = ANY($1)
       AND updated_at >= NOW() - INTERVAL '${STALE_HOURS} hours'`,
      [marketHashNames]
    );

    for (const row of rows.rows) {
      result.set(row.market_hash_name, {
        buff:   Number(row.buff),
        youpin: Number(row.youpin)
      });
    }
  } catch (err) {
    logger.error(`Erro ao buscar lote do banco: ${err.message}`);
  }

  return result;
}

async function closeDB() {
  await pool.end().catch(() => {});
}

module.exports = { setupDatabase, savePriceToDB, getBatchPricesFromDB, closeDB };
