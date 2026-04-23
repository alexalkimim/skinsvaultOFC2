#!/usr/bin/env node
require('dotenv').config();

const { extractSteamID, fetchInventory } = require('./services/steamService');
const { processInventoryPrices }         = require('./services/priceService');
const { setupDatabase, closeDB }         = require('./services/dbService');
const logger                             = require('./utils/logger');

const API_KEY = process.env.CSINVENTORY_API_KEY;
if (!API_KEY) { logger.error('CSINVENTORY_API_KEY não definida no .env'); process.exit(1); }

function printResults({ results, totalBuffBRL, totalYouPinBRL, displayRate, stats }) {
  console.log('\n');
  logger.banner('RESULTADO FINAL');
  console.log(`  💰  Total BUFF      →  R$ ${Number(totalBuffBRL).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  console.log(`  💰  Total YouPin    →  R$ ${Number(totalYouPinBRL).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  console.log(`  💱  Câmbio         →  ${displayRate}`);
  console.log(`  📊  Estatísticas   →  ${stats.total} itens | ${stats.unique} únicos | ${stats.fromDB} do banco`);
  
  logger.divider();
  console.log('\n  📦  Itens (ordem: maior valor BUFF):\n');
  
  for (const item of results) {
    const qty  = item.quantity > 1 ? ` ×${item.quantity}` : '   ';
    const name = item.name.length > 40 ? item.name.slice(0, 37) + '...' : item.name;
    
    console.log(
      `  • ${name.padEnd(42)}${qty}` +
      `  BUFF: R$ ${String(item.buffBRL).padStart(9)} ($${item.buffUSD.padStart(7)})` +
      `  │  YouPin: R$ ${String(item.youpinBRL).padStart(9)} ($${item.youpinUSD.padStart(7)})`
    );
  }
  console.log('');
  logger.divider();
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.log(`\nUso:\n  node src/index.js "<trade_link_ou_inventario>"\n`);
    process.exit(0);
  }

  logger.banner('CS2 Inventory Pricer v2.2');

  try {
    await setupDatabase();
    
    const steamId = await extractSteamID(input, API_KEY);
    logger.success(`SteamID64: ${steamId}`);

    logger.info('Buscando inventário...');
    const items = await fetchInventory(steamId, API_KEY);
    
    logger.success(`${items.length} itens encontrados`);

    logger.info('Calculando preços...');
    const result = await processInventoryPrices(items, API_KEY);
    printResults(result);

  } catch (err) {
    logger.error(err.message);
    if (process.env.DEBUG === 'true') console.error(err);
  } finally {
    await closeDB();
  }
}

main();
