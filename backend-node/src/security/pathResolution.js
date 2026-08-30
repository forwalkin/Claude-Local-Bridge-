const path = require("node:path");
const fs = require("node:fs/promises");

/**
 * Este módulo contém apenas lógica de resolução/containment de paths.
 * Não conhece Skills, permissions, destructive, confirmação ou execução.
 * Cada função é pura ou depende só do filesystem (fs.realpath), nunca de
 * estado de negócio.
 */

/**
 * Detecta, de forma agnóstica de sistema operacional, se uma string bruta
 * de path é perigosa o suficiente para ser rejeitada antes de qualquer
 * resolução contra o sandbox.
 *
 * Isso roda ANTES de qualquer chamada ao filesystem — é checagem puramente
 * textual, e por isso funciona igual em qualquer SO onde o código rodar.
 *
 * Rejeita:
 *  - path absoluto POSIX (começa com "/")
 *  - path absoluto Windows (drive letter "C:\", UNC "\\\\server\\share")
 *    -- detectado via path.win32.isAbsolute() e path.posix.isAbsolute(),
 *       ambos chamados explicitamente independente do SO real de execução,
 *       porque o valor vem de uma chamada externa (Claude) e pode conter
 *       sintaxe de qualquer SO, não só do SO onde o servidor roda agora.
 *  - qualquer segmento igual a ".." (separado por "/" OU "\", verificado
 *    manualmente porque path.posix não entende "\" como separador — se
 *    dependêssemos só de path.relative() rodando em Linux, um traversal
 *    disfarçado com "\" passaria despercebido nos testes)
 *  - dois-pontos (":") em qualquer posição — bloqueia tanto drive letters
 *    quanto NTFS Alternate Data Streams (ex: "arquivo.txt:oculto"), um
 *    vetor específico do Windows que não é coberto por isAbsolute()
 *  - byte nulo, usado classicamente para truncar strings em APIs nativas
 */
function findDangerousPatternInRawPath(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return "EMPTY_OR_NOT_STRING";
  }

  if (raw.includes("\0")) {
    return "NULL_BYTE";
  }

  if (path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) {
    return "ABSOLUTE_PATH";
  }

  if (raw.includes(":")) {
    return "COLON_CHARACTER";
  }

  const segments = raw.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    return "PARENT_SEGMENT";
  }

  return null;
}

/**
 * Verifica se `target` está contido dentro de `root`, usando path.relative
 * em vez de comparação textual (startsWith), que é vulnerável a confundir
 * "/sandbox" com "/sandbox_evil".
 *
 * root e target devem já estar resolvidos/absolutos (path.resolve ou
 * fs.realpath) antes de chegar aqui.
 */
function isContained(root, target) {
  const rel = path.relative(root, target);

  if (rel === "") {
    return true; // target é exatamente o root
  }

  if (rel === "..") {
    return false;
  }

  if (rel.startsWith(".." + path.sep)) {
    return false;
  }

  if (path.isAbsolute(rel)) {
    // Em Windows, path.relative entre drives diferentes retorna um path
    // absoluto (não é possível expressar como relativo) — isso também
    // significa "fora do root".
    return false;
  }

  return true;
}

/**
 * Canonicaliza um path resolvido (já dentro do sandbox textualmente) contra
 * o filesystem real, resolvendo symlinks/junctions/reparse points.
 *
 * Contrato importante: quando o alvo final NÃO existe, este método NÃO
 * assume que é seguro. Ele sobe a árvore de diretórios até encontrar o
 * ancestral mais profundo que realmente existe, resolve ESSE ancestral via
 * fs.realpath (o que resolve qualquer symlink/junction nele), e só então
 * reconstrói o caminho final anexando os componentes que ainda não existem.
 *
 * Isso impede o bypass clássico: "sandbox/link_para_fora/arquivo_novo.txt",
 * onde "link_para_fora" é um symlink existente apontando pra fora do
 * sandbox e "arquivo_novo.txt" não existe — um fs.realpath ingênuo no path
 * completo simplesmente lançaria ENOENT sem revelar que o ancestral já
 * escapou do sandbox.
 *
 * @returns {{ canonicalPath: string, existed: boolean }}
 * @throws {Error} para erros de filesystem inesperados (não ENOENT), ex.
 *   permissão negada — isso é tratado como falha de sistema, não como
 *   negação de política de negócio.
 * @throws {Error} se nenhum ancestral existente for encontrado até a raiz
 *   do filesystem (situação anômala, indica sandboxRoot mal configurado).
 */
async function canonicalizeAgainstFilesystem(resolvedPath) {
  try {
    const real = await fs.realpath(resolvedPath);
    return { canonicalPath: real, existed: true };
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  // O alvo final não existe. Sobe a árvore procurando o ancestral mais
  // profundo que existe de fato, coletando os componentes que faltam.
  const missingParts = [path.basename(resolvedPath)];
  let current = path.dirname(resolvedPath);

  while (true) {
    try {
      const realAncestor = await fs.realpath(current);
      missingParts.reverse();
      return {
        canonicalPath: path.join(realAncestor, ...missingParts),
        existed: false
      };
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }

      const parent = path.dirname(current);

      if (parent === current) {
        // Chegou na raiz do filesystem sem achar nenhum ancestral existente.
        throw new Error(
          `Nenhum ancestral existente encontrado ao canonicalizar "${resolvedPath}". ` +
          "Isso indica sandboxRoot mal configurado ou inexistente."
        );
      }

      missingParts.push(path.basename(current));
      current = parent;
    }
  }
}

module.exports = {
  findDangerousPatternInRawPath,
  isContained,
  canonicalizeAgainstFilesystem
};
