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
    // Tabela nova específica para valores em CNY para evitar conflito com os USD antigos
    await client.query(`
      CREATE TABLE IF NOT EXISTS item_prices_cny (
        id               SERIAL PRIMARY KEY,
        market_hash_name TEXT UNIQUE NOT NULL,
        buff_cny         NUMERIC(12, 4) DEFAULT 0,
        youpin_cny       NUMERIC(12, 4) DEFAULT 0,
        updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_item_prices_cny_name ON item_prices_cny (market_hash_name);
    `);
    logger.success('Banco de dados (CNY) pronto');
  } finally {
    client.release();
  }
}

async function savePriceToDB(marketHashName, { buff, youpin }) {
  try {
    await pool.query(
      `INSERT INTO item_prices_cny (market_hash_name, buff_cny, youpin_cny, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (market_hash_name) DO UPDATE SET
         buff_cny   = EXCLUDED.buff_cny,
         youpin_cny = EXCLUDED.youpin_cny,
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
      `SELECT market_hash_name, buff_cny, youpin_cny, updated_at
       FROM item_prices_cny WHERE market_hash_name = ANY($1)`,
      [marketHashNames]
    );
    for (const row of rows.rows) {
      if (new Date(row.updated_at).getTime() >= staleThreshold) {
        result.set(row.market_hash_name, {
          buff:   Number(row.buff_cny),
          youpin: Number(row.youpin_cny),
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