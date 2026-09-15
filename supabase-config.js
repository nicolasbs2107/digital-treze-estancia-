/* =====================================================================
   ESTÂNCIA TREZE PIZZARIA — CONEXÃO COM O SUPABASE
   ---------------------------------------------------------------------
   Este projeto é estático: não existe build nem arquivo .env, então este
   arquivo é o lugar correto para o endereço do projeto e a chave
   PUBLICÁVEL (publishable / anon).

   A chave publicável PODE ficar visível no navegador — ela apenas
   identifica o projeto. Quem decide o que pode ser lido ou escrito é a
   Row Level Security do Supabase.

   NUNCA coloque aqui a secret key / service_role: ela ignora toda a RLS.
   ===================================================================== */

const SUPABASE_URL = "https://lzvqwvtwyehteofphplj.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Ljx0VpK3-bemlOMsZ8O_vg_Ntj7EP8a";

/* ---------------------------------------------------------------------
   QUAL EMPRESA ESTE SITE ATENDE

   Em produção NÃO existe empresa fixa: quem responde isso é o banco,
   pela RPC public.resolve_business_by_domain(), a partir do endereço
   que o visitante digitou (window.location.hostname). Um domínio que
   não esteja cadastrado e ativo em public.business_domains não carrega
   nada — nunca cai em outra empresa.

   A constante abaixo é EXCLUSIVA DE DESENVOLVIMENTO. Ela só é lida
   quando a página está aberta em localhost / 127.0.0.1 / ::1 / file://
   e nenhum ?loja=SLUG foi informado. Em qualquer endereço publicado
   ela é ignorada por completo — trocar o valor daqui não muda o site
   no ar.
   --------------------------------------------------------------------- */
const DEV_BUSINESS_SLUG = "estancia-treze";

/* ---------------------------------------------------------------------
   DATA_SOURCE — de onde vem o cardápio que o cliente vê.

   "supabase" → o cardápio vem EXCLUSIVAMENTE do banco.
                Se a consulta falhar, o site mostra a mensagem de
                indisponibilidade e bloqueia novos pedidos. Nunca cai
                silenciosamente para os preços locais.

   "local"    → usa o cardápio de desenvolvimento do menu-data.js.
                Só entra em cena quando você troca esta linha à mão.
   --------------------------------------------------------------------- */
const DATA_SOURCE = "supabase";

/* Mostra o resumo da carga no console (empresa, contagens e fonte).
   Nunca registra chave, token ou dado sensível. */
const DEBUG_CARDAPIO = true;
