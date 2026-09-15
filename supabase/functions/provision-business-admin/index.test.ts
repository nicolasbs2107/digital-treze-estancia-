/* =====================================================================
   TESTES — provision-business-admin
   ---------------------------------------------------------------------
   Rodar:  deno test --allow-env supabase/functions/provision-business-admin/

   Tudo aqui é dublê. Nenhum projeto Supabase é tocado, nenhum e-mail é
   enviado e NENHUM USUÁRIO DE TESTE É CRIADO em lugar nenhum — o "Auth"
   e o "banco" destes testes são dois objetos em memória.

   O 401 não aparece como caso de teste unitário porque ele nunca chega
   ao nosso código: quem responde é o próprio withSupabase({auth:'user'})
   antes do handler rodar. O teste de ponta a ponta dele está no roteiro
   comentado no fim do arquivo.
   ===================================================================== */

/* node:assert vem embutido no Deno: nada para baixar, e o arquivo roda
   igual em qualquer máquina. */
import { deepStrictEqual, ok as verdade } from "node:assert/strict";
import {
    dependenciasSupabase,
    provisionar,
    validarPayload,
    type Dependencias,
    type UsuarioAuth,
} from "./index.ts";

const assertEquals = (obtido: unknown, esperado: unknown, msg?: string) =>
    deepStrictEqual(obtido, esperado, msg);
const assertStringIncludes = (texto: string, trecho: string, msg?: string) =>
    verdade(texto.includes(trecho), msg ?? `esperava encontrar "${trecho}" em "${texto}"`);

/* ---------- mundo falso ---------------------------------------------- */

type Mundo = {
    admin: boolean;
    empresas: string[];
    membros: Array<{ business_id: string; user_id: string; role: string }>;
    usuarios: UsuarioAuth[];
    falhar?: "rpc" | "empresa" | "membros" | "convite" | "vinculo" | "vinculo+remocao"
    | "corrida" | "corrida+remocao";
    log: Array<{ evento: string; detalhe?: unknown }>;
    convites: string[];
    apagados: string[];
    /* Fica no MUNDO, não em deps(): duas chamadas concorrentes precisam
       receber ids diferentes, como o Auth de verdade faz. */
    seq: number;
};

const EMPRESA = "11111111-2222-4333-8444-555555555555";
const OUTRA = "99999999-8888-4777-8666-555555555555";

function mundo(p: Partial<Mundo> = {}): Mundo {
    return {
        admin: true,
        empresas: [EMPRESA, OUTRA],
        membros: [],
        usuarios: [],
        log: [],
        convites: [],
        apagados: [],
        seq: 0,
        ...p,
    };
}

function deps(m: Mundo): Dependencias {
    return {
        async ehPlatformAdmin() {
            if (m.falhar === "rpc") throw new Error("rpc fora do ar");
            return m.admin;
        },
        async empresaExiste(id) {
            if (m.falhar === "empresa") throw new Error("banco fora do ar");
            return m.empresas.includes(id);
        },
        async membros(id) {
            if (m.falhar === "membros") throw new Error("banco fora do ar");
            return m.membros.filter((x) => x.business_id === id)
                .map((x) => ({ user_id: x.user_id, role: x.role }));
        },
        async acharUsuarioPorEmail(email) {
            return m.usuarios.find((u) => (u.email ?? "").toLowerCase() === email) ?? null;
        },
        async convidar(email) {
            if (m.falhar === "convite") throw new Error("auth fora do ar");
            if (m.usuarios.some((u) => (u.email ?? "").toLowerCase() === email)) {
                return { jaExistia: true };
            }
            const novo = { id: "user-" + (++m.seq), email };
            m.usuarios.push(novo);
            m.convites.push(email);
            return { usuario: novo };
        },
        async vincularOwner(business_id, user_id) {
            if (m.falhar === "vinculo" || m.falhar === "vinculo+remocao") {
                throw new Error("insert recusado");
            }
            /* Índice único parcial business_members_one_owner_per_business:
               o segundo owner da mesma empresa é recusado com 23505, igual ao
               Postgres faria. */
            if (m.falhar === "corrida" || m.falhar === "corrida+remocao" ||
                m.membros.some((x) => x.business_id === business_id && x.role === "owner")) {
                throw Object.assign(new Error(
                    'duplicate key value violates unique constraint "business_members_one_owner_per_business"'
                ), { code: "23505" });
            }
            m.membros.push({ business_id, user_id, role: "owner" });
        },
        async apagarUsuario(user_id) {
            if (m.falhar === "vinculo+remocao" || m.falhar === "corrida+remocao") {
                throw new Error("delete recusado");
            }
            m.usuarios = m.usuarios.filter((u) => u.id !== user_id);
            m.apagados.push(user_id);
        },
        /* Mesma regra do index.ts de produção: código E nome do índice.
           Um dublê mais frouxo do que o original deixaria passar bug. */
        ehConflitoDeOwner(erro) {
            const e = erro as {
                code?: unknown;
                message?: unknown;
                details?: unknown;
            } | null;

            if (!e || String(e.code ?? "") !== "23505") return false;

            const texto =
                `${String(e.message ?? "")} ${String(e.details ?? "")}`;

            return /business_members_one_owner_per_business/i.test(texto);
        },
        registrar(evento, detalhe) {
            m.log.push({ evento, detalhe });
        },
    };
}

