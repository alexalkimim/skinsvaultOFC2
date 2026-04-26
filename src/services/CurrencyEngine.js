const logger = require('../utils/logger');

class CurrencyEngine {
  constructor() {
    this.cambio = {
      USD_BRL: 5.00,
      CNY_BRL: 0.74,
    };

    this.perfis = {
      buff: {
        moedaNativa: 'USD',
        taxaFixa: 0,
        spreadCambial: 0,
        arredondamento: 'round',
        casas: 2,
        fatorCalibracao: 1.0
      },
      youpin: {
        moedaNativa: 'USD',
        taxaFixa: 0,
        spreadCambial: 0,
        arredondamento: 'round',
        casas: 2,
        fatorCalibracao: 1.0
      }
    };
  }

  atualizarCambio(usdBrl, cnyBrl) {
    this.cambio.USD_BRL = usdBrl;
    this.cambio.CNY_BRL = cnyBrl;
  }

  aplicarArredondamento(valor, metodo, casas) {
    const multiplicador = Math.pow(10, casas);
    switch (metodo) {
      case 'floor': return Math.floor(valor * multiplicador) / multiplicador;
      case 'ceil':  return Math.ceil(valor * multiplicador) / multiplicador;
      case 'round': default: return Math.round(valor * multiplicador) / multiplicador;
    }
  }

  converterPreco(valor, moedaOrigem, site) {
    const perfil = this.perfis[site.toLowerCase()];
    if (!perfil) throw new Error(`Site não suportado: ${site}`);

    let valorBaseBRL = 0;

    // Agora convertemos diretamente com a cotação do segundo exato da AwesomeAPI
    if (moedaOrigem === 'USD') {
      valorBaseBRL = valor * this.cambio.USD_BRL;
    } else if (moedaOrigem === 'CNY') {
      valorBaseBRL = valor * this.cambio.CNY_BRL;
    } else if (moedaOrigem === 'BRL') {
      valorBaseBRL = valor;
    }

    let valorComSpread = valorBaseBRL * (1 + perfil.spreadCambial);
    let valorComTaxa = valorComSpread * (1 + perfil.taxaFixa);
    let valorCalibrado = valorComTaxa * perfil.fatorCalibracao;

    return this.aplicarArredondamento(valorCalibrado, perfil.arredondamento, perfil.casas);
  }
}

module.exports = new CurrencyEngine();