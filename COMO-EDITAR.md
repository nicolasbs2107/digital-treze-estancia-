# Estância Treze Pizzaria — cardápio digital

Site estático (HTML + CSS + JS puro). Não precisa de build, servidor ou dependências:
basta abrir `index.html` ou subir os 4 arquivos em qualquer hospedagem
(Hostinger, Vercel, Netlify, GitHub Pages, cPanel...).

```
index.html     estrutura da página
styles.css     visual (cores, tipografia, layout)
menu-data.js   <-- TODO O CARDÁPIO E OS DADOS DO NEGÓCIO
app.js         lógica (carrinho, modal, WhatsApp)
```

## 1. Trocar o cardápio demonstrativo pelo real

Tudo está em `menu-data.js`. Nenhuma alteração é necessária nos outros arquivos.

**Pizza:**

```js
{
  id: "calabresa",                  // identificador único (sem espaços)
  nome: "Pizza Calabresa",
  categoria: "tradicionais",        // id de uma categoria em CATEGORIAS
  tipo: "pizza",                    // abre tamanho, borda e adicionais
  destaque: true,                   // aparece em "Mais pedidas"
  descricao: "Molho, muçarela, calabresa...",
  imagem: null,                     // troque por "fotos/calabresa.jpg"
  precos: { broto: 34.90, media: 44.90, grande: 54.90 }
}
```

**Bebida (preço único):**

```js
{ id: "coca-lata", nome: "Coca-Cola lata", categoria: "bebidas",
  tipo: "simples", descricao: "350 ml gelada.", imagem: null, preco: 8.00 }
```

Para remover um produto, apague o bloco. Para adicionar, copie um bloco e mude
`id`, `nome`, `descricao` e `precos`.

## 2. Fotos oficiais

As fotos que estão no ar são de banco de imagens de uso livre (Unsplash,
liberado para uso comercial) e entram apenas como demonstração. Cada produto
também tem uma ilustração própria: se a foto não carregar — ou se `imagem`
for `null` — a ilustração aparece no lugar, então nunca fica espaço quebrado.

Quando tiver as fotos da casa:

1. crie uma pasta `fotos/` ao lado do `index.html`;
2. coloque as imagens (de preferência quadradas, 800×800, até ~200 KB);
3. troque o endereço em `imagem:` por `imagem: "fotos/nome-do-arquivo.jpg"`.

A foto grande do cabeçalho fica em `CONFIG.heroImagem` e segue a mesma regra.

O recorte (`object-fit: cover`) e os cantos arredondados já estão prontos.

## 3. Preços, tamanhos, bordas e adicionais

No objeto `OPCOES`, no topo de `menu-data.js`:

- `tamanhos` — nome e descrição (o preço de cada tamanho fica em cada pizza);
- `bordas` — nome e valor adicional;
- `adicionais` — nome e valor adicional.

## 4. Dados do negócio

**Nome e WhatsApp não ficam mais no código.** Eles vivem na tabela `businesses`
e são editados em **Configurações**, no painel. Trocar o WhatsApp ali muda o
destinatário dos pedidos na hora, sem publicar o site de novo.

O resto continua no objeto `CONFIG` (`menu-data.js`):

- `nome`, `whatsapp` e `cidade` — **só no modo de desenvolvimento** (`DATA_SOURCE = "local"`).
  Com o site ligado ao Supabase, os dois são substituídos pelo que está no banco;
  `whatsapp` fica propositalmente vazio, para que nenhum número escrito no
  código possa virar destinatário por engano;
- `horarios` — também **só no modo de desenvolvimento**. Com o site ligado ao
  Supabase, quem manda é a tela **Horários** do painel;
- `avaliacao` e `totalAvaliacoes` — nota do Google;
- `retiradas` e `pagamentos` — opções da tela de finalização
  (para ativar delivery, basta acrescentar um item em `retiradas`).

## 5. Sair do modo demonstração

Em `CONFIG`, troque:

```js
demo: true   →   demo: false
```

