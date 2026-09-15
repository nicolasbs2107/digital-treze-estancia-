-- =====================================================================
-- UM PROPRIETÁRIO POR EMPRESA — ÍNDICE ÚNICO PARCIAL
-- ---------------------------------------------------------------------
-- O QUE ISTO RESOLVE
--
-- A Edge Function provision-business-admin confere business_members
-- antes de criar o owner. Entre a conferência e o insert existe uma
-- janela, e duas chamadas simultâneas cabem nela:
--
--     chamada A                      chamada B
--     lê business_members  (vazio)
--                                    lê business_members  (vazio)
--     convida ana@...                convida bruno@...
--     insert owner  -> ok
--                                    insert owner  -> ok    <-- dois donos
--
-- Nenhuma checagem feita ANTES do insert fecha essa janela — só o banco
-- fecha, porque só ele vê as duas transações. Com o índice abaixo, o
-- segundo insert vira erro 23505 e a Edge Function trata: desfaz o
-- convite que ela mesma acabou de criar e responde 409.
--
-- O QUE ISTO NÃO IMPEDE
--
-- Vários administradores na mesma empresa continuam possíveis: o índice
-- é PARCIAL (`where role = 'owner'`), então linhas com qualquer outra
-- role não entram nele e não disputam nada. O limite é de um owner por
-- business_id, não de um membro por business_id.
--
-- ESTE ARQUIVO NÃO:
--   · altera RLS ou policy nenhuma;
--   · altera, apaga ou reordena qualquer membership existente;
--   · cria tabela, coluna, trigger ou função.
--
-- Se já existir empresa com mais de um owner, ele ABORTA e não cria o
-- índice — arrumar isso é decisão sua, não de um script.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. PRÉ-REQUISITOS
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.business_members') is null then
    raise exception 'public.business_members não existe neste banco.';
  end if;

  if not exists (select 1 from pg_attribute
                 where attrelid = 'public.business_members'::regclass
                   and attname = 'role' and attnum > 0 and not attisdropped) then
    raise exception 'public.business_members não tem a coluna "role" — o índice parcial depende dela.';
  end if;

  if not exists (select 1 from pg_attribute
                 where attrelid = 'public.business_members'::regclass
                   and attname = 'business_id' and attnum > 0 and not attisdropped) then
    raise exception 'public.business_members não tem a coluna "business_id".';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. CONFERÊNCIA ANTES DE QUALQUER COISA
--    Criar um índice único sobre dados que já violam a regra falha com
--    a mensagem crua do Postgres, que não diz QUAIS empresas estão
--    duplicadas. Então perguntamos primeiro, e a mensagem lista os
--    business_id e quantos donos cada um tem.
-- ---------------------------------------------------------------------
do $$
declare
  v_lista text;
  v_qtd   int;
begin
  select count(*), string_agg(t.business_id::text || ' (' || t.donos || ' donos)', E'\n  ' order by t.donos desc, t.business_id)
    into v_qtd, v_lista
  from (
    select m.business_id, count(*) as donos
    from public.business_members m
    where m.role = 'owner'
    group by m.business_id
    having count(*) > 1
  ) t;

  if coalesce(v_qtd, 0) > 0 then
    raise exception E'Existe(m) % empresa(s) com mais de um proprietário. O índice NÃO foi criado.\n  %\n\nResolva antes de rodar este arquivo de novo: decida qual linha continua com role = ''owner'' e mude a role das outras (por exemplo para ''admin''). Este script não escolhe por você e não apaga membership nenhum.',
      v_qtd, v_lista;
  end if;

  raise notice 'Conferência OK: nenhuma empresa tem mais de um owner.';
end $$;

-- ---------------------------------------------------------------------
-- 2. UM ÍNDICE COM ESTE NOME JÁ EXISTE?
--    "create unique index if not exists" só olha o NOME. Se existir um
--    índice homônimo com outra definição, ele é aceito em silêncio e a
--    corrida continua aberta — parecendo resolvida. Então conferimos a
--    definição e abortamos quando ela não confere.
-- ---------------------------------------------------------------------
do $$
declare
  v_def text;
