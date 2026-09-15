-- =====================================================================
-- SUPER ADMIN DA PLATAFORMA — INFRAESTRUTURA DE BANCO
-- ---------------------------------------------------------------------
-- Esta etapa cria SOMENTE o que vive dentro do Postgres. Nada de
-- frontend, nada de /superadmin, nada de Edge Function, nada de Vercel.
--
-- O que entra aqui:
--   1. public.platform_admins            quem é admin DA PLATAFORMA
--   2. RLS fechada nessa tabela          ninguém lê nem escreve pelo navegador
--                                        (e o schema ABORTA se ela não estiver
--                                         exatamente assim)
--   3. public.is_platform_admin()        a única porta de autorização
--   4. public.normalize_business_slug()  "Pizzaria do João" -> pizzaria-do-joao
--   5. public.normalize_business_whatsapp()  (14) 99999-9999 -> 5514999999999
--   6. public.superadmin_list_businesses()   listagem para a futura tela
--   7. public.superadmin_create_business()   cria a estrutura de um cliente
--
-- DUAS IDEIAS QUE NÃO SE MISTURAM:
--
--   platform_admin  = dono da plataforma. Não aparece em business_members,
--                     não é dono de empresa nenhuma, e não ganha acesso
--                     genérico às tabelas: o poder dele existe apenas
--                     DENTRO das RPCs deste arquivo.
--   business owner  = cliente. Continua sendo identificado por
--                     business_members, exatamente como hoje.
--
-- NENHUMA policy existente é alterada. Em lugar nenhum deste arquivo
-- existe "or is_platform_admin()" acrescentado a uma policy de
-- businesses, products, categories, delivery ou horários — de propósito:
-- se algum dia houver um bug no super admin, o estrago fica contido nas
-- funções daqui, e não espalhado pela segurança do sistema inteiro.
--
-- NÃO CONTÉM: service_role, secret key, UUID escrito à mão, e-mail de
-- exemplo, criação de usuário em auth.users, criação de empresa, nem
-- inserção de ninguém em platform_admins.
--
-- Seguro para rodar de novo: nenhum DROP TABLE, nenhum DROP COLUMN,
-- nenhum DELETE. Tabela com "if not exists", funções com
-- "create or replace", policies e grants verificados antes.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. PRÉ-REQUISITOS
--    Falhar agora, com uma frase clara, é melhor do que criar metade da
--    estrutura e descobrir o problema na primeira empresa criada.
-- ---------------------------------------------------------------------
do $$
declare
  faltando text[] := '{}';
  t text;
begin
  -- business_domains entra na lista porque superadmin_list_businesses()
  -- lê dessa tabela para descobrir o domínio principal de cada empresa.
  foreach t in array array['businesses', 'business_members', 'categories', 'products',
                           'delivery_settings', 'business_hours', 'business_hours_settings',
                           'business_domains'] loop
    if to_regclass('public.' || t) is null then
      faltando := faltando || t;
    end if;
  end loop;

  if array_length(faltando, 1) is not null then
    raise exception 'Tabelas ausentes em public: %. Rode os schemas anteriores antes deste (delivery-schema.sql, business-hours-schema.sql, business-profile-schema.sql, business-domains-schema.sql).',
      array_to_string(faltando, ', ');
  end if;

  if to_regclass('auth.users') is null then
    raise exception 'auth.users não existe — este schema é feito para um projeto Supabase.';
  end if;

  -- colunas que as RPCs usam nominalmente
  if not exists (select 1 from pg_attribute
                 where attrelid = 'public.businesses'::regclass
                   and attname = 'updated_at' and not attisdropped) then
    raise exception 'public.businesses.updated_at não existe — rode business-profile-schema.sql antes.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. public.platform_admins
--    Uma linha por administrador da plataforma. A chave é o UUID do
--    usuário do Supabase Auth — NUNCA o e-mail: e-mail muda, pode ser
--    reaproveitado e é digitado pelo usuário. UUID não.
--
--    ON DELETE CASCADE: se a conta some do Auth, o privilégio some
--    junto. Não fica admin órfão apontando para um usuário inexistente.
--
--    A tabela nasce VAZIA e continua vazia depois deste arquivo. O
--    primeiro super admin será cadastrado por um SQL separado e
--    explícito (item 24 do pedido).
-- ---------------------------------------------------------------------
create table if not exists public.platform_admins (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  active     boolean     not null default true,
  created_at timestamptz not null default now()
);

