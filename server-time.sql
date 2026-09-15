-- =====================================================================
-- ESTÂNCIA TREZE PIZZARIA — HORA OFICIAL DO SERVIDOR
-- ---------------------------------------------------------------------
-- Cria uma função RPC pública e SOMENTE LEITURA que devolve a hora atual
-- do servidor do Supabase. O site público usa essa hora para decidir se
-- a loja está aberta, em vez de confiar no relógio do aparelho do
-- cliente (que pode estar adiantado, atrasado ou em outro fuso).
--
-- O que esta função NÃO faz:
--   · não lê nenhuma tabela;
--   · não recebe parâmetro nenhum;
--   · não grava nada;
--   · não usa security definer (roda com o privilégio de quem chamou);
--   · não recebe permissão de service_role nem de nenhuma chave
--     administrativa.
--
-- Seguro para rodar mais de uma vez: se a função já existir, o script
-- apenas confere e avisa, sem recriar e sem duplicar.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Já existe alguma função equivalente?
--    Procura qualquer função no schema public, sem argumentos, que
--    devolva timestamptz e tenha um nome do mesmo sentido. Se achar uma
--    com outro nome, avisa para você reaproveitar em vez de criar mais.
-- ---------------------------------------------------------------------
do $$
declare
  equivalente text;
begin
  select string_agg(p.oid::regprocedure::text, ', ')
    into equivalente
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.pronargs = 0
    and p.prorettype = 'timestamptz'::regtype
    and p.proname <> 'get_server_now'
    and p.proname in (
      'server_now', 'now_server', 'server_time', 'get_server_time',
      'hora_servidor', 'agora_servidor', 'current_server_time'
    );

  if equivalente is not null then
    raise notice 'ATENÇÃO: já existe função equivalente no banco: %. '
                 'Avalie reaproveitá-la no lugar de get_server_now().', equivalente;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. A função
--    language sql + stable: o Postgres sabe que ela não altera nada.
--    Sem security definer: nenhum privilégio extra é emprestado.
--    set search_path = pg_catalog: blinda a resolução de now().
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.get_server_now()') is null then
    execute $f$
      create function public.get_server_now()
      returns timestamptz
      language sql
      stable
      set search_path = pg_catalog
      as $inner$
        select now();
      $inner$;
    $f$;
    raise notice 'Função public.get_server_now() criada.';
  else
    raise notice 'Função public.get_server_now() já existia — mantida como está.';
  end if;
end $$;

comment on function public.get_server_now() is
  'Hora oficial do servidor (timestamptz, UTC no fio). Usada pelo cardápio para saber se a loja está aberta sem depender do relógio do aparelho do cliente.';

-- ---------------------------------------------------------------------
-- 3. Conferência do que já existia
--    Se a função foi criada antes com outra forma (volátil, ou security
--    definer), o script avisa em vez de sobrescrever silenciosamente.
-- ---------------------------------------------------------------------
do $$
declare
  volatilidade "char";
  definer      boolean;
begin
  select p.provolatile, p.prosecdef
    into volatilidade, definer
  from pg_proc p
  where p.oid = to_regprocedure('public.get_server_now()');

  if volatilidade = 'v' then
    raise notice 'ATENÇÃO: get_server_now() está marcada como VOLATILE. '
                 'Funciona, mas o esperado é STABLE.';
  end if;

  if definer then
    raise notice 'ATENÇÃO: get_server_now() está como SECURITY DEFINER. '
                 'Ela não precisa disso — considere trocar para SECURITY INVOKER.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Permissões — apenas anon e authenticated
--    Primeiro tira de PUBLIC (que é o padrão do Postgres e alcançaria
--    qualquer papel, inclusive os administrativos) e depois devolve
--    somente para os dois papéis que o site usa.
-- ---------------------------------------------------------------------
revoke all on function public.get_server_now() from public;
grant execute on function public.get_server_now() to anon, authenticated;

commit;

-- =====================================================================
-- 5. CONFERÊNCIA (rode e compare com o esperado)
-- =====================================================================

-- 5.1 A função responde? (esperado: a data e hora atuais em UTC)
select public.get_server_now() as hora_do_servidor;

-- 5.2 Forma da função
--     esperado: retorno = timestamp with time zone
--               volatilidade = stable
--               security_definer = false
select p.proname                              as funcao,
       pg_get_function_result(p.oid)          as retorno,
       case p.provolatile when 's' then 'stable'
                          when 'i' then 'immutable'
                          else 'volatile' end as volatilidade,
       p.prosecdef                            as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_server_now';

-- 5.3 Quem pode executar
--     esperado: anon, authenticated e o dono da função (postgres) — o
--     dono sempre aparece, isso é do Postgres e não é uma permissão que
--     o site use.
--     Se aparecer PUBLIC, service_role ou qualquer outro papel, revise.
select grantee, privilege_type
from information_schema.routine_privileges
where specific_schema = 'public'
  and routine_name = 'get_server_now'
order by grantee;
