'use strict'

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell, Notification } = require('electron')

Menu.setApplicationMenu(null)
const path   = require('path')
const os     = require('os')
const { v4: uuidv4 } = require('uuid')

// electron-store v8 é ESM — usar dynamic import
let Store
let store
let mqtt
let axios
let pdfPrint

// ─── Constantes ──────────────────────────────────────────────────────────────

const HUB_API   = process.env.HUB_API_URL   || 'https://api.maximushub.com.br/api/v1'
const HUB_MQTT  = process.env.HUB_MQTT_URL  || 'wss://api.maximushub.com.br/mqtt'
const APP_VERSION = require('./package.json').version

// ─── Estado global ───────────────────────────────────────────────────────────

let tray            = null
let loginWin        = null
let setupWin        = null
let mqttClient      = null
let trayStatus      = 'desconectado'
let updateDownloaded = false
let autoUpdater     = null

// ─── Boot ────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Imports dinâmicos (electron-store v8 é ESM puro)
  const { default: ElectronStore } = await import('electron-store')
  Store = ElectronStore
  store = new Store({
    name: 'maximushub-print-client',
    encryptionKey: 'mhub-prt-2024',
  })

  axios = require('axios')
  mqtt  = require('mqtt')

  // pdf-to-printer só funciona em produção com PDF disponível no sistema
  try { pdfPrint = require('pdf-to-printer') } catch (_) { pdfPrint = null }

  app.setLoginItemSettings({ openAtLogin: true })

  criarTray()
  setupAutoUpdater()

  const token = store.get('token')
  if (!token) {
    abrirLogin()
  } else {
    registrarAgente(token).then(() => conectarMqtt(token))
    // Verifica atualização na inicialização e a cada 5 min
    verificarAtualizacao()
    setInterval(verificarAtualizacao, 5 * 60 * 1000)
  }
})

app.on('window-all-closed', (e) => e.preventDefault()) // mantém rodando no tray

// ─── Tray ────────────────────────────────────────────────────────────────────

