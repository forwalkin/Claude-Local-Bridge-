const Ajv2020 = require("ajv/dist/2020");

const KNOWN_PERMISSIONS = new Set([
  "filesystem.read",
  "filesystem.write",
  "filesystem.delete",
  "process.read",
  "process.execute",
  "system.read"
]);

// Um Ajv por processo, com cache de schemas compilados por instância de skill.
// Usamos WeakMap (não Map por nome) porque o cache deve acompanhar exatamente
// o objeto imutável (deepFrozen) que o SkillRegistry entrega — não uma string
// solta que poderia, em tese, divergir do objeto real. Como bônus, entradas
// são coletadas pelo GC automaticamente se a skill sair de uso.
const ajv = new Ajv2020({ allErrors: true, strict: true });
const compiledInputSchemas = new WeakMap();

function getCompiledInputSchema(skill) {
  let compiled = compiledInputSchemas.get(skill);

  if (!compiled) {
    // Se skill.input não for um JSON Schema estruturalmente válido (ex: um
    // "type" desconhecido dentro de properties), ajv.compile() lança aqui.
    // Isso é PROPOSITAL e não é capturado: skill.input já deveria ter vindo
    // validado estruturalmente pelo SkillRegistry/skillValidator na carga do
    // manifesto. Um schema inválido chegando neste ponto é violação de
    // invariante do sistema (bug upstream), não uma negação de permissão de
    // negócio — por isso a exceção sobe crua, e não vira INPUT_SCHEMA_INVALID.
    compiled = ajv.compile(skill.input);
    compiledInputSchemas.set(skill, compiled);
  }

  return compiled;
}

/**
 * Cada check recebe { skill, input } e retorna:
 *   { ok: true }
 *   { ok: false, code: string, reason: string }
 * Nunca lança exceção para casos de negócio esperados.
 */

function checkInputPresent({ input }) {
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      code: "INPUT_MISSING",
      reason: "O input da chamada está ausente ou não é um objeto."
    };
  }

  return { ok: true };
}

function checkInputMatchesSchema({ skill, input }) {
  const validate = getCompiledInputSchema(skill);
  const valid = validate(input);

  if (!valid) {
    const details = validate.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");

    return {
      ok: false,
      code: "INPUT_SCHEMA_INVALID",
      reason: `O input não corresponde ao schema da Skill "${skill.name}": ${details || "erro desconhecido"}`
    };
  }

  return { ok: true };
}

function checkPermissionsNotEmpty({ skill }) {
  if (!Array.isArray(skill.permissions) || skill.permissions.length === 0) {
    return {
      ok: false,
      code: "PERMISSIONS_EMPTY",
      reason: `A Skill "${skill.name}" não declara nenhuma permissão.`
    };
  }

  return { ok: true };
}

function checkPermissionsKnown({ skill }) {
  const unknown = skill.permissions.filter((p) => !KNOWN_PERMISSIONS.has(p));

  if (unknown.length > 0) {
    return {
      ok: false,
      code: "PERMISSIONS_UNKNOWN",
      reason: `A Skill "${skill.name}" declara permissões desconhecidas: ${unknown.join(", ")}`
    };
  }

  return { ok: true };
}

module.exports = {
  KNOWN_PERMISSIONS,
  checkInputPresent,
  checkInputMatchesSchema,
  checkPermissionsNotEmpty,
  checkPermissionsKnown
};
