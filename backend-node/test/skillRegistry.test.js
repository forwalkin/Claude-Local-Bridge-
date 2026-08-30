const test = require("node:test");
const assert = require("node:assert/strict");

const SkillRegistry = require("../src/services/skillRegistry");

const skill = {
  name: "workspace_cleaner",
  description: "Analisa arquivos do workspace.",
  destructive: false,
  input: {
    type: "object",
    properties: {}
  },
  permissions: ["filesystem.read"]
};

test("registra e recupera uma Skill", () => {
  const registry = new SkillRegistry();

  registry.register(skill);

  assert.equal(registry.has("workspace_cleaner"), true);
  assert.deepEqual(registry.get("workspace_cleaner"), skill);
});

test("não permite Skills duplicadas", () => {
  const registry = new SkillRegistry();

  registry.register(skill);

  assert.throws(() => registry.register(skill), /já está registrada/);
});

test("congela propriedades aninhadas da Skill", () => {
  const registry = new SkillRegistry();

  registry.register({
    name: "workspace_cleaner",
    description: "Analisa arquivos.",
    destructive: false,
    input: {
      type: "object",
      properties: {}
    },
    permissions: ["filesystem.read"]
  });

  const stored = registry.get("workspace_cleaner");

  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.permissions), true);
  assert.equal(Object.isFrozen(stored.input), true);
  assert.equal(Object.isFrozen(stored.input.properties), true);

  // mutação deve falhar silenciosamente (não-strict) ou lançar (strict);
  // o importante é que o array armazenado nunca muda.
  try {
    stored.permissions.push("process.execute");
  } catch (_) {
    // esperado em modo strict
  }

  assert.deepEqual(stored.permissions, ["filesystem.read"]);
});

test("registerAll é atômico: nenhuma skill entra se uma falhar", () => {
  const registry = new SkillRegistry();

  const skillA = { ...skill, name: "skill_a" };
  const skillB = { ...skill, name: "skill_b" };
  const skillBDuplicada = { ...skill, name: "skill_b" };

  assert.throws(
    () => registry.registerAll([skillA, skillB, skillBDuplicada]),
    /já está registrada/
  );

  // nenhuma das três deve ter sido registrada, nem skill_a que era válida
  assert.equal(registry.has("skill_a"), false);
  assert.equal(registry.has("skill_b"), false);
  assert.equal(registry.count(), 0);
});

test("registerAll registra tudo quando não há conflitos", () => {
  const registry = new SkillRegistry();

  const skillA = { ...skill, name: "skill_a" };
  const skillB = { ...skill, name: "skill_b" };

  registry.registerAll([skillA, skillB]);

  assert.equal(registry.count(), 2);
  assert.equal(registry.has("skill_a"), true);
  assert.equal(registry.has("skill_b"), true);
});
