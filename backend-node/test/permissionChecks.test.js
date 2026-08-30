const test = require("node:test");
const assert = require("node:assert/strict");

const { checkInputMatchesSchema } = require("../src/security/permissionChecks");

function makeSkill(overrides = {}) {
  return {
    name: "workspace_cleaner",
    destructive: false,
    input: {
      type: "object",
      properties: {
        file_extension: { type: "string" }
      },
      required: ["file_extension"],
      additionalProperties: false
    },
    permissions: ["filesystem.read"],
    ...overrides
  };
}

test("cache de schema compilado é por instância do objeto, não por nome", () => {
  // Duas instâncias distintas, mesmo "name", com schemas de input DIFERENTES.
  // Se o cache fosse indexado por skill.name (Map antigo), a segunda leitura
  // reaproveitaria erroneamente o schema compilado da primeira instância.
  const skillA = makeSkill({
    input: {
      type: "object",
      properties: { file_extension: { type: "string" } },
      required: ["file_extension"],
      additionalProperties: false
    }
  });

  const skillB = makeSkill({
    input: {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
      additionalProperties: false
    }
  });

  const resultA = checkInputMatchesSchema({ skill: skillA, input: { file_extension: "log" } });
  const resultB = checkInputMatchesSchema({ skill: skillB, input: { count: 3 } });

  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);

  // Confirma que skillA não aceita o input de skillB (schemas não colidiram no cache)
  const cross = checkInputMatchesSchema({ skill: skillA, input: { count: 3 } });
  assert.equal(cross.ok, false);
  assert.equal(cross.code, "INPUT_SCHEMA_INVALID");
});

test("cache reaproveita o schema compilado na mesma instância de skill", () => {
  const skill = makeSkill();

  const first = checkInputMatchesSchema({ skill, input: { file_extension: "log" } });
  const second = checkInputMatchesSchema({ skill, input: { file_extension: "txt" } });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});
