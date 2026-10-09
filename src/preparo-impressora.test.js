/**
 * Teste do preparo da impressora — `node src/preparo-impressora.test.js`.
 *
 * O que se prova aqui é quase todo sobre o que NÃO fazer. Preparo é a única
 * coisa que este programa escreve na configuração de um equipamento alheio:
 * mandar para a impressora errada imprime lixo numa folha, e mandar comando
 * errado estraga a impressão de quem está trabalhando.
 */
const assert = require('assert');
const {
  criarPreparoDeImpressora,
  comandosDePreparo,
  ehZebra,
} = require('./preparo-impressora');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

function montar({ falhar = false, agora = () => 1000, intervaloMs } = {}) {
  const enviados = [];
  const logs = [];
  const preparo = criarPreparoDeImpressora({
    agora,
    intervaloMs,
    enviarZpl: async (nome, texto) => {
      if (falhar) throw new Error('impressora offline');
      enviados.push({ nome, texto });
    },
    registrar: (m) => logs.push(m),
  });
  return { preparo, enviados, logs };
}

// ── quem recebe ────────────────────────────────────────────────────────────
describe_bloco('a detecção é lista de ACEITE', () => {
  teste('reconhece as Zebras da expedição', () => {
    assert.ok(ehZebra('ZDesigner GC420t (Copiar 1)'));
    assert.ok(ehZebra('ZDesigner GC420t (EPL) (Copiar 1)'));
    assert.ok(ehZebra('Zebra ZD220'));
    assert.ok(ehZebra('ZDesigner ZT411'));
  });

  /**
   * ⚠️ O caso que justifica a lista ser de aceite: `~JSO` numa laser comum
   * sai IMPRESSO numa folha, a cada lote.
   */
  teste('NÃO reconhece impressora que não fala ZPL', () => {
    for (const nome of [
      'Microsoft Print to PDF',
      'OneNote (Desktop)',
      'Microsoft XPS Document Writer',
      'Fax',
      'HP LaserJet 1020',
      'EPSON L3150',
      '',
      null,
    ]) {
      assert.strictEqual(ehZebra(nome), false, `casou indevidamente: ${nome}`);
    }
  });

  teste('impressora desconhecida não recebe nada', async () => {
    const { preparo, enviados } = montar();
    assert.strictEqual(await preparo.preparar('HP LaserJet 1020'), 'nao_e_zebra');
    assert.deepStrictEqual(enviados, []);
  });
});

// ── o que é enviado ────────────────────────────────────────────────────────
describe_bloco('os comandos', () => {
  teste('o preparo mínimo é só `~JSO` — o que desliga o backfeed', () => {
    assert.strictEqual(comandosDePreparo(), '~JSO\n');
  });

  /**
   * ⚠️ A lista negra. Cada um destes já tem motivo escrito no módulo: calibrar
   * gasta etiqueta, tracking errado cospe papel, darkness apaga o código de
   * barras, tamanho errado corta o conteúdo, e `^JUS` desgasta a EEPROM.
   */
  teste('NUNCA envia comando que mexe em mídia, calibra ou grava memória', () => {
    const tudo = comandosDePreparo({ velocidade: 4 });
    for (const proibido of ['~JC', '~JG', '^MN', '^MD', '~SD', '^LL', '^PW', '^JUS']) {
      assert.ok(!tudo.includes(proibido), `enviou ${proibido}`);
    }
  });

  teste('a velocidade só entra quando pedida, e dentro de um formato', () => {
    assert.ok(!comandosDePreparo().includes('^PR'));
    assert.strictEqual(comandosDePreparo({ velocidade: 4 }), '~JSO\n^XA^MMT^PR4^XZ\n');
  });
});

// ── quando é enviado ───────────────────────────────────────────────────────
describe_bloco('a frequência', () => {
  teste('prepara na primeira impressão', async () => {
    const { preparo, enviados } = montar();
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'preparada');
    assert.strictEqual(enviados.length, 1);
    assert.strictEqual(enviados[0].texto, '~JSO\n');
  });

  /** `~JS` é configuração persistente: repetir a cada lote só enche o spooler. */
  teste('não repete dentro do intervalo', async () => {
    const { preparo, enviados } = montar();
    await preparo.preparar('Zebra ZD220');
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'recente');
    assert.strictEqual(enviados.length, 1);
  });

  teste('reenvia depois do intervalo (cobre reset de fábrica)', async () => {
    let t = 1000;
    const { preparo, enviados } = montar({ agora: () => t, intervaloMs: 5000 });
    await preparo.preparar('Zebra ZD220');
    t += 6000;
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'preparada');
    assert.strictEqual(enviados.length, 2);
  });

  teste('cada impressora tem o seu próprio controle', async () => {
    const { preparo, enviados } = montar();
    await preparo.preparar('Zebra ZD220');
    await preparo.preparar('ZDesigner GC420t');
    assert.deepStrictEqual(enviados.map((e) => e.nome), ['Zebra ZD220', 'ZDesigner GC420t']);
  });
});

// ── quando dá errado ───────────────────────────────────────────────────────
describe_bloco('falha', () => {
  /**
   * ⚠️ Trocar uma pausa de 1,5 s por uma etiqueta que não sai seria um
   * péssimo negócio. Preparo é otimização: falhou, segue.
   */
  teste('falha no envio NÃO lança — a etiqueta sai assim mesmo', async () => {
    const { preparo, logs } = montar({ falhar: true });
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'falhou');
    assert.ok(logs.join(' ').includes('imprimindo assim mesmo'));
  });

  teste('falha não marca como preparada — a próxima tenta de novo', async () => {
    const enviados = [];
    let deveFalhar = true;
    const preparo = criarPreparoDeImpressora({
      enviarZpl: async (nome, texto) => {
        if (deveFalhar) throw new Error('offline');
        enviados.push({ nome, texto });
      },
    });
    await preparo.preparar('Zebra ZD220');
    deveFalhar = false;
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'preparada');
    assert.strictEqual(enviados.length, 1);
  });

  /** O freio de mão: desligar sem precisar de release. */
  teste('`ligado: false` não envia nada', async () => {
    const { preparo, enviados } = montar();
    assert.strictEqual(await preparo.preparar('Zebra ZD220', { ligado: false }), 'desligado');
    assert.deepStrictEqual(enviados, []);
  });
});

function describe_bloco(nome, fn) {
  casos.push([`── ${nome}`, null]);
  fn();
}

(async () => {
  for (const [nome, fn] of casos) {
    if (!fn) { console.log(`  ${nome}`); continue; }
    try {
      await fn();
      passaram++;
      console.log(`  ✓ ${nome}`);
    } catch (erro) {
      console.error(`  ✗ ${nome}\n    ${erro.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passaram}/${casos.filter(([, f]) => f).length} casos`);
})();
