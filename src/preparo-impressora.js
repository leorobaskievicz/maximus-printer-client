/**
 * PREPARO DA IMPRESSORA — os comandos ZPL que tiram a pausa entre etiquetas.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * O PROBLEMA, DESCRITO POR QUEM OPERA (09/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * *"Imprime 1 etiqueta, a impressora parece que recalibra a posição e depois
 * imprime a nova."*
 *
 * Esse vai-e-volta é o **backfeed**. Em modo Tear-Off a Zebra avança a
 * etiqueta até a barra de destaque quando termina e **recua** antes da
 * próxima, para posicionar o início da impressão. Custa ~0,5–1,5 s POR
 * ETIQUETA e é mecânico: acontece por mais rápido que o software entregue.
 *
 * Foi por isso que agrupar os jobs (`fila-impressao.js`) deixou o software
 * 7,8× mais rápido — 26 etiquetas entregues em 4,3 s — e a expedição não viu
 * diferença no papel: a impressora leva ~40 s para cuspir as mesmas 26.
 *
 * ⚠️ **Enviar a configuração evita mexer em máquina por máquina.** Um SaaS
 * não pode pedir que cada cliente configure a própria impressora — a
 * alternativa manual ("Post-Print Action: None") foi procurada no driver da
 * expedição e **nem existe lá**.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ A SEGUNDA CAUSA, DOCUMENTADA PELA ZEBRA (09/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Depois de o backfeed não explicar tudo, a busca na base da Zebra achou o
 * sintoma descrito palavra por palavra: *"long delay before jobs print or
 * between print jobs"* em impressora USB no Windows — e a causa é um
 * **problema de temporização entre o tratamento USB do Windows e o Zebra
 * Language Monitor** do pacote de driver. A correção que eles indicam é
 * **desligar o suporte BIDIRECIONAL** da fila de impressão.
 *
 * Isso não é configuração da IMPRESSORA, é da fila do WINDOWS — e
 * `Win32_Printer.EnableBIDI` é gravável por WMI. Dá para fazer daqui, sem
 * ninguém abrir tela nenhuma, que é o que um SaaS precisa.
 *
 * ⚠️ O preço é real e está aceito: sem bidirecional o Windows deixa de ler
 * status da impressora (sem papel, tampa aberta). O Hub nunca usou esse
 * status — quem confirma impressão aqui é o ACK do próprio job.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ AS TRÊS REGRAS QUE ESTE ARQUIVO SEGUE (e por que cada uma existe)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **1. Só para impressora térmica, e na LINGUAGEM certa.** Mandar `~JSO` para
 * uma laser comum IMPRIME O TEXTO "~JSO" numa folha. A detecção é pelo nome e
 * é deliberadamente conservadora: na dúvida, não manda.
 *
 * ⚠️ **E a linguagem importa tanto quanto o modelo** (09/10/2026). A 1.0.5
 * mandou `~JSO` e a pausa continuou: a impressora da expedição é a
 * `ZDesigner GC420t (EPL) (Copiar 1)` — driver em **EPL**, onde `~JSO`
 * simplesmente não existe e é ignorado. Em EPL o comando equivalente é `JB`
 * (*Disable Top Of Form Backup*). Supor a linguagem pelo fabricante foi o
 * erro; o nome do driver diz qual é, e agora ele decide.
 *
 * **2. Nada que faça a impressora andar.** Os comandos `~` (control) são
 * processados na hora e não produzem papel. Ficaram DE FORA, de propósito:
 *   - `~JC`/`~JG` (calibrar) — faz exatamente o que queremos evitar e gasta
 *     etiqueta a cada envio;
 *   - `^MN` (media tracking) — errado, a impressora cospe etiquetas em branco;
 *   - `^MD`/`~SD` (darkness) — borra ou apaga o código de barras, e código que
 *     não lê na transportadora é um problema muito pior que 1,5 s de pausa;
 *   - `^LL`/`^PW` (tamanho) — dependem da mídia instalada; errado, corta o
 *     conteúdo;
 *   - `^JUS` (gravar na memória não volátil) — desgasta a EEPROM se enviado a
 *     cada impressão, e `~JS` já persiste sozinho.
 *
 * **3. Uma vez por impressora, não a cada etiqueta.** O pedido foi "antes de
 * toda impressão"; o efeito é o mesmo e o custo é menor assim. `~JS` é
 * configuração PERSISTENTE (sobrevive a desligar a impressora), então
 * repetir a cada lote só enfileira trabalho a mais no spooler. O reenvio
 * periódico cobre o caso de alguém restaurar o padrão de fábrica.
 */

