/**
 * Teste do envio RAW — `node src/envio-raw-windows.test.js`.
 *
 * ⚠️ Cada caso aqui corresponde a uma falha REAL que foi para produção e não
 * produziu erro de impressão nenhum: a etiqueta saía pelo caminho do PDF e o
 * comando nunca chegava à impressora. Não há como exercitar o `winspool` fora
 * do Windows, então o que se prova são as invariantes ESTRUTURAIS do script —
 * que é exatamente onde os três defeitos moravam.
 */
const assert = require('assert');
const { scriptPowerShell, comandoPowerShell } = require('./envio-raw-windows');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

const script = scriptPowerShell();
const linhas = script.split('\n');

// ── o defeito da 1.0.7/1.0.8: o script achatado numa linha ────────────────
/**
 * ⚠️ O log da expedição (09/10/2026) dizia `No linha:1 caractere:32` — o
 * script inteiro havia virado uma linha só. Sem quebra de linha, `$Error...`
 * e `Add-Type` colam num comando inválido.
 */
teste('o script tem VÁRIAS linhas — achatá-lo é o defeito', () => {
  assert.ok(linhas.length > 30, `só ${linhas.length} linha(s)`);
});

teste('cada comando de topo está na SUA linha', () => {
  const topo = linhas.filter((l) => /^\$ErrorActionPreference|^Add-Type|^\[RawPrint\]/.test(l));
  assert.deepStrictEqual(topo, [
    "$ErrorActionPreference='Stop'",
    'Add-Type -TypeDefinition @"',
    '[RawPrint]::Enviar($impressora,$arquivo)',
  ]);
});

/** `@"` abre o here-string e TEM de ser o fim da linha. */
teste('o here-string abre no fim da linha', () => {
  const abre = linhas.findIndex((l) => l.endsWith('@"'));
  assert.ok(abre >= 0, 'não achei a abertura `@"`');
  assert.strictEqual(linhas[abre], 'Add-Type -TypeDefinition @"');
});

/** ⚠️ `"@` indentado NÃO fecha o here-string: tem de começar a linha. */
teste('o here-string fecha na COLUNA 0', () => {
  const fecha = linhas.filter((l) => l.includes('"@'));
  assert.strictEqual(fecha.length, 1, `achei ${fecha.length} candidatos a fechamento`);
  assert.strictEqual(fecha[0], '"@');
});

// ── o defeito até a 1.0.6: struct errada e retorno ignorado ───────────────
/**
 * ⚠️ `DOC_INFO_1` são TRÊS PONTEIROS (24 bytes em x64). A versão antiga
 * passava `int[3]` (12 bytes) e o spooler lia lixo além do buffer.
 */
teste('DOCINFO tem os três campos de string, não um array de int', () => {
  assert.ok(script.includes('public struct DOCINFO'));
  for (const campo of ['public string pDocName', 'public string pOutputFile', 'public string pDatatype']) {
    assert.ok(script.includes(campo), `faltou ${campo}`);
  }
  assert.ok(!/int\[\]\s*di|New-Object int\[\]/.test(script), 'ainda usa array de int');
});

/** Sem `RAW` o spooler usa o padrão do driver e o ZPL sai IMPRESSO como texto. */
teste('pDatatype é "RAW"', () => {
  assert.ok(script.includes('di.pDatatype="RAW"'));
});

/**
 * ⚠️ `|Out-Null` em tudo foi o que tornou a falha MUDA: `StartDocPrinter`
 * falhava, `WritePrinter` seguia, nada era escrito e ninguém sabia.
 */
teste('nenhum retorno é descartado com Out-Null', () => {
  assert.ok(!/Out-Null/i.test(script));
});

teste('toda chamada do winspool tem o retorno conferido', () => {
  for (const trecho of [
    'if(!OpenPrinter(',
    'if(StartDocPrinter(h,1,ref di)==0)',
    'if(!StartPagePrinter(h))',
    'if(!WritePrinter(',
    'if(escritos!=b.Length)',
  ]) {
    assert.ok(script.includes(trecho), `faltou conferir: ${trecho}`);
  }
});

teste('o handle é sempre liberado, mesmo com exceção', () => {
  assert.ok(script.includes('} finally { EndDocPrinter(h); }'));
  assert.ok(script.includes('} finally { ClosePrinter(h); }'));
});

// ── os dados não entram no código ─────────────────────────────────────────
/**
 * ⚠️ A garantia estrutural: `scriptPowerShell()` não recebe argumento nenhum,
 * então não existe interpolação a escapar. Nome de impressora com aspas é
 * problema do `param`, não nosso.
 */
teste('o script não aceita dado nenhum e recebe tudo por `param`', () => {
  assert.strictEqual(scriptPowerShell.length, 0);
  assert.strictEqual(linhas[0], 'param([string]$impressora,[string]$arquivo)');
  assert.strictEqual(scriptPowerShell(), script);
});

teste('`param` é a PRIMEIRA instrução do arquivo (exigência do PowerShell)', () => {
  assert.ok(linhas[0].startsWith('param('));
});

// ── a linha de comando ────────────────────────────────────────────────────
/** ⚠️ `-Command` é o que obrigava a achatar o script. */
teste('usa -File, nunca -Command', () => {
  const cmd = comandoPowerShell('C:\\tmp\\a.ps1', 'Zebra ZD220', 'C:\\tmp\\a.bin');
  assert.ok(cmd.includes('-File "C:\\tmp\\a.ps1"'));
  assert.ok(!cmd.includes('-Command'));
});

teste('impressora e arquivo vão como argumentos entre aspas', () => {
  const cmd = comandoPowerShell('s.ps1', 'ZDesigner GC420t (EPL) (Copiar 1)', 'a.bin');
  assert.ok(cmd.includes('"ZDesigner GC420t (EPL) (Copiar 1)"'));
  assert.ok(cmd.endsWith('"a.bin"'));
});

teste('não executa o profile do usuário nem esbarra na política de execução', () => {
  const cmd = comandoPowerShell('s.ps1', 'X', 'a.bin');
  assert.ok(cmd.includes('-NoProfile'));
  assert.ok(cmd.includes('-ExecutionPolicy Bypass'));
});

for (const [nome, fn] of casos) {
  try {
    fn();
    passaram++;
    console.log(`  ✓ ${nome}`);
  } catch (erro) {
    console.error(`  ✗ ${nome}\n    ${erro.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passaram}/${casos.length} casos`);
