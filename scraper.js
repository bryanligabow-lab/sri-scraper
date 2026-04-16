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

    // Tipo de comprobante = Factura
    console.log('  Seleccionando tipo: Factura...');
    const selTipo = page.locator('select[id*="tipoComprobante"], select[id*="comprobante"], select[id*="tipo"]').first();
    if (await selTipo.count()) {
      const opcionesDisponibles = await selTipo.locator('option').allTextContents().catch(() => []);
      console.log('    Opciones tipo:', JSON.stringify(opcionesDisponibles));

      // Intentar seleccionar "Factura" de varias formas
      let seleccionado = false;
      for (const intento of [
        { type: 'label', value: 'Factura' },
        { type: 'label', value: 'FACTURA' },
        { type: 'value', value: '1' },
        { type: 'value', value: '01' },
      ]) {
        try {
          if (intento.type === 'label') {
            await selTipo.selectOption({ label: intento.value });
          } else {
            await selTipo.selectOption(intento.value);
          }
          seleccionado = true;
          console.log(`    Tipo seleccionado: ${intento.value}`);
          break;
        } catch {}
      }
      if (!seleccionado) console.log('    No se pudo seleccionar tipo');
      await page.waitForTimeout(500);
    } else {
      console.log('    Dropdown de tipo no encontrado');
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
      // Esperar un poco más para que termine de cargar la tabla (JSF es lento)
      await page.waitForTimeout(5000);

      // Primero verificar si hay resultados en la tabla (probamos varios selectores)
      const hayTabla = await page.evaluate(() => {
        const selectores = [
          '[id*="tablaCompRecibidos"] tbody tr',
          '.ui-datatable-data tr',
          '[role="row"]',
          'table.ui-datatable-data tr',
          '[id*="tabla"] tbody tr',
        ];
        for (const sel of selectores) {
          const filas = document.querySelectorAll(sel);
          if (filas.length > 0) return { count: filas.length, selector: sel };
        }
        return { count: 0, selector: null };
      });
      console.log(`  Filas en tabla: ${hayTabla.count} (selector: ${hayTabla.selector || 'ninguno'})`);

      if (hayTabla.count === 0) {
        console.log('  No hay facturas en el período consultado. Screenshot...');
        await page.screenshot({ path: '/tmp/sri-sin-resultados.png', fullPage: true }).catch(() => {});
        await page.close();
        return {
          ok: true,
          facturas,
          totalArchivos: 0,
          mensaje: `No hay facturas en ${anio}-${String(mes).padStart(2, '0')}`,
        };
      }

      console.log('  Descargando reporte con múltiples estrategias...');

      // Esperar un poco para que reCAPTCHA y JSF terminen de cargar
      await page.waitForTimeout(3000);

      // Scroll al link para que sea visible
      await linkReporte.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(1500);

      // Obtener coordenadas del link para click nativo
      const boundingBox = await linkReporte.boundingBox().catch(() => null);
      console.log(`    Link bounding box: ${JSON.stringify(boundingBox)}`);

      // Registrar TODAS las requests y responses para debug
      const allRequests = [];
      const allResponses = [];
      let responseCapturada = null;

      const requestHandler = (req) => {
        allRequests.push({ url: req.url().substring(0, 100), method: req.method() });
      };
      const responseHandler = async (response) => {
        const url = response.url();
        const status = response.status();
        const headers = response.headers();
        const contentType = (headers['content-type'] || '').toLowerCase();
        const contentDisp = (headers['content-disposition'] || '').toLowerCase();
        allResponses.push({ url: url.substring(0, 100), status, contentType: contentType.substring(0, 50) });

        if (
          contentDisp.includes('attachment') ||
          contentDisp.includes('filename') ||
          contentType.includes('excel') ||
          contentType.includes('spreadsheet') ||
          contentType.includes('ms-excel') ||
          contentType.includes('vnd.ms') ||
          contentType.includes('octet-stream') ||
          contentType.includes('application/zip')
        ) {
          console.log(`    Response con archivo: ${url.substring(0, 80)}`);
          console.log(`      content-type: ${contentType}, disposition: ${contentDisp.substring(0, 80)}`);
          try {
            const body = await response.body();
            if (body && body.length > 100) {
              responseCapturada = { body, contentType, contentDisp, url };
              console.log(`      body capturado: ${(body.length / 1024).toFixed(1)}KB`);
            }
          } catch (e) {
            console.log('      Error leyendo body:', e.message);
          }
        }
      };
      page.on('request', requestHandler);
      page.on('response', responseHandler);

      // Método principal: hacer el form POST directo con fetch desde el browser
      // Esto simula exactamente lo que hace mojarra.jsfcljs pero capturamos la response
      let dl = null;
      console.log('    Extrayendo ViewState y haciendo POST directo...');

      const resultadoPost = await page.evaluate(async () => {
        const form = document.getElementById('frmPrincipal');
        if (!form) return { ok: false, error: 'form no encontrado' };

        const viewState = form.querySelector('input[name="javax.faces.ViewState"]');
        if (!viewState) return { ok: false, error: 'ViewState no encontrado' };

        // Usar URLSearchParams (application/x-www-form-urlencoded) en vez de FormData
        // JSF submit tradicional usa urlencoded, no multipart
        const params = new URLSearchParams();
        const inputs = form.querySelectorAll('input, select, textarea');
        inputs.forEach(input => {
          if (input.name && input.type !== 'submit') {
            if (input.type === 'checkbox' || input.type === 'radio') {
              if (input.checked) params.append(input.name, input.value);
            } else {
              params.append(input.name, input.value || '');
            }
          }
        });
        // Agregar el parámetro que identifica qué link se clickeó
        params.append('frmPrincipal:lnkTxtlistado', 'frmPrincipal:lnkTxtlistado');

        const action = form.getAttribute('action') || window.location.href;

        try {
          const resp = await fetch(action, {
            method: 'POST',
            body: params.toString(),
            credentials: 'include',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'Accept': '*/*',
            },
          });

          const contentType = resp.headers.get('content-type') || '';
          const contentDisp = resp.headers.get('content-disposition') || '';

          // Si es un archivo, lo convertimos a base64
          if (contentType.includes('excel') || contentType.includes('octet-stream') ||
              contentType.includes('ms-excel') || contentType.includes('spreadsheet') ||
              contentDisp.includes('attachment') || contentDisp.includes('filename')) {
            const buffer = await resp.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
            return {
              ok: true,
              base64: btoa(binary),
              contentType,
              contentDisp,
              size: buffer.byteLength,
            };
          }

          const text = await resp.text();
          return {
            ok: false,
            status: resp.status,
            contentType,
            contentDisp,
            bodyPreview: text.substring(0, 500),
          };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }).catch(e => ({ ok: false, error: 'evaluate error: ' + e.message }));

      console.log('    Resultado POST:', JSON.stringify({
        ok: resultadoPost.ok,
        contentType: resultadoPost.contentType?.substring(0, 50),
        contentDisp: resultadoPost.contentDisp?.substring(0, 80),
        size: resultadoPost.size,
        status: resultadoPost.status,
        error: resultadoPost.error,
        preview: resultadoPost.bodyPreview?.substring(0, 100),
      }, null, 2));

      if (resultadoPost.ok && resultadoPost.base64) {
        // Extraer nombre del content-disposition
        let nombre = `reporte_facturas_${anio}_${String(mes).padStart(2, '0')}.xls`;
        const matchNombre = (resultadoPost.contentDisp || '').match(/filename[*]?=["']?([^"';]+)/i);
        if (matchNombre) nombre = matchNombre[1].replace(/['"]/g, '');

        const ext = nombre.split('.').pop().toLowerCase();
        facturas.push({
          nombre,
          contenido: resultadoPost.base64,
          tipo: ext,
          mimeType: resultadoPost.contentType || 'application/vnd.ms-excel',
          info: `Reporte facturas recibidas ${anio}-${String(mes).padStart(2, '0')}`,
        });
        console.log(`  ✓ Reporte descargado (POST directo): ${nombre} (${(resultadoPost.size / 1024).toFixed(1)}KB)`);
      } else {
        console.log('  ✗ POST directo falló. Probando page.mouse.click con coordenadas reales...');

        // Estrategia 2: Click nativo con mouse (trusted event)
        if (boundingBox) {
          const cx = boundingBox.x + boundingBox.width / 2;
          const cy = boundingBox.y + boundingBox.height / 2;
          console.log(`    Click en (${cx.toFixed(0)}, ${cy.toFixed(0)})...`);

          const [download1] = await Promise.all([
            page.waitForEvent('download', { timeout: 45000 }).catch(() => null),
            page.mouse.click(cx, cy, { delay: 100 }).catch(e => console.log('    Error mouse.click:', e.message)),
          ]);

          if (download1) {
            dl = download1;
            const ruta = await dl.path();
            if (ruta) {
              const nombre = dl.suggestedFilename() || `reporte_facturas_${anio}_${mes}.xls`;
              const contenido = fs.readFileSync(ruta);
              const ext = nombre.split('.').pop().toLowerCase();
              facturas.push({
                nombre,
                contenido: contenido.toString('base64'),
                tipo: ext,
                mimeType: ext === 'pdf' ? 'application/pdf' : 'application/vnd.ms-excel',
                info: `Reporte facturas recibidas ${anio}-${String(mes).padStart(2, '0')}`,
              });
              console.log(`  ✓ Reporte descargado (mouse.click): ${nombre}`);
            }
          }
        }

        // Estrategia 3: Click de Playwright con force como último recurso
        if (facturas.length === 0) {
          console.log('    Probando linkReporte.click({force: true})...');
          const [download2] = await Promise.all([
            page.waitForEvent('download', { timeout: 30000 }).catch(() => null),
            linkReporte.click({ force: true }).catch(e => console.log('    Error click:', e.message)),
          ]);

          if (download2) {
            dl = download2;
            const ruta = await dl.path();
            if (ruta) {
              const nombre = dl.suggestedFilename() || `reporte_facturas_${anio}_${mes}.xls`;
              const contenido = fs.readFileSync(ruta);
              const ext = nombre.split('.').pop().toLowerCase();
              facturas.push({
                nombre,
                contenido: contenido.toString('base64'),
                tipo: ext,
                mimeType: ext === 'pdf' ? 'application/pdf' : 'application/vnd.ms-excel',
                info: `Reporte facturas recibidas ${anio}-${String(mes).padStart(2, '0')}`,
              });
              console.log(`  ✓ Reporte descargado (force click): ${nombre}`);
            }
          }
        }

        if (responseCapturada) {
          let nombre = `reporte_facturas_${anio}_${String(mes).padStart(2, '0')}.xls`;
          const matchNombre = (responseCapturada.contentDisp || '').match(/filename[*]?=["']?([^"';]+)/i);
          if (matchNombre) nombre = matchNombre[1].replace(/['"]/g, '');
          const ext = nombre.split('.').pop().toLowerCase();
          facturas.push({
            nombre,
            contenido: responseCapturada.body.toString('base64'),
            tipo: ext,
            mimeType: responseCapturada.contentType || 'application/vnd.ms-excel',
            info: `Reporte facturas recibidas ${anio}-${String(mes).padStart(2, '0')}`,
          });
          console.log(`  ✓ Reporte guardado (HTTP response): ${nombre}`);
        }

        // Si todavía no hay archivo, loggear las últimas requests/responses para debug
        if (facturas.length === 0) {
          console.log('  Últimas 10 requests:', JSON.stringify(allRequests.slice(-10), null, 2));
          console.log('  Últimas 10 responses:', JSON.stringify(allResponses.slice(-10), null, 2));
        }
      }

      page.off('request', requestHandler);
      page.off('response', responseHandler);

      if (facturas.length === 0) {
        console.log('  ✗ No se pudo descargar el reporte. Screenshot...');
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
