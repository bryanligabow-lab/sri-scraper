const { chromium } = require('playwright');
const fs = require('fs');

const BROWSER_DATA_DIR = process.env.BROWSER_DATA_DIR || './browser-data';
const SRI_RUC = process.env.SRI_RUC;
const SRI_CLAVE = process.env.SRI_CLAVE;

const SRI_COMPROBANTES_URL = 'https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/pages/consultas/recibidos/comprobantesRecibidos.jsf';
const SRI_LOGIN_URL = 'https://srienlinea.sri.gob.ec/tuportal-internet/';

const TIMEOUT_NAV = 60000;
const TIMEOUT_DESCARGA = 30000;

// ========== BROWSER SINGLETON ==========
let _browserCtx = null;

async function obtenerContexto() {
  if (_browserCtx) return _browserCtx;

  fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
  ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
    try { fs.unlinkSync(`${BROWSER_DATA_DIR}/${f}`); } catch {}
  });

  _browserCtx = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 900 },
    locale: 'es-EC',
    timezoneId: 'America/Guayaquil',
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  console.log('Browser singleton creado');
  return _browserCtx;
}

async function cerrarContexto() {
  if (_browserCtx) {
    await _browserCtx.close().catch(() => {});
    _browserCtx = null;
  }
}

// ========== LOGIN CON DOBLE REDIRECT ==========
async function hacerLogin(page) {
  if (!SRI_RUC || !SRI_CLAVE) {
    return { ok: false, error: 'credenciales', mensaje: 'SRI_RUC y SRI_CLAVE no configurados' };
  }

  // El SRI hace doble redirect: login → recarga → login otra vez → entra
  for (let intento = 1; intento <= 3; intento++) {
    console.log(`  Login intento ${intento}/3...`);

    // Esperar a que cargue el formulario
    await page.waitForTimeout(2000);
    const url = page.url();

    // Si ya no estamos en login, éxito
    if (!url.includes('login') && !url.includes('auth/realms') && !url.includes('tuportal-internet')) {
      console.log('  Login exitoso en intento', intento);
      return { ok: true };
    }

    // Buscar campos del formulario
    const campoUsuario = page.locator('input#usuario').first();
    const campoClave = page.locator('input#password, input[type="password"]').first();

    if (await campoUsuario.count() === 0 || await campoClave.count() === 0) {
      // Puede que estemos en una página intermedia, esperar
      await page.waitForTimeout(3000);
      continue;
    }

    // Llenar usuario con keyboard.type para activar JS handlers del SRI
    await campoUsuario.click();
    await campoUsuario.fill('');
    await page.keyboard.type(SRI_RUC, { delay: 20 });
    await page.waitForTimeout(300);

    // Copiar al campo hidden 'username'
    await page.evaluate((ruc) => {
      const h = document.getElementById('username');
      if (h) h.value = ruc;
    }, SRI_RUC);

    // Llenar clave
    await campoClave.click();
    await campoClave.fill('');
    await page.keyboard.type(SRI_CLAVE, { delay: 20 });
    await page.waitForTimeout(500);

    // Click en botón de login
    const boton = page.locator('input#kc-login, input[name="login"], button[type="submit"]').first();
    if (await boton.count() > 0) {
      await boton.click();
    }

    // Esperar navegación
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  // Verificar si quedamos logueados
  const urlFinal = page.url();
  if (urlFinal.includes('login') || urlFinal.includes('auth/realms')) {
    const errTexts = await page.locator('.alert, .kc-feedback-text, [class*="error"]').allTextContents().catch(() => []);
    return { ok: false, error: 'login_fallido', mensaje: errTexts.join(' ').trim() || 'Login fallido después de 3 intentos' };
  }

  console.log('  Login exitoso');
  return { ok: true };
}

// ========== NAVEGAR A COMPROBANTES ==========
async function navegarAComprobantes(page) {
  console.log('  Navegando a comprobantes recibidos...');
  await page.goto(SRI_COMPROBANTES_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
  await page.waitForTimeout(3000);

  let url = page.url();

  // Si nos redirige a login, hacer login y volver a intentar
  if (url.includes('login') || url.includes('auth/realms')) {
    console.log('  Sesión expirada, haciendo login...');

    const loginResult = await hacerLogin(page);
    if (!loginResult.ok) return loginResult;

    // Después del login, ir directo a comprobantes recibidos
    console.log('  URL post-login:', page.url().substring(0, 100));

    // Intentar ir directo a comprobantes recibidos con el link del portal
    console.log('  Navegando a comprobantes recibidos...');
    await page.goto('https://srienlinea.sri.gob.ec/tuportal-internet/accederAplicacion.jspa?redireccion=57&idGrupo=55', { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
    await page.waitForTimeout(5000);
    url = page.url();
    console.log('  URL después de accederAplicacion:', url.substring(0, 100));

    // Si redirige a login, tal vez necesitamos otro intento de login desde aquí
    if (url.includes('login') || url.includes('auth/realms')) {
      console.log('  Sesión aún no válida, intentando login desde aquí...');
      const loginResult2 = await hacerLogin(page);
      if (loginResult2.ok) {
        // Después del 2do login, navegar directo
        await page.goto('https://srienlinea.sri.gob.ec/tuportal-internet/accederAplicacion.jspa?redireccion=57&idGrupo=55', { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
        await page.waitForTimeout(5000);
        url = page.url();
        console.log('  URL después de 2do intento:', url.substring(0, 100));
      }
    }

    // Si aún redirige, ir vía el link directo del portal a "Comprobantes electrónicos recibidos"
    if (url.includes('login') || url.includes('auth/realms')) {
      console.log('  Intentando link directo del portal...');
      await page.goto('https://srienlinea.sri.gob.ec/tuportal-internet/accederAplicacion.jspa?redireccion=57&idGrupo=55', { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
      await page.waitForTimeout(5000);
      url = page.url();
    }

    if (url.includes('login') || url.includes('auth/realms')) {
      return { ok: false, error: 'sesion', mensaje: 'No se pudo acceder a comprobantes después del login' };
    }
  }

  console.log('  En comprobantes recibidos');
  return { ok: true };
}

// ========== DESCARGAR FACTURAS ==========
async function descargarFacturas(anio, mes) {
  const context = await obtenerContexto();
  const page = await context.newPage();
  const facturas = [];

  try {
    // 1. Navegar a comprobantes
    const navResult = await navegarAComprobantes(page);
    if (!navResult.ok) {
      await page.close();
      return navResult;
    }

    // 2. Configurar filtros
    console.log(`  Filtros: año=${anio}, mes=${mes}`);

    const selAnio = page.locator('select[id*="ano"], select[id*="anio"]').first();
    if (await selAnio.count()) {
      await selAnio.selectOption(String(anio));
      await page.waitForTimeout(500);
    }

    const selMes = page.locator('select[id*="mes"]').first();
    if (await selMes.count()) {
      await selMes.selectOption(String(mes));
      await page.waitForTimeout(500);
    }

    const selDia = page.locator('select[id*="dia"]').first();
    if (await selDia.count()) {
      try { await selDia.selectOption('0'); } catch {
        try { await selDia.selectOption({ label: 'Todos' }); } catch {}
      }
      await page.waitForTimeout(300);
    }

    // 3. Click en Consultar primero
    console.log('  Click en Consultar...');
    const selectoresConsultar = [
      'a#frmPrincipal\\:btnRecaptcha',
      'a[id="frmPrincipal:btnRecaptcha"]',
      '[id*="btnRecaptcha"]',
      '[id*="frmPrincipal"] button:has-text("Consultar")',
      '[id*="frmPrincipal"] a:has-text("Consultar")',
      'button:visible:has-text("Consultar")',
      'a:visible:has-text("Consultar")',
      'input[value="Consultar"]:visible',
    ];

    let consultaHecha = false;
    for (const sel of selectoresConsultar) {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
        console.log(`    Usando selector: ${sel}`);
        await btn.click();
        await page.waitForTimeout(10000);
        consultaHecha = true;
        break;
      }
    }

    if (!consultaHecha) {
      console.log('  NO se encontró botón Consultar. Tomando screenshot...');
      await page.screenshot({ path: '/tmp/sri-no-consultar.png', fullPage: true }).catch(() => {});
      // Intentar listar todos los botones/links visibles
      const elementos = await page.evaluate(() => {
        const result = [];
        document.querySelectorAll('button, a, input[type="submit"], input[type="button"]').forEach(el => {
          const text = (el.innerText || el.value || '').trim().substring(0, 50);
          if (text && el.offsetWidth > 0) {
            result.push({ tag: el.tagName, id: el.id, text, visible: el.offsetWidth > 0 });
          }
        });
        return result.slice(0, 20);
      }).catch(() => []);
      console.log('  Elementos visibles:', JSON.stringify(elementos, null, 2));
    } else {
      console.log('  Consulta ejecutada, esperando resultados...');
    }

    // 4. Click en "Descargar reporte"
    console.log('  Buscando link "Descargar reporte"...');
    const selectoresReporte = [
      '#frmPrincipal\\:lnkTxtlistado',
      'a[id="frmPrincipal:lnkTxtlistado"]',
      'a:has-text("Descargar reporte")',
      'a:has(p:has-text("Descargar reporte"))',
      '[id*="lnkTxtlistado"]',
    ];

    let linkReporte = null;
    for (const sel of selectoresReporte) {
      const l = page.locator(sel).first();
      const cnt = await l.count();
      if (cnt > 0) {
        console.log(`    Encontrado con: ${sel} (${cnt} matches)`);
        linkReporte = l;
        break;
      }
    }

    if (linkReporte) {
      console.log('  Descargando reporte...');
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: TIMEOUT_DESCARGA }).catch(() => null),
        linkReporte.click({ force: true }).catch(e => console.log('    Error click:', e.message)),
      ]);

      if (dl) {
        const ruta = await dl.path();
        if (ruta) {
          const nombre = dl.suggestedFilename() || `reporte_facturas_${anio}_${mes}.xls`;
          const contenido = fs.readFileSync(ruta);
          const ext = nombre.split('.').pop().toLowerCase();

          facturas.push({
            nombre,
            contenido: contenido.toString('base64'),
            tipo: ext,
            mimeType: ext === 'pdf' ? 'application/pdf' : ext === 'xml' ? 'application/xml' : 'application/vnd.ms-excel',
            info: `Reporte facturas recibidas ${anio}-${String(mes).padStart(2, '0')}`,
          });

          console.log(`  Reporte descargado: ${nombre} (${(contenido.length / 1024).toFixed(1)}KB)`);
        }
      } else {
        console.log('  No se inició descarga del reporte. Tomando screenshot...');
        await page.screenshot({ path: '/tmp/sri-no-descarga.png', fullPage: true }).catch(() => {});
      }
    } else {
      console.log('  NO se encontró link de Descargar reporte. Tomando screenshot...');
      await page.screenshot({ path: '/tmp/sri-no-reporte.png', fullPage: true }).catch(() => {});
    }

    await page.close();
    return {
      ok: true,
      facturas,
      totalArchivos: facturas.length,
      mensaje: `${facturas.length} archivos descargados`,
    };
  } catch (err) {
    console.error('Error general:', err.message);
    await page.screenshot({ path: '/tmp/sri-error.png', fullPage: true }).catch(() => {});
    await page.close().catch(() => {});
    return { ok: false, error: 'general', mensaje: err.message };
  }
}

module.exports = { descargarFacturas, cerrarContexto };
