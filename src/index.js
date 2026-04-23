#!/usr/bin/env node
require('dotenv').config();

const { extractSteamID, fetchInventory } = require('./services/steamService');
const { processInventoryPrices }         = require('./services/priceService');
const { setupDatabase, closeDB }         = require('./services/dbService');
const logger                             = require('./utils/logger');

const API_KEY = process.env.CSINVENTORY_API_KEY;

if (!API_KEY) {
  logger.error('CSINVENTORY_API_KEY não definida');
  process.exit(1);
}

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.log(`Uso: node src/index.js "<trade_link>"`);
    process.exit(0);
  }

  logger.banner('CS2 Inventory Pricer');

  try {
    await setupDatabase();

    const steamId = await extractSteamID(input, API_KEY);
    logger.success(`SteamID: ${steamId}`);

    logger.info('Buscando inventário...');
    const items = await fetchInventory(steamId, API_KEY);

    logger.success(`Itens encontrados: ${items.length}`);

    logger.info('Calculando preços...');
    const result = await processInventoryPrices(items, API_KEY);

    console.log(result);

  } catch (err) {
    logger.error(err.message);
  } finally {
    await closeDB();
  }
}

main();