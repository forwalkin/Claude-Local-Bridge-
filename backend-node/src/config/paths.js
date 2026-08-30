const path = require("node:path");

// backend-node/src/config/paths.js -> sobe 3 níveis para chegar na raiz do projeto
const ROOT_DIR = path.resolve(__dirname, "../../../");

module.exports = {
  ROOT_DIR,
  SKILLS_SCHEMA: path.join(
    ROOT_DIR,
    "ai-skills",
    "schemas",
    "skill.schema.json"
  ),
  SKILLS_MANIFESTS: path.join(
    ROOT_DIR,
    "ai-skills",
    "manifests"
  ),
  SANDBOX_ROOT: path.join(ROOT_DIR, "sandbox")
};
