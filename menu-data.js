/* =====================================================================
   ESTÂNCIA TREZE PIZZARIA — DADOS DO CARDÁPIO
   ---------------------------------------------------------------------
   CARDÁPIO DE DESENVOLVIMENTO / FALLBACK MANUAL.

   Com DATA_SOURCE = "supabase" (supabase-config.js), estes dados NÃO são
   usados: o cardápio vem do banco. Eles só entram em cena quando você
   troca explicitamente para DATA_SOURCE = "local".

   As quatro variáveis são declaradas com "let" porque a camada de dados
   as substitui pelo conteúdo vindo do Supabase.

   1) CONFIG   -> dados do negócio (nome, WhatsApp, horários, avaliação)
   2) OPCOES   -> tamanhos, bordas e adicionais usados pelas pizzas
   3) CATEGORIAS -> ordem e nome das abas do cardápio
   4) MENU     -> produtos

   FOTOS: o campo "imagem" aceita um caminho local (ex.: "fotos/calabresa.jpg")
   ou uma URL. As fotos usadas aqui são de banco de imagens livre (Unsplash,
   uso comercial liberado) e servem apenas como demonstração — troque pelas
   fotos oficiais da pizzaria quando elas existirem.
   Se a imagem não carregar, ou se "imagem" for null, o site desenha sozinho
   uma ilustração elegante no lugar (nunca fica espaço quebrado).
   ===================================================================== */

let CONFIG = {
  /* Nome: a fonte oficial é businesses.name, editado em Configurações no
     painel. O valor abaixo é só o texto do modo de desenvolvimento
     (DATA_SOURCE = "local") e é SOBRESCRITO assim que o cardápio carrega
     do Supabase — é a única cópia do nome que sobrou no projeto. */
  nome: "Estância Treze Pizzaria",
  nomeCompleto: "Estância Treze Pizzaria",
  slogan: "Pizza, sabor e bons momentos.",
  /* Cidade/UF também vêm do banco (address_city + address_state), editados
     em Configurações. Vazio de propósito: nenhum endereço escrito no código. */
  cidade: "",
  /* O número que recebe os pedidos mora em businesses.whatsapp e é editado
     em Configurações, no painel. Estes campos ficam VAZIOS de propósito:
     nenhum número escrito no código pode virar destinatário por engano.
     No modo local (DATA_SOURCE = "local") o site simplesmente não mostra
     botão de WhatsApp. */
  whatsapp: "",
  whatsappExibicao: "",
  avaliacao: 4.5,
  totalAvaliacoes: 420,
  timezone: "America/Sao_Paulo",

  // 0 = domingo ... 6 = sábado.  null = fechado.  [abre, fecha] em horas.
  horarios: {
    0: null,
    1: null,
    2: null,
    3: null,
    4: [19, 23],
    5: [19, 23],
    6: [19, 23]
  },

  servicos: ["Refeição no local", "Retirada no local"],

  // Modos de recebimento oferecidos na finalização.
  // "pedeEndereco: true" faz a seção de endereço aparecer no checkout.
  retiradas: [
    { id: "retirada", nome: "Retirar no local",  detalhe: "Você busca na pizzaria", emoji: "🛍️" },
    { id: "local",    nome: "Consumir no local", detalhe: "Mesa na pizzaria",       emoji: "🍽️" },
    { id: "delivery", nome: "Receber em casa",   detalhe: "Delivery",               emoji: "🛵", pedeEndereco: true }
  ],

  /* -------------------------------------------------------------------
     REGRAS DE ENTREGA
     Nada aqui é inventado: a pizzaria ainda não informou taxa, bairros
     atendidos nem pedido mínimo. Enquanto os valores forem null, o site
     mostra "A confirmar" e NÃO soma nada ao total.

     É este objeto que, no futuro, virá do Supabase e será editado no
     painel. A função calcularEntrega() em app.js já lê tudo daqui — é o
     único ponto que precisará mudar quando as regras existirem.
     ------------------------------------------------------------------- */
  entrega: {
    ativa: true,            // false esconde a opção "Receber em casa"
    taxa: null,             // número em R$; null = a confirmar
    taxaTexto: "A confirmar",
    pedidoMinimo: null,     // número em R$; null = sem mínimo
    gratisAcimaDe: null,    // número em R$; null = sem regra de frete grátis
    bairros: []             // futuro: [{ nome: "Centro", taxa: 8 }]
  },

  pagamentos: [
    { id: "pix",      nome: "PIX",      emoji: "📱" },
    { id: "dinheiro", nome: "Dinheiro", emoji: "💵" },
    { id: "cartao",   nome: "Cartão",   emoji: "💳" }
  ],

  // Modo demonstração: exibe o aviso de cardápio ilustrativo.
  // Troque para false quando o cardápio real entrar no ar.
  demo: true,
  avisoDemo: "Cardápio demonstrativo — produtos e valores ilustrativos.",

  // Foto grande do cabeçalho. Troque pelo caminho de uma foto da pizzaria
  // (ex.: "fotos/fachada.jpg"). Se falhar ou ficar null, entra a ilustração.
  heroImagem: "https://images.unsplash.com/photo-1513104890138-7c749659a591?w=900&h=900&q=78&auto=format&fit=crop"
};

