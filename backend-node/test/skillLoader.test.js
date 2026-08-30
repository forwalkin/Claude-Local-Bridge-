const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const SkillLoader = require("../src/services/skillLoader");
const validateSkill = require("../src/services/skillValidator");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "skills-"));
}

test("carrega um manifesto válido cujo nome bate com o arquivo", async () => {
  const dir = await makeTempDir();

  const skill = {
    name: "workspace_cleaner",
    description: "Analisa arquivos.",
    destructive: false,
    pathFields: [],
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    permissions: ["filesystem.read"]
  };

  await fs.writeFile(
    path.join(dir, "workspace_cleaner.json"),
    JSON.stringify(skill)
  );

  const loader = new SkillLoader({ manifestsDir: dir, validator: validateSkill });
  const skills = await loader.loadAll();

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "workspace_cleaner");
});

test("rejeita manifesto cujo nome não bate com o arquivo", async () => {
  const dir = await makeTempDir();

  const skill = {
    name: "outra_coisa",
    description: "Analisa arquivos.",
    destructive: false,
    pathFields: [],
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    permissions: ["filesystem.read"]
  };

  await fs.writeFile(
    path.join(dir, "workspace_cleaner.json"),
    JSON.stringify(skill)
  );

  const loader = new SkillLoader({ manifestsDir: dir, validator: validateSkill });

  await assert.rejects(
    () => loader.loadAll(),
    /não corresponde ao arquivo/
  );
});

test("rejeita JSON malformado com mensagem clara", async () => {
  const dir = await makeTempDir();

  await fs.writeFile(path.join(dir, "quebrado.json"), "{ not valid json");

  const loader = new SkillLoader({ manifestsDir: dir, validator: validateSkill });

  await assert.rejects(() => loader.loadAll(), /JSON inválido/);
});