Isso remove a faixa "Cardápio demonstrativo", os avisos no carrinho,
os cards de avaliação de exemplo e a linha de aviso na mensagem do WhatsApp.

## 6. Cores

Em `styles.css`, bloco `:root` (primeiras linhas): `--vinho`, `--brasa`,
`--fundo`, `--dourado`. O bloco seguinte repete os tokens para o modo escuro.

## 7. Painel administrativo (`/admin`)

Suba a pasta `admin/` junto com o site: o endereço vira `seusite.com/admin`.
Ela usa o mesmo `supabase-config.js` do site público (caminho `../`), então
não há chave duplicada em lugar nenhum.

- **Entrar:** e-mail e senha criados por você no Supabase (Authentication →
  Users). Não existe cadastro público.
- **Dar acesso a alguém:** crie o usuário no Supabase e insira uma linha em
  `business_members` ligando o `user_id` ao `business_id` da empresa. Sem essa
  linha, o painel recusa o login com uma mensagem explicativa.
- **Fotos:** vão para `product-images/<business_id>/arquivo.webp`. A imagem é
  reduzida para 1000 px e convertida para WebP no próprio navegador antes de
  subir.
- **Promoções:** o preço promocional só vale dentro do período informado. Por
  isso o painel exige pelo menos a data de início ou a de término.
- **Configurações:** nome, WhatsApp, descrição curta, Instagram e endereço.
  Tudo isso aparece no site assim que o cliente recarrega a página — sem
  publicar nada de novo. Campo em branco simplesmente **some** do site:
  sem descrição, o parágrafo não aparece; sem Instagram, o botão some; sem
  endereço, o card "Endereço" e o link "Ver no mapa" somem. O nome aparece no cabeçalho,
  na seção sobre, no rodapé, no título da aba e no topo da mensagem do pedido.
  O WhatsApp pode ser digitado como você preferir — `(14) 99798-2903`,
  `+55 14 99798-2903` ou só os números — que o painel guarda sempre no formato
  do WhatsApp (`5514997982903`). Números incompletos ou de fora do Brasil são
  recusados com uma mensagem, em vez de irem para o banco.
- **Identidade visual:** logo e favicon. A logo entra no lugar do selo "13"
  do cabeçalho, no mesmo tamanho e posição; sem logo cadastrada, o "13"
  continua. O favicon vira o ícone da aba do navegador. Se a imagem não
  carregar, o site segue normalmente com o visual de antes — logo e favicon
  são enfeite, não requisito.
- **Horários:** o que você salva na tela Horários aparece no site na hora —
  o selo "Aberto agora / Fechado no momento", a próxima abertura e a grade
  da seção *Horário*. Um turno que vira a madrugada (ex.: 18:00 às 02:00)
  fica na linha do dia em que ele **começa**.
- **Pedidos fora do horário:** com a chave desligada, o cliente ainda navega e
  monta o carrinho, mas o botão de finalizar fica bloqueado com o aviso
  "Estamos fechados no momento. Voltamos a atender ...". Ligada, nada é
  bloqueado.

## 8. A hora usada pelo site

O site nunca confia no relógio do celular do cliente — ele pergunta a hora ao
próprio banco, pela função `public.get_server_now()` (criada por
`server-time.sql`). Isso é feito **uma vez** ao abrir o cardápio e **de novo**
antes de abrir o WhatsApp, para o caso de a loja ter fechado no meio do pedido.

Entre uma consulta e outra, o tempo avança por um relógio *monotônico* do
navegador (`performance.now()`), que não é afetado se a data do aparelho for
alterada. Na prática: mudar o relógio do celular no meio do pedido não abre
nem fecha a loja.

Se essa função for apagada ou perder a permissão de `anon`, o site continua
funcionando, mas passa a exibir "Horário indisponível" — e, se a casa estiver
bloqueando pedidos fora do horário, a finalização para. Nesse caso, rode
`server-time.sql` de novo.

## 9. Qual empresa o site carrega

O mesmo `index.html` atende empresas diferentes. Quem decide qual delas
aparece é **o endereço que o cliente digitou**, não o código:

