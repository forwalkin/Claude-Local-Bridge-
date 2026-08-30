const fs = require("node:fs/promises");
const path = require("node:path");

class SkillLoader {
  constructor({ manifestsDir, validator }) {
    this.manifestsDir = manifestsDir;
    this.validator = validator;
  }

  async loadAll() {
    const files = await fs.readdir(this.manifestsDir);

    const manifestFiles = files.filter((file) => file.endsWith(".json"));

    const skills = [];

    for (const file of manifestFiles) {
      const filePath = path.join(this.manifestsDir, file);
      const skill = await this.loadOne(filePath);

      skills.push(skill);
    }

    return skills;
  }

  async loadOne(filePath) {
    let raw;

    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      throw new Error(
        `Não foi possível ler o manifesto "${filePath}": ${error.message}`
      );
    }

    let manifest;

    try {
      manifest = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `JSON inválido no manifesto "${filePath}": ${error.message}`
      );
    }

    const valid = this.validator(manifest);

    if (!valid) {
      const details = this.validator.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");

      throw new Error(
        `Manifesto inválido "${filePath}": ${details || "erro desconhecido"}`
      );
    }

    const expectedName = path.basename(filePath, ".json");

    if (manifest.name !== expectedName) {
      throw new Error(
        `O nome da Skill "${manifest.name}" não corresponde ao arquivo "${expectedName}.json".`
      );
    }

    return manifest;
  }
}

module.exports = SkillLoader;