/* ---------------------------------------------------------------------
   OPÇÕES DAS PIZZAS
   --------------------------------------------------------------------- */
let OPCOES = {
  tamanhos: [
    { id: "broto",  nome: "Broto",  detalhe: "4 fatias · 25 cm" },
    { id: "media",  nome: "Média",  detalhe: "6 fatias · 30 cm" },
    { id: "grande", nome: "Grande", detalhe: "8 fatias · 35 cm" }
  ],
  bordas: [
    { id: "sem",      nome: "Sem borda", preco: 0 },
    { id: "catupiry", nome: "Catupiry",  preco: 8 },
    { id: "cheddar",  nome: "Cheddar",   preco: 8 }
  ],
  adicionais: [
    { id: "bacon",    nome: "Bacon",           preco: 5 },
    { id: "catupiry", nome: "Catupiry extra",  preco: 5 },
    { id: "mucarela", nome: "Muçarela extra",  preco: 5 }
  ]
};

/* ---------------------------------------------------------------------
   CATEGORIAS  (a aba "Mais pedidas" é montada com os produtos destaque)
   --------------------------------------------------------------------- */
let CATEGORIAS = [
  { id: "mais-pedidas",  nome: "Mais pedidas",       icone: "🔥", destaque: true },
  { id: "tradicionais",  nome: "Pizzas tradicionais", icone: "🍕" },
  { id: "especiais",     nome: "Pizzas especiais",    icone: "🥩" },
  { id: "doces",         nome: "Pizzas doces",        icone: "🍫" },
  { id: "bebidas",       nome: "Bebidas",             icone: "🥤" }
];

/* ---------------------------------------------------------------------
   PRODUTOS
   tipo: "pizza"  -> abre tamanho, borda e adicionais
   tipo: "simples"-> preço único (bebidas)
   arte: ilustração usada enquanto não houver foto oficial
   --------------------------------------------------------------------- */
