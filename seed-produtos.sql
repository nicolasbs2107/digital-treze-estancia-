-- =====================================================================
-- ESTÂNCIA TREZE PIZZARIA — SEED DO CARDÁPIO DEMONSTRATIVO
-- Gerado a partir do menu-data.js do projeto. Nada foi inventado:
-- nomes, descrições, preços, tamanhos, bordas, adicionais e imagens são
-- exatamente os que estão hoje no site.
--
-- Produtos: 17   (pizzas-tradicionais: 5, pizzas-especiais: 4, pizzas-doces: 3, bebidas: 5)
--
-- O business_id vem do slug 'estancia-treze' e cada category_id vem da
-- tabela categories pelo par (business_id, slug). Nenhum UUID escrito à mão.
--
-- "Mais pedidas" NÃO é criada como categoria: continua sendo uma aba
-- virtual do frontend, montada com featured = true.
--
-- As ilustrações SVG não vão para o banco — seguem como fallback do site.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Conferências antes de escrever qualquer coisa.
--    Se faltar a empresa ou alguma categoria, o seed para aqui e nada
--    é alterado (estamos dentro de uma transação).
-- ---------------------------------------------------------------------
do $$
declare
  v_business uuid;
  v_faltando text;
begin
  select id into v_business from public.businesses where slug = 'estancia-treze';
  if v_business is null then
    raise exception 'Empresa com slug "estancia-treze" não encontrada em public.businesses';
  end if;

  select string_agg(s, ', ') into v_faltando
  from unnest(array['pizzas-tradicionais','pizzas-especiais','pizzas-doces','bebidas']) as s
  where not exists (
    select 1 from public.categories c where c.business_id = v_business and c.slug = s
  );

  if v_faltando is not null then
    raise exception 'Categorias não encontradas para esta empresa: %', v_faltando;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. SOMENTE PARA SEED DE DESENVOLVIMENTO
--    Apaga os produtos desta empresa para o seed poder rodar quantas
--    vezes for preciso sem duplicar. Aceitável apenas enquanto o banco
--    não tem produtos reais cadastrados pelo proprietário.
--    REMOVER ESTE BLOCO ANTES DE QUALQUER USO EM PRODUÇÃO.
-- ---------------------------------------------------------------------
delete from public.products
where business_id = (
  select id
  from public.businesses
  where slug = 'estancia-treze'
);