const chamar = (m: Mundo, email = "cliente@empresa.com", businessId = EMPRESA) =>
    provisionar({ businessId, email }, deps(m));

/* Nenhuma resposta pode conter segredo, token ou detalhe interno. */
const PROIBIDO = [
    "secret", "service_role", "sb_secret", "eyJ", "access_token", "refresh_token",
    "action_link", "confirmation", "session", "apikey", "jwt", "password", "stack",
];
function semSegredo(corpo: unknown) {
    const texto = JSON.stringify(corpo ?? {}).toLowerCase();
    return PROIBIDO.filter((t) => texto.includes(t.toLowerCase()));
}

/* ===================================================================== */

Deno.test("payload: business_id ausente ou inválido -> 400", () => {
    for (const p of [
        {},
        { email: "a@b.com" },
        { business_id: "", email: "a@b.com" },
        { business_id: "nao-e-uuid", email: "a@b.com" },
        { business_id: 123, email: "a@b.com" },
        { business_id: EMPRESA + "x", email: "a@b.com" },
    ]) {
        const r = validarPayload(p);
        assertEquals(r.falha?.status, 400, JSON.stringify(p));
    }
});

Deno.test("payload: e-mail ausente ou inválido -> 400", () => {
    for (const e of ["", "   ", "sem-arroba", "a@b", "a@@b.com", "a b@c.com", "x".repeat(250) + "@b.com"]) {
        const r = validarPayload({ business_id: EMPRESA, email: e });
        assertEquals(r.falha?.status, 400, JSON.stringify(e));
        assertEquals(r.falha?.codigo, "invalid_email");
    }
});

Deno.test("payload: e-mail é trimado e comparado em minúsculas", () => {
    const r = validarPayload({ business_id: EMPRESA, email: "  Cliente@Empresa.COM  " });
    assertEquals(r.dados?.email, "cliente@empresa.com");
});

Deno.test("payload: corpo que não é objeto -> 400", () => {
    for (const p of [null, undefined, "texto", 42, ["a"]]) {
        assertEquals(validarPayload(p).falha?.status, 400);
    }
});

Deno.test("payload: role/redirectTo/is_super_admin vindos do navegador são RECUSADOS", () => {
    for (const campo of [
        "role", "redirectTo", "redirect_to", "is_super_admin",
        "admin_user_id", "user_id", "is_admin", "platform_admin",
    ]) {
        const r = validarPayload({ business_id: EMPRESA, email: "a@b.com", [campo]: "x" });
        assertEquals(r.falha?.status, 400, campo);
        assertEquals(r.falha?.codigo, "forbidden_field", campo);
        assertStringIncludes(r.falha!.mensagem, campo);
    }
});