begin
  select indexdef into v_def
  from pg_indexes
  where schemaname = 'public'
    and tablename  = 'business_members'
    and indexname  = 'business_members_one_owner_per_business';

  if v_def is null then
    return;                                   -- não existe: será criado abaixo
  end if;

  if v_def !~* 'unique' or v_def !~* '\(business_id\)' or v_def !~* 'where.*role.*=.*''owner''' then
    raise exception E'Já existe um índice chamado business_members_one_owner_per_business, mas com outra definição:\n  %\n\nConfira-o antes de continuar: com o nome ocupado, "if not exists" não recria nada e a regra de um owner por empresa ficaria só aparentemente garantida.', v_def;
  end if;

  raise notice 'Índice business_members_one_owner_per_business já existia com a definição correta — mantido.';
end $$;

-- ---------------------------------------------------------------------
-- 3. O ÍNDICE
--    Único + parcial. Nenhuma linha com role diferente de 'owner' entra
--    nele, então vários admins na mesma empresa continuam permitidos.
--
--    Sem CONCURRENTLY de propósito: CONCURRENTLY não roda dentro de
--    transação, e aqui a transação é o que garante que uma falha não
--    deixe nada pela metade. A tabela é pequena (uma linha por pessoa
--    com acesso), então o bloqueio é instantâneo.
-- ---------------------------------------------------------------------
create unique index if not exists business_members_one_owner_per_business
  on public.business_members (business_id)
  where role = 'owner';

comment on index public.business_members_one_owner_per_business is
  'No máximo um role = ''owner'' por empresa. Parcial: outras roles não entram no índice, então vários administradores continuam possíveis. É esta constraint que fecha a corrida entre duas chamadas simultâneas de provision-business-admin.';

commit;

-- =====================================================================
-- CONFERÊNCIAS
-- =====================================================================

-- A. O índice existe e está com a definição esperada?
--    Esperado: uma linha, com UNIQUE, (business_id) e WHERE role = 'owner'.
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename  = 'business_members'
  and indexname  = 'business_members_one_owner_per_business';

-- B. Ele é realmente único e parcial?
--    Esperado: unico = t, parcial = t.
select i.indisunique          as unico,
       i.indpred is not null  as parcial,
       pg_get_expr(i.indpred, i.indrelid) as condicao
from pg_index i
where i.indexrelid = 'public.business_members_one_owner_per_business'::regclass;

-- C. Nenhuma empresa com mais de um dono (esperado: nenhuma linha)
select m.business_id, count(*) as donos
from public.business_members m
where m.role = 'owner'
group by m.business_id
having count(*) > 1;

-- D. Panorama: quantos membros e quantos donos por empresa
select b.slug,
       count(m.*)                                   as membros,
       count(*) filter (where m.role = 'owner')     as donos,
       string_agg(distinct m.role, ', ')            as roles
from public.businesses b
left join public.business_members m on m.business_id = b.id
group by b.slug
order by b.slug;

-- E. As policies de business_members NÃO foram tocadas.
--    Esperado: exatamente as mesmas de antes deste arquivo.
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'business_members'
order by policyname;

-- F. Nenhuma linha foi alterada por este arquivo: a contagem total
--    continua a mesma de antes de rodá-lo.
select count(*) as total_de_memberships from public.business_members;

-- =====================================================================
-- COMO A CONSTRAINT SE COMPORTA (exemplos COMENTADOS — nada roda)
-- =====================================================================

-- -- Segundo owner na mesma empresa -> recusado com 23505:
-- -- insert into public.business_members (business_id, user_id, role)
-- -- values ('<uuid-da-empresa>', '<outro-user>', 'owner');
-- --   ERROR:  duplicate key value violates unique constraint
-- --           "business_members_one_owner_per_business"
--
-- -- Vários administradores na mesma empresa -> continuam permitidos:
-- -- insert into public.business_members (business_id, user_id, role)
-- -- values ('<uuid-da-empresa>', '<outro-user>', 'admin');   -- ok
-- --
-- -- É esse 23505 que a Edge Function provision-business-admin captura
-- -- para desfazer o convite que ela acabou de criar e responder 409
-- -- "Esta empresa já possui um proprietário." em vez de 500.
-- =====================================================================
