/* =====================================================================
   EDGE FUNCTION — provision-business-admin
   ---------------------------------------------------------------------
   Dá o primeiro acesso a uma empresa que JÁ EXISTE: convida o
   administrador do cliente no Supabase Auth e cria a linha de
   business_members com role = 'owner'.

   O QUE ESTA FUNÇÃO NÃO FAZ, de propósito:

     · não cria empresa (superadmin_create_business() é outra etapa, e
       fica antes desta). Assim, se o convite falhar, a empresa continua
       existindo com acesso pendente e dá para tentar de novo;
     · não cria tabela, coluna, policy nem RPC;
     · não usa user_metadata como autorização;
     · não aceita role, redirectTo, is_super_admin nem qualquer outra
       pista de permissão vinda do navegador.

   AS DUAS IDENTIDADES DESTE ARQUIVO — não confundir:

     ctx.supabase       o chamador. Cliente preso ao JWT de quem fez a
                        requisição, com RLS ligada. É com ele, e só com
                        ele, que perguntamos "você é platform admin?".
     ctx.supabaseAdmin  a plataforma. Cliente da secret key, que ignora
                        RLS e abre a Admin API do Auth. Só entra em cena
                        DEPOIS que o chamador provou ser platform admin.

   A secret key vive exclusivamente no ambiente desta Edge Function,
   injetada pela plataforma em SUPABASE_SECRET_KEYS. Ela não aparece no
   código, não é lida por nada aqui, não vai para o HTML, para o
   superadmin.js, para o admin.js, para o GitHub, nem para a resposta.
   ===================================================================== */

import { withSupabase } from "npm:@supabase/server@^1.6.0";

/* ---------- constantes ---------------------------------------------- */

/** A role é decidida aqui, nunca pelo payload. */
const ROLE_OWNER = "owner";

/** Varredura do Auth por e-mail: ver comentário em acharUsuarioPorEmail(). */
const USUARIOS_POR_PAGINA = 200;
const MAX_PAGINAS = 25;                 // teto de 5.000 contas por varredura

/** Campos que, se aparecerem no payload, são recusados em vez de
    ignorados em silêncio — para ninguém achar que surtiram efeito. */
const CAMPOS_PROIBIDOS = [
    "role",
    "redirectto",
    "redirect_to",
    "is_super_admin",
    "issuperadmin",
    "is_admin",
    "isadmin",
    "admin_user_id",
    "user_id",
    "platform_admin",
];

/* Aceita qualquer UUID canônico. Não amarramos na versão 4: o objetivo
   é recusar lixo antes de ir ao banco, não bancar o RFC. */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Conferência de formato, não de existência: quem diz se o endereço
   existe mesmo é o e-mail de convite chegando (ou não). */
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL = 254;

/* ---------- respostas ------------------------------------------------ */

type Falha = { status: number; codigo: string; mensagem: string };

const ok = (corpo: Record<string, unknown>) => Response.json(corpo, { status: 200 });

/* Nada de stack trace para o navegador: só o status, um código estável
   para o frontend tratar, e uma frase que uma pessoa entende. */
const falha = (f: Falha) =>
    Response.json(
        { success: false, error: f.codigo, message: f.mensagem },
        { status: f.status },
    );

const FALHAS = {
    metodo: { status: 405, codigo: "method_not_allowed", mensagem: "Método não permitido. Use POST." },
    json: { status: 400, codigo: "invalid_payload", mensagem: "Corpo da requisição inválido: envie um JSON com business_id e email." },
    businessId: { status: 400, codigo: "invalid_business_id", mensagem: "business_id é obrigatório e precisa ser um UUID válido." },
    email: { status: 400, codigo: "invalid_email", mensagem: "email é obrigatório e precisa ser um endereço válido." },
    naoAdmin: { status: 403, codigo: "forbidden", mensagem: "Acesso restrito ao administrador da plataforma." },
    semEmpresa: { status: 404, codigo: "business_not_found", mensagem: "Empresa não encontrada." },
    jaTemOwner: { status: 409, codigo: "owner_exists", mensagem: "Esta empresa já possui um proprietário." },
    emailEmUso: { status: 409, codigo: "email_in_use", mensagem: "Este e-mail já possui uma conta no sistema." },
    interno: { status: 500, codigo: "internal_error", mensagem: "Não foi possível concluir. Tente novamente." },
    inconsistente: { status: 500, codigo: "inconsistent_state", mensagem: "O acesso não pôde ser concluído e o usuário criado não pôde ser removido. Verifique o estado desta conta antes de tentar de novo." },
} as const satisfies Record<string, Falha>;

