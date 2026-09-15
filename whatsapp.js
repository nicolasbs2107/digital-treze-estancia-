/* =====================================================================
   NÚMERO DE WHATSAPP — normalização e exibição
   ---------------------------------------------------------------------
   Arquivo compartilhado pelo site público e pelo painel administrativo,
   para que os dois concordem sobre o que é um número válido e sobre o
   formato gravado no banco.

   O que o banco guarda: SOMENTE DÍGITOS, com o código do país.
       (14) 99798-2903      -> 5514997982903
       +55 14 99798-2903    -> 5514997982903

   Como o código do país é decidido (sem ambiguidade):
       10 ou 11 dígitos  = DDD + número       -> acrescenta 55
       12 ou 13 dígitos  = já vem com o país  -> mantém como está
   Isso resolve o caso do DDD 55 (Rio Grande do Sul): "55 99798-2903"
   tem 11 dígitos, então é DDD + número e vira 5555997982903 — o 55 do
   país não é acrescentado duas vezes.
   ===================================================================== */
window.Whats = (function () {
  "use strict";

  const soDigitos = (v) => String(v == null ? "" : v).replace(/\D/g, "");

  /* Checagem básica de número brasileiro:
     55 + DDD (11 a 99, sem terminar em 0) + assinante
     · 9 dígitos -> celular, começa com 9
     · 8 dígitos -> fixo, começa de 2 a 5                             */
  function valido(digitos) {
    if (!/^55\d{10,11}$/.test(digitos)) return false;
    const ddd = digitos.slice(2, 4);
    if (!/^[1-9][1-9]$/.test(ddd)) return false;
    const assinante = digitos.slice(4);
    if (assinante.length === 9) return /^9\d{8}$/.test(assinante);
    if (assinante.length === 8) return /^[2-5]\d{7}$/.test(assinante);
    return false;
  }

  /* Devolve { ok, numero, exibicao, motivo } — nunca lança. */
  function normalizar(valor) {
    const d = soDigitos(valor);

    if (!d) {
      return { ok: false, numero: "", exibicao: "",
               motivo: "Informe o número de WhatsApp que vai receber os pedidos." };
    }

    let numero;
    if (d.length === 10 || d.length === 11) numero = "55" + d;      // DDD + número
    else if (d.length === 12 || d.length === 13) numero = d;         // já tem o país
    else {
      return { ok: false, numero: "", exibicao: "",
               motivo: "Número incompleto. Use DDD + número, como (14) 99798-2903." };
    }

    if ((d.length === 12 || d.length === 13) && numero.slice(0, 2) !== "55") {
      return { ok: false, numero: "", exibicao: "",
               motivo: "Por enquanto só aceitamos números do Brasil (começam com 55)." };
    }
    if (!valido(numero)) {
      return { ok: false, numero: "", exibicao: "",
               motivo: "Esse número não parece válido. Confira o DDD e os dígitos." };
    }
    return { ok: true, numero: numero, exibicao: exibir(numero), motivo: "" };
  }

  /* 5514997982903 -> (14) 99798-2903 */
  function exibir(digitos) {
    const d = soDigitos(digitos);
    if (!valido(d)) return d;
    const ddd = d.slice(2, 4);
    const a = d.slice(4);
    const meio = a.length === 9 ? a.slice(0, 5) : a.slice(0, 4);
    const fim = a.length === 9 ? a.slice(5) : a.slice(4);
    return "(" + ddd + ") " + meio + "-" + fim;
  }

  return { normalizar: normalizar, exibir: exibir, valido: valido, soDigitos: soDigitos };
})();