1. ao abrir a página, o site pega `window.location.hostname`;
2. pergunta ao banco, pela função `public.resolve_business_by_domain()`,
   de quem é aquele endereço;
3. o `business_id` que voltar é o dono da página do começo ao fim —
   cardápio, entrega, horários e, no final, o WhatsApp do pedido.

Quem normaliza o endereço (maiúsculas, `www.`, porta, ponto no fim) é o
banco, em `normalize_business_domain()`. `loja.com.br`, `LOJA.com.br` e
`www.loja.com.br` são o mesmo domínio.

**Para um endereço novo entrar no ar**, use a tela **Domínios** do painel
(ou, na mão, um insert em `public.business_domains` — sem UUID escrito à
mão):

```sql
insert into public.business_domains (business_id, domain, is_primary)
select b.id, 'digital-treze-estancia.vercel.app', true
from public.businesses b
where b.slug = 'estancia-treze';
```

Enquanto o domínio não estiver **cadastrado e ativo**, quem abrir aquele
endereço vê "Estabelecimento não encontrado" — e nada mais. É de
propósito: um endereço desconhecido nunca cai no cardápio de outra casa.

Duas telas de erro, com significados diferentes:

- **Estabelecimento não encontrado** — o domínio não está na tabela (ou
  está com `active = false`). Não adianta recarregar; falta o cadastro.
- **Não foi possível carregar o estabelecimento** — o banco não
  respondeu. Os dados existem, só não chegaram; por isso essa tem o
  botão "Tentar novamente".

**Em desenvolvimento** (`localhost`, `127.0.0.1`, `::1` ou arquivo aberto
direto do disco) dá para trocar de empresa pela URL:
`http://localhost:8000/?loja=slug-da-empresa`. Sem esse parâmetro, vale
`DEV_BUSINESS_SLUG`, lá no `supabase-config.js`.

Em qualquer endereço publicado o `?loja=` é **ignorado por completo** —
nem chega a ser lido. `seusite.com.br/?loja=outra-empresa` continua
mostrando a sua loja.

O selo redondo do cabeçalho mostra a **logo** cadastrada em Configurações.
Sem logo, ele mostra as iniciais do nome da empresa (não mais um "13"
fixo, que era marca de uma casa só).

O painel `/admin` não usa nada disso: ele continua descobrindo a empresa
pelo usuário logado, em `business_members`.

## 10. A tela Domínios do painel

Em **Domínios** você vê e gerencia os endereços que abrem o seu cardápio.
A empresa vem do usuário logado (`business_members`) — a tela nunca
pergunta nem aceita um identificador de empresa.

- **Adicionar:** pode colar o endereço do jeito que estiver
  (`https://www.minhaempresa.com.br/` serve). Quem guarda o formato final
  é o banco; a tela mostra o que ele gravou.
- **Principal:** é o endereço oficial da casa. Só existe **um** por
  empresa. Ao promover outro, o antigo vira secundário e **continua
  ativo** — dá para manter `estanciatreze.com.br` como principal e
  `digital-treze-estancia.vercel.app` como secundário, os dois no ar.
  Se a troca falhar no meio, o painel desfaz o primeiro passo para a
  empresa não ficar sem principal; se nem isso der certo, ele avisa na
  tela em vez de deixar quieto.
- **Ativar/desativar:** um domínio inativo deixa de abrir o cardápio.
  O principal não pode ser desativado — escolha outro principal antes.
- **Excluir:** só domínios secundários. Se for o único endereço
  cadastrado, o painel avisa em letras claras antes de remover.
- **Domínio repetido:** `domain` é único no sistema inteiro. Se o
  endereço já pertencer a alguém (inclusive outra empresa), a tela diz
  apenas "Este domínio já está cadastrado no sistema".

Dois avisos importantes:

1. cadastrar aqui **não** configura DNS nem adiciona o domínio à
   hospedagem (Vercel). Isso continua sendo feito no painel da
   hospedagem e no seu provedor de DNS;
2. cadastrar aqui **não** comprova que o domínio é seu. A verificação de
   propriedade ainda não existe.
