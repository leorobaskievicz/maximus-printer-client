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
 * ⚠️ **Enviar a configuração evita mexer em máquina por máquina.** Era a
 * alternativa: trocar "Post-Print Action" para `None` no driver de cada
 * computador. Um comando no fio resolve para todas, inclusive as que forem
 * instaladas depois.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ AS TRÊS REGRAS QUE ESTE ARQUIVO SEGUE (e por que cada uma existe)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **1. Só para impressora que fala ZPL.** Mandar `~JSO` para uma laser comum
 * IMPRIME O TEXTO "~JSO" numa folha. A detecção é pelo nome e é
 * deliberadamente conservadora: na dúvida, não manda.
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

function ehZebra(nomeDaImpressora) {
  return NOME_DE_ZEBRA.test(String(nomeDaImpressora || ''));
}

/**
 * Os comandos, na ordem.
 *
 * `~JSO` — **Backfeed Sequence: Off.** É o que resolve o sintoma relatado.
 * Control command: a impressora processa na hora, sem imprimir nem avançar.
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
function comandosDePreparo({ velocidade = null } = {}) {
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
function criarPreparoDeImpressora({ enviarZpl, registrar = () => {}, agora = Date.now, intervaloMs = INTERVALO_MS }) {
  /** nome da impressora → instante do último preparo bem-sucedido */
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
    if (!nomeDaImpressora || !ehZebra(nomeDaImpressora)) return 'nao_e_zebra';

    const ultimo = ultimoPreparo.get(nomeDaImpressora);
    if (ultimo && agora() - ultimo < intervaloMs) return 'recente';

    try {
      await enviarZpl(nomeDaImpressora, comandosDePreparo(opcoes));
      ultimoPreparo.set(nomeDaImpressora, agora());
      registrar(`impressora ${nomeDaImpressora} preparada (backfeed desligado)`);
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

module.exports = {
  criarPreparoDeImpressora,
  comandosDePreparo,
  ehZebra,
  NOME_DE_ZEBRA,
  INTERVALO_MS,
};