let MENU = [
  /* ============ TRADICIONAIS ============ */
  {
    id: "calabresa",
    nome: "Pizza Calabresa",
    categoria: "tradicionais",
    tipo: "pizza",
    destaque: true,
    descricao: "Molho de tomate, muçarela, calabresa fatiada, cebola e orégano.",
    imagem: "https://images.unsplash.com/photo-1534308983496-4fabb1a015ee?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 34.90, media: 44.90, grande: 54.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#C8381F",
      itens: [
        { forma: "circulo", cor: "#8E2B1F", borda: "#6C1D14", n: 9, tam: 13 },
        { forma: "anel",    cor: "#F6ECD8", n: 6, tam: 8 },
        { forma: "raspa",   cor: "#4E7A32", n: 10, tam: 3 }
      ]
    }
  },
  {
    id: "frango-catupiry",
    nome: "Pizza Frango com Catupiry",
    categoria: "tradicionais",
    tipo: "pizza",
    destaque: true,
    descricao: "Molho de tomate, muçarela, frango desfiado e Catupiry.",
    imagem: "https://images.unsplash.com/photo-1593504049359-74330189a345?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 34.90, media: 44.90, grande: 54.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#E8C88A",
      itens: [
        { forma: "fio",     cor: "#C89A5E", n: 14, tam: 12 },
        { forma: "gota",    cor: "#FCF6E6", n: 7,  tam: 12 },
        { forma: "raspa",   cor: "#4E7A32", n: 8,  tam: 3 }
      ]
    }
  },
  {
    id: "portuguesa",
    nome: "Pizza Portuguesa",
    categoria: "tradicionais",
    tipo: "pizza",
    destaque: true,
    descricao: "Muçarela, presunto, ovo, cebola, tomate e azeitonas.",
    imagem: "https://images.unsplash.com/photo-1604382354936-07c5d9983bd3?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 34.90, media: 44.90, grande: 54.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#EFD79B",
      itens: [
        { forma: "circulo", cor: "#FBF7EC", borda: "#E9C96A", n: 5, tam: 12 },
        { forma: "circulo", cor: "#E79A9A", n: 6, tam: 9 },
        { forma: "circulo", cor: "#2E2A26", n: 7, tam: 6 },
        { forma: "anel",    cor: "#F8F1E0", n: 5, tam: 7 }
      ]
    }
  },
  {
    id: "mucarela",
    nome: "Pizza Muçarela",
    categoria: "tradicionais",
    tipo: "pizza",
    descricao: "Molho de tomate, muçarela em fatias e orégano.",
    imagem: "https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 32.90, media: 42.90, grande: 52.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#F0D392",
      itens: [
        { forma: "gota",  cor: "#FAEFCF", n: 9, tam: 14 },
        { forma: "raspa", cor: "#4E7A32", n: 12, tam: 3 }
      ]
    }
  },
  {
    id: "marguerita",
    nome: "Pizza Marguerita",
    categoria: "tradicionais",
    tipo: "pizza",
    descricao: "Muçarela, rodelas de tomate, manjericão fresco e azeite.",
    imagem: "https://images.unsplash.com/photo-1598023696416-0193a0bcd302?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 34.90, media: 44.90, grande: 54.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#EBCD8D",
      itens: [
        { forma: "circulo", cor: "#D2503A", borda: "#A93C2A", n: 7, tam: 12 },
        { forma: "folha",   cor: "#3F7A38", n: 8, tam: 11 }
      ]
    }
  },

  /* ============ ESPECIAIS ============ */
  {
    id: "file-mignon",
    nome: "Pizza Filé Mignon Especial",
    categoria: "especiais",
    tipo: "pizza",
    destaque: true,
    descricao: "Filé mignon em cubos, muçarela, tomate e temperos da casa.",
    imagem: "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 39.90, media: 49.90, grande: 59.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#E4C285",
      itens: [
        { forma: "quadrado", cor: "#6E3624", borda: "#4E2318", n: 11, tam: 12 },
        { forma: "anel",     cor: "#F6ECD8", n: 5, tam: 8 },
        { forma: "raspa",    cor: "#4E7A32", n: 8, tam: 3 }
      ]
    }
  },
  {
    id: "quatro-queijos",
    nome: "Pizza Quatro Queijos",
    categoria: "especiais",
    tipo: "pizza",
    destaque: true,
    descricao: "Muçarela, provolone, parmesão e Catupiry.",
    imagem: "https://images.unsplash.com/photo-1594007654729-407eedc4be65?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 39.90, media: 49.90, grande: 59.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#F2DEA8",
      itens: [
        { forma: "gota",  cor: "#FBF3DB", n: 8, tam: 15 },
        { forma: "gota",  cor: "#E6C173", n: 6, tam: 12 },
        { forma: "raspa", cor: "#C79A4B", n: 10, tam: 4 }
      ]
    }
  },
  {
    id: "bacon-especial",
    nome: "Pizza Bacon Especial",
    categoria: "especiais",
    tipo: "pizza",
    descricao: "Muçarela, bacon crocante, tomate e orégano.",
    imagem: "https://images.unsplash.com/photo-1628840042765-356cda07504e?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 39.90, media: 49.90, grande: 59.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#E3BE7F",
      itens: [
        { forma: "quadrado", cor: "#B4553A", borda: "#8C3A25", n: 12, tam: 11 },
        { forma: "circulo",  cor: "#D2503A", n: 4, tam: 10 },
        { forma: "raspa",    cor: "#4E7A32", n: 9, tam: 3 }
      ]
    }
  },
  {
    id: "lombo-catupiry",
    nome: "Pizza Lombo com Catupiry",
    categoria: "especiais",
    tipo: "pizza",
    descricao: "Lombo canadense, muçarela, Catupiry e cebola caramelizada.",
    imagem: "https://images.unsplash.com/photo-1613564834361-9436948817d1?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 39.90, media: 49.90, grande: 59.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#E9C68C",
      itens: [
        { forma: "circulo", cor: "#D98C7A", borda: "#B36A5A", n: 8, tam: 12 },
        { forma: "gota",    cor: "#FCF6E6", n: 6, tam: 12 },
        { forma: "fio",     cor: "#C79A4B", n: 9, tam: 13 }
      ]
    }
  },

  /* ============ DOCES ============ */
  {
    id: "chocolate",
    nome: "Pizza Chocolate",
    categoria: "doces",
    tipo: "pizza",
    descricao: "Chocolate ao leite derretido e finalização especial da casa.",
    imagem: "https://images.unsplash.com/photo-1708649783218-b2b9a8781724?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 32.90, media: 42.90, grande: 52.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#5E3320",
      itens: [
        { forma: "fio",   cor: "#8A5233", n: 12, tam: 16 },
        { forma: "raspa", cor: "#F3E3CB", n: 14, tam: 4 }
      ]
    }
  },
  {
    id: "chocolate-morango",
    nome: "Pizza Chocolate com Morango",
    categoria: "doces",
    tipo: "pizza",
    destaque: true,
    descricao: "Chocolate ao leite e morangos frescos fatiados.",
    imagem: "https://images.unsplash.com/photo-1767114916329-9b5649724379?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 34.90, media: 44.90, grande: 54.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#5E3320",
      itens: [
        { forma: "gota",  cor: "#C6293C", borda: "#96182A", n: 9, tam: 13 },
        { forma: "fio",   cor: "#8A5233", n: 8, tam: 14 },
        { forma: "raspa", cor: "#F3E3CB", n: 8, tam: 4 }
      ]
    }
  },
  {
    id: "banana-canela",
    nome: "Pizza Banana com Canela",
    categoria: "doces",
    tipo: "pizza",
    descricao: "Banana, açúcar, canela e fios de leite condensado.",
    imagem: "https://images.unsplash.com/photo-1568594245756-74df6a35e197?w=640&h=640&q=72&auto=format&fit=crop",
    precos: { broto: 32.90, media: 42.90, grande: 52.90 },
    arte: {
      tipo: "pizza", massa: "#E9BB6A", base: "#EFD9A4",
      itens: [
        { forma: "gota",  cor: "#F0D782", borda: "#D2B35C", n: 10, tam: 13 },
        { forma: "raspa", cor: "#9A5A2A", n: 16, tam: 4 },
        { forma: "fio",   cor: "#FDF8EA", n: 7, tam: 13 }
      ]
    }
  },

  /* ============ BEBIDAS ============ */
  {
    id: "coca-lata",
    nome: "Coca-Cola lata",
    categoria: "bebidas",
    tipo: "simples",
    descricao: "350 ml gelada.",
    imagem: null,
    preco: 8.00,
    arte: { tipo: "lata", cor: "#B2202B", cor2: "#7C1119" }
  },
  {
    id: "guarana-lata",
    nome: "Guaraná lata",
    categoria: "bebidas",
    tipo: "simples",
    descricao: "350 ml gelada.",
    imagem: null,
    preco: 8.00,
    arte: { tipo: "lata", cor: "#1F6B4A", cor2: "#14472F" }
  },
  {
    id: "coca-2l",
    nome: "Coca-Cola 2L",
    categoria: "bebidas",
    tipo: "simples",
    descricao: "Garrafa 2 litros gelada.",
    imagem: null,
    preco: 14.00,
    arte: { tipo: "garrafa", cor: "#B2202B", cor2: "#3A2018" }
  },
  {
    id: "guarana-2l",
    nome: "Guaraná 2L",
    categoria: "bebidas",
    tipo: "simples",
    descricao: "Garrafa 2 litros gelada.",
    imagem: null,
    preco: 14.00,
    arte: { tipo: "garrafa", cor: "#1F6B4A", cor2: "#2B3A2A" }
  },
  {
    id: "agua",
    nome: "Água mineral",
    categoria: "bebidas",
    tipo: "simples",
    descricao: "500 ml, com ou sem gás.",
    imagem: null,
    preco: 6.00,
    arte: { tipo: "garrafa", cor: "#5B93B8", cor2: "#2E5F80" }
  }
];