/* ---------- validação do payload ------------------------------------- */

export type Entrada = { businessId: string; email: string };

export function validarPayload(bruto: unknown): { dados?: Entrada; falha?: Falha } {
    if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
        return { falha: FALHAS.json };
    }
    const p = bruto as Record<string, unknown>;

    /* Um payload que tenta mandar role/redirectTo/is_super_admin não é
       atendido pela metade: é recusado, para o erro ser visível. */
    const proibido = Object.keys(p).find((k) => CAMPOS_PROIBIDOS.includes(k.toLowerCase()));
    if (proibido) {
        return {
            falha: {
                status: 400,
                codigo: "forbidden_field",
                mensagem: `O campo "${proibido}" não é aceito. A permissão e o destino do convite são decididos pelo servidor.`,
            },
        };
    }

    const businessId = typeof p.business_id === "string" ? p.business_id.trim() : "";
    if (!businessId || !RE_UUID.test(businessId)) return { falha: FALHAS.businessId };

    const emailBruto = typeof p.email === "string" ? p.email.trim() : "";
    const email = emailBruto.toLowerCase();
    if (!email || email.length > MAX_EMAIL || !RE_EMAIL.test(email)) return { falha: FALHAS.email };

    return { dados: { businessId, email } };
}

/* ---------- o que a lógica precisa do mundo lá fora -------------------
   Declarado como interface para o teste poder entrar com dublês e
   exercitar cada caminho — inclusive os que envolvem apagar usuário —
   sem tocar em nenhum projeto de verdade.
   --------------------------------------------------------------------- */

export type UsuarioAuth = { id: string; email?: string | null };

export interface Dependencias {
    /** Pergunta ao BANCO, com o JWT do chamador, se ele é platform admin. */
    ehPlatformAdmin(): Promise<boolean>;
    /** A empresa existe? (cliente administrativo) */
    empresaExiste(businessId: string): Promise<boolean>;
    /** Membros já cadastrados nessa empresa. */
    membros(businessId: string): Promise<Array<{ user_id: string; role: string | null }>>;
    /** Conta do Auth com esse e-mail, se houver. */
    acharUsuarioPorEmail(email: string): Promise<UsuarioAuth | null>;
    /** Convida (cria + envia e-mail). `jaExistia` distingue o 409 do sucesso. */
    convidar(email: string): Promise<{ usuario?: UsuarioAuth; jaExistia?: boolean }>;
    /** Cria o vínculo owner. */
    vincularOwner(businessId: string, userId: string): Promise<void>;
    /** O erro do vínculo foi a constraint de "um owner por empresa"? */
    ehConflitoDeOwner(erro: unknown): boolean;
    /** Compensação — só para usuário criado NESTA chamada. */
    apagarUsuario(userId: string): Promise<void>;
    /** Log técnico (fica nos logs da Edge Function, não na resposta). */
    registrar(evento: string, detalhe?: unknown): void;
}

export type Resultado =
    | { status: 200; corpo: Record<string, unknown> }
    | { status: number; falha: Falha };

/* ---------- a lógica -------------------------------------------------- */