Deno.test("usuário autenticado que NÃO é platform admin -> 403", async () => {
    const m = mundo({ admin: false });
    const r = await chamar(m);
    assertEquals(r.status, 403);
    assertEquals(m.convites.length, 0);
    assertEquals(m.membros.length, 0);
    assertEquals(m.usuarios.length, 0);
});

Deno.test("platform admin: passa da autorização", async () => {
    const r = await chamar(mundo());
    assertEquals(r.status, 200);
});

Deno.test("empresa inexistente -> 404, e nada é criado", async () => {
    const m = mundo();
    const r = await chamar(m, "cliente@empresa.com", "00000000-0000-4000-8000-000000000000");
    assertEquals(r.status, 404);
    assertEquals((r as any).falha.codigo, "business_not_found");
    assertEquals(m.convites.length, 0);
    assertEquals(m.usuarios.length, 0);
});

Deno.test("empresa que já tem owner -> 409", async () => {
    const m = mundo({ membros: [{ business_id: EMPRESA, user_id: "user-antigo", role: "owner" }] });
    const r = await chamar(m, "novo@empresa.com");
    assertEquals(r.status, 409);
    assertEquals((r as any).falha.codigo, "owner_exists");
    assertEquals(m.convites.length, 0);
    assertEquals(m.membros.length, 1);
});

Deno.test("e-mail com conta no Auth, não vinculado -> 409 e NÃO vincula sozinho", async () => {
    const m = mundo({ usuarios: [{ id: "user-existente", email: "cliente@empresa.com" }] });
    const r = await chamar(m);
    assertEquals(r.status, 409);
    assertEquals((r as any).falha.codigo, "email_in_use");
    assertEquals(m.membros.length, 0);
    assertEquals(m.apagados.length, 0);      // conta de terceiro jamais é tocada
});

Deno.test("e-mail vinculado a OUTRA empresa: continua 409 nesta", async () => {
    const m = mundo({
        usuarios: [{ id: "user-x", email: "cliente@empresa.com" }],
        membros: [{ business_id: OUTRA, user_id: "user-x", role: "owner" }],
    });
    const r = await chamar(m, "cliente@empresa.com", EMPRESA);
    assertEquals(r.status, 409);
    assertEquals((r as any).falha.codigo, "email_in_use");
    assertEquals(m.membros.length, 1);
});

Deno.test("já vinculado a ESTA empresa como owner -> sucesso idempotente", async () => {
    const m = mundo({
        usuarios: [{ id: "user-dono", email: "cliente@empresa.com" }],
        membros: [{ business_id: EMPRESA, user_id: "user-dono", role: "owner" }],
    });
    const r = await chamar(m);
    assertEquals(r.status, 200);
    const corpo = (r as any).corpo;
    assertEquals(corpo.success, true);
    assertEquals(corpo.already_linked, true);
    assertEquals(corpo.invited, false);
    assertEquals(corpo.user_id, "user-dono");
    assertEquals(corpo.role, "owner");
    assertEquals(m.convites.length, 0);       // não convida de novo
    assertEquals(m.membros.length, 1);        // não duplica o vínculo
});

Deno.test("chamar duas vezes seguidas: a segunda é idempotente", async () => {
    const m = mundo();
    const primeira = await chamar(m);
    assertEquals(primeira.status, 200);
    assertEquals((primeira as any).corpo.invited, true);

    const segunda = await chamar(m);
    assertEquals(segunda.status, 200);
    assertEquals((segunda as any).corpo.already_linked, true);
    assertEquals((segunda as any).corpo.invited, false);
    assertEquals(m.convites.length, 1);
    assertEquals(m.membros.length, 1);
});

Deno.test("usuário novo: convite enviado + business_members owner", async () => {
    const m = mundo();
    const r = await chamar(m);
    assertEquals(r.status, 200);
    const corpo = (r as any).corpo;
    assertEquals(corpo, {
        success: true,
        business_id: EMPRESA,
        user_id: "user-1",
        email: "cliente@empresa.com",
        role: "owner",
        invited: true,
    });
    assertEquals(m.convites, ["cliente@empresa.com"]);
    assertEquals(m.membros, [{ business_id: EMPRESA, user_id: "user-1", role: "owner" }]);
});