comment on table public.platform_admins is
  'Administradores DA PLATAFORMA (não são donos de empresa). Fechada para anon e authenticated: só é lida pela função public.is_platform_admin().';
comment on column public.platform_admins.user_id is
  'auth.users.id do administrador. A autorização é sempre por UUID, nunca por e-mail.';
comment on column public.platform_admins.active is
  'Permite revogar o acesso sem apagar a linha (fica o histórico do created_at).';

-- ---------------------------------------------------------------------
-- 2. RLS: a tabela fica fechada
--    RLS ligada e NENHUMA policy criada. Sem policy, RLS nega tudo para
--    quem não é dono da tabela: anon e authenticated não conseguem
--    select, insert, update nem delete, nem mesmo descobrir se estão
--    lá dentro.
--
--    Os REVOKE abaixo são a segunda tranca: mesmo que alguém crie uma
--    policy sem querer no futuro, sem GRANT não há acesso.
--
--    ATENÇÃO ao mexer aqui: NÃO usar "force row level security". A
--    função is_platform_admin() é SECURITY DEFINER e roda como dona da
--    tabela — é justamente por isso que ela consegue ler. Com FORCE,
--    o dono também passaria a obedecer às policies (que não existem) e
--    a função responderia "false" para todo mundo, para sempre.
-- ---------------------------------------------------------------------
alter table public.platform_admins enable row level security;

revoke all on table public.platform_admins from public;
revoke all on table public.platform_admins from anon;
revoke all on table public.platform_admins from authenticated;

-- A tabela FALHA FECHADA: se o estado não for exatamente o previsto —
-- RLS ligada, FORCE desligada, zero policies — o schema aborta em vez de
-- seguir em frente. Uma policy inesperada aqui significa que alguém
-- (ou algum script) abriu uma porta nesta tabela, e continuar seria
-- carimbar como correto um estado que não é.
do $$
declare
  v_rls     boolean;
  v_force   boolean;
  v_policies text;
begin
  select c.relrowsecurity, c.relforcerowsecurity
    into v_rls, v_force
  from pg_class c
  where c.oid = 'public.platform_admins'::regclass;

  if not v_rls then
    raise exception 'public.platform_admins está com RLS DESLIGADA. A tabela precisa estar fechada.';
  end if;

  if v_force then
    raise exception 'public.platform_admins está com FORCE ROW LEVEL SECURITY ligado. Com FORCE, nem a dona da tabela lê, e public.is_platform_admin() passaria a responder false para todo mundo. Rode: alter table public.platform_admins no force row level security;';
  end if;

  select string_agg(policyname, ', ' order by policyname)
    into v_policies
  from pg_policies
  where schemaname = 'public' and tablename = 'platform_admins';

  if v_policies is not null then
    raise exception 'public.platform_admins tem policy(s) que não deveriam existir: %. Esta tabela é fechada de propósito: sem policy nenhuma, a RLS nega tudo para anon e authenticated, e só public.is_platform_admin() (SECURITY DEFINER) a enxerga. Remova a(s) policy(s) e rode este arquivo de novo.', v_policies;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. public.is_platform_admin()
--    A ÚNICA porta de autorização do super admin.
--
--    Não recebe parâmetro nenhum. Isso é proposital: uma função do tipo
--    is_platform_admin(p_user_id uuid) poderia ser chamada com o UUID de
--    outra pessoa, e quem passa o parâmetro é o navegador. Aqui a
--    identidade vem exclusivamente de auth.uid(), que sai do JWT
--    verificado pelo servidor e não pode ser forjado pelo frontend.
--
--    SECURITY DEFINER porque platform_admins está fechada: a função roda
--    com os privilégios de quem a criou e enxerga a tabela, sem precisar
--    abrir nada para o público.
--
--    search_path fixo em pg_catalog, pg_temp (pg_temp por ÚLTIMO) e
--    todas as referências qualificadas por schema: nenhum objeto
--    temporário criado por quem chama pode se passar por
--    public.platform_admins ou por auth.uid().
-- ---------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from public.platform_admins a
    where a.user_id = auth.uid()
      and a.active is true
  );
