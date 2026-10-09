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
  comandoDesligarBidi,
  comandosDePreparo,
  ehZebra,
  linguagemDaImpressora,
} = require('./preparo-impressora');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

function montar({ falhar = false, bidiFalha = false, semBidi = false, agora = () => 1000, intervaloMs } = {}) {
  const enviados = [];
  const bidis = [];
  const logs = [];
  const preparo = criarPreparoDeImpressora({
    agora,
    intervaloMs,
    enviarZpl: async (nome, texto) => {
      if (falhar) throw new Error('impressora offline');
      enviados.push({ nome, texto });
    },
    desligarBidi: semBidi ? null : async (nome) => {
      if (bidiFalha) throw new Error('acesso negado');
      bidis.push(nome);
      return 'bidi_desligado';
    },
    registrar: (m) => logs.push(m),
  });
  return { preparo, enviados, bidis, logs };
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

// ── a linguagem ────────────────────────────────────────────────────────────
describe_bloco('ZPL ou EPL — o driver diz qual', () => {
  /**
   * ⚠️ O caso que a 1.0.5 errou. A impressora da expedição é a
   * `ZDesigner GC420t (EPL) (Copiar 1)`: o `~JSO` (ZPL) foi enviado, a
   * impressora ignorou, e a pausa continuou. Supor a linguagem pelo
   * fabricante não funciona — o sufixo do driver é quem sabe.
   */
  teste('o sufixo (EPL) no nome decide a linguagem', () => {
    assert.strictEqual(linguagemDaImpressora('ZDesigner GC420t (EPL) (Copiar 1)'), 'epl');
    assert.strictEqual(linguagemDaImpressora('ZDesigner GC420t (Copiar 1)'), 'zpl');
    assert.strictEqual(linguagemDaImpressora('Zebra ZD220'), 'zpl');
    assert.strictEqual(linguagemDaImpressora('Microsoft Print to PDF'), null);
  });

  teste('em EPL o comando é `JB`, não `~JSO`', () => {
    assert.strictEqual(comandosDePreparo({ linguagem: 'epl' }), 'JB\n');
    assert.ok(!comandosDePreparo({ linguagem: 'epl' }).includes('~JSO'));
  });

  teste('a impressora recebe o comando da SUA linguagem', async () => {
    const { preparo, enviados } = montar();
    await preparo.preparar('ZDesigner GC420t (EPL) (Copiar 1)');
    await preparo.preparar('ZDesigner GC420t (Copiar 1)');
    assert.deepStrictEqual(enviados.map((e) => e.texto), ['JB\n', '~JSO\n']);
  });

  /**
   * ⚠️ Desde a conversão PDF→ZPL no servidor (09/10/2026), a MESMA impressora
   * recebe ZPL cru mesmo com o driver EPL instalado: a Zebra troca de modo ao
   * ver o `^XA`. Nesse caso quem vale é o `~JSO`, e o nome do driver passa a
   * ser só o palpite do caminho em PDF.
   */
  teste('a linguagem do JOB vence o nome do driver', async () => {
    const { preparo, enviados } = montar();
    await preparo.preparar('ZDesigner GC420t (EPL) (Copiar 1)', { linguagem: 'zpl' });
    assert.deepStrictEqual(enviados.map((e) => e.texto), ['~JSO\n']);
  });

  /**
   * ⚠️ Em modo ZPL o `JB` é ignorado, e em modo EPL o `~JSO` também. Com a
   * memória guardada só pelo nome, o segundo modo ficaria uma hora inteira
   * sem preparo nenhum — e a pausa voltaria só nele.
   */
  teste('a mesma impressora é preparada nas DUAS linguagens', async () => {
    const { preparo, enviados } = montar();
    assert.strictEqual(await preparo.preparar('Zebra ZD220', { linguagem: 'zpl' }), 'preparada');
    assert.strictEqual(await preparo.preparar('Zebra ZD220', { linguagem: 'epl' }), 'preparada');
    assert.deepStrictEqual(enviados.map((e) => e.texto), ['~JSO\n', 'JB\n']);
    // mas não repete a mesma linguagem dentro do intervalo
    assert.strictEqual(await preparo.preparar('Zebra ZD220', { linguagem: 'zpl' }), 'recente');
  });

  /** A linguagem do job não pode fazer uma laser comum receber `~JSO`. */
  teste('`linguagem` do job NÃO contorna a lista de aceite', async () => {
    const { preparo, enviados } = montar();
    assert.strictEqual(
      await preparo.preparar('HP LaserJet 1020', { linguagem: 'zpl' }),
      'nao_e_zebra',
    );
    assert.deepStrictEqual(enviados, []);
  });

  teste('a velocidade em EPL é `S<n>`', () => {
    assert.strictEqual(comandosDePreparo({ linguagem: 'epl', velocidade: 4 }), 'JB\nS4\n');
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

// ── o bidirecional ─────────────────────────────────────────────────────────
describe_bloco('desligar o bidirecional da fila do Windows', () => {
  /**
   * ⚠️ A segunda causa, e a documentada pela Zebra: "long delay before jobs
   * print or between print jobs" em USB, por temporização entre o Windows e
   * o Language Monitor do driver. A correção é da FILA, não da impressora —
   * e por isso cabe a um SaaS aplicá-la sozinho.
   */
  teste('o preparo também desliga o bidirecional', async () => {
    const { preparo, bidis } = montar();
    await preparo.preparar('Zebra ZD220');
    assert.deepStrictEqual(bidis, ['Zebra ZD220']);
  });

  teste('a consulta WQL dobra a aspa simples do nome', () => {
    const cmd = comandoDesligarBidi("Zebra's ZD220");
    assert.ok(cmd.includes("Name='Zebra''s ZD220'"));
  });

  teste('não mexe em quem já está desligado', () => {
    assert.ok(comandoDesligarBidi('X').includes('bidi_ja_estava_desligado'));
  });

  /** Mexer na fila pode exigir elevação — e falhar nisso não pode apagar o
   * preparo que deu certo nem impedir a impressão. */
  teste('falha ao desligar o bidi NÃO derruba o preparo', async () => {
    const { preparo, enviados, logs } = montar({ bidiFalha: true });
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'preparada');
    assert.strictEqual(enviados.length, 1);
    assert.ok(logs.join(' ').includes('nao foi possivel desligar o bidirecional'));
  });

  teste('`bidi: false` pula só essa parte', async () => {
    const { preparo, enviados, bidis } = montar();
    await preparo.preparar('Zebra ZD220', { bidi: false });
    assert.strictEqual(enviados.length, 1);
    assert.deepStrictEqual(bidis, []);
  });

  teste('sem a porta `desligarBidi`, o preparo funciona igual', async () => {
    const { preparo, enviados } = montar({ semBidi: true });
    assert.strictEqual(await preparo.preparar('Zebra ZD220'), 'preparada');
    assert.strictEqual(enviados.length, 1);
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