export async function provisionar(entrada: Entrada, dep: Dependencias): Promise<Resultado> {
    const { businessId, email } = entrada;

    /* 1. AUTORIZAÇÃO
       Ter JWT válido só prova que a pessoa entrou no sistema — qualquer
       cliente da Estância Treze tem um. Quem manda aqui é a resposta do
       banco à pergunta feita COM A IDENTIDADE DELA. */
    let admin: boolean;
    try {
        admin = await dep.ehPlatformAdmin();
    } catch (e) {
        dep.registrar("erro ao consultar is_platform_admin", e);
        return { status: 500, falha: FALHAS.interno };
    }
    if (!admin) return { status: 403, falha: FALHAS.naoAdmin };

    /* 2. A EMPRESA EXISTE?
       Daqui para baixo é tudo com o cliente administrativo. */
    let existe: boolean;
    try {
        existe = await dep.empresaExiste(businessId);
    } catch (e) {
        dep.registrar("erro ao buscar a empresa", e);
        return { status: 500, falha: FALHAS.interno };
    }
    if (!existe) return { status: 404, falha: FALHAS.semEmpresa };

    /* 3. QUEM JÁ ESTÁ NESSA EMPRESA E QUEM JÁ EXISTE NO AUTH
       As duas respostas são necessárias ANTES de decidir qualquer coisa:
       é a combinação delas que separa "já está tudo pronto" de "essa
       empresa já tem dono" e de "esse e-mail já é de alguém". */
    let membros: Array<{ user_id: string; role: string | null }>;
    let usuario: UsuarioAuth | null;
    try {
        membros = await dep.membros(businessId);
        usuario = await dep.acharUsuarioPorEmail(email);
    } catch (e) {
        dep.registrar("erro ao conferir membros ou usuário", e);
        return { status: 500, falha: FALHAS.interno };
    }

    const owners = membros.filter((m) => (m.role ?? ROLE_OWNER) === ROLE_OWNER);

    /* 3.a IDEMPOTÊNCIA — vem primeiro de propósito.
       A mesma chamada repetida (duplo clique, retentativa, reenvio) não
       pode virar 409: se essa conta já é a dona desta empresa, o pedido
       já está atendido. */
    if (usuario && owners.some((m) => m.user_id === usuario!.id)) {
        return {
            status: 200,
            corpo: {
                success: true,
                already_linked: true,
                business_id: businessId,
                user_id: usuario.id,
                email,
                role: ROLE_OWNER,
                invited: false,
            },
        };
    }

    /* 3.b A empresa já tem um dono, e não é esta conta. Nesta versão só
       existe um proprietário inicial; acrescentar administradores será
       uma tela própria, depois. */
    if (owners.length > 0) return { status: 409, falha: FALHAS.jaTemOwner };

    /* 3.c O e-mail já tem conta, mas não está ligado a esta empresa.
       NÃO vinculamos por conta própria: ligar uma conta existente a outra
       empresa por engano é o tipo de erro que ninguém percebe na hora. */
    if (usuario) return { status: 409, falha: FALHAS.emailEmUso };

    /* 4. CONVITE
       Cria o usuário e envia o e-mail. Sem signUp, sem cadastro público,
       sem senha temporária — quem define a senha é o convidado, pelo link
       que ele recebe. */
    let convidado: UsuarioAuth;
    try {
        const r = await dep.convidar(email);
        /* A varredura do passo 3 tem teto (ver acharUsuarioPorEmail). Se o
           e-mail existia além do teto — ou nasceu entre um passo e outro —
           é o Auth que avisa, e a resposta é a mesma do 3.c. */
        if (r.jaExistia) return { status: 409, falha: FALHAS.emailEmUso };
        if (!r.usuario?.id) {
            dep.registrar("convite sem usuário na resposta", { email });
            return { status: 500, falha: FALHAS.interno };
        }
        convidado = r.usuario;
    } catch (e) {
        dep.registrar("erro ao convidar", e);
        return { status: 500, falha: FALHAS.interno };
    }

    /* 5. VÍNCULO + COMPENSAÇÃO
       Auth e Postgres não compartilham transação: o usuário já existe
       quando chegamos aqui. Se o vínculo falhar, desfazemos o passo 4
       apagando a conta — e SÓ ela, que foi criada nesta chamada. Um
       usuário que já existia nunca chega neste ponto: o passo 3.c o
       interceptou com 409.
  
       DUAS CHAMADAS AO MESMO TEMPO. A leitura do passo 3 não fecha a
       janela entre conferir e inserir: duas requisições simultâneas leem
       "sem dono" e as duas seguem em frente. Quem fecha é o índice único
       parcial business_members_one_owner_per_business (one-owner-constraint.sql):
       o segundo insert vira 23505.
  
       Nesse caso a perdedora não errou nada — ela só chegou depois. O
       desfecho correto é o MESMO do passo 3.b: 409 "esta empresa já
       possui um proprietário". Um 500 mandaria o super admin investigar
       um problema que não existe. Mas o 409 só é honesto depois que a
       compensação der certo: enquanto a conta convidada estiver de pé,
       sobrou coisa para trás, e aí o erro grave continua valendo. */
    try {
        await dep.vincularOwner(businessId, convidado.id);
    } catch (e) {
        const perdeuACorrida = dep.ehConflitoDeOwner(e);
        dep.registrar(
            perdeuACorrida
                ? "outra chamada criou o proprietário primeiro — desfazendo o convite"
                : "erro ao criar business_members — desfazendo o convite",
            e,
        );
        try {
            await dep.apagarUsuario(convidado.id);
            dep.registrar("compensação concluída: usuário recém-criado removido", { user_id: convidado.id });
            return perdeuACorrida
                ? { status: 409, falha: FALHAS.jaTemOwner }
                : { status: 500, falha: FALHAS.interno };
        } catch (e2) {
            /* Os dois lados falharam: sobrou uma conta no Auth sem vínculo
               nenhum. Isso não pode passar batido — nem virar 409, que soaria
               como "está tudo certo, só chegou tarde". Vai para o log com os
               dois erros e volta como 500 explicando o estado. */
            dep.registrar("COMPENSAÇÃO FALHOU — conta órfã no Auth", {
                user_id: convidado.id,
                email,
                business_id: businessId,
                perdeu_a_corrida: perdeuACorrida,
                erro_vinculo: String(e),
                erro_remocao: String(e2),
            });
            return { status: 500, falha: FALHAS.inconsistente };
        }
    }

    /* 6. SUCESSO — só o mínimo. Nada de token, sessão, action link ou
       qualquer detalhe interno do Auth. */
    return {
        status: 200,
        corpo: {
            success: true,
            business_id: businessId,
            user_id: convidado.id,
            email,
            role: ROLE_OWNER,
            invited: true,
        },
    };
}

