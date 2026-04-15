require('dotenv').config();
const express = require('express');
const { descargarFacturas } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3050;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/descargar-facturas', async (req, res) => {
  const ahora = new Date();
  const anio = req.body.anio || ahora.getFullYear();
  const mes = req.body.mes || (ahora.getMonth() + 1);

  console.log(`[${ahora.toISOString()}] Descarga: año=${anio}, mes=${mes}`);

  try {
    const resultado = await descargarFacturas(anio, mes);
    console.log(`[${new Date().toISOString()}] ${resultado.mensaje || resultado.error}`);
    res.json(resultado);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message);
    res.status(500).json({ ok: false, error: 'servidor', mensaje: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nSRI Scraper corriendo en puerto ${PORT}`);
  console.log(`RUC: ${process.env.SRI_RUC ? 'Sí' : 'No'}\n`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