Deno.test("a role é sempre owner, decidida pelo servidor", async () => {
    const m = mundo();
    await chamar(m);
    assertEquals(m.membros[0].role, "owner");
});

Deno.test("convite que descobre conta existente (fora do teto da varredura) -> 409", async () => {
    const m = mundo();
    const d = deps(m);
    const r = await provisionar(
        { businessId: EMPRESA, email: "escondido@empresa.com" },
        { ...d, acharUsuarioPorEmail: async () => null, convidar: async () => ({ jaExistia: true }) },
    );
    assertEquals(r.status, 409);
    assertEquals((r as any).falha.codigo, "email_in_use");
    assertEquals(m.membros.length, 0);
});

Deno.test("falha no business_members: o usuário recém-criado é removido", async () => {
    const m = mundo({ falhar: "vinculo" });
    const r = await chamar(m);
    assertEquals(r.status, 500);
    assertEquals((r as any).falha.codigo, "internal_error");
    assertEquals(m.apagados.length, 1);                    // compensou
    assertEquals(m.usuarios.length, 0);                    // não sobrou conta órfã
    assertEquals(m.membros.length, 0);
    assertStringIncludes(m.log.map((l) => l.evento).join(" | "), "desfazendo o convite");
});

Deno.test("compensação NUNCA apaga usuário que já existia antes", async () => {
    /* Conta pré-existente nem chega ao convite: o 409 do passo 3.c corta
       antes. Este teste trava esse contrato. */
    const m = mundo({ usuarios: [{ id: "user-antigo", email: "cliente@empresa.com" }], falhar: "vinculo" });
    const r = await chamar(m);
    assertEquals(r.status, 409);
    assertEquals(m.apagados.length, 0);
    assertEquals(m.usuarios.length, 1);
});

Deno.test("falha no vínculo E na remoção -> 500 explícito, com log técnico", async () => {
    const m = mundo({ falhar: "vinculo+remocao" });
    const r = await chamar(m);
    assertEquals(r.status, 500);
    assertEquals((r as any).falha.codigo, "inconsistent_state");
    const evento = m.log.map((l) => l.evento).join(" | ");
    assertStringIncludes(evento, "COMPENSAÇÃO FALHOU");
    /* a situação não fica escondida, e a resposta diz o que houve */
    assertStringIncludes((r as any).falha.mensagem, "não pôde ser removido");
});

Deno.test("CORRIDA: a chamada que perde o insert responde 409, não 500", async () => {
    const m = mundo({ falhar: "corrida" });
    const r = await chamar(m);
    assertEquals(r.status, 409);
    assertEquals((r as any).falha.codigo, "owner_exists");
    assertStringIncludes((r as any).falha.mensagem, "já possui um proprietário");
    /* e a conta que ELA convidou não fica largada por aí */
    assertEquals(m.apagados.length, 1);
    assertEquals(m.usuarios.length, 0);
    assertEquals(m.membros.length, 0);
    assertStringIncludes(m.log.map((l) => l.evento).join(" | "), "outra chamada criou o proprietário primeiro");
});

Deno.test("CORRIDA: duas chamadas simultâneas — uma vence, a outra recebe 409", async () => {
    /* O mesmo "banco" para as duas: quem inserir primeiro cria o owner, e
       o vincularOwner do dublê recusa o segundo com 23505, como o índice
       único parcial faz no Postgres. */
    const m = mundo();
    const [a, b] = await Promise.all([
        chamar(m, "ana@empresa.com"),
        chamar(m, "bruno@empresa.com"),
    ]);

    const status = [a.status, b.status].sort();
    assertEquals(status, [200, 409]);

    const vencedora = (a.status === 200 ? a : b) as any;
    const perdedora = (a.status === 409 ? a : b) as any;
    assertEquals(vencedora.corpo.success, true);
    assertEquals(vencedora.corpo.invited, true);
    assertEquals(perdedora.falha.codigo, "owner_exists");

    /* O estado final é o que importa: um owner, um usuário, e a conta da
       perdedora removida. */
    assertEquals(m.membros.length, 1);
    assertEquals(m.membros[0].role, "owner");
    assertEquals(m.membros[0].user_id, vencedora.corpo.user_id);
    assertEquals(m.usuarios.length, 1);
    assertEquals(m.usuarios[0].id, vencedora.corpo.user_id);
    assertEquals(m.apagados.length, 1);
    assertEquals(m.convites.length, 2);          // as duas chegaram a convidar
});