/* ---------- ligação com o Supabase ------------------------------------ */

/* O e-mail do convite volta para onde? A Admin API aceita redirectTo,
   mas ele NUNCA vem do navegador: sai de uma variável de ambiente da
   Edge Function. Sem a variável, não inventamos endereço nenhum — o
   convite sai sem redirectTo e o Supabase usa a Site URL do projeto.
   (Hardcodear digital-treze-estancia.vercel.app mandaria o cliente de
   outra empresa para o painel da Estância Treze.) */
function redirectDoAmbiente(ler: (k: string) => string | undefined): string | undefined {
    const valor = (ler("ADMIN_INVITE_REDIRECT_URL") ?? "").trim();
    if (!valor) return undefined;
    try {
        const u = new URL(valor);
        if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
        return u.toString();
    } catch {
        console.error("[provision-business-admin] ADMIN_INVITE_REDIRECT_URL não é uma URL válida — convite enviado sem redirectTo.");
        return undefined;
    }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Cliente = any;

export function dependenciasSupabase(
    supabase: Cliente,
    supabaseAdmin: Cliente,
    redirectTo: string | undefined,
    idReq: string,
): Dependencias {
    const log = (evento: string, detalhe?: unknown) =>
        console.error(`[provision-business-admin][${idReq}] ${evento}`, detalhe ?? "");

    return {
        /* A RPC roda com o JWT do chamador. is_platform_admin() não recebe
           parâmetro: ela lê auth.uid() lá dentro. Não existe caminho para o
           navegador dizer quem ele é. */
        async ehPlatformAdmin() {
            const { data, error } = await supabase.rpc("is_platform_admin");
            if (error) throw error;
            return data === true;
        },

        async empresaExiste(businessId: string) {
            const { data, error } = await supabaseAdmin
                .from("businesses").select("id").eq("id", businessId).maybeSingle();
            if (error) throw error;
            return !!data?.id;
        },

        async membros(businessId: string) {
            const { data, error } = await supabaseAdmin
                .from("business_members").select("user_id, role").eq("business_id", businessId);
            if (error) throw error;
            return data ?? [];
        },

        /* A Admin API do Auth não tem busca por e-mail: listUsers() só
           pagina. Então varremos as páginas até achar, com teto — e o teto
           não é um buraco, porque o convite (passo 4) devolve "já existe"
           para qualquer conta que a varredura não tenha alcançado.
    
           Esta consulta acontece SÓ no servidor: a Admin API não é exposta
           ao navegador em momento nenhum. */
        async acharUsuarioPorEmail(email: string) {
            for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
                const { data, error } = await supabaseAdmin.auth.admin.listUsers({
                    page: pagina,
                    perPage: USUARIOS_POR_PAGINA,
                });
                if (error) throw error;
                const usuarios: UsuarioAuth[] = data?.users ?? [];
                const achado = usuarios.find((u) => (u.email ?? "").trim().toLowerCase() === email);
                if (achado) return { id: achado.id, email: achado.email };
                if (usuarios.length < USUARIOS_POR_PAGINA) return null;   // última página
            }
            log("varredura de usuários atingiu o teto de páginas", { paginas: MAX_PAGINAS });
            return null;
        },

        async convidar(email: string) {
            const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(
                email,
                redirectTo ? { redirectTo } : undefined,
            );
            if (error) {
                const codigo = String((error as any)?.code ?? "");
                const msg = String((error as any)?.message ?? "");
                if (codigo === "email_exists" || /already been registered|already exists|email_exists/i.test(msg)) {
                    return { jaExistia: true };
                }
                throw error;
            }
            const u = data?.user;
            return { usuario: u ? { id: u.id, email: u.email } : undefined };
        },

        /* role vem da constante, nunca do payload. */
        async vincularOwner(businessId: string, userId: string) {
            const { data, error } = await supabaseAdmin
                .from("business_members")
                .insert({ business_id: businessId, user_id: userId, role: ROLE_OWNER })
                .select("business_id");
            if (error) throw error;
            if (!data || data.length === 0) throw new Error("insert em business_members não gravou nenhuma linha");
        },

        /* O insert bateu no índice único parcial de "um owner por empresa"?
           Exige as DUAS coisas: código 23505 (violação de unicidade) E o
           nome do índice no texto do erro. Nada de deduzir pelo código
           sozinho — responder "esta empresa já possui um proprietário" para
           uma violação que veio de outra constraint seria afirmar como certo
           algo que não foi verificado. Um 23505 que não se identifica cai no
           500 genérico, que é o desfecho honesto para "não sei o que houve".
    
           Na prática o nome sempre vem: o Postgres o inclui na mensagem de
           toda violação de unicidade
           ('... violates unique constraint "<nome>"'), e o PostgREST
           repassa message e details inteiros. */
        ehConflitoDeOwner(erro: unknown) {
            const e = erro as { code?: unknown; message?: unknown; details?: unknown } | null;

            if (!e || String(e.code ?? "") !== "23505") return false;

            const texto = `${String(e.message ?? "")} ${String(e.details ?? "")}`;

            return /business_members_one_owner_per_business/i.test(texto);
        },

        async apagarUsuario(userId: string) {
            const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
            if (error) throw error;
        },

        registrar: log,
    };
}

