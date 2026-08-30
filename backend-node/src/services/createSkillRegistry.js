const paths = require("../config/paths");
const SkillLoader = require("./skillLoader");
const SkillRegistry = require("./skillRegistry");
const validateSkill = require("./skillValidator");

async function createSkillRegistry() {
  const loader = new SkillLoader({
    manifestsDir: paths.SKILLS_MANIFESTS,
    validator: validateSkill
  });

  const skills = await loader.loadAll();

  const registry = new SkillRegistry();
  registry.registerAll(skills);

  return registry;
}

module.exports = {
  createSkillRegistry
};
