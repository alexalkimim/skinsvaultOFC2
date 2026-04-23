// dbService.js — Supabase (PostgreSQL) como cache persistente
const { Pool } = require('pg');
const logger   = require('../utils/logger');

const STALE_HOURS = Number(process.env.PRICE_STALE_HOURS || 24);

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
      CREATE TABLE IF NOT EXISTS item_prices (
        id               SERIAL PRIMARY KEY,
        market_hash_name TEXT UNIQUE NOT NULL,
        buff_usd         NUMERIC(12, 4) DEFAULT 0,
        youpin_usd       NUMERIC(12, 4) DEFAULT 0,
        updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_item_prices_name ON item_prices (market_hash_name);
    `);
    logger.success('Banco de dados pronto');
  } finally {
    client.release();
  }
}

async function savePriceToDB(marketHashName, { buff, youpin }) {
  try {
    await pool.query(
      `INSERT INTO item_prices (market_hash_name, buff_usd, youpin_usd, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (market_hash_name) DO UPDATE SET
         buff_usd   = EXCLUDED.buff_usd,
         youpin_usd = EXCLUDED.youpin_usd,
         updated_at = NOW()`,
      [marketHashName, buff, youpin]
    );
  } catch (err) {
    logger.error(`Erro ao salvar "${marketHashName}": ${err.message}`);
  }
}

async function getBatchPricesFromDB(marketHashNames) {
  const result = new Map();
  if (marketHashNames.length === 0) return result;
  try {
    const staleThreshold = Date.now() - STALE_HOURS * 60 * 60 * 1000;
    const rows = await pool.query(
      `SELECT market_hash_name, buff_usd, youpin_usd, updated_at
       FROM item_prices WHERE market_hash_name = ANY($1)`,
      [marketHashNames]
    );
    for (const row of rows.rows) {
      if (new Date(row.updated_at).getTime() >= staleThreshold) {
        result.set(row.market_hash_name, {
          buff:   Number(row.buff_usd),
          youpin: Number(row.youpin_usd),
        });
      }
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