$$;

comment on function public.is_platform_admin() is
  'true somente se o usuário autenticado (auth.uid()) estiver em platform_admins com active = true. Não aceita parâmetro: a identidade vem do JWT, nunca do frontend.';

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated;
-- anon não executa: visitante do cardápio não tem o que perguntar aqui.

-- ---------------------------------------------------------------------
-- 4. public.normalize_business_slug(text)
--    "Pizzaria do João"  -> pizzaria-do-joao
--    "  Bella Pizza  "   -> bella-pizza
--    "Café --- Açaí!!"   -> cafe-acai
--
--    Sem depender da extensão unaccent (que pode não estar instalada no
--    projeto): translate() troca letra a letra. Depois, tudo que não é
--    a-z0-9 vira hífen, hifens repetidos viram um só e os das pontas
--    saem. Devolve NULL quando não sobra nada aproveitável.
--
--    CUIDADO AO EDITAR AS DUAS STRINGS DO translate():
--    elas são posicionais e precisam ter EXATAMENTE o mesmo número de
--    caracteres — 55 e 55. translate() não reclama de tamanhos
--    diferentes: ele simplesmente ignora o excedente, e um caractere a
--    mais no meio desloca todo o resto do mapeamento em silêncio. A
--    conferência I, no fim do arquivo, testa justamente as letras do
--    fim da fila (Ú, Ç, Ñ), que são as primeiras a quebrar quando isso
--    acontece.
--
--        origem:  ...ÚÙÛÜúùûüÇçÑñÝÿý   (55 caracteres)
--        destino: ...uuuuuuuuccnnyyy   (55 caracteres)
--
--    IMMUTABLE: mesma entrada, mesma saída, sempre — pode ser usada em
--    índice ou constraint no futuro.
-- ---------------------------------------------------------------------
create or replace function public.normalize_business_slug(p_valor text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select nullif(
           btrim(
             regexp_replace(
               regexp_replace(
                 lower(translate(
                   btrim(coalesce(p_valor, '')),
                   'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖØóòôõöøÚÙÛÜúùûüÇçÑñÝÿý',
                   'aaaaaaaaaaaaeeeeeeeeiiiiiiiioooooooooooouuuuuuuuccnnyyy'
                 )),
                 '[^a-z0-9]+', '-', 'g'
               ),
               '-{2,}', '-', 'g'
             ),
             '-'
           ),
           ''
         );
$$;

comment on function public.normalize_business_slug(text) is
  'Transforma um nome em slug: minúsculas, sem acento, espaços e símbolos viram hífen, sem hífen repetido nem nas pontas. NULL quando não sobra nada.';

revoke all on function public.normalize_business_slug(text) from public;
grant execute on function public.normalize_business_slug(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. public.normalize_business_whatsapp(text)
--    Mesmas regras que o painel já usa (whatsapp.js), agora também do
--    lado do banco, para a RPC não depender de validação feita no
--    navegador. O frontend NÃO foi alterado: continua com a lógica dele.
--
--        (14) 99999-9999   -> 5514999999999
--        +55 14 99999-9999 -> 5514999999999
--        5514999999999     -> 5514999999999   (não duplica o 55)
--
--    Como o código do país é decidido, sem ambiguidade:
--        10 ou 11 dígitos = DDD + número      -> acrescenta 55
--        12 ou 13 dígitos = já veio com país  -> mantém
--    É o que resolve o DDD 55 (Rio Grande do Sul): "55 99999-9999" tem
--    11 dígitos, então é DDD + número, e vira 5555999999999.
--
--    Validação: 55 + DDD de 11 a 99 (nenhum dígito zero) + assinante
--        9 dígitos -> celular, começa com 9
--        8 dígitos -> fixo, começa de 2 a 5
--    Número que não passa vira NULL — quem decide o que fazer com isso é
--    quem chamou.
-- ---------------------------------------------------------------------
create or replace function public.normalize_business_whatsapp(p_valor text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  d          text;
  numero     text;
  ddd        text;
  assinante  text;
begin
  d := regexp_replace(coalesce(p_valor, ''), '[^0-9]', '', 'g');
  if d = '' then
    return null;
  end if;

  if length(d) in (10, 11) then
    numero := '55' || d;
  elsif length(d) in (12, 13) then
    numero := d;
  else
    return null;                      -- curto ou longo demais
  end if;

  if left(numero, 2) <> '55' then
    return null;                      -- por enquanto, só Brasil
  end if;

  ddd := substr(numero, 3, 2);
  if ddd !~ '^[1-9][1-9]$' then
    return null;
  end if;

  assinante := substr(numero, 5);
  if length(assinante) = 9 and assinante ~ '^9[0-9]{8}$' then
    return numero;
  elsif length(assinante) = 8 and assinante ~ '^[2-5][0-9]{7}$' then
    return numero;
  end if;

  return null;
end;
$$;

comment on function public.normalize_business_whatsapp(text) is
  'Normaliza um número brasileiro para o formato do WhatsApp (só dígitos, com 55 na frente). NULL quando o número não é válido. Mesmas regras do whatsapp.js.';

revoke all on function public.normalize_business_whatsapp(text) from public;
grant execute on function public.normalize_business_whatsapp(text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. public.superadmin_list_businesses()
--    Listagem para a futura tela /superadmin.
--
--    Devolve SÓ dados de empresa. Nada de auth.users: nem e-mail, nem
--    id de usuário, nem data de último acesso. Quem é o dono da empresa
--    não é assunto desta função.
--
--    Os contadores saem de subconsultas simples nas próprias tabelas do
--    projeto. Rodando como SECURITY DEFINER, a RLS das tabelas não
--    atrapalha a contagem — e isso só é aceitável porque a primeira
--    linha do corpo já garantiu que quem chamou é super admin.
-- ---------------------------------------------------------------------
create or replace function public.superadmin_list_businesses()
returns table (
  id             uuid,
  name           text,
  slug           text,
  whatsapp       text,
  created_at     timestamptz,
  updated_at     timestamptz,
  products_count bigint,
  members_count  bigint,
  primary_domain text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'ACCESS DENIED: é necessário estar autenticado.'
      using errcode = '42501';
  end if;
  if not public.is_platform_admin() then
    raise exception 'ACCESS DENIED: esta operação é exclusiva do administrador da plataforma.'
      using errcode = '42501';
  end if;

  return query
    select
      b.id,
      b.name,
      b.slug,
      b.whatsapp,
      b.created_at,
      b.updated_at,
      (select count(*) from public.products p        where p.business_id = b.id),
      (select count(*) from public.business_members m where m.business_id = b.id),
      (select d.domain from public.business_domains d
        where d.business_id = b.id and d.is_primary is true and d.active is true
        limit 1)
    from public.businesses b
    order by b.created_at asc;
end;
$$;

comment on function public.superadmin_list_businesses() is
  'Lista as empresas da plataforma para a tela /superadmin. Exclusiva de platform_admin. Não devolve nada de auth.users.';

revoke all on function public.superadmin_list_businesses() from public;
grant execute on function public.superadmin_list_businesses() to authenticated;

-- ---------------------------------------------------------------------
-- 7. public.superadmin_create_business(...)
--    Cria a ESTRUTURA de um cliente novo — e só isso.
--
--    NÃO cria usuário em auth.users. NÃO cria linha em business_members.
--    NÃO adiciona o super admin como dono de coisa nenhuma. Convidar ou
--    criar o administrador do cliente é trabalho da futura Edge Function
--    (ver o rodapé deste arquivo), onde a service_role pode viver como
--    secret de servidor.
--
--    ATOMICIDADE: uma função plpgsql roda dentro de uma única transação.
--    Qualquer exceção aqui dentro — inclusive as levantadas pelas
--    constraints — desfaz TUDO o que a função já tinha feito. Não fica
--    empresa criada sem horários, nem horários sem empresa. O bloco
--    EXCEPTION do final existe só para trocar a mensagem crua do
--    Postgres por uma frase legível; o rollback acontece do mesmo jeito.
--
--    Parâmetros: nenhum deles diz respeito a permissão. Não existe, e
--    não deve passar a existir, um "p_is_super_admin" ou "p_user_id" —
--    quem autoriza é auth.uid() + is_platform_admin(), sempre.
--
--    p_whatsapp é OBRIGATÓRIO. Ele continua declarado com "default null"
--    apenas porque vem depois de p_slug, que tem default — o Postgres
--    não aceita um parâmetro sem default atrás de outro que tem. Quem
--    exige o valor é o corpo da função: chamar sem WhatsApp, ou com
--    string vazia, devolve erro e não cria nada. Uma empresa sem número
--    não teria como receber pedido nenhum pelo checkout.
-- ---------------------------------------------------------------------
create or replace function public.superadmin_create_business(
  p_name                       text,
  p_slug                       text default null,
  p_whatsapp                   text default null,   -- obrigatório (ver 7.4)
  p_create_pizzeria_categories boolean default true
)
returns table (
  business_id uuid,
  name        text,
  slug        text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id        uuid;
  v_name      text;
  v_slug      text;
  v_whatsapp  text;
  v_tem_icon  boolean;
  v_dia       smallint;
  c           record;
begin
  -- ---- 7.1 AUTORIZAÇÃO: antes de qualquer outra coisa ----
  if auth.uid() is null then
    raise exception 'ACCESS DENIED: é necessário estar autenticado.'
      using errcode = '42501';
  end if;
  if not public.is_platform_admin() then
    raise exception 'ACCESS DENIED: esta operação é exclusiva do administrador da plataforma.'
      using errcode = '42501';
  end if;

  -- ---- 7.2 NOME ----
  v_name := btrim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'O nome da empresa é obrigatório.' using errcode = '22023';
  end if;
  if length(v_name) > 120 then
    raise exception 'O nome da empresa é longo demais (máximo de 120 caracteres).' using errcode = '22023';
  end if;

  -- ---- 7.3 SLUG ----
  -- Em branco: sai do nome. Preenchido: normalizado do mesmo jeito, para
  -- não existirem duas regras de slug no sistema.
  v_slug := public.normalize_business_slug(coalesce(nullif(btrim(coalesce(p_slug, '')), ''), v_name));
  if v_slug is null then
    raise exception 'Não foi possível gerar um endereço (slug) a partir de "%". Informe um slug com letras ou números.', v_name
      using errcode = '22023';
  end if;
  if length(v_slug) > 60 then
    raise exception 'O slug ficou longo demais (%). Informe um slug mais curto.', v_slug
      using errcode = '22023';
  end if;

  -- Conferência explícita ANTES do insert, só para a mensagem ser boa.
  -- Quem garante de verdade é a UNIQUE de businesses.slug, e é ela que
  -- vale numa corrida entre duas criações ao mesmo tempo (tratada no
  -- EXCEPTION lá embaixo). Nada de acrescentar "-2" por conta própria.
  if exists (select 1 from public.businesses b where b.slug = v_slug) then
    raise exception 'Já existe uma empresa com o slug "%". Escolha outro.', v_slug
      using errcode = '23505';
  end if;

  -- ---- 7.4 WHATSAPP (obrigatório) ----
  -- É o número que vai receber os pedidos. Sem ele o checkout do
  -- cardápio não tem para onde mandar nada, então a empresa não nasce
  -- pela metade: nasce com número ou não nasce.
  if nullif(btrim(coalesce(p_whatsapp, '')), '') is null then
    raise exception 'O WhatsApp da empresa é obrigatório. Informe DDD + número, como (14) 99798-2903.'
      using errcode = '22023';
  end if;

  v_whatsapp := public.normalize_business_whatsapp(p_whatsapp);
  if v_whatsapp is null then
    raise exception 'WhatsApp inválido: "%". Use DDD + número, como (14) 99798-2903.', p_whatsapp
      using errcode = '22023';
  end if;

  -- ---- 7.5 EMPRESA ----
  -- Só name, slug e whatsapp. Descrição, Instagram, endereço, logo e
  -- favicon ficam NULL: nada é copiado de nenhuma empresa existente.
  insert into public.businesses (name, slug, whatsapp)
  values (v_name, v_slug, v_whatsapp)
  returning businesses.id into v_id;

  -- ---- 7.6 ENTREGA (estado inicial conservador) ----
  -- Delivery DESLIGADO: a casa liga quando tiver as regras dela.
  -- Nenhum bairro é criado.
  insert into public.delivery_settings
    (business_id, enabled, fee_mode, fixed_fee, min_order,
     free_delivery_above, allow_unlisted_neighborhoods)
  values
    (v_id, false, 'confirm', null, 0, null, true);

  -- ---- 7.7 HORÁRIOS ----
  insert into public.business_hours_settings
    (business_id, timezone, accept_orders_when_closed)
  values
    (v_id, 'America/Sao_Paulo', true);

  -- Os sete dias fechados e sem horário — é o que a constraint
  -- business_hours_coerencia_check exige de um dia fechado.
  for v_dia in 0..6 loop
    insert into public.business_hours (business_id, day_of_week, is_closed, opens_at, closes_at)
    values (v_id, v_dia, true, null, null);
  end loop;

  -- ---- 7.8 CATEGORIAS INICIAIS (opcionais) ----
  -- "Mais pedidas" NÃO entra: ela é uma aba virtual do frontend, montada
  -- a partir de products.featured, e não existe como categoria no banco.
  if p_create_pizzeria_categories then
    select exists (
      select 1 from pg_attribute
      where attrelid = 'public.categories'::regclass
        and attname = 'icon' and attnum > 0 and not attisdropped
    ) into v_tem_icon;

    for c in
      select * from (values
        ('Pizzas tradicionais', 'pizzas-tradicionais', 1, '🍕'),
        ('Pizzas especiais',    'pizzas-especiais',    2, '⭐'),
        ('Pizzas doces',        'pizzas-doces',        3, '🍫'),
        ('Bebidas',             'bebidas',             4, '🥤')
      ) as t(nome, slug, posicao, icone)
    loop
      -- SQL dinâmico apenas para a coluna `icon` ser opcional. O texto é
      -- literal e fixo; todo valor vai por USING, então não há como
      -- injetar nada por aqui.
      if v_tem_icon then
        execute 'insert into public.categories (business_id, name, slug, position, active, icon)
                 values ($1, $2, $3, $4, true, $5)'
          using v_id, c.nome, c.slug, c.posicao, c.icone;
      else
        execute 'insert into public.categories (business_id, name, slug, position, active)
                 values ($1, $2, $3, $4, true)'
          using v_id, c.nome, c.slug, c.posicao;
      end if;
    end loop;
  end if;

  -- ---- 7.9 RETORNO ----
  -- business_id é o que a futura Edge Function usará para ligar o
  -- administrador do cliente em business_members.
  return query select v_id, v_name, v_slug;

exception
  when unique_violation then
    -- Duas criações ao mesmo tempo com o mesmo slug: uma passa, a outra
    -- chega aqui. Tudo o que esta chamada fez já foi desfeito.
    raise exception 'Já existe uma empresa com o slug "%". Escolha outro.', v_slug
      using errcode = '23505';
end;
$$;

comment on function public.superadmin_create_business(text, text, text, boolean) is
  'Cria a estrutura de uma empresa nova (businesses + delivery_settings + business_hours_settings + 7 dias + categorias opcionais), de forma atômica. Exclusiva de platform_admin. NÃO cria usuário em auth.users nem linha em business_members.';

revoke all on function public.superadmin_create_business(text, text, text, boolean) from public;
grant execute on function public.superadmin_create_business(text, text, text, boolean) to authenticated;

commit;

-- =====================================================================
-- CONFERÊNCIAS
-- =====================================================================

-- A. A tabela
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'platform_admins'
order by ordinal_position;

-- B. A chave estrangeira para auth.users, com a regra de exclusão
select con.conname                                as constraint_name,
       confrelid::regclass::text                  as referencia,
       case con.confdeltype when 'c' then 'CASCADE'
                            when 'r' then 'RESTRICT'
                            when 'a' then 'NO ACTION'
                            when 'n' then 'SET NULL'
                            when 'd' then 'SET DEFAULT' end as on_delete
from pg_constraint con
where con.conrelid = 'public.platform_admins'::regclass
  and con.contype = 'f';

-- C. RLS ligada, FORCE desligada e NENHUMA policy
--    Esperado: rls_ligada = true, rls_forcada = false, politicas = 0.
select relrowsecurity  as rls_ligada,
       relforcerowsecurity as rls_forcada,
       (select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'platform_admins') as politicas
from pg_class
where oid = 'public.platform_admins'::regclass;

-- D. Quem tem privilégio na TABELA (esperado: nenhuma linha para anon
--    e authenticated — a tabela é fechada)
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'platform_admins'
  and grantee in ('anon', 'authenticated', 'PUBLIC')
order by grantee, privilege_type;

-- E. A tabela está vazia? (esperado: 0 — o bootstrap é um SQL à parte)
select count(*) as administradores_cadastrados from public.platform_admins;

-- F. As funções: retorno, volatilidade, security definer, argumentos e
--    search_path
select p.proname                                   as funcao,
       pg_get_function_result(p.oid)               as retorno,
       case p.provolatile when 'i' then 'IMMUTABLE'
                          when 's' then 'STABLE'
                          when 'v' then 'VOLATILE' end as volatilidade,
       p.prosecdef                                 as security_definer,
       pg_get_function_arguments(p.oid)            as argumentos,
       coalesce(array_to_string(p.proconfig, ', '), '(sem search_path fixo)') as configuracao
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_platform_admin', 'normalize_business_slug',
                    'normalize_business_whatsapp',
                    'superadmin_list_businesses', 'superadmin_create_business')
order by p.proname;

-- G. Permissões de execução das funções
--    Esperado: authenticated pode executar as cinco; anon e PUBLIC, nenhuma.
select p.proname as funcao,
       r.rolname as papel,
       has_function_privilege(r.rolname, p.oid, 'EXECUTE') as pode_executar
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
where n.nspname = 'public'
  and p.proname in ('is_platform_admin', 'normalize_business_slug',
                    'normalize_business_whatsapp',
                    'superadmin_list_businesses', 'superadmin_create_business')
order by p.proname, r.rolname;

-- H. PUBLIC não executa nada (esperado: nenhuma linha)
--    A conferência lê a ACL de pg_proc diretamente, em vez de passar
--    'public' como se fosse um usuário: PUBLIC é um pseudo-papel da ACL,
--    e na ACL ele aparece como grantee = 0. proacl nula significa "ACL
--    padrão", que para função inclui EXECUTE para PUBLIC — por isso o
--    coalesce com acldefault(), senão uma função nunca tocada por
--    GRANT/REVOKE passaria despercebida.
select p.proname as funcao_aberta_ao_public
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(
  coalesce(p.proacl, acldefault('f', p.proowner))
) acl
where n.nspname = 'public'
  and p.proname in (
    'is_platform_admin',
    'normalize_business_slug',
    'normalize_business_whatsapp',
    'superadmin_list_businesses',
    'superadmin_create_business'
  )
  and acl.grantee = 0
  and acl.privilege_type = 'EXECUTE';

-- I. A normalização do slug, sem gravar nada.
--    A coluna "confere" precisa ser TODA true. Os casos com Ú, Ç e Ñ
--    estão aqui de propósito: são os primeiros a quebrar se as duas
--    strings do translate() deixarem de ter o mesmo tamanho.
select entrada,
       public.normalize_business_slug(entrada) as slug,
       public.normalize_business_slug(entrada) is not distinct from esperado as confere
from (values
  ('Única Pizza',             'unica-pizza'),
  ('Ção Pizzaria',            'cao-pizzaria'),
  ('Ñandú',                   'nandu'),
  ('Café --- Açaí!!',         'cafe-acai'),
  ('Pizzaria do João',        'pizzaria-do-joao'),
  ('  Bella Pizza  ',         'bella-pizza'),
  ('Estância Treze Pizzaria', 'estancia-treze-pizzaria'),
  ('ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ', 'aaaaaaeeeeiiiiooooouuuucny'),
  ('áàâãäåéèêëíìîïóòôõöúùûüçñýÿ', 'aaaaaaeeeeiiiiooooouuuucnyy'),
  ('---',                     null),
  ('',                        null)
) as t(entrada, esperado);

-- I.2 As duas strings do translate() têm o mesmo tamanho?
--     Esperado: origem = 55, destino = 55, iguais = true.
select length('ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖØóòôõöøÚÙÛÜúùûüÇçÑñÝÿý')  as origem,
       length('aaaaaaaaaaaaeeeeeeeeiiiiiiiioooooooooooouuuuuuuuccnnyyy')   as destino,
       length('ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖØóòôõöøÚÙÛÜúùûüÇçÑñÝÿý')
         = length('aaaaaaaaaaaaeeeeeeeeiiiiiiiioooooooooooouuuuuuuuccnnyyy') as iguais;

-- J. A normalização do WhatsApp, sem gravar nada
--    (NULL = recusado)
select entrada, public.normalize_business_whatsapp(entrada) as numero
from (values
  ('(14) 99798-2903'),
  ('+55 14 99798-2903'),
  ('5514997982903'),
  ('55 99798-2903'),
  ('1433334444'),
  ('14 3333-4444'),
  ('123'),
  ('1 202 555 0134'),
  ('')
) as t(entrada);

-- K. As policies das tabelas existentes NÃO foram tocadas.
--    Esperado: nenhuma linha — nenhuma policy do sistema menciona
--    is_platform_admin.
select schemaname, tablename, policyname
from pg_policies
where schemaname = 'public'
  and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%is_platform_admin%';

-- =====================================================================
-- EXEMPLOS DE USO — DEIXADOS COMENTADOS DE PROPÓSITO
-- Nada abaixo roda. Nenhuma empresa e nenhum usuário são criados por
-- este arquivo.
-- =====================================================================

-- -- 1) BOOTSTRAP DO PRIMEIRO SUPER ADMIN (SQL separado, feito por você)
-- --    Rode no SQL Editor do Supabase, com o SEU usuário já criado em
-- --    Authentication -> Users. Nenhum UUID escrito à mão: ele é
-- --    procurado pelo e-mail no momento da execução.
-- --
-- -- insert into public.platform_admins (user_id)
-- -- select u.id from auth.users u
-- -- where u.email = 'coloque-aqui-o-seu-email'
-- -- on conflict (user_id) do update set active = true;

-- -- 2) CONFERIR SE VOCÊ É SUPER ADMIN (logado no app, não no SQL Editor:
-- --    no editor auth.uid() é nulo e a resposta é sempre false)
-- -- select public.is_platform_admin();

-- -- 3) LISTAR AS EMPRESAS
-- -- select * from public.superadmin_list_businesses();

-- -- 4) CRIAR UMA EMPRESA (a estrutura, nada de usuário)
-- --    p_whatsapp é obrigatório: sem ele a chamada devolve erro e não
-- --    cria nada.
-- -- select * from public.superadmin_create_business(
-- --   'Pizzaria do João',      -- p_name
-- --   null,                    -- p_slug      (null = sai do nome: pizzaria-do-joao)
-- --   '(14) 99999-9999',       -- p_whatsapp  (OBRIGATÓRIO)
-- --   true                     -- p_create_pizzeria_categories
-- -- );

-- -- 5) REVOGAR UM SUPER ADMIN sem apagar o histórico
-- -- update public.platform_admins set active = false where user_id = '...';

-- =====================================================================
-- PRÓXIMA ETAPA (NÃO IMPLEMENTADA AQUI): EDGE FUNCTION
--   provision-business-admin
--
--   Super Admin autenticado
--     -> Edge Function confere public.is_platform_admin() com o JWT dele
--     -> Supabase Admin Auth (service_role, secret DO SERVIDOR)
--     -> cria ou convida o usuário do cliente
--     -> recebe user.id
--     -> insere em business_members (business_id, user_id, role = 'owner')
--
--   A service_role poderá existir SOMENTE dentro da Edge Function, como
--   variável de ambiente do servidor. NUNCA em HTML, JS público,
--   admin.js, superadmin.js ou em qualquer arquivo versionado no GitHub.
--
--   Só depois disso o cliente consegue entrar no painel /admin: é a
--   linha em business_members que dá a ele a empresa.
-- =====================================================================
