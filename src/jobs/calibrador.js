// src/jobs/calibrador.js
const puppeteer = require('puppeteer');
const engine = require('../services/CurrencyEngine');
const logger = require('../utils/logger');

async function calibrarCSFloat() {
  logger.info('Iniciando Bot Calibrador no CSFloat...');
  
  // Abre um navegador invisível
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();

  try {
    // 1. Vamos até a página de uma skin sentinela bem comum (ex: AK-47 Slate FT)
    await page.goto('https://csfloat.com/search?def_index=47&paint_index=1035&wear_tier=2', { waitUntil: 'networkidle2' });

    // 2. Aqui o bot raspa a tela para ler o preço em BRL
    // (O seletor exato depende do HTML do site, isso é um exemplo da lógica)
    const priceBRLText = await page.$eval('.item-price-brl', el => el.innerText); 
    const priceUSDText = await page.$eval('.item-price-usd', el => el.innerText);

    // 3. Limpa os textos (tira o "R$" e o "$")
    const valorBRL = Number(priceBRLText.replace(/[^0-9.-]+/g,""));
    const valorUSD = Number(priceUSDText.replace(/[^0-9.-]+/g,""));

    // 4. MANDA PARA A INTELIGÊNCIA DO NOSSO MOTOR!
    if (valorBRL > 0 && valorUSD > 0) {
      engine.calibrarAutomaticamente('csfloat', valorUSD, 'USD', valorBRL);
      logger.success(`CSFloat Calibrado! A taxa oculta deles hoje é: ${(valorBRL / valorUSD).toFixed(2)}`);
    }

  } catch (error) {
    logger.error(`Erro ao calibrar CSFloat: ${error.message}`);
  } finally {
    await browser.close(); // Fecha o navegador para não gastar memória
  }
}

// Exportamos a função para rodar a cada X horas no index.js
module.exports = { calibrarCSFloat };