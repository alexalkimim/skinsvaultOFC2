// src/index.js
require('dotenv').config();

const { extractSteamID, fetchInventory } = require('./services/steamService');
const { processInventoryPrices }         = require('./services/priceService');
const { setupDatabase, closeDB }         = require('./services/dbService');
const { calibrarTaxa }                   = require('./jobs/calibrador');
const logger                             = require('./utils/logger');

const API_KEY = process.env.CSINVENTORY_API_KEY;
if (!API_KEY) {
  logger.error('CSINVENTORY_API_KEY não definida no .env');
  process.exit(1);
}

function printDiagnosticReport(stats, error = null) {
  const report = {
    status:       error ? 'ERRO' : 'OK',
    error:        error ? error.message : null,
    itens_totais: stats?.total  || 0,
    itens_unicos: stats?.unique || 0,
    origem:       { api: stats?.fromAPI || 0 },
    cambio:       stats?.displayRate || 'N/A',
    timestamp:    new Date().toISOString(),
  };
  console.log('\n==================================================');
  console.log('📋 RELATÓRIO DE DIAGNÓSTICO');
  console.log('==================================================');
  console.log(JSON.stringify(report, null, 2));
  console.log('==================================================\n');
}

function printItemTable(results) {
  console.log('\n  📦  PREÇOS POR ITEM (unitário × quantidade):\n');

  console.log(
    '  ' +
    'Item'.padEnd(45) +
    'Qtd'.padStart(4) +
    '  BUFF unit'.padStart(12) +
    '  BUFF total'.padStart(13) +
    '  YOUPIN unit'.padStart(14) +
    '  YOUPIN total'.padStart(15)
  );
  console.log('  ' + '─'.repeat(103));

  for (const item of results) {
    const name = item.name.length > 44
      ? item.name.slice(0, 41) + '...'
      : item.name;

    const buffUnit  = `R$${item.buffBRLUnit}`;
    const buffTotal = `R$${item.buffBRL}`;
    const ypUnit    = `R$${item.youpinBRLUnit}`;
    const ypTotal   = `R$${item.youpinBRL}`;

    const diff = Math.abs(Number(item.buffBRL) - Number(item.youpinBRL));
    const pct  = Number(item.buffBRL) > 0
      ? (diff / Number(item.buffBRL) * 100)
      : 0;
    const flag = pct > 10 ? ' ⚠' : '';

    console.log(
      '  ' +
      name.padEnd(45) +
      String(item.quantity).padStart(4) +
      buffUnit.padStart(12) +
      buffTotal.padStart(13) +
      ypUnit.padStart(14) +
      (ypTotal + flag).padStart(15)
    );
  }
  console.log('  ' + '─'.repeat(103));
}

function printResults({ results, totalBuffBRL, totalYouPinBRL, displayRate, stats }) {
  console.log('\n');
  logger.banner('RESUMO DE VALORES');
  console.log(`  💰  Total BUFF      →  R$ ${Number(totalBuffBRL).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  console.log(`  💰  Total YouPin    →  R$ ${Number(totalYouPinBRL).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  console.log(`  💱  Câmbio         →  ${displayRate}`);
  console.log(`  📊  Estatísticas   →  ${stats.total} itens | ${stats.unique} únicos`);

  printItemTable(results);

  console.log(`\n  💰  Total BUFF      →  R$ ${Number(totalBuffBRL).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  console.log(`  💰  Total YouPin    →  R$ ${Number(totalYouPinBRL).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  console.log('');
  logger.divider();
  printDiagnosticReport({ ...stats, displayRate });
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.log(`\nUso:\n  node src/index.js "<trade_link>" [--calibrar]\n`);
    process.exit(0);
  }

  logger.banner('CS2 Inventory Pricer v3.1');

  try {
    await setupDatabase();

    if (process.argv.includes('--calibrar')) {
      await calibrarTaxa(API_KEY);
    }

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