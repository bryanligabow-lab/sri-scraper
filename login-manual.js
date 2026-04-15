require('dotenv').config();
const { loginManual } = require('./scraper');

loginManual().catch(console.error);
