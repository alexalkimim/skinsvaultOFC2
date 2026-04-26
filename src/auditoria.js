require('dotenv').config();
const axios = require('axios');
const engine = require('./services/CurrencyEngine');

const API_KEY = process.env.CSINVENTORY_API_KEY;

// A nossa "Hitlist" de 15 skins para teste de fogo
const SKINS_AUDITORIA = [
  "AK-47 | Redline (Field-Tested)",
  "AWP | Asiimov (Field-Tested)",
  "★ Karambit | Vanilla",
  "★ Butterfly Knife | Doppler (Factory New)",
  "M4A1-S | Printstream (Field-Tested)",
  "USP-S | Kill Confirmed (Field-Tested)",
  "Glock-18 | Water Elemental (Factory New)",
  "Desert Eagle | Printstream (Field-Tested)",
  "★ Driver Gloves | Imperial Plaid (Field-Tested)",
  "AK-47 | Slate (Field-Tested)",
  "M4A4 | The Emperor (Field-Tested)",
  "AWP | Atheris (Field-Tested)",
  "MAC-10 | Neon Rider (Factory New)",
  "★ Hand Wraps | Badlands (Field-Tested)",
  "Sticker | Titan | Katowice 2014"
];

async function fetchExchangeRate() {
  const { data } = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL,CNY-BRL', { timeout: 8000 });
  const usdBrl = Number(data.USDBRL.bid);
  const cnyBrl = process.env.BUFF_BALANCE_RATE ? Number(process.env.BUFF_BALANCE_RATE) : Number(data.CNYBRL.bid);
  engine.atualizarCambio(usdBrl, cnyBrl);
  console.log(`\n💱 Câmbio Motor: 1 USD = R$ ${usdBrl.toFixed(2)} | 1 CNY (Saldo) = R$ ${cnyBrl.toFixed(4)}\n`);
}

async function fetchSourcePrices(source) {
  const { data } = await axios.get('https://csinventoryapi.com/api/v2/prices', {
    params: { api_key: API_KEY, source, app_id: 730 }
  });
  const pricesObj = data.data || data.items || data;
  const priceMap = new Map();

  for (const [name, info] of Object.entries(pricesObj)) {
    if (name === 'success') continue;
    let priceUSD = info?.sell_price_cents?.usd ? (info.sell_price_cents.usd / 100) : (info?.sell_price || 0);
    priceMap.set(name, priceUSD);
  }
  return priceMap;
}

async function runAuditoria() {
  console.log("🔍 Iniciando Auditoria de Preços...");
  await fetchExchangeRate();

  console.log("Baixando dados da API (Buff, Youpin, CSFloat)... aguarde.");
  const [buffPrices, youpinPrices, csfloatPrices] = await Promise.all([
    fetchSourcePrices('buff163'),
    fetchSourcePrices('youpin'),
    fetchSourcePrices('csfloat')
  ]);

  console.log("==========================================================================================");
  console.log(" 📋 RELATÓRIO DE AUDITORIA (CÓDIGO) vs (REALIDADE)");
  console.log("==========================================================================================\n");

  for (const skin of SKINS_AUDITORIA) {
    // 💡 O TRUQUE DO VANILLA: Se a skin tiver " | Vanilla", ele apaga essa parte antes de procurar!
    const nomeRealAPI = skin.replace(' | Vanilla', '');

    const bUsd = buffPrices.get(nomeRealAPI) || 0;
    const yUsd = youpinPrices.get(nomeRealAPI) || 0;
    const cUsd = csfloatPrices.get(nomeRealAPI) || 0;

    const buffFinal    = bUsd > 0 ? engine.converterPreco(bUsd, 'BUFF_USD_FAKE', 'buff').toFixed(2) : "N/A";
    const youpinFinal  = yUsd > 0 ? engine.converterPreco(yUsd, 'BUFF_USD_FAKE', 'youpin').toFixed(2) : "N/A";
    const csfloatFinal = cUsd > 0 ? engine.converterPreco(cUsd, 'USD', 'csfloat').toFixed(2) : "N/A";

    console.log(`🔫 ${skin}`);
    console.log(`   🔸 BUFF    | Código: R$ ${String(buffFinal).padStart(8)}  |  Site: R$ _________`);
    console.log(`   🔹 YOUPIN  | Código: R$ ${String(youpinFinal).padStart(8)}  |  App:  R$ _________`);
    console.log(`   🟢 CSFLOAT | Código: R$ ${String(csfloatFinal).padStart(8)}  |  Site: R$ _________`);
    console.log("------------------------------------------------------------------------------------------");
  }
}

runAuditoria().catch(err => console.error("Erro na auditoria:", err.message));