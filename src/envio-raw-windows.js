/**
 * ENVIO RAW PARA O SPOOLER DO WINDOWS — a montagem do script PowerShell.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ POR QUE ISTO VIVE NUM MÓDULO PRÓPRIO, COM TESTE
 * ══════════════════════════════════════════════════════════════════════════
 * Este pedaço de código **falhou em silêncio três vezes**, e nenhuma delas
 * apareceu como erro de impressão — a etiqueta saía pelo caminho do PDF e o
 * comando simplesmente nunca chegava à impressora:
 *
 *  1. até 1.0.6: `DOC_INFO_1` declarada como `int[3]` (12 bytes) onde são
 *     TRÊS PONTEIROS (24 bytes em x64), e `|Out-Null` engolindo todo retorno;
 *  2. 1.0.7/1.0.8: o script inteiro era colapsado numa linha só por um
 *     `.replace(/\n\s+/g, ' ')`, para caber em `powershell -Command`. O log da
 *     expedição em 09/10/2026 mostrou o resultado:
 *
 *         $ErrorActionPreference='Stop' Add-Type -TypeDefinition @" ...
 *                                       ~~~~~~~~
 *         Token 'Add-Type' inesperado na expressao ou instrucao.
 *         No linha:1 caractere:32
 *
 *     "linha 1" é o diagnóstico inteiro. Numa linha só, os comandos ficam sem
 *     `;` entre eles **e** o here-string `@"…"@` deixa de ser válido — ele
 *     exige quebra de linha logo depois do `@"` e o `"@` começando a linha.
 *
 * A lição: **o script não cabe numa linha de comando.** Ele vai para um
 * arquivo `.ps1`, e os dados vão como ARGUMENTO (`param(...)`), nunca
 * interpolados no código — assim nome de impressora com aspas deixa de ser um
 * problema de escape.
 *
 * ⚠️ `pDatatype = "RAW"` é obrigatório. Sem ele o spooler usa o padrão do
 * driver, que no ZDesigner pode ser gráfico — e aí os bytes do ZPL saem
 * IMPRESSOS como texto na etiqueta, em vez de interpretados.
 */

/**
 * O script, pronto para ser gravado em `.ps1`.
 *
 * ⚠️ Nenhum dado entra aqui: impressora e arquivo chegam por `param`. A função
 * não recebe argumento NENHUM de propósito — é a garantia estrutural de que
 * não há interpolação a escapar.
 */
function scriptPowerShell() {
  return `param([string]$impressora,[string]$arquivo)
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
[RawPrint]::Enviar($impressora,$arquivo)
`;
}

/**
 * A linha de comando.
 *
 * ⚠️ `-File`, nunca `-Command`: é `-Command` que obriga a achatar o script e
 * foi o que quebrou a 1.0.7/1.0.8.
 */
function comandoPowerShell(caminhoDoScript, nomeDaImpressora, caminhoDoArquivo) {
  return (
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${caminhoDoScript}" ` +
    `"${nomeDaImpressora}" "${caminhoDoArquivo}"`
  );
}

module.exports = { scriptPowerShell, comandoPowerShell };