/** Quanto tempo até reenviar o preparo para a mesma impressora. */
const INTERVALO_MS = 60 * 60 * 1000;

/**
 * Impressoras que falam ZPL, pelo nome que o Windows expõe.
 *
 * ⚠️ Lista de ACEITE, nunca de recusa: nome desconhecido não recebe nada. O
 * erro de não preparar é uma pausa que já existe; o de preparar errado é uma
 * folha impressa com "~JSO" em cada impressão.
 */
const NOME_DE_ZEBRA = /zebra|zdesigner|\bzd[24]\d{2}\b|\bg[ckx]4\d{2}\b|\bzt[24]\d{2}\b|\bzp\s?5\d{2}\b|\bzq\d{3}\b/i;

/** O driver anuncia a linguagem no próprio nome: "ZDesigner GC420t (EPL)". */
const NOME_DE_EPL = /\bepl\b/i;

function ehZebra(nomeDaImpressora) {
  return NOME_DE_ZEBRA.test(String(nomeDaImpressora || ''));
}

/**
 * `'epl'` | `'zpl'` | `null` — a linguagem que esta impressora entende.
 *
 * ⚠️ O sufixo `(EPL)` no nome do driver é a única pista confiável que temos
 * sem conversar com o equipamento. Errar aqui é mandar um comando que a
 * impressora ignora (o caso da 1.0.5) — ou, pior, que ela imprime.
 */
function linguagemDaImpressora(nomeDaImpressora) {
  const nome = String(nomeDaImpressora || '');
  if (!ehZebra(nome)) return null;
  return NOME_DE_EPL.test(nome) ? 'epl' : 'zpl';
}

/**
 * Os comandos, na ordem.
 *
 * **ZPL** — `~JSO` (*Backfeed Sequence: Off*). Control command: a impressora
 * processa na hora, sem imprimir nem avançar.
 *
 * **EPL** — `JB` (*Disable Top Of Form Backup*). Mesmo efeito, outra
 * linguagem. É o que a impressora da expedição entende, e o que faltava na
 * 1.0.5.
 *
 * `^XA^MMT^PR{v}^XZ` — formato de configuração, OPCIONAL (ver `velocidade`):
 *   - `^MMT` garante o modo Tear-Off (se a impressora estiver em Peel ou
 *     Cutter, o backfeed volta por outro caminho);
 *   - `^PR` é a velocidade de impressão em polegadas/s. A GC420t da expedição
 *     vai até 4; valor acima do suportado é limitado pela própria impressora.
 *
 * ⚠️ O formato de configuração é separado e desligável porque um `^XA…^XZ`
 * sem campo imprimível **não deveria** produzir etiqueta — mas "não deveria"
 * depende do firmware, e uma etiqueta em branco por lote é desperdício
 * visível. O `~JSO`, que é o que importa, não tem essa dúvida.
 */
function comandosDePreparo({ velocidade = null, linguagem = 'zpl' } = {}) {
  if (linguagem === 'epl') {
    const partes = ['JB'];
    // `S<n>` é a velocidade em EPL. Desligada por padrão, pela mesma razão do
    // `^PR`: mexer em parâmetro de impressão sem ver o papel.
    if (velocidade) partes.push(`S${velocidade}`);
    return partes.join('\n') + '\n';
  }
  const partes = ['~JSO'];
  if (velocidade) partes.push(`^XA^MMT^PR${velocidade}^XZ`);
  return partes.join('\n') + '\n';
}

/**
 * Cria o preparador.
 *
 * @param {(nome: string, texto: string) => Promise<void>} enviarZpl
 * @param {(mensagem: string) => void} [registrar]
 * @param {() => number} [agora] injetável para o teste não depender do relógio
 */
