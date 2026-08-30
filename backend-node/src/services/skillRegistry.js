function deepFreeze(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

class SkillRegistry {
  constructor() {
    this.skills = new Map();
  }

  register(skill) {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill "${skill.name}" já está registrada.`);
    }

    this.skills.set(skill.name, deepFreeze(skill));
  }

  // Tudo-ou-nada: se qualquer skill do batch falhar, nenhuma é registrada.
  registerAll(skills) {
    const pending = new Map();

    for (const skill of skills) {
      if (pending.has(skill.name) || this.skills.has(skill.name)) {
        throw new Error(`Skill "${skill.name}" já está registrada.`);
      }

      pending.set(skill.name, deepFreeze(skill));
    }

    for (const [name, skill] of pending) {
      this.skills.set(name, skill);
    }
  }

  get(name) {
    return this.skills.get(name);
  }

  has(name) {
    return this.skills.has(name);
  }

  list() {
    return [...this.skills.values()];
  }

  count() {
    return this.skills.size;
  }
}

module.exports = SkillRegistry;
