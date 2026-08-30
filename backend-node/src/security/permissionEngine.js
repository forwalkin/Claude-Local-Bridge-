const {
  checkInputPresent,
  checkInputMatchesSchema,
  checkPermissionsNotEmpty,
  checkPermissionsKnown
} = require("./permissionChecks");

// Ordem importa: cada check assume que os anteriores já passaram.
// Ex: checkInputMatchesSchema assume que input é um objeto (garantido por checkInputPresent).
const CHECKS = [
  checkInputPresent,
  checkInputMatchesSchema,
  checkPermissionsNotEmpty,
  checkPermissionsKnown
];

/**
 * PermissionEngine.evaluate({ skill, input })
 *
 * Responde apenas: "esta skill, com este input, é permitida do ponto de
 * vista de schema de chamada e permissões declaradas?"
 *
 * NÃO sabe nada sobre filesystem, paths, sessão ou confirmação humana.
 * NÃO decide se uma operação destrutiva precisa de aprovação — apenas
 * repassa `destructive` no resultado para a próxima camada decidir.
 *
 * Contrato sobre `skill.input` malformado: este método assume que `skill`
 * veio do SkillRegistry, ou seja, já passou pelo skillValidator no momento
 * da carga do manifesto. Se `skill.input` for estruturalmente inválido como
 * JSON Schema (ex: um "type" desconhecido dentro de properties), o Ajv lança
 * uma exceção ao compilar — e essa exceção sobe crua daqui, sem virar um
 * resultado `{ allowed: false }`. Isso é proposital: um schema inválido
 * chegando até aqui é violação de invariante do sistema (bug upstream na
 * validação de carga), não uma negação de permissão de negócio, e não deve
 * ser confundido com os códigos INPUT_MISSING/INPUT_SCHEMA_INVALID, que
 * descrevem problemas no INPUT DA CHAMADA, não no schema da skill em si.
 *
 * @param {{ skill: object, input: object }} request
 * @returns {{
 *   allowed: boolean,
 *   code: string,
 *   reason: string|null,
 *   skillName: string,
 *   destructive: boolean,
 *   permissions: string[]
 * }}
 */
function evaluate({ skill, input }) {
  if (!skill || typeof skill !== "object") {
    throw new TypeError("PermissionEngine.evaluate requer uma skill válida (erro de programação, não de negócio).");
  }

  const context = { skill, input };

  for (const check of CHECKS) {
    const result = check(context);

    if (!result.ok) {
      return {
        allowed: false,
        code: result.code,
        reason: result.reason,
        skillName: skill.name,
        destructive: skill.destructive,
        permissions: skill.permissions
      };
    }
  }

  return {
    allowed: true,
    code: "ALLOWED",
    reason: null,
    skillName: skill.name,
    destructive: skill.destructive,
    permissions: skill.permissions
  };
}

module.exports = { evaluate };