/* ---------- handler ---------------------------------------------------
   auth: 'user'  — o SDK verifica o JWT contra o JWKS do projeto e
                   responde 401 sozinho quando falta ou está inválido,
                   sem rebaixar para anônimo. Este arquivo nunca vê uma
                   requisição sem usuário autenticado.
   cors: 'default' — responde o preflight OPTIONS com 204 e carimba os
                   cabeçalhos em todas as respostas, inclusive no 401 do
                   próprio SDK. CORS não autoriza nada: é só o navegador
                   podendo ler a resposta. A autorização de verdade são
                   as duas travas acima (usuário autenticado +
                   is_platform_admin()).
   ------------------------------------------------------------------- */
export default {
    fetch: withSupabase({ auth: "user", cors: "default" }, async (req: Request, ctx: any) => {
        const idReq = crypto.randomUUID();

        if (req.method !== "POST") return falha(FALHAS.metodo);

        let bruto: unknown;
        try {
            bruto = await req.json();
        } catch {
            return falha(FALHAS.json);
        }

        const { dados, falha: invalido } = validarPayload(bruto);
        if (invalido || !dados) return falha(invalido ?? FALHAS.json);

        const redirectTo = redirectDoAmbiente((k) => (globalThis as any).Deno?.env?.get(k));

        const resultado = await provisionar(
            dados,
            dependenciasSupabase(ctx.supabase, ctx.supabaseAdmin, redirectTo, idReq),
        );

        return "corpo" in resultado ? ok(resultado.corpo) : falha(resultado.falha);
    }),
};