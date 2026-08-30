const path = require("node:path");

/**
 * Deriva o path do runner Python de uma skill exclusivamente a partir de
 * skillName -- nunca de dado vindo do manifesto ou de input. skillName já
 * passou por pattern ^[a-z0-9_]+$ no skill.schema.json, então é seguro
 * usar diretamente num path, mas a checagem de containment abaixo é
 * defesa em profundidade, não confia só na validação anterior.
 *
 * Convenção fixa: automation-python/skills/<skillName>/runner.py
 */
function resolveRunnerPath({ runnersRoot, skillName }) {
  if (typeof skillName !== "string" || !/^[a-z0-9_]+$/.test(skillName)) {
    throw new TypeError(`skillName inválido para resolução de runner: "${skillName}"`);
  }

  const runnersRealRoot = path.resolve(runnersRoot);
  const runnerPath = path.join(runnersRealRoot, skillName, "runner.py");

  // Defesa em profundidade: mesmo com o pattern do schema já garantindo
  // ausência de "..", confirma containment via path.relative antes de
  // devolver o path que será usado no spawn.
  const rel = path.relative(runnersRealRoot, runnerPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new TypeError(`Runner resolvido escapa de runnersRoot: "${runnerPath}"`);
  }

  return runnerPath;
}

module.exports = { resolveRunnerPath };
