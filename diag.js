#!/usr/bin/env node
require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');

async function quickDiag() {
    console.log("🔍 INICIANDO DIAGNÓSTICO COMPLETO...\n");
    const results = {
        env_key: !!process.env.CSINVENTORY_API_KEY,
        env_db: !!process.env.DATABASE_URL,
        api_status: 'unknown',
        db_status: 'unknown',
        timestamp: new Date().toISOString()
    };

    // 1. Teste da API
    try {
        const res = await axios.get('https://csinventoryapi.com/api/v2/prices', { 
            params: { api_key: process.env.CSINVENTORY_API_KEY, source: 'buff163', app_id: 730 },
            timeout: 5000 
        } );
        results.api_status = res.status === 200 ? 'ONLINE (OK)' : 'ERRO NA API';
    } catch (e) {
        results.api_status = 'OFFLINE OU CHAVE INVÁLIDA';
    }

    // 2. Teste do Banco de Dados
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const client = await pool.connect();
        const res = await client.query('SELECT NOW()');
        results.db_status = res.rows.length > 0 ? 'CONECTADO (OK)' : 'ERRO NA CONSULTA';
        client.release();
    } catch (e) {
        results.db_status = 'ERRO DE CONEXÃO: ' + e.message;
    } finally {
        await pool.end();
    }

    console.log('📋 COPIE E COLE ISSO PARA O MANUS:');
    console.log('==================================================');
    console.log(JSON.stringify(results, null, 2));
    console.log('==================================================');
}

quickDiag();