function criarTray () {
  const iconPath = path.join(__dirname, 'assets', 'icon-tray.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('MaximusHub Print Client')
  tray.on('double-click', abrirSetup)
  atualizarTray('desconectado')
}

function atualizarTray (status) {
  if (!tray) return
  trayStatus = status

  const labels = {
    conectado:    '● Conectado ao MaximusHub',
    desconectado: '○ Desconectado',
    conectando:   '◌ Conectando...',
  }

  const items = [
    { label: labels[status] || labels.desconectado, enabled: false },
    { type: 'separator' },
    { label: 'Gerenciar Impressoras', click: abrirSetup },
  ]

  if (status !== 'conectado') {
    items.push({ label: 'Reconectar', click: reconectar })
  }

  if (updateDownloaded) {
    items.push({ type: 'separator' })
    items.push({
      label: '⬆ Instalar atualização agora',
      click: () => {
        if (autoUpdater) autoUpdater.quitAndInstall(true, true)
      },
    })
  }

  items.push({ type: 'separator' })
  items.push({ label: `Sair (v${APP_VERSION})`, click: () => app.quit() })

  tray.setContextMenu(Menu.buildFromTemplate(items))
}

// ─── Janela de Login ─────────────────────────────────────────────────────────

function abrirLogin () {
  if (loginWin) { loginWin.focus(); return }

  loginWin = new BrowserWindow({
    width: 420, height: 520,
    resizable: false, center: true,
    title: 'MaximusHub Print Client',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  })

  loginWin.loadFile(path.join(__dirname, 'src', 'login.html'))
  loginWin.on('closed', () => { loginWin = null })
}

// ─── Janela de Setup (gerenciar impressoras) ──────────────────────────────────

function abrirSetup () {
  if (setupWin) { setupWin.focus(); return }

  setupWin = new BrowserWindow({
    width: 680, height: 560,
    resizable: true, center: true,
    title: 'Impressoras — MaximusHub',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  })

  setupWin.loadFile(path.join(__dirname, 'src', 'setup.html'))
  setupWin.on('closed', () => { setupWin = null })
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────

function conectarMqtt (token) {
  const agentUuid = garantirAgentUuid()
  const userId    = store.get('user_id')
  if (!userId) { abrirLogin(); return }

  atualizarTray('conectando')

  if (mqttClient) {
    mqttClient.end(true)
    mqttClient = null
  }

  mqttClient = mqtt.connect(HUB_MQTT, {
    clientId:           `agent_${userId}_${agentUuid}`,
    username:           token,
    password:           '',
    reconnectPeriod:    5000,
    connectTimeout:     15000,
    keepalive:          30,
    clean:              true,
    protocolVersion:    4,
  })

  mqttClient.on('connect', async () => {
    atualizarTray('conectado')
    mqttClient.subscribe(`hub/print/${userId}/${agentUuid}`, { qos: 1 })
    notificar('MaximusHub', 'Print Client conectado e pronto.')
    await sincronizarImpressoras(token, agentUuid)
  })

  mqttClient.on('message', async (topic, payload) => {
    try {
      const job = JSON.parse(payload.toString())
      await executarImpressao(job, token, userId, agentUuid)
    } catch (err) {
      console.error('[MQTT] Erro ao processar job:', err.message)
    }
  })

  mqttClient.on('error', (err) => {
    console.error('[MQTT] Erro:', err.message)
    atualizarTray('desconectado')
  })

  mqttClient.on('offline', () => atualizarTray('desconectado'))
  mqttClient.on('reconnect', () => atualizarTray('conectando'))
}

function reconectar () {
  const token = store.get('token')
  if (token) conectarMqtt(token)
  else abrirLogin()
}

// ─── Impressão ────────────────────────────────────────────────────────────────

async function executarImpressao (job, token, userId, agentUuid) {
  const { job_uuid, printer_system_name, type, data, zpl_host, zpl_port } = job
  let status = 'success'
  let errorMsg = null

  try {
    const buffer = Buffer.from(data, 'base64')

    if (type === 'zpl') {
      await imprimirZpl(buffer, zpl_host, zpl_port || 9100, printer_system_name)
    } else {
      await imprimirPdf(buffer, printer_system_name)
    }
  } catch (err) {
    status   = 'error'
    errorMsg = err.message
    console.error(`[PRINT] Falha no job ${job_uuid}:`, err.message)
  }

  // Publica ack
  mqttClient.publish(
    `hub/ack/${userId}/${job_uuid}`,
    JSON.stringify({ job_uuid, status, error: errorMsg }),
    { qos: 1 }
  )
}

// Escala de impressão por impressora (local). Modos:
//   label   = RECOMENDADO. Reescreve o PDF via pdf-lib para EXATAMENTE
//             100×150mm (288×432pt) e imprime noscale. Determinístico:
//             não depende do driver nem da heurística do SumatraPDF.
//   custom  = reescreve o PDF aplicando % definida pelo usuário (50-300).
//   auto    = lê o MediaBox do PDF e escolhe fit ou noscale (legado 1.0.3)
//   noscale = tamanho real do MediaBox (= 100% do PDF, NÃO 100% do driver)
//   shrink  = encolhe só se o conteúdo não couber
//   fit     = SumatraPDF ajusta à página configurada NO DRIVER (se o driver
//             estiver com papel errado, sai errado — por isso `label` é melhor)
//
// Config por impressora no electron-store (`pdf_scale_by_printer`):
//   string ('auto'|'noscale'|...)        — formato legado
//   { mode: 'label'|'custom'|..., pct }  — formato novo
const ESCALAS_PDF = ['label', 'custom', 'auto', 'noscale', 'shrink', 'fit']
function obterConfigEscala (printerName) {
  const map = store.get('pdf_scale_by_printer') || {}
  const v = map[printerName]
  if (typeof v === 'string' && ESCALAS_PDF.includes(v)) return { mode: v, pct: 100 }
  if (v && typeof v === 'object' && ESCALAS_PDF.includes(v.mode)) {
    return { mode: v.mode, pct: Math.min(300, Math.max(50, parseInt(v.pct) || 100)) }
  }
  return { mode: 'label', pct: 100 } // default novo: determinístico
}

/**
 * Lê o MediaBox da primeira página de um PDF sem dependência externa.
 * Funciona em ~95% dos PDFs (não funciona se o MediaBox vive em xref-stream
 * comprimido, raro em etiquetas geradas por marketplaces).
 *
 * @returns {{ widthPts:number, heightPts:number } | null}
 */
function lerMediaBoxPdf (filePath) {
  try {
    const fs = require('fs')
    const fd = fs.openSync(filePath, 'r')
    // 128KB cobre praticamente todos os PDFs simples
    const buf = Buffer.alloc(128 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const text = buf.slice(0, n).toString('latin1')
    const m = text.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/)
    if (!m) return null
    const [x1, y1, x2, y2] = m.slice(1, 5).map(parseFloat)
    return { widthPts: Math.abs(x2 - x1), heightPts: Math.abs(y2 - y1) }
  } catch (_) {
    return null
  }
}

/**
 * Decide a escala efetiva no modo 'auto'.
 *
 * Heurística: compara o MediaBox do PDF (em pontos, 1pt = 1/72 polegada) com o
 * tamanho-alvo de uma etiqueta 4×6" (288×432 pt). Se alguma dimensão do PDF é
 * <85% do alvo, considera PDF "menor que a etiqueta" e aplica `fit` (escala
 * proporcional para preencher). Caso contrário, `noscale` mantém fidelidade.
 *
 * Sem leitura do MediaBox → `fit` por segurança (etiqueta cheia > etiqueta no
 * canto do papel).
 */
function decidirEscalaAuto (filePath) {
  const mb = lerMediaBoxPdf(filePath)
  if (!mb) return 'fit'
  const ALVO_W = 288 // 4 pol em pontos
  const ALVO_H = 432 // 6 pol em pontos
  const menor   = Math.min(mb.widthPts, mb.heightPts)
  const maior   = Math.max(mb.widthPts, mb.heightPts)
  // Considera PDF "no tamanho da etiqueta" se as duas dimensões batem ≥85%
  // do alvo, independente de portrait/landscape.
  const cabeNoTamanho = (menor >= ALVO_W * 0.85) && (maior >= ALVO_H * 0.85)
  return cabeNoTamanho ? 'noscale' : 'fit'
}

// Tamanho-alvo da etiqueta térmica padrão: 100×150mm = 288×432pt
const LABEL_W_PT = 288
const LABEL_H_PT = 432

/**
 * Reescreve o PDF via pdf-lib:
 *   mode 'label'  → cada página vira EXATAMENTE 288×432pt com o conteúdo
 *                   escalado proporcionalmente para preencher (sem distorcer).
 *   mode 'custom' → escala o conteúdo + página por pct/100.
 *
 * O resultado vai à impressora com `noscale`, então o que está no PDF é o que
 * sai no papel — driver e SumatraPDF não interferem mais na escala.
 */
async function transformarPdf (buffer, mode, pct) {
  const { PDFDocument } = require('pdf-lib')
  const doc = await PDFDocument.load(buffer)

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize()
    if (mode === 'label') {
      // Respeita orientação: se o PDF é paisagem, alvo vira 432×288
      const isLandscape = width > height
      const targetW = isLandscape ? LABEL_H_PT : LABEL_W_PT
      const targetH = isLandscape ? LABEL_W_PT : LABEL_H_PT
      // Escala proporcional pelo lado que limita (sem distorção)
      const k = Math.min(targetW / width, targetH / height)
      page.scale(k, k)
      // Centraliza ajustando o MediaBox para o tamanho exato da etiqueta
      const newW = width * k
      const newH = height * k
      const dx = (targetW - newW) / 2
      const dy = (targetH - newH) / 2
      page.translateContent(dx, dy)
      page.setSize(targetW, targetH)
    } else if (mode === 'custom') {
      const k = pct / 100
      page.scale(k, k)
    }
  }
  return Buffer.from(await doc.save())
}

async function imprimirPdf (buffer, printerName) {
  const fs   = require('fs')
  const tmp  = require('os').tmpdir()

  const cfg = obterConfigEscala(printerName)
  let bufferFinal = buffer
  let escalaSumatra = 'noscale'

  if (cfg.mode === 'label' || cfg.mode === 'custom') {
    // Pré-processa o PDF — escala determinística independente do driver.
    try {
      bufferFinal = await transformarPdf(buffer, cfg.mode, cfg.pct)
      escalaSumatra = 'noscale'
      console.log(`[print] ${printerName} mode=${cfg.mode}${cfg.mode === 'custom' ? ` pct=${cfg.pct}` : ''} → PDF reescrito + noscale`)
    } catch (e) {
      console.error(`[print] transformarPdf falhou (${e.message}) — fallback fit`)
      bufferFinal = buffer
      escalaSumatra = 'fit'
    }
  } else if (cfg.mode === 'auto') {
    // Heurística legada — mantida por compat
    const probe = path.join(tmp, `mhub_probe_${Date.now()}.pdf`)
    fs.writeFileSync(probe, buffer)
    escalaSumatra = decidirEscalaAuto(probe)
    try { fs.unlinkSync(probe) } catch (_) {}
  } else {
    escalaSumatra = cfg.mode // noscale | shrink | fit diretos
  }

  const file = path.join(tmp, `mhub_${Date.now()}.pdf`)
  fs.writeFileSync(file, bufferFinal)

  try {
    if (pdfPrint) {
      await pdfPrint.print(file, { printer: printerName, silent: true, scale: escalaSumatra })
    } else {
      // Fallback macOS/Linux via CUPS (lp)
      const { execSync } = require('child_process')
      const scaleArg = escalaSumatra === 'fit' ? '-o fit-to-page '
                     : escalaSumatra === 'noscale' ? '-o scaling=100 '
                     : ''
      execSync(`lp ${scaleArg}-d "${printerName}" "${file}"`)
    }
  } finally {
    try { require('fs').unlinkSync(file) } catch (_) {}
  }
}

/**
 * Gera uma etiqueta de TESTE com moldura nas bordas exatas, diagonais e
 * texto explicativo. Gerada propositalmente em ~80×130mm (tamanho típico de
 * PDF Shopee) pra validar o pipeline de escala no caso real.
 *
 * Como validar no papel: a moldura tracejada deve encostar nas bordas da
 * etiqueta física. Se sobrar margem grande ou cortar, ajustar o modo/% e
 * imprimir teste de novo.
 */
async function gerarPdfTeste () {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib')
  const doc = await PDFDocument.create()
  // 80×130mm = 226.8×368.5pt — simula PDF Shopee menor que a etiqueta
  const W = 226.8, H = 368.5
  const page = doc.addPage([W, H])
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  const fontN = await doc.embedFont(StandardFonts.Helvetica)

  // Moldura na borda exata
  page.drawRectangle({ x: 1, y: 1, width: W - 2, height: H - 2, borderColor: rgb(0, 0, 0), borderWidth: 2 })
  // Diagonais
  page.drawLine({ start: { x: 0, y: 0 }, end: { x: W, y: H }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })
  page.drawLine({ start: { x: 0, y: H }, end: { x: W, y: 0 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })

  const cx = W / 2
  page.drawText('TESTE DE ESCALA', { x: cx - 62, y: H / 2 + 40, size: 14, font })
  page.drawText('MaximusHub Print Client', { x: cx - 60, y: H / 2 + 22, size: 10, font: fontN })
  page.drawText('A moldura deve encostar', { x: cx - 56, y: H / 2 - 4, size: 9, font: fontN })
  page.drawText('nas bordas da etiqueta.', { x: cx - 52, y: H / 2 - 16, size: 9, font: fontN })
  page.drawText('Se nao encostar: ajuste o', { x: cx - 56, y: H / 2 - 34, size: 9, font: fontN })
  page.drawText('modo de escala e teste de novo.', { x: cx - 68, y: H / 2 - 46, size: 9, font: fontN })

  return Buffer.from(await doc.save())
}

async function imprimirZpl (buffer, zplHost, zplPort, printerName) {
  if (zplHost) {
    // Impressora de rede: TCP direto na porta 9100
    await new Promise((resolve, reject) => {
      const net = require('net')
      const socket = net.createConnection({ host: zplHost, port: zplPort }, () => {
        socket.write(buffer)
        socket.end()
      })
      socket.on('close', resolve)
      socket.on('error', reject)
      setTimeout(() => { socket.destroy(); reject(new Error('Timeout TCP ZPL')) }, 10000)
    })
  } else {
    // Driver Windows: PowerShell RawPrint
    const { execSync } = require('child_process')
    const fs   = require('fs')
    const file = path.join(os.tmpdir(), `mhub_${Date.now()}.zpl`)
    fs.writeFileSync(file, buffer)
    const ps = `
      Add-Type -TypeDefinition @"
      using System;using System.Runtime.InteropServices;using System.IO;
      public class RawPrint {
        [DllImport("winspool.drv",EntryPoint="OpenPrinterA",SetLastError=true)]
        public static extern bool OpenPrinter(string printerName,ref IntPtr hPrinter,IntPtr pd);
        [DllImport("winspool.drv",EntryPoint="ClosePrinter",SetLastError=true)]
        public static extern bool ClosePrinter(IntPtr hPrinter);
        [DllImport("winspool.drv",EntryPoint="StartDocPrinterA",SetLastError=true)]
        public static extern int StartDocPrinter(IntPtr hPrinter,int level,int[] di);
        [DllImport("winspool.drv",EntryPoint="EndDocPrinter",SetLastError=true)]
        public static extern bool EndDocPrinter(IntPtr hPrinter);
        [DllImport("winspool.drv",EntryPoint="StartPagePrinter",SetLastError=true)]
        public static extern bool StartPagePrinter(IntPtr hPrinter);
        [DllImport("winspool.drv",EntryPoint="EndPagePrinter",SetLastError=true)]
        public static extern bool EndPagePrinter(IntPtr hPrinter);
        [DllImport("winspool.drv",EntryPoint="WritePrinter",SetLastError=true)]
        public static extern bool WritePrinter(IntPtr hPrinter,byte[] pBytes,int dwCount,ref int dwWritten);
      }
"@
      $hPrinter=[IntPtr]::Zero
      [RawPrint]::OpenPrinter("${printerName}",[ref]$hPrinter,[IntPtr]::Zero)|Out-Null
      $di=New-Object int[] 3;$di[0]=1;[RawPrint]::StartDocPrinter($hPrinter,1,$di)|Out-Null
      [RawPrint]::StartPagePrinter($hPrinter)|Out-Null
      $bytes=[IO.File]::ReadAllBytes("${file}")
      $written=0;[RawPrint]::WritePrinter($hPrinter,$bytes,$bytes.Length,[ref]$written)|Out-Null
      [RawPrint]::EndPagePrinter($hPrinter)|Out-Null
      [RawPrint]::EndDocPrinter($hPrinter)|Out-Null
      [RawPrint]::ClosePrinter($hPrinter)|Out-Null
    `.replace(/\n\s+/g, ' ')
    try {
      execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 15000 })
    } finally {
      try { require('fs').unlinkSync(file) } catch (_) {}
    }
  }
}