Deno.test("CORRIDA: a perdedora apaga SÓ a conta dela, nunca a da vencedora", async () => {
    const m = mundo();
    const [a, b] = await Promise.all([
        chamar(m, "ana@empresa.com"),
        chamar(m, "bruno@empresa.com"),
    ]);
    const vencedora = (a.status === 200 ? a : b) as any;
    const emailVencedor = vencedora.corpo.email;
    assertEquals(m.usuarios.map((u) => u.email), [emailVencedor]);
    assertEquals(m.apagados.includes(vencedora.corpo.user_id), false);
});

Deno.test("CORRIDA: se a compensação falhar, continua sendo o erro grave", async () => {
    const m = mundo({ falhar: "corrida+remocao" });
    const r = await chamar(m);
    assertEquals(r.status, 500);
    assertEquals((r as any).falha.codigo, "inconsistent_state");
    const log = m.log.find((l) => l.evento.includes("COMPENSAÇÃO FALHOU"));
    assertEquals(!!log, true);
    assertEquals((log!.detalhe as any).perdeu_a_corrida, true);
    assertEquals(m.usuarios.length, 1);          // a conta órfã existe, e o log diz qual
});

Deno.test("um erro de insert que NÃO é 23505 continua sendo 500", async () => {
    const m = mundo({ falhar: "vinculo" });
    const r = await chamar(m);
    assertEquals(r.status, 500);
    assertEquals((r as any).falha.codigo, "internal_error");
    assertEquals(m.apagados.length, 1);
});

Deno.test("classificador REAL do adaptador, com erros como o Postgres manda", () => {
    /* Os clientes não são usados por ehConflitoDeOwner — nada de rede aqui. */
    const { ehConflitoDeOwner } = dependenciasSupabase(null, null, undefined, "teste");

    /* o índice de um-owner-por-empresa: é a corrida */
    assertEquals(ehConflitoDeOwner({
        code: "23505",
        message: 'duplicate key value violates unique constraint "business_members_one_owner_per_business"',
        details: "Key (business_id)=(111...) already exists.",
    }), true);

    /* o nome também vale quando vem em details */
    assertEquals(ehConflitoDeOwner({
        code: "23505",
        message: "duplicate key value violates unique constraint",
        details: 'constraint "business_members_one_owner_per_business" on table business_members',
    }), true);

    /* 23505 SEM nome de constraint: não dá para afirmar que é a corrida */
    assertEquals(ehConflitoDeOwner({ code: "23505", message: "duplicate key value" }), false);
    assertEquals(ehConflitoDeOwner({ code: "23505" }), false);

    /* 23505 de OUTRA constraint: não é a corrida do owner */
    assertEquals(ehConflitoDeOwner({
        code: "23505",
        message: 'duplicate key value violates unique constraint "business_members_business_id_user_id_key"',
    }), false);

    /* outros códigos nunca viram 409 */
    for (const code of ["23503", "23502", "23514", "42501", "42P01", "", "PGRST116"]) {
        assertEquals(ehConflitoDeOwner({ code, message: "x" }), false, code);
    }
    assertEquals(ehConflitoDeOwner(new Error("insert recusado")), false);
    assertEquals(ehConflitoDeOwner(null), false);
    assertEquals(ehConflitoDeOwner(undefined), false);
    assertEquals(ehConflitoDeOwner("23505"), false);
});

