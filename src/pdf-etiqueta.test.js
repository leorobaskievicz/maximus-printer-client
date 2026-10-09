/**
 * Teste do PDF da etiqueta — `node src/pdf-etiqueta.test.js`.
 *
 * A junção de etiquetas num documento só é o que elimina a pausa entre uma e
 * outra; o que estes casos protegem é que juntar **não mexa no tamanho**.
 * Etiqueta ampliada já aconteceu em produção (08/10/2026), e o sintoma chega
 * em rolo de papel desperdiçado, não em log.
 */
const assert = require('assert');
const { PDFDocument } = require('pdf-lib');
const {
  transformarPdf,
  normalizarEJuntar,
  juntarPdfs,
  LABEL_W_PT,
  LABEL_H_PT,
} = require('./pdf-etiqueta');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

/** Um PDF de uma página no tamanho pedido (em pontos). */
async function pdfDe(largura, altura, paginas = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) doc.addPage([largura, altura]);
  return Buffer.from(await doc.save());
}

const tamanhos = async (buffer) => {
  const doc = await PDFDocument.load(buffer);
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return [Math.round(width), Math.round(height)];
  });
};

teste('junta 3 etiquetas num documento de 3 páginas', async () => {
  const lista = [await pdfDe(283, 425), await pdfDe(283, 425), await pdfDe(283, 425)];
  const juntas = await normalizarEJuntar(lista, 'label');
  assert.deepStrictEqual(await tamanhos(juntas), [
    [LABEL_W_PT, LABEL_H_PT],
    [LABEL_W_PT, LABEL_H_PT],
    [LABEL_W_PT, LABEL_H_PT],
  ]);
});

/**
 * ⚠️ O risco de juntar: cada etiqueta chega num tamanho diferente (a Shopee
 * manda A4 e 105×148mm no mesmo dia). Todas têm de sair no MESMO tamanho
 * final — uma página fora da medida é uma etiqueta ampliada no meio do rolo.
 */
teste('tamanhos de origem diferentes saem todos em 288×432', async () => {
  const lista = [await pdfDe(595, 842), await pdfDe(297, 420), await pdfDe(283, 425)];
  const juntas = await normalizarEJuntar(lista, 'label');
  const medidas = await tamanhos(juntas);
  assert.strictEqual(medidas.length, 3);
  assert.ok(medidas.every(([w, h]) => w === LABEL_W_PT && h === LABEL_H_PT), JSON.stringify(medidas));
});

/** Paisagem continua paisagem: o alvo gira junto, como no original. */
teste('etiqueta em paisagem vira 432×288, não é rotacionada à força', async () => {
  const juntas = await normalizarEJuntar([await pdfDe(420, 297)], 'label');
  assert.deepStrictEqual(await tamanhos(juntas), [[LABEL_H_PT, LABEL_W_PT]]);
});

teste('PDF de origem com várias páginas entra inteiro', async () => {
  const lista = [await pdfDe(283, 425, 2), await pdfDe(283, 425, 1)];
  assert.strictEqual((await tamanhos(await normalizarEJuntar(lista, 'label'))).length, 3);
});

teste('uma etiqueta só: o resultado é o mesmo de antes da junção', async () => {
  const unica = await pdfDe(283, 425);
  assert.deepStrictEqual(
    await tamanhos(await normalizarEJuntar([unica], 'label')),
    await tamanhos(await transformarPdf(unica, 'label')),
  );
});

teste('modo custom escala pelo percentual', async () => {
  const juntas = await normalizarEJuntar([await pdfDe(200, 400)], 'custom', 50);
  assert.deepStrictEqual(await tamanhos(juntas), [[100, 200]]);
});

/** `juntarPdfs` é o caminho dos modos que NÃO reescrevem (noscale/fit/auto). */
teste('juntarPdfs preserva o tamanho de cada origem', async () => {
  const juntas = await juntarPdfs([await pdfDe(283, 425), await pdfDe(595, 842)]);
  assert.deepStrictEqual(await tamanhos(juntas), [[283, 425], [595, 842]]);
});

teste('PDF ilegível no meio da lista FALHA o lote (quem chama refaz uma a uma)', async () => {
  const lista = [await pdfDe(283, 425), Buffer.from('isto não é um pdf')];
  await assert.rejects(() => normalizarEJuntar(lista, 'label'));
});

(async () => {
  for (const [nome, fn] of casos) {
    try {
      await fn();
      passaram++;
      console.log(`  ✓ ${nome}`);
    } catch (erro) {
      console.error(`  ✗ ${nome}\n    ${erro.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passaram}/${casos.length} casos`);
})();