function criarPreparoDeImpressora({
  enviarZpl,
  desligarBidi = null,
  registrar = () => {},
  agora = Date.now,
  intervaloMs = INTERVALO_MS,
}) {
  /** `nome\0linguagem` → instante do último preparo bem-sucedido */
  const ultimoPreparo = new Map();

  /**
   * Prepara a impressora se for Zebra e se já passou do intervalo.
   *
   * ⚠️ **Nunca lança.** Preparo é otimização: se falhar, a etiqueta tem de
   * sair assim mesmo. Um erro aqui derrubando a impressão trocaria uma pausa
   * de 1,5 s por uma etiqueta que não imprime.
   */
  async function preparar(nomeDaImpressora, opcoes = {}) {
    if (opcoes.ligado === false) return 'desligado';
    /*
     * ⚠️ **Quem manda é o JOB, não o nome do driver** (09/10/2026). Desde a
     * conversão PDF→ZPL no servidor, a etiqueta pode chegar como ZPL cru para
     * a MESMA impressora cujo driver é EPL — e a Zebra troca de linguagem
     * sozinha ao ver o `^XA` ("automatic printer language detection and
     * switching", manual da GC420t). Nesse caso ela está em ZPL e quem vale é
     * o `~JSO`; o nome do driver passa a ser só o palpite de quando o job vem
     * em PDF, que é o caminho que de fato passa pelo driver.
     */
    const linguagem = opcoes.linguagem || linguagemDaImpressora(nomeDaImpressora);
    if (!linguagem || !ehZebra(nomeDaImpressora)) return 'nao_e_zebra';

    /*
     * ⚠️ A memória é por (impressora, LINGUAGEM). A mesma máquina recebendo um
     * lote em ZPL e outro em PDF precisa dos dois comandos: em modo ZPL o `JB`
     * é ignorado, e em modo EPL o `~JSO` também. Com a chave só no nome, o
     * segundo modo ficaria uma hora sem preparo nenhum.
     */
    const chave = `${nomeDaImpressora}\u0000${linguagem}`;
    const ultimo = ultimoPreparo.get(chave);
    if (ultimo && agora() - ultimo < intervaloMs) return 'recente';

    try {
      await enviarZpl(nomeDaImpressora, comandosDePreparo({ ...opcoes, linguagem }));
      ultimoPreparo.set(chave, agora());
      registrar(
        `impressora ${nomeDaImpressora} preparada em ${linguagem.toUpperCase()} (backfeed desligado)`,
      );
      /*
       * ⚠️ DEPOIS do comando, e com erro isolado: desligar o bidirecional é a
       * segunda causa (ver o cabeçalho), mas mexe na fila do Windows e pode
       * exigir elevação. Falhar aqui não pode apagar o preparo que deu certo.
       */
      if (desligarBidi && opcoes.bidi !== false) {
        try {
          registrar(`${nomeDaImpressora}: ${await desligarBidi(nomeDaImpressora)}`);
        } catch (erro) {
          registrar(
            `${nomeDaImpressora}: nao foi possivel desligar o bidirecional ` +
              `(${erro && erro.message ? erro.message : erro})`,
          );
        }
      }
      return 'preparada';
    } catch (erro) {
      // Não marca como preparada: a próxima impressão tenta de novo.
      registrar(
        `preparo de ${nomeDaImpressora} falhou (${erro && erro.message ? erro.message : erro}) — imprimindo assim mesmo`,
      );
      return 'falhou';
    }
  }

  /** Só para teste/diagnóstico. */
  function esquecer() {
    ultimoPreparo.clear();
  }

  return { preparar, esquecer };
}

/**
 * O comando WMI que desliga o bidirecional de UMA fila de impressão.
 *
 * ⚠️ `Put()` grava na configuração do spooler — pode exigir elevação. Quando
 * não houver, o erro vai para o log e a impressão segue: é otimização, não
 * requisito.
 *
 * ⚠️ O nome da impressora entra com aspas simples DOBRADAS, não escapadas com
 * barra: é WQL dentro de PowerShell, e `Zebra's` quebraria a consulta.
 */
function comandoDesligarBidi(nomeDaImpressora) {
  const nome = String(nomeDaImpressora).replace(/'/g, "''");
  return (
    `$p = Get-WmiObject Win32_Printer -Filter "Name='${nome}'"; ` +
    'if ($p -and $p.EnableBIDI) { $p.EnableBIDI = $false; $r = $p.Put(); ' +
    "Write-Output 'bidi_desligado' } " +
    "elseif ($p) { Write-Output 'bidi_ja_estava_desligado' } " +
    "else { Write-Output 'impressora_nao_encontrada' }"
  );
}

module.exports = {
  criarPreparoDeImpressora,
  comandoDesligarBidi,
  comandosDePreparo,
  ehZebra,
  linguagemDaImpressora,
  NOME_DE_ZEBRA,
  INTERVALO_MS,
};
