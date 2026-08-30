const path = require("node:path");
const fs = require("node:fs/promises");

const {
  findDangerousPatternInRawPath,
  isContained,
  canonicalizeAgainstFilesystem
} = require("./pathResolution");

/**
 * PathPolicy.evaluate({ skill, input })
 *
 * Responde apenas: "os paths desta chamada, conforme declarados em
 * skill.pathFields, estão dentro do sandbox, resolvidos de forma
 * enganação-resistente?"
 *
 * NÃO sabe nada sobre PermissionEngine, ConfirmationManager ou
 * ExecutionEngine. NÃO executa comandos, NÃO acessa CMD/Python, NÃO pede
 * confirmação humana. NÃO decide se um arquivo precisa existir para a
 * operação — apenas garante que, exista ou não, o path resolvido não
 * escapa do sandbox.
 *
 * Usa exclusivamente skill.pathFields para saber quais campos do input
 * validar como path — nunca heurística por nome de campo.
 *
 * Códigos de negação:
 *   PATH_ALLOWED               — todos os pathFields passaram
 *   PATH_FIELD_MISSING         — campo declarado em pathFields ausente no
 *                                 input, ou presente mas não é string
 *   PATH_ABSOLUTE_REJECTED     — path absoluto, ou contém padrão perigoso
 *                                 textual (":", byte nulo) tratado com a
 *                                 mesma severidade de um path absoluto
 *   PATH_TRAVERSAL_REJECTED    — resolução textual (sem tocar filesystem)
 *                                 aponta pra fora do sandbox, incluindo
 *                                 segmentos ".." disfarçados com "\"
 *   PATH_ESCAPE_VIA_SYMLINK    — só detectável após canonicalização real
 *                                 via fs.realpath: o path passou na
 *                                 checagem textual, mas um symlink/junction
 *                                 em algum ancestral resolve pra fora
 *
 * Erros de sistema (permissão negada no filesystem, sandboxRoot mal
 * configurado/inexistente) sobem como exceção, nunca como negação
 * estruturada — mesmo padrão do PermissionEngine para violações de
 * invariante: isso não é uma decisão sobre a chamada, é uma falha do
 * ambiente em que o servidor está rodando.
 *
 * @param {{ sandboxRoot: string }} config
 * @returns {{ evaluate: (request: { skill: object, input: object }) => Promise<{
 *   allowed: boolean,
 *   code: string,
 *   reason: string|null,
 *   resolvedPaths: Record<string, string>
 * }> }}
 */
function createPathPolicy({ sandboxRoot }) {
  if (!sandboxRoot || typeof sandboxRoot !== "string") {
    throw new TypeError("createPathPolicy requer sandboxRoot (string).");
  }

  const normalizedSandboxRoot = path.resolve(sandboxRoot);

  // Cache do realpath do próprio sandboxRoot: não deveria mudar durante a
  // vida do processo. Escopado por instância (fechamento de
  // createPathPolicy), não é estado global compartilhado entre sandboxes
  // diferentes (ex: em testes, cada teste cria seu próprio sandboxRoot).
  let cachedSandboxRealRoot = null;

  async function getSandboxRealRoot() {
    if (cachedSandboxRealRoot) {
      return cachedSandboxRealRoot;
    }

    // Se isto lançar (ex: sandboxRoot não existe no filesystem), é erro de
    // configuração do servidor — sobe cru, não vira negação de política.
    cachedSandboxRealRoot = await fs.realpath(normalizedSandboxRoot);
    return cachedSandboxRealRoot;
  }

  async function evaluateField(fieldName, rawValue) {
    if (typeof rawValue !== "string" || rawValue.length === 0) {
      return {
        ok: false,
        code: "PATH_FIELD_MISSING",
        reason: `O campo "${fieldName}" declarado em pathFields está ausente ou não é uma string não-vazia.`
      };
    }

    // Camada 1: checagem textual, agnóstica de SO, sem tocar o filesystem.
    const dangerPattern = findDangerousPatternInRawPath(rawValue);

    if (dangerPattern === "PARENT_SEGMENT") {
      return {
        ok: false,
        code: "PATH_TRAVERSAL_REJECTED",
        reason: `O campo "${fieldName}" contém um segmento ".." (traversal textual).`
      };
    }

    if (dangerPattern) {
      // ABSOLUTE_PATH, COLON_CHARACTER, NULL_BYTE
      return {
        ok: false,
        code: "PATH_ABSOLUTE_REJECTED",
        reason: `O campo "${fieldName}" contém um path absoluto ou padrão não permitido (${dangerPattern}).`
      };
    }

    // Camada 2: resolução textual contra o sandbox + containment, ainda
    // sem tocar filesystem.
    const resolvedTextual = path.resolve(normalizedSandboxRoot, rawValue);

    if (!isContained(normalizedSandboxRoot, resolvedTextual)) {
      return {
        ok: false,
        code: "PATH_TRAVERSAL_REJECTED",
        reason: `O campo "${fieldName}" resolve para fora do sandbox (traversal textual).`
      };
    }

    // Camada 3: canonicalização real via filesystem (resolve symlinks,
    // junctions, reparse points — inclusive quando o alvo final ainda não
    // existe, via resolução do ancestral mais profundo existente).
    const canonical = await canonicalizeAgainstFilesystem(resolvedTextual);
    const sandboxRealRoot = await getSandboxRealRoot();

    if (!isContained(sandboxRealRoot, canonical.canonicalPath)) {
      return {
        ok: false,
        code: "PATH_ESCAPE_VIA_SYMLINK",
        reason: `O campo "${fieldName}" resolve para fora do sandbox após canonicalização (symlink/junction/reparse point em algum ancestral).`
      };
    }

    return { ok: true, canonicalPath: canonical.canonicalPath };
  }

  async function evaluate({ skill, input }) {
    if (!skill || typeof skill !== "object") {
      throw new TypeError("PathPolicy.evaluate requer uma skill válida (erro de programação, não de negócio).");
    }

    if (!Array.isArray(skill.pathFields)) {
      throw new TypeError(
        `Skill "${skill.name}" não declara pathFields como array (deveria ter sido barrado no schema).`
      );
    }

    if (skill.pathFields.length === 0) {
      return { allowed: true, code: "PATH_ALLOWED", reason: null, resolvedPaths: {} };
    }

    if (!input || typeof input !== "object") {
      return {
        allowed: false,
        code: "PATH_FIELD_MISSING",
        reason: "O input está ausente, portanto nenhum pathField declarado pode ser validado.",
        resolvedPaths: {}
      };
    }

    const resolvedPaths = {};

    for (const fieldName of skill.pathFields) {
      const result = await evaluateField(fieldName, input[fieldName]);

      if (!result.ok) {
        return {
          allowed: false,
          code: result.code,
          reason: result.reason,
          resolvedPaths: {}
        };
      }

      resolvedPaths[fieldName] = result.canonicalPath;
    }

    return { allowed: true, code: "PATH_ALLOWED", reason: null, resolvedPaths };
  }

  return { evaluate };
}

module.exports = { createPathPolicy };
