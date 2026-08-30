const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluate } = require("../src/security/permissionEngine");

function baseSkill(overrides = {}) {
  return {
    name: "workspace_cleaner",
    description: "Analisa arquivos.",
    destructive: true,
    input: {
      type: "object",
      properties: {
        file_extension: { type: "string" },
        dry_run: { type: "boolean" }
      },
      required: ["file_extension", "dry_run"],
      additionalProperties: false
    },
    permissions: ["filesystem.read", "filesystem.delete"],
    ...overrides
  };
}

test("1. allowed=true quando input bate com o schema e permissions são válidas", () => {
  const result = evaluate({
    skill: baseSkill(),
    input: { file_extension: "log", dry_run: true }
  });

  assert.equal(result.allowed, true);
  assert.equal(result.code, "ALLOWED");
  assert.equal(result.reason, null);
});

test("2. INPUT_MISSING quando input é null", () => {
  const result = evaluate({ skill: baseSkill(), input: null });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "INPUT_MISSING");
});

test("2b. INPUT_MISSING quando input é undefined", () => {
  const result = evaluate({ skill: baseSkill(), input: undefined });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "INPUT_MISSING");
});

test("3. INPUT_SCHEMA_INVALID quando falta campo obrigatório", () => {
  const result = evaluate({
    skill: baseSkill(),
    input: { file_extension: "log" } // falta dry_run
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "INPUT_SCHEMA_INVALID");
});

test("4. INPUT_SCHEMA_INVALID quando o tipo do campo está errado", () => {
  const result = evaluate({
    skill: baseSkill(),
    input: { file_extension: "log", dry_run: "sim" } // deveria ser boolean
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "INPUT_SCHEMA_INVALID");
});

test("5. INPUT_SCHEMA_INVALID quando há campo extra não declarado", () => {
  const result = evaluate({
    skill: baseSkill(),
    input: { file_extension: "log", dry_run: true, extra_field: "hack" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "INPUT_SCHEMA_INVALID");
});

test("6. PERMISSIONS_EMPTY quando a skill não declara nenhuma permissão (defesa em profundidade)", () => {
  const result = evaluate({
    skill: baseSkill({ permissions: [] }),
    input: { file_extension: "log", dry_run: true }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PERMISSIONS_EMPTY");
});

test("7. PERMISSIONS_UNKNOWN quando há permissão fora do enum conhecido", () => {
  const result = evaluate({
    skill: baseSkill({ permissions: ["filesystem.read", "network.access"] }),
    input: { file_extension: "log", dry_run: true }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PERMISSIONS_UNKNOWN");
  assert.match(result.reason, /network\.access/);
});

test("8. destructive e permissions são repassados mesmo quando allowed=false", () => {
  const result = evaluate({
    skill: baseSkill({ destructive: true, permissions: ["filesystem.delete"] }),
    input: null // força negação em INPUT_MISSING
  });

  assert.equal(result.allowed, false);
  assert.equal(result.destructive, true);
  assert.deepEqual(result.permissions, ["filesystem.delete"]);
});

test("8b. destructive e permissions são repassados quando allowed=true", () => {
  const result = evaluate({
    skill: baseSkill({ destructive: false, permissions: ["filesystem.read"] }),
    input: { file_extension: "log", dry_run: true }
  });

  assert.equal(result.allowed, true);
  assert.equal(result.destructive, false);
  assert.deepEqual(result.permissions, ["filesystem.read"]);
});

test("9. short-circuit: input nulo nunca chega a checar permissions", () => {
  const result = evaluate({
    skill: baseSkill({ permissions: ["nao_existe_essa_permissao"] }),
    input: null
  });

  // Se não houvesse short-circuit, o code seria PERMISSIONS_UNKNOWN.
  // Com short-circuit, INPUT_MISSING é detectado primeiro e o pipeline para ali.
  assert.equal(result.code, "INPUT_MISSING");
});

test("erro de programação: skill ausente lança TypeError (não é caso de negócio)", () => {
  assert.throws(
    () => evaluate({ skill: null, input: {} }),
    TypeError
  );
});

test("erro de invariante: skill.input estruturalmente inválido como JSON Schema lança (não vira negação de negócio)", () => {
  // Este cenário não deveria acontecer em condições normais: skill.input já
  // deveria ter sido validado estruturalmente pelo skillValidator na carga
  // do manifesto (skill.schema.json). Se, mesmo assim, chegar aqui um
  // schema inválido (ex: um "type" que não existe em JSON Schema), o Ajv
  // lança ao compilar — e essa exceção deve subir crua, sem ser convertida
  // em { allowed: false, code: "INPUT_SCHEMA_INVALID" }, porque o problema
  // está no contrato da skill (bug upstream), não no input da chamada.
  const brokenSkill = baseSkill({
    input: {
      type: "object",
      properties: {
        file_extension: { type: "nao_e_um_tipo_valido" }
      },
      additionalProperties: false
    }
  });

  assert.throws(
    () => evaluate({ skill: brokenSkill, input: { file_extension: "log" } }),
    /schema is invalid/
  );
});
