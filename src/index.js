#!/usr/bin/env node
require('dotenv').config();

const { extractSteamID, fetchInventory } = require('./services/steamService');
const { processInventoryPrices }         = require('./services/priceService');
const { setupDatabase, closeDB }         = require('./services/dbService');
const logger                             = require('./utils/logger');

const API_KEY = process.env.CSINVENTORY_API_KEY;
if (!API_KEY) { logger.error('CSINVENTORY_API_KEY não definida no .env'); process.exit(1); }

function printDiagnosticReport(stats, error = null) {
  const report = {
    status: error ? 'ERRO' : 'OK',
    error: error ? error.message : null,
    itens_totais: stats?.total || 0,
    itens_unicos: stats?.unique || 0,
    origem: { banco: stats?.fromDB || 0, api: stats?.fromAPI || 0 },
    cambio: stats?.displayRate || 'N/A',
    timestamp: new Date().toISOString()
  };
  console.log('\n==================================================');
  console.log('📋 RELATÓRIO DE DIAGNÓSTICO (COPIE E COLE PARA O MANUS)');
  console.log('==================================================');
  console.log(JSON.stringify(report, null, 2));
  console.log('==================================================\n');
}

function printResults({ results, totalBuffBRL, totalYouPinBRL, displayRate, stats }) {
  console.log('\n');
  logger.banner('RESUMO DE VALORES (API V2 -> USD BASE)');
  console.log(`  💰  Total BUFF      →  R$ ${Number(totalBuffBRL).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  console.log(`  💰  Total YouPin    →  R$ ${Number(totalYouPinBRL).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  console.log(`  💱  Câmbio         →  ${displayRate}`);
  console.log(`  📊  Estatísticas   →  ${stats.total} itens | ${stats.unique} únicos | ${stats.fromDB} do banco`);
  
  logger.divider();
  printDiagnosticReport({ ...stats, displayRate });

  if (process.argv.includes('--full')) {
    console.log('\n  📦  Lista Detalhada de Itens:\n');
    for (const item of results) {
      const qty  = item.quantity > 1 ? ` ×${item.quantity}` : '   ';
      const name = item.name.length > 40 ? item.name.slice(0, 37) + '...' : item.name;
      console.log(
        `  • ${name.padEnd(42)}${qty}` +
        `  BUFF: R$ ${String(item.buffBRL).padStart(8)} ($${item.buffUSD.padStart(7)})` +
        `  │  YouPin: R$ ${String(item.youpinBRL).padStart(8)} ($${item.youpinUSD.padStart(7)})`
      );
    }
    console.log('');
    logger.divider();
  }
}

async function main() {
  const input = process.argv[2];
  if (!input) { console.log(`\nUso:\n  node src/index.js "<trade_link>"\n`); process.exit(0); }

  logger.banner('CS2 Inventory Pricer v2.4 - Pro USD');

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
    printDiagnosticReport(null, err);
  } finally {
    await closeDB();
  }
}

main();