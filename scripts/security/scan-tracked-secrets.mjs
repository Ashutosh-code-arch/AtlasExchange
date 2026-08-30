import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, "../..");

const contentRules = Object.freeze([
  Object.freeze({
    id: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  }),
  Object.freeze({ id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ }),
  Object.freeze({ id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/ }),
  Object.freeze({
    id: "github-fine-grained-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{50,255}\b/,
  }),
  Object.freeze({ id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ }),
  Object.freeze({ id: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{16,255}\b/ }),
  Object.freeze({ id: "stripe-live-secret", pattern: /\bsk_live_[0-9A-Za-z]{16,255}\b/ }),
]);

const privateCredentialFilePattern =
  /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:p12|pfx|jks|keystore))$/i;
const environmentTemplatePattern = /\.(?:example|sample|template)$/i;

function lineNumberAt(text, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 10) {
      line += 1;
    }
  }
  return line;
}

export function scanPath(path) {
  const fileName = path.split("/").at(-1) ?? path;
  const isEnvironmentCredential =
    (fileName === ".env" || fileName.startsWith(".env.")) &&
    !environmentTemplatePattern.test(fileName);

  return isEnvironmentCredential || privateCredentialFilePattern.test(path)
    ? [Object.freeze({ line: 1, path, ruleId: "credential-file" })]
    : [];
}

export function scanText(text, path) {
  const findings = [];

  for (const rule of contentRules) {
    const match = rule.pattern.exec(text);
    if (match?.index !== undefined) {
      findings.push(
        Object.freeze({
          line: lineNumberAt(text, match.index),
          path,
          ruleId: rule.id,
        }),
      );
    }
  }

  return findings;
}

export function listRepositoryFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repositoryDirectory,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  return output.split("\0").filter((path) => path.length > 0);
}

export function scanRepository(paths = listRepositoryFiles()) {
  const findings = [];

  for (const path of paths) {
    const absolutePath = resolve(repositoryDirectory, path);
    const repositoryRelativePath = relative(repositoryDirectory, absolutePath);
    if (
      repositoryRelativePath.startsWith("..") ||
      resolve(repositoryDirectory, repositoryRelativePath) !== absolutePath
    ) {
      throw new Error(`Refusing to scan a path outside the repository: ${path}`);
    }

    findings.push(...scanPath(path));

    const stats = lstatSync(absolutePath);
    if (!stats.isFile()) {
      continue;
    }

    const content = readFileSync(absolutePath);
    if (content.includes(0)) {
      continue;
    }

    findings.push(...scanText(content.toString("utf8"), path));
  }

  return findings;
}

function run() {
  const findings = scanRepository();
  if (findings.length === 0) {
    process.stdout.write("Tracked-secret scan passed.\n");
    return;
  }

  process.stderr.write("Tracked-secret scan found prohibited credential material:\n");
  for (const finding of findings) {
    process.stderr.write(`- ${finding.path}:${finding.line} [${finding.ruleId}]\n`);
  }
  process.stderr.write(
    "No matched credential value was printed. Revoke or rotate a real credential before removing it from source.\n",
  );
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(
      `Tracked-secret scan failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