// ─── Registro do agente ───────────────────────────────────────────────────────

async function registrarAgente (token) {
  const agentUuid = garantirAgentUuid()
  try {
    await axios.post(
      `${HUB_API}/print-agents/register`,
      {
        agent_uuid: agentUuid,
        name:       `${os.hostname()} (${os.platform()})`,
        hostname:   os.hostname(),
        platform:   os.platform(),
        version:    APP_VERSION,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    )
  } catch (err) {
    console.error('[REGISTER] Erro ao registrar agente:', err.response?.data?.message || err.message)
  }
}

// ─── Descoberta de impressoras ────────────────────────────────────────────────

async function descobrirImpressoras () {
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process')
      const raw = execSync('powershell -NoProfile -Command "Get-Printer | Select-Object Name | ConvertTo-Json"', { timeout: 10000 }).toString()
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : [parsed]
      return list.map(p => ({
        system_name:  p.Name,
        display_name: p.Name,
        type:         detectarTipoImpressora(p.Name),
      }))
    } else {
      const { execSync } = require('child_process')
      const raw = execSync('lpstat -a 2>/dev/null || echo ""', { timeout: 5000 }).toString()
      return raw.split('\n')
        .filter(l => l.trim())
        .map(l => l.split(' ')[0])
        .filter(Boolean)
        .map(name => ({
          system_name:  name,
          display_name: name,
          type:         detectarTipoImpressora(name),
        }))
    }
  } catch (err) {
    console.error('[PRINTERS] Erro ao descobrir impressoras:', err.message)
    return []
  }
}