Deno.test("classificador do harness: mesma regra do index.ts de produção", () => {
    const classificar = deps(mundo()).ehConflitoDeOwner;
    const NOME = "business_members_one_owner_per_business";

    /* 23505 + o índice certo -> é a corrida */
    assertEquals(classificar({
        code: "23505",
        message: `duplicate key value violates unique constraint "${NOME}"`,
    }), true);
    assertEquals(classificar({
        code: "23505",
        message: "duplicate key value violates unique constraint",
        details: `constraint "${NOME}" on table business_members`,
    }), true);

    /* 23505 sem nome de constraint -> não dá para afirmar */
    assertEquals(classificar({ code: "23505", message: "duplicate key value" }), false);
    assertEquals(classificar({ code: "23505" }), false);

    /* 23505 de outra constraint */
    assertEquals(classificar({
        code: "23505",
        message: 'duplicate key value violates unique constraint "business_members_business_id_user_id_key"',
    }), false);

    /* outros códigos */
    assertEquals(classificar({ code: "23503", message: `x ${NOME}` }), false);   // FK
    assertEquals(classificar({ code: "42501", message: `x ${NOME}` }), false);   // RLS

    /* nada que não seja erro do Postgres */
    assertEquals(classificar(new Error("insert recusado")), false);
    assertEquals(classificar(null), false);
    assertEquals(classificar(undefined), false);
});

Deno.test("erros de infraestrutura viram 500 sem vazar detalhe técnico", async () => {
    for (const alvo of ["rpc", "empresa", "membros", "convite"] as const) {
        const m = mundo({ falhar: alvo });
        const r = await chamar(m);
        assertEquals(r.status, 500, alvo);
        assertEquals((r as any).falha.codigo, "internal_error", alvo);
        /* o detalhe fica no log da Edge Function... */
        assertEquals(m.log.length > 0, true, alvo);
        /* ...e não na resposta */
        const texto = JSON.stringify((r as any).falha);
        assertEquals(texto.includes("fora do ar"), false, alvo);
    }
});

Deno.test("nenhuma resposta devolve segredo ou detalhe interno do Auth", async () => {
    const casos: unknown[] = [];
    casos.push((await chamar(mundo())) as unknown);
    casos.push((await chamar(mundo({ admin: false }))) as unknown);
    casos.push((await chamar(mundo(), "x@y.com", "00000000-0000-4000-8000-000000000000")) as unknown);
    casos.push((await chamar(mundo({ membros: [{ business_id: EMPRESA, user_id: "u", role: "owner" }] }))) as unknown);
    casos.push((await chamar(mundo({ usuarios: [{ id: "u", email: "cliente@empresa.com" }] }))) as unknown);
    casos.push((await chamar(mundo({ falhar: "vinculo" }))) as unknown);
    casos.push((await chamar(mundo({ falhar: "vinculo+remocao" }))) as unknown);
    for (const c of casos) {
        assertEquals(semSegredo(c), [], JSON.stringify(c));
    }
});

Deno.test("o sucesso devolve exatamente os campos previstos, e nada mais", async () => {
    const corpo = (await chamar(mundo()) as any).corpo;
    assertEquals(
        Object.keys(corpo).sort(),
        ["business_id", "email", "invited", "role", "success", "user_id"],
    );
});

/* =====================================================================
   ROTEIRO MANUAL — só depois do deploy, com um e-mail seu de verdade.
   Nada aqui roda sozinho.

   1) sem login            -> 401
      curl -i -X POST "$URL/functions/v1/provision-business-admin" \
        -H 'content-type: application/json' \
        -d '{"business_id":"<uuid>","email":"voce@exemplo.com"}'

   2) usuário comum (JWT de um cliente) -> 403
      curl -i ... -H "Authorization: Bearer $JWT_DE_CLIENTE" ...

   3) platform admin, empresa inexistente -> 404
   4) platform admin, empresa com owner   -> 409 owner_exists
   5) platform admin, e-mail já cadastrado -> 409 email_in_use
   6) platform admin, e-mail novo          -> 200 invited:true + e-mail chega
   7) repetir a 6                          -> 200 already_linked:true
   8) preflight                            -> 204 com os cabeçalhos CORS
      curl -i -X OPTIONS "$URL/functions/v1/provision-business-admin"
   ===================================================================== */