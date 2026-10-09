/**
 * O PDF da etiqueta — reescrita de escala e junção de várias numa só.
 *
 * Puro: só depende de `pdf-lib`. Vive fora do `main.js` para poder ser
 * testado sem Electron (`src/pdf-etiqueta.test.js`) — e porque é aqui que
 * mora a decisão que já causou "etiqueta saindo ampliada" em produção.
 */

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

/**
 * Imprime UMA chamada à impressora com uma ou VÁRIAS etiquetas.
 *
 * ⚠️ `buffers` pode ser um Buffer (um PDF) ou um array deles — nesse caso as
 * páginas são reunidas num documento único. Reunir é o ponto: uma térmica
 * recebendo um documento de N páginas imprime em fluxo; N documentos de uma
 * página têm N inicializações no meio do caminho.
 *
 * ⚠️ A ESCALA é do documento inteiro, não da página. Por isso a fila só junta
 * jobs do mesmo destino (mesma impressora e mesma escala) — ver
 * `chaveDoDestino`.
 *
 * ⚠️ Etiqueta cuja normalização FALHA sai do lote e é impressa sozinha, com o
 * fallback `fit` que ela sempre teve. Misturar uma página não normalizada com
 * as outras aplicaria a escala errada nela e, pior, só nela — o tipo de
 * defeito que aparece como "uma etiqueta ampliada no meio do rolo".
 */
/**
 * Normaliza CADA etiqueta (a mesma regra de `transformarPdf`) e devolve um
 * documento único com todas as páginas.
 *
 * ⚠️ Um `PDFDocument` de destino só: `copyPages` traz as páginas já
 * reescritas, então o resultado tem exatamente o tamanho final em todas —
 * não há "primeira página certa e o resto fora".
 */
async function normalizarEJuntar (lista, mode, pct) {
  if (lista.length === 1) return transformarPdf(lista[0], mode, pct)
  const { PDFDocument } = require('pdf-lib')
  const destino = await PDFDocument.create()
  for (const bruto of lista) {
    const normalizado = await transformarPdf(bruto, mode, pct)
    const origem = await PDFDocument.load(normalizado)
    const paginas = await destino.copyPages(origem, origem.getPageIndices())
    for (const p of paginas) destino.addPage(p)
  }
  return Buffer.from(await destino.save())
}

/** Junta PDFs SEM mexer na escala (modos `auto`/`noscale`/`shrink`/`fit`). */
async function juntarPdfs (lista) {
  const { PDFDocument } = require('pdf-lib')
  const destino = await PDFDocument.create()
  for (const bruto of lista) {
    const origem = await PDFDocument.load(bruto)
    const paginas = await destino.copyPages(origem, origem.getPageIndices())
    for (const p of paginas) destino.addPage(p)
  }
  return Buffer.from(await destino.save())
}


module.exports = { transformarPdf, normalizarEJuntar, juntarPdfs, LABEL_W_PT, LABEL_H_PT }
