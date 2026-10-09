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
  // Para quem está na expedição conseguir mandar o log sem mexer em pasta.
  items.push({
    label: 'Abrir log de impressão',
    click: () => shell.openPath(caminhoDoLog()),
  })
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

  mqttClient.on('message', (topic, payload) => {
    try {
      const job = JSON.parse(payload.toString())
      // ⚠️ NÃO imprime aqui — enfileira. Ver `enfileirar` e o cabeçalho da
      // seção de impressão: imprimir direto no handler fazia uma chamada ao
      // SumatraPDF por etiqueta, e era isso que criava a pausa entre uma e
      // outra. Também não havia fila: dois `await` em voo podiam disputar a
      // mesma impressora e inverter a ordem do papel.
      enfileirar(job, userId)
    } catch (err) {
      console.error('[MQTT] Erro ao ler job:', err.message)
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
//
// ══════════════════════════════════════════════════════════════════════════
// ⚠️ POR QUE EXISTE UMA FILA, E POR QUE ELA AGRUPA (09/10/2026)
// ══════════════════════════════════════════════════════════════════════════
// Reclamação: "a cada etiqueta que sai tem uma pequena pausa pra iniciar a
// próxima, não é contínuo".
//
// Medido no Hub: **99% dos jobs são de UMA etiqueta** (8.606 de 8.676 num dia)
// e o servidor publica a cada ~0,5 s. Ou seja, o gargalo não era o envio — era
// o que este arquivo fazia com cada job: reescrever o PDF, gravar um arquivo
// temporário e **chamar o SumatraPDF**. Criar esse processo, carregar o PDF,
// falar com o spooler e fechar custa centenas de milissegundos — por etiqueta.
// É exatamente a pausa que a expedição vê entre uma e outra.
//
// A correção não é "deixar mais rápido": é **parar de fazer N vezes o que
// pode ser feito uma vez**. As etiquetas de uma rajada viram UM PDF de N
// páginas e UMA chamada à impressora; o papel sai contínuo, que é como a
// térmica trabalha melhor.
//
// ⚠️ **Sem janela de espera, de propósito.** O agrupamento é oportunista: a
// fila ociosa dispara NA HORA com o que tiver (uma etiqueta avulsa continua
// instantânea, sem nenhum atraso novo); as que chegam ENQUANTO o lote
// imprime se acumulam e saem juntas no ciclo seguinte. Quanto maior a
// rajada, maior o lote — sem nenhum temporizador para calibrar, e sem
// penalizar o clique único, que é o caso mais comum fora da onda.
//
// ⚠️ **Uma fila por DESTINO** (impressora + tipo + escala). Misturar
// impressoras numa fila só serializaria duas que podiam imprimir em paralelo;
// misturar escalas num PDF só é impossível — a escala é do documento inteiro.
//
// ⚠️ **Lote que falha é refeito UM A UM.** Um PDF corrompido no meio não pode
// derrubar as outras 24 etiquetas: o erro vira ACK só para quem falhou.

/**
 * ⚠️ **O LOG EM ARQUIVO** (09/10/2026). Três versões seguidas tentaram tirar
 * a pausa entre etiquetas e nenhuma pôde ser verificada: o `console.log` de
 * um app de bandeja não vai a lugar nenhum, e a máquina está a 400 km. O
 * diagnóstico virou palpite — e dois palpites erraram.
 *
 * Agora toda decisão de impressão fica em `print.log`, ao lado da
 * configuração, e o menu da bandeja abre o arquivo. É o que permite
 * responder "o comando chegou na impressora?" sem adivinhar.
 *
 * ⚠️ Rotação simples por tamanho: um log que cresce sem limite num
 * computador de expedição vira um problema pior que o que ele resolve.
 */
const LIMITE_DO_LOG = 2 * 1024 * 1024

function caminhoDoLog () {
  return path.join(app.getPath('userData'), 'print.log')
}

function registrar (mensagem) {
  const linha = `${new Date().toISOString()} ${mensagem}`
  console.log(linha)
  try {
    const fs = require('fs')
    const arquivo = caminhoDoLog()
    try {
      if (fs.statSync(arquivo).size > LIMITE_DO_LOG) {
        fs.renameSync(arquivo, `${arquivo}.1`)
      }
    } catch (_) { /* ainda não existe */ }
    fs.appendFileSync(arquivo, linha + '\n')
  } catch (_) { /* log nunca pode derrubar impressão */ }
}

const { criarFilaDeImpressao } = require('./src/fila-impressao')
const { criarPreparoDeImpressora } = require('./src/preparo-impressora')

/**
 * O preparo da impressora — `src/preparo-impressora.js`.
 *
 * ⚠️ Roda ANTES do lote, não antes de cada etiqueta: `~JSO` é configuração
 * PERSISTENTE na impressora, e repetir só enfileira trabalho no spooler.
 * Nunca lança: preparo é otimização, e uma falha aqui não pode impedir a
 * etiqueta de sair.
 */
const preparoDeImpressora = criarPreparoDeImpressora({
  enviarZpl: (nome, texto) => imprimirZpl(Buffer.from(texto, 'ascii'), null, null, nome),
  registrar: (m) => registrar(`[preparo] ${m}`),
})

/**
 * A fila — a regra mora em `src/fila-impressao.js` (pura, com teste). Aqui
 * ficam só as PONTAS: falar com a impressora e publicar o ACK no MQTT.
 */
const filaDeImpressao = criarFilaDeImpressao({
  imprimir: async (lote) => {
    const { job } = lote[0]
    const buffers = lote.map((i) => Buffer.from(i.job.data, 'base64'))
    // ⚠️ Antes do lote: desliga o backfeed na Zebra, que é o "recalibrar"
    // entre uma etiqueta e outra. Só vale para impressora que fala ZPL e por
    // isso a detecção é pelo nome — ver `preparo-impressora.js`.
    await preparoDeImpressora.preparar(job.printer_system_name, obterPreparo(job.printer_system_name))
    if (job.type === 'zpl') {
      // ⚠️ ZPL é um fluxo de comandos (`^XA`…`^XZ` por etiqueta): concatenar
      // é o formato nativo de mandar várias. Um socket, não N.
      await imprimirZpl(Buffer.concat(buffers), job.zpl_host, job.zpl_port || 9100, job.printer_system_name)
    } else {
      await imprimirPdf(buffers, job.printer_system_name, job.escala)
    }
  },
  confirmar: (item, status, erro) => {
    if (!mqttClient) return
    mqttClient.publish(
      `hub/ack/${item.userId}/${item.job.job_uuid}`,
      JSON.stringify({ job_uuid: item.job.job_uuid, status, error: erro }),
      { qos: 1 }
    )
  },
  registrar: (m) => registrar(`[fila] ${m}`),
})

function enfileirar (job, userId) {
  return filaDeImpressao.enfileirar(job, userId)
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
/**
 * ⚠️ **A escala do SERVIDOR vence a configuração local** (08/10/2026).
 *
 * Etiqueta de marketplace é 100×150 mm por definição — não é preferência de
 * cada máquina. Enquanto a decisão era só local, o operador de SP estava com
 * `noscale` e a etiqueta saía pequena, sem nada errado no servidor: o PDF que
 * chegava já era 100×150 (medido payload contra payload, Adonis e porte
 * idênticos). O que faltava era o Hub DIZER como imprimir.
 *
 * ⚠️ A config local continua valendo quando o servidor não manda nada — é o
 * que mantém o client velho funcionando e permite a exceção pontual (papel
 * diferente numa máquina específica).
 */
function obterConfigEscala (printerName, escalaDoServidor) {
  if (typeof escalaDoServidor === 'string' && ESCALAS_PDF.includes(escalaDoServidor)) {
    return { mode: escalaDoServidor, pct: 100, origem: 'servidor' }
  }
  const map = store.get('pdf_scale_by_printer') || {}
  const v = map[printerName]
  if (typeof v === 'string' && ESCALAS_PDF.includes(v)) return { mode: v, pct: 100, origem: 'local' }
  if (v && typeof v === 'object' && ESCALAS_PDF.includes(v.mode)) {
    return { mode: v.mode, pct: Math.min(300, Math.max(50, parseInt(v.pct) || 100)), origem: 'local' }
  }
  return { mode: 'label', pct: 100, origem: 'default' } // default novo: determinístico
}

/**
 * A configuração do preparo, por impressora (local, como a da escala).
 *
 * ⚠️ **Ligado por padrão, e desligável sem release.** O backfeed é o sintoma
 * que a expedição relatou; desligá-lo é o conserto. Mas é a única coisa que o
 * Print Client escreve na CONFIGURAÇÃO de um equipamento, então precisa de
 * freio de mão sem depender de atualização.
 *
 * ⚠️ `velocidade` nasce NULA de propósito. `^PR` exige um `^XA…^XZ`, e um
 * formato sem campo imprimível **não deveria** produzir etiqueta — mas isso
 * depende do firmware, e uma etiqueta em branco por lote é desperdício
 * visível. Quem quiser testar liga numa máquina e confere o papel; o `~JSO`,
 * que é o que resolve, não tem essa dúvida e por isso vai sempre.
 */
function obterPreparo (printerName) {
  const map = store.get('zpl_prep_by_printer') || {}
  const v = map[printerName]
  if (v && typeof v === 'object') {
    return {
      ligado: v.ligado !== false,
      velocidade: Number.isFinite(Number(v.velocidade)) && Number(v.velocidade) > 0
        ? Math.min(14, Math.max(1, parseInt(v.velocidade, 10)))
        : null,
    }
  }
  if (v === false) return { ligado: false }
  return { ligado: true, velocidade: null }
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

// O tamanho-alvo, a reescrita do PDF e a junção de etiquetas moram em
// `src/pdf-etiqueta.js` — puros, com teste (`src/pdf-etiqueta.test.js`).
const { transformarPdf, normalizarEJuntar, juntarPdfs } = require('./src/pdf-etiqueta')

async function imprimirPdf (buffers, printerName, escalaDoServidor) {
  const fs   = require('fs')
  const tmp  = require('os').tmpdir()
  const lista = Array.isArray(buffers) ? buffers : [buffers]

  const cfg = obterConfigEscala(printerName, escalaDoServidor)
  let bufferFinal = lista[0]
  let escalaSumatra = 'noscale'

  if (cfg.mode === 'label' || cfg.mode === 'custom') {
    // Pré-processa o PDF — escala determinística independente do driver.
    try {
      bufferFinal = await normalizarEJuntar(lista, cfg.mode, cfg.pct)
      escalaSumatra = 'noscale'
      registrar(`[pdf] ${printerName} mode=${cfg.mode} (${cfg.origem})${cfg.mode === 'custom' ? ` pct=${cfg.pct}` : ''} → ${lista.length} PDF(s) reescrito(s) + noscale`)
    } catch (e) {
      // ⚠️ RELANÇA quando é lote: `imprimirLote` refaz uma a uma e cada uma
      // cai no seu próprio fallback. Engolir aqui imprimiria o lote inteiro
      // com a escala errada.
      if (lista.length > 1) throw e
      registrar(`[pdf] transformarPdf falhou (${e.message}) — fallback fit`)
      bufferFinal = lista[0]
      escalaSumatra = 'fit'
    }
  } else if (cfg.mode === 'auto') {
    // Heurística legada — mantida por compat. Decide pelo PRIMEIRO PDF: no
    // lote todos vêm da mesma origem e do mesmo formato.
    const probe = path.join(tmp, `mhub_probe_${Date.now()}.pdf`)
    fs.writeFileSync(probe, lista[0])
    escalaSumatra = decidirEscalaAuto(probe)
    try { fs.unlinkSync(probe) } catch (_) {}
    if (lista.length > 1) bufferFinal = await juntarPdfs(lista)
  } else {
    escalaSumatra = cfg.mode // noscale | shrink | fit diretos
    if (lista.length > 1) bufferFinal = await juntarPdfs(lista)
  }

  const file = path.join(tmp, `mhub_${Date.now()}.pdf`)
  fs.writeFileSync(file, bufferFinal)

  const comecou = Date.now()
  try {
    if (pdfPrint) {
      await pdfPrint.print(file, { printer: printerName, silent: true, scale: escalaSumatra })
      /*
       * ⚠️ Este número é o que separa "o software está lento" de "a
       * impressora está lenta". Ele mede até o SPOOLER aceitar — o papel sai
       * depois, no ritmo do equipamento. Sem ele, as duas coisas viram a
       * mesma queixa.
       */
      registrar(`[pdf] ${printerName}: ${lista.length} documento(s) entregues ao spooler em ${Date.now() - comecou} ms (escala ${escalaSumatra})`)
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
    // Driver Windows: envio RAW pelo spooler (winspool).
    //
    // ══════════════════════════════════════════════════════════════════════
    // ⚠️ ESTE CAMINHO ESTAVA QUEBRADO, E EM SILÊNCIO (09/10/2026)
    // ══════════════════════════════════════════════════════════════════════
    // A versão anterior declarava `StartDocPrinter(IntPtr, int, int[])` e
    // passava `New-Object int[] 3` como DOC_INFO_1. A estrutura são TRÊS
    // PONTEIROS — 24 bytes em x64 — e o array tem 12: o spooler lia 12 bytes
    // de lixo além do buffer. Pior, `$di[0]=1` punha o valor 1 em `pDocName`,
    // que é um ponteiro: endereço inválido.
    //
    // E **nada conferia retorno** (`|Out-Null` em tudo). Quando
    // `StartDocPrinter` falhava, o `WritePrinter` seguia e não escrevia nada
    // — o comando simplesmente não chegava à impressora, sem erro nenhum.
    //
    // Foi o que aconteceu com o preparo das versões 1.0.5 e 1.0.6: o `~JSO`
    // e o `JB` eram montados certos e provavelmente nunca saíram daqui. Como
    // ninguém imprimia ZPL por driver em produção (100% dos jobs são PDF via
    // SumatraPDF), o defeito nunca tinha aparecido.
    //
    // ⚠️ **`pDatatype = "RAW"` é obrigatório.** Sem ele o spooler usa o
    // padrão do driver, que para o ZDesigner pode ser o formato gráfico — e
    // aí os bytes do comando seriam IMPRESSOS como texto numa etiqueta, em
    // vez de interpretados.
    const { execSync } = require('child_process')
    const fs   = require('fs')
    const file = path.join(os.tmpdir(), `mhub_${Date.now()}.bin`)
    fs.writeFileSync(file, buffer)
    const ps = `
      $ErrorActionPreference='Stop'
      Add-Type -TypeDefinition @"
      using System;using System.Runtime.InteropServices;using System.IO;
      [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
      public struct DOCINFO { public string pDocName; public string pOutputFile; public string pDatatype; }
      public class RawPrint {
        [DllImport("winspool.drv",EntryPoint="OpenPrinterW",SetLastError=true,CharSet=CharSet.Unicode)]
        public static extern bool OpenPrinter(string printerName,out IntPtr hPrinter,IntPtr pd);
        [DllImport("winspool.drv",EntryPoint="ClosePrinter",SetLastError=true)]
        public static extern bool ClosePrinter(IntPtr hPrinter);
        [DllImport("winspool.drv",EntryPoint="StartDocPrinterW",SetLastError=true,CharSet=CharSet.Unicode)]
        public static extern int StartDocPrinter(IntPtr hPrinter,int level,ref DOCINFO di);
        [DllImport("winspool.drv",EntryPoint="EndDocPrinter",SetLastError=true)]
        public static extern bool EndDocPrinter(IntPtr hPrinter);
        [DllImport("winspool.drv",EntryPoint="StartPagePrinter",SetLastError=true)]
        public static extern bool StartPagePrinter(IntPtr hPrinter);
        [DllImport("winspool.drv",EntryPoint="EndPagePrinter",SetLastError=true)]
        public static extern bool EndPagePrinter(IntPtr hPrinter);
        [DllImport("winspool.drv",EntryPoint="WritePrinter",SetLastError=true)]
        public static extern bool WritePrinter(IntPtr hPrinter,byte[] pBytes,int dwCount,out int dwWritten);
        public static void Enviar(string impressora,string arquivo){
          IntPtr h; 
          if(!OpenPrinter(impressora, out h, IntPtr.Zero))
            throw new Exception("OpenPrinter falhou: "+Marshal.GetLastWin32Error());
          try{
            DOCINFO di=new DOCINFO();
            di.pDocName="MaximusHub RAW"; di.pDatatype="RAW";
            if(StartDocPrinter(h,1,ref di)==0)
              throw new Exception("StartDocPrinter falhou: "+Marshal.GetLastWin32Error());
            try{
              if(!StartPagePrinter(h))
                throw new Exception("StartPagePrinter falhou: "+Marshal.GetLastWin32Error());
              byte[] b=File.ReadAllBytes(arquivo); int escritos=0;
              if(!WritePrinter(h,b,b.Length,out escritos))
                throw new Exception("WritePrinter falhou: "+Marshal.GetLastWin32Error());
              if(escritos!=b.Length)
                throw new Exception("WritePrinter escreveu "+escritos+" de "+b.Length+" bytes");
              EndPagePrinter(h);
            } finally { EndDocPrinter(h); }
          } finally { ClosePrinter(h); }
        }
      }
"@
      [RawPrint]::Enviar('${printerName.replace(/'/g, "''")}','${file.replace(/'/g, "''")}')
    `.replace(/\n\s+/g, ' ')
    try {
      // ⚠️ `stdio: pipe` para a mensagem de erro do PowerShell chegar aqui: a
      // versão anterior engolia qualquer falha junto com o `Out-Null`.
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
        { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      const detalhe = (e.stderr && e.stderr.toString().trim()) || e.message
      throw new Error(`Envio RAW para "${printerName}" falhou: ${detalhe.slice(0, 300)}`)
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