-- ---------------------------------------------------------------------
-- 2. Produtos
-- ---------------------------------------------------------------------
with empresa as (
  select id from public.businesses where slug = 'estancia-treze'
),
dados (cat_slug, name, description, image_url, price, sizes, borders, addons, featured, available, position) as (
  values
  ('pizzas-tradicionais', 'Pizza Calabresa', 'Molho de tomate, muçarela, calabresa fatiada, cebola e orégano.', 'https://images.unsplash.com/photo-1534308983496-4fabb1a015ee?w=640&h=640&q=72&auto=format&fit=crop', '34.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":34.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":44.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":54.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'true', 'true', '1'),  -- pizza · destaque
  ('pizzas-tradicionais', 'Pizza Frango com Catupiry', 'Molho de tomate, muçarela, frango desfiado e Catupiry.', 'https://images.unsplash.com/photo-1593504049359-74330189a345?w=640&h=640&q=72&auto=format&fit=crop', '34.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":34.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":44.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":54.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'true', 'true', '2'),  -- pizza · destaque
  ('pizzas-tradicionais', 'Pizza Portuguesa', 'Muçarela, presunto, ovo, cebola, tomate e azeitonas.', 'https://images.unsplash.com/photo-1604382354936-07c5d9983bd3?w=640&h=640&q=72&auto=format&fit=crop', '34.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":34.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":44.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":54.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'true', 'true', '3'),  -- pizza · destaque
  ('pizzas-tradicionais', 'Pizza Muçarela', 'Molho de tomate, muçarela em fatias e orégano.', 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=640&h=640&q=72&auto=format&fit=crop', '32.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":32.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":42.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":52.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'false', 'true', '4'),  -- pizza
  ('pizzas-tradicionais', 'Pizza Marguerita', 'Muçarela, rodelas de tomate, manjericão fresco e azeite.', 'https://images.unsplash.com/photo-1598023696416-0193a0bcd302?w=640&h=640&q=72&auto=format&fit=crop', '34.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":34.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":44.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":54.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'false', 'true', '5'),  -- pizza
  ('pizzas-especiais', 'Pizza Filé Mignon Especial', 'Filé mignon em cubos, muçarela, tomate e temperos da casa.', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=640&h=640&q=72&auto=format&fit=crop', '39.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":39.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":49.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":59.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'true', 'true', '1'),  -- pizza · destaque
  ('pizzas-especiais', 'Pizza Quatro Queijos', 'Muçarela, provolone, parmesão e Catupiry.', 'https://images.unsplash.com/photo-1594007654729-407eedc4be65?w=640&h=640&q=72&auto=format&fit=crop', '39.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":39.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":49.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":59.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'true', 'true', '2'),  -- pizza · destaque
  ('pizzas-especiais', 'Pizza Bacon Especial', 'Muçarela, bacon crocante, tomate e orégano.', 'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=640&h=640&q=72&auto=format&fit=crop', '39.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":39.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":49.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":59.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'false', 'true', '3'),  -- pizza
  ('pizzas-especiais', 'Pizza Lombo com Catupiry', 'Lombo canadense, muçarela, Catupiry e cebola caramelizada.', 'https://images.unsplash.com/photo-1613564834361-9436948817d1?w=640&h=640&q=72&auto=format&fit=crop', '39.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":39.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":49.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":59.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'false', 'true', '4'),  -- pizza
  ('pizzas-doces', 'Pizza Chocolate', 'Chocolate ao leite derretido e finalização especial da casa.', 'https://images.unsplash.com/photo-1708649783218-b2b9a8781724?w=640&h=640&q=72&auto=format&fit=crop', '32.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":32.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":42.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":52.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'false', 'true', '1'),  -- pizza
  ('pizzas-doces', 'Pizza Chocolate com Morango', 'Chocolate ao leite e morangos frescos fatiados.', 'https://images.unsplash.com/photo-1767114916329-9b5649724379?w=640&h=640&q=72&auto=format&fit=crop', '34.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":34.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":44.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":54.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'true', 'true', '2'),  -- pizza · destaque
  ('pizzas-doces', 'Pizza Banana com Canela', 'Banana, açúcar, canela e fios de leite condensado.', 'https://images.unsplash.com/photo-1568594245756-74df6a35e197?w=640&h=640&q=72&auto=format&fit=crop', '32.90', '[{"id":"broto","name":"Broto","detail":"4 fatias · 25 cm","price":32.9,"promo_price":null},{"id":"media","name":"Média","detail":"6 fatias · 30 cm","price":42.9,"promo_price":null},{"id":"grande","name":"Grande","detail":"8 fatias · 35 cm","price":52.9,"promo_price":null}]', '[{"id":"sem","name":"Sem borda","price":0},{"id":"catupiry","name":"Catupiry","price":8},{"id":"cheddar","name":"Cheddar","price":8}]', '[{"id":"bacon","name":"Bacon","price":5},{"id":"catupiry","name":"Catupiry extra","price":5},{"id":"mucarela","name":"Muçarela extra","price":5}]', 'false', 'true', '3'),  -- pizza
  ('bebidas', 'Coca-Cola lata', '350 ml gelada.', null, '8.00', '[]', '[]', '[]', 'false', 'true', '1'),  -- simples
  ('bebidas', 'Guaraná lata', '350 ml gelada.', null, '8.00', '[]', '[]', '[]', 'false', 'true', '2'),  -- simples
  ('bebidas', 'Coca-Cola 2L', 'Garrafa 2 litros gelada.', null, '14.00', '[]', '[]', '[]', 'false', 'true', '3'),  -- simples
  ('bebidas', 'Guaraná 2L', 'Garrafa 2 litros gelada.', null, '14.00', '[]', '[]', '[]', 'false', 'true', '4'),  -- simples
  ('bebidas', 'Água mineral', '500 ml, com ou sem gás.', null, '6.00', '[]', '[]', '[]', 'false', 'true', '5')  -- simples
)
insert into public.products
  (business_id, category_id, name, description, image_url,
   price, sizes, borders, addons, featured, available, position)
select
  e.id,
  c.id,
  d.name,
  d.description,
  nullif(d.image_url, '')            as image_url,
  d.price::numeric(10,2),
  d.sizes::jsonb,
  d.borders::jsonb,
  d.addons::jsonb,
  d.featured::boolean,
  d.available::boolean,
  d.position::int
from dados d
cross join empresa e
join public.categories c
  on c.business_id = e.id
 and c.slug = d.cat_slug;

commit;

-- =====================================================================
-- 3. CONFERÊNCIA
-- =====================================================================

-- 3.1 Total de produtos da empresa (esperado: 17)
select count(*) as total_produtos
from public.products p
join public.businesses b on b.id = p.business_id
where b.slug = 'estancia-treze';

-- 3.2 Total por categoria
select c.slug as categoria, c.name as categoria_nome, count(p.id) as produtos
from public.categories c
join public.businesses b on b.id = c.business_id
left join public.products p on p.category_id = c.id
where b.slug = 'estancia-treze'
group by c.slug, c.name, c.position
order by c.position;

-- 3.3 Lista completa
select
  p.name       as produto,
  c.name       as categoria,
  p.price      as preco,
  p.featured,
  p.available,
  p.position,
  jsonb_array_length(coalesce(p.sizes, '[]'::jsonb))   as tamanhos,
  jsonb_array_length(coalesce(p.borders, '[]'::jsonb)) as bordas,
  jsonb_array_length(coalesce(p.addons, '[]'::jsonb))  as adicionais,
  (p.image_url is not null)                            as tem_imagem
from public.products p
join public.categories c on c.id = p.category_id
join public.businesses b on b.id = p.business_id
where b.slug = 'estancia-treze'
order by c.position, p.position;

-- 3.4 Produtos em destaque (alimentam a aba virtual "Mais pedidas")
select p.name as produto, c.name as categoria
from public.products p
join public.categories c on c.id = p.category_id
join public.businesses b on b.id = p.business_id
where b.slug = 'estancia-treze' and p.featured
order by c.position, p.position;