function detectarTipoImpressora (name) {
  const n = (name || '').toLowerCase()
  if (n.includes('zpl') || n.includes('zebra') || n.includes('datamax') || n.includes('tsc ')) return 'zpl'
  if (n.includes('pdf') || n.includes('virtual') || n.includes('microsoft print')) return 'pdf'
  return 'auto'
}

async function sincronizarImpressoras (token, agentUuid) {
  try {
    const printers = await descobrirImpressoras()
    await axios.post(
      `${HUB_API}/print-agents/${agentUuid}/printers`,
      { printers },
      { headers: { Authorization: `Bearer ${token}` } }
    )
  } catch (err) {
    console.error('[SYNC] Erro ao sincronizar impressoras:', err.message)
  }
}

// ─── IPC — comunicação com páginas HTML ──────────────────────────────────────

ipcMain.handle('login', async (_, { email, password }) => {
  try {
    const res = await axios.post(`${HUB_API}/auth/login`, { email, password })
    const { token: { token }, user } = res.data.data

    store.set('token',   token)
    store.set('user_id', user.id)
    store.set('user_name', user.name || user.email)

    await registrarAgente(token)
    conectarMqtt(token)

    if (loginWin) { loginWin.close(); loginWin = null }
    abrirSetup()

    // Inicia verificação de atualização após login
    verificarAtualizacao()
    setInterval(verificarAtualizacao, 5 * 60 * 1000)

    return { success: true }
  } catch (err) {
    const msg = err.response?.data?.message || err.message
    return { success: false, message: msg }
  }
})

ipcMain.handle('get-printers', async () => {
  return await descobrirImpressoras()
})

ipcMain.handle('get-hub-printers', async () => {
  const token    = store.get('token')
  const agentUuid = garantirAgentUuid()
  try {
    const res = await axios.get(
      `${HUB_API}/print-agents/${agentUuid}/printers`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    return res.data.data || []
  } catch (_) { return [] }
})

ipcMain.handle('update-printer', async (_, { agentUuid, printerId, data }) => {
  const token = store.get('token')
  try {
    const res = await axios.put(
      `${HUB_API}/print-agents/${agentUuid}/printers/${printerId}`,
      data,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    return res.data
  } catch (err) {
    return { success: false, message: err.response?.data?.message || err.message }
  }
})

ipcMain.handle('sync-printers', async () => {
  const token     = store.get('token')
  const agentUuid = garantirAgentUuid()
  if (!token) return { success: false, data: [], message: 'Não autenticado' }
  try {
    await registrarAgente(token)
    const printers = await descobrirImpressoras()
    const res = await axios.post(
      `${HUB_API}/print-agents/${agentUuid}/printers`,
      { printers },
      { headers: { Authorization: `Bearer ${token}` } }
    )
    return { success: true, data: res.data.data || [] }
  } catch (err) {
    const msg = err.response?.data?.message || err.message
    return { success: false, data: [], message: msg }
  }
})

ipcMain.handle('get-store', (_, key) => store.get(key))

// Escala de impressão PDF por impressora (armazenada localmente neste PC)
ipcMain.handle('get-pdf-scale-map', () => store.get('pdf_scale_by_printer') || {})

// Aceita formato legado ({printer, scale}) e novo ({printer, scale, pct}).
ipcMain.handle('set-pdf-scale', (_, { printer, scale, pct }) => {
  const map = store.get('pdf_scale_by_printer') || {}
  if (ESCALAS_PDF.includes(scale)) {
    map[printer] = scale === 'custom'
      ? { mode: 'custom', pct: Math.min(300, Math.max(50, parseInt(pct) || 100)) }
      : { mode: scale, pct: 100 }
  }
  store.set('pdf_scale_by_printer', map)
  return map
})

// Imprime etiqueta de TESTE com a config de escala atual da impressora.
// Usuário valida no papel físico e ajusta o modo/% até a moldura encostar
// nas bordas — aí TODAS as impressões reais saem certas.
ipcMain.handle('print-test-label', async (_, { printer }) => {
  try {
    const buffer = await gerarPdfTeste()
    await imprimirPdf(buffer, printer)
    return { success: true }
  } catch (e) {
    return { success: false, message: e.message }
  }
})

ipcMain.handle('logout', () => {
  store.clear()
  if (mqttClient) { mqttClient.end(true); mqttClient = null }
  atualizarTray('desconectado')
  abrirLogin()
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

function garantirAgentUuid () {
  let uuid = store.get('agent_uuid')
  if (!uuid) {
    uuid = uuidv4()
    store.set('agent_uuid', uuid)
  }
  return uuid
}

function notificar (title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }
}

// ─── Auto-update ─────────────────────────────────────────────────────────────

function setupAutoUpdater () {
  if (!app.isPackaged) return // sem update em desenvolvimento

  try {
    autoUpdater = require('electron-updater').autoUpdater
    autoUpdater.autoDownload         = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger               = null

    autoUpdater.on('update-available', () => {
      notificar('MaximusHub Print Client', 'Nova versão disponível. Baixando automaticamente...')
    })

    autoUpdater.on('update-downloaded', () => {
      updateDownloaded = true
      notificar('MaximusHub Print Client', 'Atualização pronta! Clique no ícone da bandeja para instalar.')
      atualizarTray(trayStatus)
    })

    autoUpdater.on('error', (err) => {
      console.error('[UPDATE] electron-updater error:', err.message)
    })
  } catch (err) {
    console.error('[UPDATE] Falha ao carregar electron-updater:', err.message)
  }
}

async function verificarAtualizacao () {
  const token = store.get('token')
  if (!token) return

  try {
    const res    = await axios.get(`${HUB_API}/printer-client/version`)
    const latest = res.data?.data
    if (!latest) return

    const isNewer = compareVersions(latest.version, APP_VERSION) > 0
    if (!isNewer) return

    if (latest.is_required) {
      const { response } = await dialog.showMessageBox({
        type:      'warning',
        title:     'Atualização obrigatória',
        message:   `Versão ${latest.version} disponível (obrigatória)`,
        detail:    latest.release_notes
          || 'Esta versão contém correções críticas. Por favor, atualize agora.',
        buttons:   ['Instalar automaticamente', 'Baixar manualmente'],
        defaultId: 0,
      })

      if (response === 0 && autoUpdater) {
        autoUpdater.checkForUpdatesAndNotify()
      } else {
        shell.openExternal(
          latest.download_url ||
          'https://github.com/leorobaskievicz/maximus-printer-client/releases/latest'
        )
      }
    } else {
      // Não-obrigatória: dispara o updater silenciosamente
      if (autoUpdater) {
        autoUpdater.checkForUpdates()
      }
    }
  } catch (err) {
    console.error('[UPDATE] Erro ao verificar versão:', err.message)
  }
}

function compareVersions (a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
